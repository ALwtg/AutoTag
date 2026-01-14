const puppeteer = require('puppeteer');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
const { createServer } = require('http-server');

// Arguments 处理
const args = process.argv.slice(2);
let packageZipPath = (args[0] && args[0] !== "") ? args[0] : 'autotag_package.zip';
let mediaZipPath = (args[1] && args[1] !== "") ? args[1] : 'media.zip';
let configPath = (args[2] && args[2] !== "") ? args[2] : 'workflow_config.json';
let outputDir = (args[3] && args[3] !== "") ? args[3] : 'output';

// Environment Variables
const API_KEY = process.env.API_KEY;

(async () => {
    let server;
    let browser;
    const tempFilesDir = path.resolve('temp_extracted_media');

    try {
        console.log('--- Configuration ---');
        console.log(`Package Zip: ${packageZipPath}`);
        console.log(`Media Zip: ${mediaZipPath}`);
        console.log(`Config Path: ${configPath}`);
        console.log(`Output Dir: ${outputDir}`);
        console.log('---------------------');

        // 1. 如果存在 packageZipPath，从中提取 media.zip 和 config
        if (fs.existsSync(packageZipPath)) {
            console.log(`Found package zip: ${packageZipPath}, extracting...`);
            const packageData = fs.readFileSync(packageZipPath);
            const packageZip = await JSZip.loadAsync(packageData);
            
            if (packageZip.file("workflow_config.json")) {
                const configContent = await packageZip.file("workflow_config.json").async("nodebuffer");
                configPath = "extracted_workflow_config.json";
                fs.writeFileSync(configPath, configContent);
                console.log('Extracted workflow_config.json from package');
            }
            
            if (packageZip.file("media.zip")) {
                const mediaContent = await packageZip.file("media.zip").async("nodebuffer");
                mediaZipPath = "extracted_media.zip";
                fs.writeFileSync(mediaZipPath, mediaContent);
                console.log('Extracted media.zip from package');
            }
        }

        // 检查最终需要的文件是否存在
        if (!fs.existsSync(mediaZipPath)) {
            console.error(`Error: Media zip not found at ${mediaZipPath}`);
            console.log('Current directory files:', fs.readdirSync('.'));
            process.exit(1);
        }
        if (!fs.existsSync(configPath)) {
            console.error(`Error: Config file not found at ${configPath}`);
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
        
        const inputZip = await JSZip.loadAsync(mediaZipData);
        const filesFolderInZip = taskZip.folder("files");
        if (!fs.existsSync(tempFilesDir)) fs.mkdirSync(tempFilesDir, { recursive: true });

        let fileCount = 0;
        for (const [relativePath, file] of Object.entries(inputZip.files)) {
            if (!file.dir && !relativePath.startsWith('__MACOSX') && !relativePath.includes('.DS_Store')) {
                const buffer = await file.async("nodebuffer");
                const fileName = path.basename(relativePath);
                filesFolderInZip.file(fileName, buffer);
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
            console.log(`Dialog: ${dialog.message()}`);
            await dialog.accept();
        });

        page.on('console', msg => console.log('PAGE:', msg.text()));

        await page.goto('http://localhost:8080/index.html');
        
        // API Key Logic
        let apiKey = API_KEY;
        let allSecrets = {};
        if (process.env.ALL_SECRETS) {
            try { allSecrets = JSON.parse(process.env.ALL_SECRETS); } catch (e) {}
        }
        
        // --- 修改后的 API Key 匹配逻辑 ---
        if (taskConfig.model) {
            const sanitizedModel = taskConfig.model.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
            const keyName = sanitizedModel + '_KEY';
            
            // 定义不区分大小写的查找函数
            const findKeyIgnoreCase = (envObj, key) => {
                const upperKey = key.toUpperCase();
                for (const envKey in envObj) {
                    if (envKey.toUpperCase() === upperKey) {
                        return envObj[envKey];
                    }
                }
                return null;
            };

            const specificKey = findKeyIgnoreCase(process.env, sanitizedModel) || 
                               findKeyIgnoreCase(process.env, keyName) || 
                               findKeyIgnoreCase(allSecrets, keyName) || 
                               findKeyIgnoreCase(allSecrets, sanitizedModel);
            
            if (specificKey) {
                apiKey = specificKey;
            } else if (!apiKey && allSecrets.GEMINI_API_KEY) {
                // 如果没找到模型特定的Key，退而求其次寻找通用的 GEMINI_API_KEY
                apiKey = allSecrets.GEMINI_API_KEY;
            }
        }

        if (apiKey) {
            await page.evaluate((key, model) => {
                if (window.CONFIGS && window.CONFIGS[model]) {
                    window.CONFIGS[model].key = key;
                }
            }, apiKey, taskConfig.model);
        }

        // Upload and process
        const fileInput = await page.$('#importTaskInput');
        await fileInput.uploadFile(importZipPath);
        
        console.log('Waiting for analysis...');
        await page.waitForFunction(() => window.state && window.state.isProcessing === true, { timeout: 30000 }).catch(() => {});
        await page.waitForFunction(() => window.state && window.state.isProcessing === false, { timeout: 1800000 });
        console.log('Analysis completed!');

        // 5. Export
        const formats = (userConfig.exportFormat || 'yolo').split(',').map(s => s.trim());
        await page.evaluate(async (fmts) => {
            for (const fmt of fmts) {
                if (fmt === 'original') continue;
                if (fmt === 'tagged') { if (!window.state.isVideoMode) await window.exportBatchTaggedImages(); }
                else if (fmt === 'crop') { if (!window.state.isVideoMode) await window.exportAllCroppedImages(); }
                else if (fmt === 'transparent') { if (!window.state.isVideoMode) await window.exportAllTransparentImages(); }
                else if (fmt === 'yolo_txt') {
                    if (window.state.isVideoMode) await window.exportBatchVideoFrames({ includeImages: false, includeLabels: true, includeClasses: false });
                    else await window.exportBatchImageLabels({ includeClasses: false });
                } else if (fmt === 'classes') {
                    if (window.state.isVideoMode) await window.exportBatchVideoFrames({ includeImages: false, includeLabels: false, includeClasses: true });
                    else await window.exportBatchImageLabels({ onlyClasses: true, includeClasses: true });
                } else if (fmt === 'yolo') {
                    if (window.state.isVideoMode) await window.exportBatchVideoFrames();
                    else await window.exportBatchImageLabels();
                } else if (fmt === 'tracked_video' || fmt === 'video') {
                    if (window.state.isVideoMode) await window.exportAllTaggedVideos();
                }
                await new Promise(r => setTimeout(r, 2000));
            }
        }, formats);

        if (formats.includes('original')) {
            const files = fs.readdirSync(tempFilesDir);
            for (const file of files) fs.copyFileSync(path.join(tempFilesDir, file), path.join(outputDir, file));
        }

        // Wait for downloads
        for (let i = 0; i < 60; i++) {
            const files = fs.readdirSync(outputDir);
            if (files.length > 0 && !files.some(f => f.endsWith('.crdownload'))) break;
            await new Promise(r => setTimeout(r, 1000));
        }

    } catch (err) {
        console.error('Execution Error:', err);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
        if (server) server.close();
        if (fs.existsSync('temp_import_task.zip')) fs.unlinkSync('temp_import_task.zip');
        if (fs.existsSync(tempFilesDir)) fs.rmSync(tempFilesDir, { recursive: true, force: true });
        console.log('Done.');
    }
})();
