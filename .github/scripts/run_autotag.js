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

const API_KEY = process.env.API_KEY;

(async () => {
    let server = null;
    let browser = null;
    let page = null; // 提升作用域
    const tempFilesDir = path.resolve('temp_extracted_media');
    const rootDir = process.cwd();

    try {
        console.log('--- Environment Check ---');
        console.log('Working Directory:', rootDir);
        ['index.html', 'config.js', 'main.js', 'task_manager.js'].forEach(file => {
            console.log(`File ${file} exists: ${fs.existsSync(path.join(rootDir, file))}`);
        });

        // 1. 提取包逻辑 (保持不变)
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
            throw new Error(`Required files missing (media.zip or workflow_config.json).`);
        }

        // 2. 准备任务包 (保持不变)
        const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const taskConfig = {
            timestamp: Date.now(),
            mode: userConfig.mode || 'image',
            model: userConfig.model || 'gemini_3_flash',
            prompt: userConfig.prompt || '',
            scaleFactor: userConfig.scaleFactor || '4',
            apiRpm: userConfig.apiRpm || '60',
            parallelCount: userConfig.parallelCount || '3',
            results: []
        };
        
        const taskZip = new JSZip();
        taskZip.file("task_config.json", JSON.stringify(taskConfig));
        const mediaZipData = fs.readFileSync(mediaZipPath);
        const inputZip = await JSZip.loadAsync(mediaZipData);
        if (!fs.existsSync(tempFilesDir)) fs.mkdirSync(tempFilesDir, { recursive: true });

        const filesFolderInZip = taskZip.folder("files");
        for (const [relativePath, file] of Object.entries(inputZip.files)) {
            if (!file.dir && !relativePath.startsWith('__MACOSX') && !relativePath.includes('.DS_Store')) {
                const buffer = await file.async("nodebuffer");
                filesFolderInZip.file(path.basename(relativePath), buffer);
                fs.writeFileSync(path.join(tempFilesDir, path.basename(relativePath)), buffer);
            }
        }
        
        const importZipBuffer = await taskZip.generateAsync({ type: 'nodebuffer' });
        const importZipPath = path.resolve('temp_import_task.zip');
        fs.writeFileSync(importZipPath, importZipBuffer);

        // 3. 启动服务器
        server = createServer({ root: rootDir, cache: -1 }); 
        server.listen(8080, '127.0.0.1');
        console.log('Server started on http://127.0.0.1:8080');

        // 4. 启动浏览器
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
        });
        page = await browser.newPage();
        
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: path.resolve(outputDir) });

        // 监听错误
        page.on('pageerror', err => console.error('PAGE JS ERROR:', err.message));
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        page.on('requestfailed', request => console.error(`PAGE REQUEST FAILED: ${request.url()} - ${request.failure()?.errorText}`));

        console.log('Navigating to platform...');
        await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'networkidle2', timeout: 60000 });

        // 重要修复：检测 CONFIGS 而不是 window.CONFIGS
        console.log('Checking for CONFIGS object...');
        await page.waitForFunction(() => typeof CONFIGS !== 'undefined', { timeout: 30000 });
        console.log('CONFIGS detected.');

        // 5. API Key 注入 (逻辑修正)
        let apiKey = API_KEY; 
        let allSecrets = {};
        if (process.env.ALL_SECRETS) {
            try { allSecrets = JSON.parse(process.env.ALL_SECRETS); } catch (e) {}
        }
        const modelName = taskConfig.model; // 这是 Key，如 'gemini_3_flash_X666_'
        const envSafeName = modelName.replace(/[^a-zA-Z0-9_]/g, '').toUpperCase();
        
        const findKey = (obj, name) => {
            if (!obj) return null;
            return obj[name.toUpperCase()] || obj[name.toUpperCase() + '_KEY'];
        };

        const matchedKey = findKey(process.env, envSafeName) || findKey(allSecrets, envSafeName);
        if (matchedKey) apiKey = matchedKey;

        if (apiKey) {
            await page.evaluate((key, mName) => {
                // 直接访问 CONFIGS 变量
                if (typeof CONFIGS !== 'undefined' && CONFIGS[mName]) {
                    CONFIGS[mName].key = key;
                    console.log(`Injected key into CONFIGS["${mName}"]`);
                } else {
                    console.log(`Model key "${mName}" not found in CONFIGS, fallback to fuzzy match`);
                    for (let k in CONFIGS) {
                        if (k.toLowerCase().includes('gemini')) CONFIGS[k].key = key;
                    }
                }
            }, apiKey, modelName);
        }

        // 6. 执行分析任务
        console.log('Importing task zip...');
        const fileInput = await page.$('#importTaskInput');
        await fileInput.uploadFile(importZipPath);
        
        // 等待 state 对象
        await page.waitForFunction(() => typeof state !== 'undefined', { timeout: 10000 });

        console.log('Waiting for analysis to start...');
        await page.waitForFunction(() => state.isProcessing === true, { timeout: 90000 });
        
        console.log('Processing... (This might take a long time)');
        // 增加心跳打印，防止 GitHub Actions 认为任务卡死
        const checkInterval = setInterval(() => console.log('STILL PROCESSING...'), 60000);

        await page.waitForFunction(() => state.isProcessing === false, { timeout: 3600000 });
        clearInterval(checkInterval);
        console.log('Analysis finished.');

        // 7. 导出应用
        const formats = (userConfig.exportFormat || 'yolo').split(',').map(s => s.trim());
        await page.evaluate(async (fmts) => {
            for (const fmt of fmts) {
                if (fmt === 'original') continue;
                if (fmt === 'yolo') {
                    if (state.isVideoMode) await exportBatchVideoFrames();
                    else await exportBatchImageLabels();
                } else if (fmt === 'tracked_video') {
                    if (state.isVideoMode) await exportAllTaggedVideos();
                }
                await new Promise(r => setTimeout(r, 5000));
            }
        }, formats);

        // 等待下载完成
        console.log('Finalizing downloads...');
        let wait = 0;
        while (wait < 60) {
            const files = fs.readdirSync(outputDir);
            if (files.length > 0 && !files.some(f => f.endsWith('.crdownload'))) break;
            await new Promise(r => setTimeout(r, 5000));
            wait++;
        }

    } catch (err) {
        console.error('CRITICAL ERROR:', err.message);
        if (page) {
            await page.screenshot({ path: 'error_screenshot.png' });
            console.log('Screenshot saved as error_screenshot.png');
            // 打印页面 HTML 结构辅助调试 (可选)
            // const html = await page.content();
            // console.log('Page HTML:', html.substring(0, 1000));
        }
        process.exit(1);
    } finally {
        if (browser) await browser.close();
        if (server) server.close();
        if (fs.existsSync('temp_import_task.zip')) fs.unlinkSync('temp_import_task.zip');
        if (fs.existsSync(tempFilesDir)) fs.rmSync(tempFilesDir, { recursive: true, force: true });
        console.log('Process completed.');
    }
})();
