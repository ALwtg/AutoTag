const puppeteer = require('puppeteer');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
const { createServer } = require('http-server');

// Arguments
const args = process.argv.slice(2);
// Logic: if args[0] is a zip that contains config and media, use it.
// Otherwise treat args[0] as media.zip and args[1] as config.
let packageZipPath = args[0];
let mediaZipPath = args[1] || 'media.zip';
let configPath = args[2] || 'workflow_config.json';
let outputDir = args[3] || 'output';

// Adjust mapping if the first argument is clearly the package zip (or fallback to old behavior)
// But wait, in workflow yml we pass: package_zip media_zip config_file output
// So we have 4 arguments now.
packageZipPath = args[0];
mediaZipPath = args[1];
configPath = args[2];
outputDir = args[3];

// Environment Variables
const API_KEY = process.env.API_KEY;

(async () => {
    try {
        console.log('Starting AutoTag Workflow...');

        // Check if package zip exists and use it to extract media and config
        if (packageZipPath && fs.existsSync(packageZipPath)) {
            console.log(`Found package zip: ${packageZipPath}, extracting...`);
            const packageData = fs.readFileSync(packageZipPath);
            const packageZip = await JSZip.loadAsync(packageData);
            
            // Extract workflow_config.json
            if (packageZip.file("workflow_config.json")) {
                const configContent = await packageZip.file("workflow_config.json").async("nodebuffer");
                configPath = "extracted_workflow_config.json";
                fs.writeFileSync(configPath, configContent);
                console.log('Extracted workflow_config.json');
            }
            
            // Extract media.zip
            if (packageZip.file("media.zip")) {
                const mediaContent = await packageZip.file("media.zip").async("nodebuffer");
                mediaZipPath = "extracted_media.zip";
                fs.writeFileSync(mediaZipPath, mediaContent);
                console.log('Extracted media.zip');
            }
        }

        if (!fs.existsSync(mediaZipPath)) {
            console.error(`Media zip not found: ${mediaZipPath}`);
            process.exit(1);
        }
        if (!fs.existsSync(configPath)) {
            console.error(`Config file not found: ${configPath}`);
            process.exit(1);
        }

        // 1. Prepare Import Zip
        console.log('Preparing task package...');
        const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const mediaZipData = fs.readFileSync(mediaZipPath);
    
    const taskZip = new JSZip();
    
    // Construct task_config.json expected by TaskManager
    const taskConfig = {
        timestamp: Date.now(),
        mode: userConfig.mode || 'image', // 'image' or 'video'
        model: userConfig.model || 'gemini-3-flash',
        prompt: userConfig.prompt || '',
        scaleFactor: userConfig.scaleFactor || '4',
        apiRpm: userConfig.apiRpm || '60',
        parallelCount: userConfig.parallelCount || '3',
        results: [] // Empty results for new task
    };
    
    taskZip.file("task_config.json", JSON.stringify(taskConfig));
    
    // Unzip media files and add to "files/" folder
    const inputZip = await JSZip.loadAsync(mediaZipData);
    const filesFolder = taskZip.folder("files");
    
    let fileCount = 0;
    inputZip.forEach((relativePath, file) => {
        if (!file.dir && !relativePath.startsWith('__MACOSX') && !relativePath.includes('.DS_Store')) {
            filesFolder.file(path.basename(relativePath), file.async("nodebuffer"));
            fileCount++;
        }
    });
    
    console.log(`Packed ${fileCount} files into task package.`);
    
    const importZipBuffer = await taskZip.generateAsync({ type: 'nodebuffer' });
    const importZipPath = path.resolve('temp_import_task.zip');
    fs.writeFileSync(importZipPath, importZipBuffer);

    // 2. Start Local Server
    const server = createServer({ root: '.' });
    server.listen(8080);
    console.log('Server started on port 8080');

    // 3. Launch Puppeteer
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    
    // Allow downloads
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: path.resolve(outputDir)
    });

    // Handle Dialogs (Confirmations)
    page.on('dialog', async dialog => {
        console.log(`Dialog message: ${dialog.message()}`);
        await dialog.accept(); // Always accept "Resume" or "Stop" dialogs
    });

    // Console logs forwarding
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    try {
        await page.goto('http://localhost:8080/index.html');
        
        // Determine API Key based on model
        let apiKey = API_KEY; // Default from env.API_KEY (Workflow Input)
        
        let allSecrets = {};
        if (process.env.ALL_SECRETS) {
            try {
                allSecrets = JSON.parse(process.env.ALL_SECRETS);
            } catch (e) {
                console.error("Failed to parse ALL_SECRETS", e);
            }
        }

        // Fallback: If no input key provided, try to load default GEMINI_API_KEY from secrets
        if (!apiKey && allSecrets.GEMINI_API_KEY) {
            apiKey = allSecrets.GEMINI_API_KEY;
        }
        
        // Try to find a specific key for the model
        // Sanitize model name to be env-var friendly (uppercase, replace non-alphanum with _)
        // e.g. 'gemini-3-flash（X666）' -> 'GEMINI_3_FLASH_X666_'
        if (taskConfig.model) {
            const sanitizedModel = taskConfig.model.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
            const keyName = sanitizedModel + '_KEY';
            
            // 1. Check for specific env vars (if explicitly passed in workflow)
            let specificKey = process.env[sanitizedModel] || process.env[keyName];
            
            // 2. If not found, look up in ALL_SECRETS json
            if (!specificKey) {
                // Try exact match or with _KEY suffix
                specificKey = allSecrets[keyName] || allSecrets[sanitizedModel];
                if (specificKey) {
                    console.log(`Found specific API Key in ALL_SECRETS for model ${taskConfig.model} (Key: ${keyName})`);
                }
            }

            if (specificKey) {
                console.log(`Using specific API Key for model ${taskConfig.model}`);
                apiKey = specificKey;
            }
        }

        // Inject API Key if provided
        if (apiKey) {
            console.log('Injecting API Key...');
            await page.evaluate((key, model) => {
                if (window.CONFIGS && window.CONFIGS[model]) {
                    window.CONFIGS[model].key = key;
                }
            }, apiKey, taskConfig.model);
        }

        // Upload Zip to trigger import
        console.log('Uploading task package...');
        const fileInput = await page.$('#importTaskInput');
        await fileInput.uploadFile(importZipPath);
        
        // Wait for processing to start and finish
        // importTask will trigger a confirm dialog -> accept -> startAnalysis
        // startAnalysis sets state.isProcessing = true
        
        console.log('Waiting for analysis to complete...');
        
        // Wait until isProcessing becomes true (started)
        await page.waitForFunction(() => window.state && window.state.isProcessing === true, { timeout: 10000 })
            .catch(() => console.log('Warning: Timeout waiting for isProcessing=true. Task might have finished very quickly or failed to start.'));
            
        // Wait until isProcessing becomes false (finished)
        // Set a long timeout (e.g., 30 mins)
        await page.waitForFunction(() => window.state && window.state.isProcessing === false, { timeout: 1800000 });
        
        console.log('Analysis completed!');

        // 4. Export Results based on format
        const exportFormatRaw = userConfig.exportFormat || 'yolo'; 
        console.log(`Exporting results in format(s): ${exportFormatRaw}`);
        
        // Support multiple formats comma separated
        const formats = exportFormatRaw.split(',').map(s => s.trim());

        // Trigger export function
        await page.evaluate(async (fmts) => {
            for (const fmt of fmts) {
                // Image Mode Options
                if (fmt === 'original') {
                    // Handled by node script, skipped here
                } else if (fmt === 'tagged') {
                    if (!window.state.isVideoMode) await window.exportBatchTaggedImages();
                } else if (fmt === 'crop') {
                    if (!window.state.isVideoMode) await window.exportAllCroppedImages();
                } else if (fmt === 'transparent') {
                    if (!window.state.isVideoMode) await window.exportAllTransparentImages();
                } else if (fmt === 'yolo_txt') {
                    // YOLO txt only
                    if (window.state.isVideoMode) {
                        // For video, we use exportBatchVideoFrames but only for labels
                        await window.exportBatchVideoFrames({ includeImages: false, includeLabels: true, includeClasses: false });
                    } else {
                        // For image, we use exportBatchImageLabels but only for labels (it does this by default mostly, but we ensure no extra stuff if any)
                        await window.exportBatchImageLabels({ includeClasses: false });
                    }
                } else if (fmt === 'classes') {
                    // Export just classes.txt
                    // We can reuse existing function with a flag
                    if (window.state.isVideoMode) {
                        await window.exportBatchVideoFrames({ includeImages: false, includeLabels: false, includeClasses: true });
                    } else {
                        await window.exportBatchImageLabels({ onlyClasses: true, includeClasses: true });
                    }
                } 
                
                // Video Mode Options
                else if (fmt === 'tracked_video') {
                    if (window.state.isVideoMode) await window.exportAllTaggedVideos();
                } else if (fmt === 'frames') {
                    if (window.state.isVideoMode) {
                        await window.exportBatchVideoFrames({ includeImages: true, includeLabels: false, includeClasses: false });
                    }
                } 
                
                // Legacy / Combined Options
                else if (fmt === 'yolo') {
                    // Full YOLO package (images + txt + classes)
                    if (window.state.isVideoMode) {
                        await window.exportBatchVideoFrames();
                    } else {
                        await window.exportBatchImageLabels();
                    }
                } else if (fmt === 'video') {
                    if (window.state.isVideoMode) await window.exportAllTaggedVideos();
                } else {
                    console.error("Unknown or inapplicable export format: " + fmt);
                }
                
                // Small delay between exports
                await new Promise(r => setTimeout(r, 1000));
            }
        }, formats);

        // Handle 'original' files copy if requested
        if (formats.includes('original')) {
            console.log('Copying original files...');
            const filesDir = path.resolve('files'); // The extracted files directory
            if (fs.existsSync(filesDir)) {
                const allFiles = fs.readdirSync(filesDir);
                for (const file of allFiles) {
                    fs.copyFileSync(path.join(filesDir, file), path.join(outputDir, file));
                }
            }
        }

        // Wait for file to appear in outputDir
        console.log('Waiting for download(s)...');
        // Simple polling for at least one file, but we might want to wait for all?
        // It's hard to know exactly how many files, but at least we wait for something.
        // We extend the wait time slightly to allow multiple downloads.
        for (let i = 0; i < 120; i++) {
            const files = fs.readdirSync(outputDir);
            // Check if we have enough files? Or just any file.
            // Since downloads are sequential, if we see one, it means at least the first one started.
            // But we want to ensure all are done. 
            // We can check if any .crdownload exists.
            const hasCrdownload = files.some(f => f.endsWith('.crdownload'));
            // Calculate expected file count (roughly)
            // 'original' doesn't trigger download, it's direct copy.
            const downloadTriggerFormats = formats.filter(f => f !== 'original');
            
            if (files.length >= downloadTriggerFormats.length && !hasCrdownload) {
                console.log(`All downloads seemingly complete. Files: ${files.join(', ')}`);
                break;
            }
            if (files.length > 0 && !hasCrdownload && i > 60) {
                 // Fallback: if we have some files and enough time passed
                 console.log(`Downloads seemingly complete (timeout fallback). Files: ${files.join(', ')}`);
                 break;
            }
            await new Promise(r => setTimeout(r, 1000));
        }

    } catch (err) {
        console.error('Error during execution:', err);
        process.exit(1);
    } finally {
        await browser.close();
        server.close();
        // Cleanup temp file
        if (fs.existsSync(importZipPath)) fs.unlinkSync(importZipPath);
    }
})();
