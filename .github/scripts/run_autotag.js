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
    let server = null;
    let browser = null;
    const tempFilesDir = path.resolve('temp_extracted_media');

    try {
        console.log('--- Configuration ---');
        console.log(`Package Zip: ${packageZipPath}`);
        console.log(`Media Zip: ${mediaZipPath}`);
        console.log(`Config Path: ${configPath}`);
        console.log(`Output Dir: ${outputDir}`);
        console.log('---------------------');

        // 1. 提取包文件 (如果用户上传的是一个整合包)
        if (fs.existsSync(packageZipPath)) {
            const packageData = fs.readFileSync(packageZipPath);
            const packageZip = await JSZip.loadAsync(packageData);
            if (packageZip.file("workflow_config.json")) {
                const configContent = await packageZip.file("workflow_config.json").async("nodebuffer");
                configPath = "extracted_workflow_config.json";
                fs.writeFileSync(configPath, configContent);
            }
            if (packageZip.file("media.zip")) {
                const mediaContent = await packageZip.file("media.zip").async("nodebuffer");
                mediaZipPath = "extracted_media.zip";
                fs.writeFileSync(mediaZipPath, mediaContent);
            }
        }

        if (!fs.existsSync(mediaZipPath) || !fs.existsSync(configPath)) {
            console.error(`Error: Required files missing (media.zip or workflow_config.json).`);
            process.exit(1);
        }

        // 2. 准备任务包 (注入到浏览器执行)
        console.log('Preparing task package...');
        const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const mediaZipData = fs.readFileSync(mediaZipPath);
        const taskZip = new JSZip();
        
        // 注意：这里的 model 存储的是映射名/键名，如 'gemini_3_flash_X666_'
        const taskConfig = {
            timestamp: Date.now(),
            mode: userConfig.mode || 'image',
            model: userConfig.model || 'gemini_3_flash', // 这里的 model 对应 CONFIGS 的 key
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
        
        console.log(`Packed ${fileCount} files.`);
        const importZipBuffer = await taskZip.generateAsync({ type: 'nodebuffer' });
        const importZipPath = path.resolve('temp_import_task.zip');
        fs.writeFileSync(importZipPath, importZipBuffer);

        // 3. 启动本地静态服务器
        server = createServer({ root: '.' });
        server.listen(8080);

        // 4. 启动 headless 浏览器
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        
        // 允许 Puppeteer 自动下载文件到 output 文件夹
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: path.resolve(outputDir) });

        page.on('dialog', async dialog => await dialog.accept());
        page.on('console', msg => {
            const text = msg.text();
            console.log('PAGE LOG:', text);
            if (text.includes('401')) console.error('CRITICAL: API Key rejected (401 Unauthorized)');
        });

        await page.goto('http://localhost:8080/index.html');
        // 确保页面上的 CONFIGS 已加载
        await page.waitForFunction(() => window.CONFIGS !== undefined, { timeout: 15000 });

        // --- 核心：API Key 自动匹配与注入逻辑 ---
        let apiKey = API_KEY; 
        let allSecrets = {};
        if (process.env.ALL_SECRETS) {
            try { allSecrets = JSON.parse(process.env.ALL_SECRETS); } catch (e) {}
        }

        // 规则：将模型名转为大写，替换非法字符，用于在 Secret 寻找。
        // 如 "gemini_3_flash_X666_" -> "GEMINI_3_FLASH_X666_"
        const modelNameFromConfig = taskConfig.model;
        const envSafeModelName = modelNameFromConfig.replace(/[^a-zA-Z0-9_]/g, '').toUpperCase();
        
        const findKey = (envObj, keyName) => {
            if (!envObj) return null;
            const upperTarget = keyName.toUpperCase();
            // 同时尝试 原始名大写 和 原始名大写_KEY
            return envObj[upperTarget] || envObj[upperTarget + '_KEY'];
        };

        // 匹配顺序：环境变量 -> Secrets JSON -> 通用 API_KEY
        let matchedKey = findKey(process.env, envSafeModelName) || 
                         findKey(allSecrets, envSafeModelName);
        
        if (matchedKey) {
            apiKey = matchedKey;
            console.log(`Matching key found for model "${modelNameFromConfig}": ${apiKey.substring(0, 6)}...`);
        } else if (!apiKey && (process.env.GEMINI_API_KEY || allSecrets.GEMINI_API_KEY)) {
            apiKey = process.env.GEMINI_API_KEY || allSecrets.GEMINI_API_KEY;
            console.log(`Using fallback GEMINI_API_KEY`);
        }

        if (apiKey) {
            await page.evaluate((key, modelName) => {
                // modelName 是 config.js 里的键名，如 'gemini_3_flash_X666_'
                if (window.CONFIGS && window.CONFIGS[modelName]) {
                    window.CONFIGS[modelName].key = key;
                    console.log(`API Key successfully injected into configurations for: ${modelName}`);
                } else {
                    // 如果键名没匹配上，尝试模糊匹配 gemini 关键字
                    console.warn(`Target model name "${modelName}" not found in CONFIGS keys. Attempting fuzzy match...`);
                    for (let k in window.CONFIGS) {
                        if (k.toLowerCase().includes('gemini')) {
                            window.CONFIGS[k].key = key;
                        }
                    }
                }
            }, apiKey, modelNameFromConfig);
        } else {
            console.warn('WARNING: No specific API Key found for this model. Analysis might fail.');
        }

        // --- 开始任务 ---
        // 模拟用户点击“导入任务包”按钮并分析
        const fileInput = await page.$('#importTaskInput');
        await fileInput.uploadFile(importZipPath);
        
        console.log('Upload complete. Waiting for analysis to start...');
        
        // 等待分析开始 (isProcessing 变为 true)
        await page.waitForFunction(() => window.state && window.state.isProcessing === true, { timeout: 60000 }).catch(() => {
            console.log('Timeout waiting for start. Checking if results already exist.');
        });
        
        console.log('Processing in progress... This may take a while.');
        
        // 等待分析结束 (isProcessing 变为 false)，设定最大超时时间 30 分钟
        await page.waitForFunction(() => window.state && window.state.isProcessing === false, { timeout: 1800000 });
        
        const hasResults = await page.evaluate(() => {
            const results = window.state.isVideoMode ? window.state.videoResults : window.state.imageResults;
            return results && results.length > 0;
        });

        if (!hasResults) {
            console.error('Analysis failed: No results produced. Check logs for API errors.');
        } else {
            console.log('Analysis finished. Starting export sequence...');
        }

        // 5. 按照 workflow_config.json 中指定的格式导出结果
        const formats = (userConfig.exportFormat || 'yolo').split(',').map(s => s.trim());
        
        await page.evaluate(async (fmts) => {
            for (const fmt of fmts) {
                console.log(`Exporting format: ${fmt}`);
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
                // 每个导出动作间隔一下，避免冲突
                await new Promise(r => setTimeout(r, 3000));
            }
        }, formats);

        // 如果包含 original 格式，手动拷贝原始文件
        if (formats.includes('original')) {
            const files = fs.readdirSync(tempFilesDir);
            for (const file of files) fs.copyFileSync(path.join(tempFilesDir, file), path.join(outputDir, file));
        }

        // 等待下载完成 (检查 output 目录下是否有文件，且没有临时下载后缀)
        console.log('Finalizing downloads...');
        for (let i = 0; i < 60; i++) {
            const files = fs.readdirSync(outputDir);
            if (files.length > 0 && !files.some(f => f.endsWith('.crdownload'))) break;
            await new Promise(r => setTimeout(r, 2000));
        }

    } catch (err) {
        console.error('CRITICAL EXECUTION ERROR:', err);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
        if (server) server.close();
        
        // 清理临时文件
        if (fs.existsSync('temp_import_task.zip')) fs.unlinkSync('temp_import_task.zip');
        if (fs.existsSync(tempFilesDir)) fs.rmSync(tempFilesDir, { recursive: true, force: true });
        if (fs.existsSync('extracted_workflow_config.json')) fs.unlinkSync('extracted_workflow_config.json');
        if (fs.existsSync('extracted_media.zip')) fs.unlinkSync('extracted_media.zip');
        
        console.log('Process finished.');
    }
})();
