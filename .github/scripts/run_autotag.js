const puppeteer = require('puppeteer');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
const { createServer } = require('http-server');

// Arguments
const args = process.argv.slice(2);
// 默认参数处理
let packageZipPath = args[0];
let mediaZipPath = args[1] || 'media.zip';
let configPath = args[2] || 'workflow_config.json';
let outputDir = args[3] || 'output';

// Environment Variables
const API_KEY = process.env.API_KEY;

(async () => {
    let server;
    let browser;
    const tempFilesDir = path.resolve('temp_extracted_media'); // 用于存放临时解压的文件

    try {
        console.log('Starting AutoTag Workflow...');

        // 1. Check if package zip exists and use it to extract media and config
        if (packageZipPath && fs.existsSync(packageZipPath)) {
            console.log(`Found package zip: ${packageZipPath}, extracting...`);
            const packageData = fs.readFileSync(packageZipPath);
            const packageZip = await JSZip.loadAsync(packageData);
            
            if (packageZip.file("workflow_config.json")) {
                const configContent = await packageZip.file("workflow_config.json").async("nodebuffer");
                configPath = "extracted_workflow_config.json";
                fs.writeFileSync(configPath, configContent);
                console.log('Extracted workflow_config.json');
            }
            
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

        // 2. Prepare Task Package
        console.log('Preparing task package...');
        const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const mediaZipData = fs.readFileSync(mediaZipPath);
        const taskZip = new JSZip();
        
        const taskConfig = {
            timestamp: Date.now(),
            mode: userConfig.mode || 'image',
            model: userConfig.model || 'gemini-1.5-flash',
            prompt: userConfig.prompt || '',
            scaleFactor: userConfig.scaleFactor || '4',
            apiRpm: userConfig.apiRpm || '60',
            parallelCount: userConfig.parallelCount || '3',
            results: []
        };
        
        taskZip.file("task_config.json", JSON.stringify(taskConfig));
        
        // Unzip media files and add to "files/" folder in taskZip
        const inputZip = await JSZip.loadAsync(mediaZipData);
        const filesFolderInZip = taskZip.folder("files");
        
        if (!fs.existsSync(tempFilesDir)) fs.mkdirSync(tempFilesDir, { recursive: true });

        let fileCount = 0;
        // 使用 for...of 处理异步提取，确保文件被写入磁盘以便后续 "original" 复制
        for (const [relativePath, file] of Object.entries(inputZip.files)) {
            if (!file.dir && !relativePath.startsWith('__MACOSX') && !relativePath.includes('.DS_Store')) {
                const buffer = await file.async("nodebuffer");
                const fileName = path.basename(relativePath);
                
                // 放入任务压缩包
                filesFolderInZip.file(fileName, buffer);
                // 写入临时目录（用于最后的 original 拷贝）
                fs.writeFileSync(path.join(tempFilesDir, fileName), buffer);
                
                fileCount++;
            }
        }
        
        console.log(`Packed ${fileCount} files into task package.`);
        const importZipBuffer = await taskZip.generateAsync({ type: 'nodebuffer' });
        const importZipPath = path.resolve('temp_import_task.zip');
        fs.writeFileSync(importZipPath, importZipBuffer);

        // 3. Start Local Server
        server = createServer({ root: '.' });
        server.listen(8080);
        console.log('Server started on port 8080');

        // 4. Launch Puppeteer
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: path.resolve(outputDir)
        });

        page.on('dialog', async dialog => {
            console.log(`Dialog message: ${dialog.message()}`);
            await dialog.accept();
        });

        page.on('console', msg => console.log('PAGE LOG:', msg.text()));

        await page.goto('http://localhost:8080/index.html');
        
        // Handle API Keys logic
        let apiKey = API_KEY;
        let allSecrets = {};
        if (process.env.ALL_SECRETS) {
            try {
                allSecrets = JSON.parse(process.env.ALL_SECRETS);
            } catch (e) {
                console.error("Failed to parse ALL_SECRETS", e);
            }
        }
        if (!apiKey && allSecrets.GEMINI_API_KEY) apiKey = allSecrets.GEMINI_API_KEY;
        
        if (taskConfig.model) {
            const sanitizedModel = taskConfig.model.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
            const keyName = sanitizedModel + '_KEY';
            let specificKey = process.env[sanitizedModel] || process.env[keyName] || allSecrets[keyName] || allSecrets[sanitizedModel];
            if (specificKey) {
                console.log(`Using specific API Key for model ${taskConfig.model}`);
                apiKey = specificKey;
            }
        }

        if (apiKey) {
            console.log('Injecting API Key...');
            await page.evaluate((key, model) => {
                if (window.CONFIGS && window.CONFIGS[model]) {
                    window.CONFIGS[model].key = key;
                }
            }, apiKey, taskConfig.model);
        }

        console.log('Uploading task package...');
        const fileInput = await page.$('#importTaskInput');
        await fileInput.uploadFile(importZipPath);
        
        console.log('Waiting for analysis to complete...');
        await page.waitForFunction(() => window.state && window.state.isProcessing === true, { timeout: 30000 })
            .catch(() => console.log('Waiting for processing to start...'));
            
        // Wait until finished (max 30 mins)
        await page.waitForFunction(() => window.state && window.state.isProcessing === false, { timeout: 1800000 });
        console.log('Analysis completed!');

        // 5. Export Results
        const exportFormatRaw = userConfig.exportFormat || 'yolo'; 
        const formats = exportFormatRaw.split(',').map(s => s.trim());

        await page.evaluate(async (fmts) => {
            for (const fmt of fmts) {
                if (fmt === 'original') continue; // Handled by node
                
                if (fmt === 'tagged') {
                    if (!window.state.isVideoMode) await window.exportBatchTaggedImages();
                } else if (fmt === 'crop') {
                    if (!window.state.isVideoMode) await window.exportAllCroppedImages();
                } else if (fmt === 'transparent') {
                    if (!window.state.isVideoMode) await window.exportAllTransparentImages();
                } else if (fmt === 'yolo_txt') {
                    if (window.state.isVideoMode) {
                        await window.exportBatchVideoFrames({ includeImages: false, includeLabels: true, includeClasses: false });
                    } else {
                        await window.exportBatchImageLabels({ includeClasses: false });
                    }
                } else if (fmt === 'classes') {
                    if (window.state.isVideoMode) {
                        await window.exportBatchVideoFrames({ includeImages: false, includeLabels: false, includeClasses: true });
                    } else {
                        await window.exportBatchImageLabels({ onlyClasses: true, includeClasses: true });
                    }
                } else if (fmt === 'tracked_video' || fmt === 'video') {
                    if (window.state.isVideoMode) await window.exportAllTaggedVideos();
                } else if (fmt === 'frames') {
                    if (window.state.isVideoMode) {
                        await window.exportBatchVideoFrames({ includeImages: true, includeLabels: false, includeClasses: false });
                    }
                } else if (fmt === 'yolo') {
                    if (window.state.isVideoMode) {
                        await window.exportBatchVideoFrames();
                    } else {
                        await window.exportBatchImageLabels();
                    }
                }
                await new Promise(r => setTimeout(r, 2000));
            }
        }, formats);

        // Copy original files if requested
        if (formats.includes('original')) {
            console.log('Copying original files...');
            if (fs.existsSync(tempFilesDir)) {
                const files = fs.readdirSync(tempFilesDir);
                for (const file of files) {
                    fs.copyFileSync(path.join(tempFilesDir, file), path.join(outputDir, file));
                }
            }
        }

        console.log('Waiting for downloads to sink...');
        for (let i = 0; i < 120; i++) {
            const files = fs.readdirSync(outputDir);
            const hasCrdownload = files.some(f => f.endsWith('.crdownload'));
            const downloadTriggerFormats = formats.filter(f => f !== 'original');
            
            if (files.length >= downloadTriggerFormats.length && !hasCrdownload && files.length > 0) {
                console.log(`Downloads complete. Files: ${files.length}`);
                break;
            }
            await new Promise(r => setTimeout(r, 1000));
        }

    } catch (err) {
        console.error('Error during execution:', err);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
        if (server) server.close();
        
        // Cleanup temp files
        const tempImportPath = path.resolve('temp_import_task.zip');
        if (fs.existsSync(tempImportPath)) fs.unlinkSync(tempImportPath);
        if (fs.existsSync(tempFilesDir)) {
            fs.rmSync(tempFilesDir, { recursive: true, force: true });
        }
        console.log('Workflow finished.');
    }
})();
