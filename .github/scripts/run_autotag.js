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
    const tempFilesDir = path.resolve('temp_extracted_media');
    const rootDir = process.cwd(); // 确保获取当前工作目录

    try {
        console.log('--- Environment Check ---');
        console.log('Working Directory:', rootDir);
        // 核心：检查关键文件是否存在，防止 404
        ['index.html', 'config.js', 'main.js', 'task_manager.js'].forEach(file => {
            const exists = fs.existsSync(path.join(rootDir, file));
            console.log(`File ${file} exists: ${exists}`);
            if (!exists) console.error(`CRITICAL ERROR: ${file} is missing in the workspace!`);
        });

        // 1. 提取包逻辑保持不变...
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

        // 2. 准备任务包
        console.log('Preparing task package...');
        const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const mediaZipData = fs.readFileSync(mediaZipPath);
        const taskZip = new JSZip();
        
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

        // 3. 启动静态服务器 (使用 127.0.0.1 避免某些 CI 下的 localhost 解析问题)
        server = createServer({ root: rootDir, cache: -1 }); 
        server.listen(8080, '127.0.0.1');
        console.log('Server started on http://127.0.0.1:8080');

        // 4. 启动浏览器
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-web-security', // 允许跨域请求
                '--allow-file-access-from-files'
            ]
        });
        const page = await browser.newPage();
        
        // 设置下载目录
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: path.resolve(outputDir) });

        // ！！增强调试：记录 404 的具体资源名称 ！！
        page.on('response', response => {
            if (response.status() === 404) {
                console.error(`PAGE ERROR 404: File not found -> ${response.url()}`);
            }
        });

        page.on('console', msg => console.log('PAGE LOG:', msg.text()));

        // 核心逻辑：使用 retry 机制打开页面，并等待网络闲置
        console.log('Navigating to local labels platform...');
        await page.goto('http://127.0.0.1:8080/index.html', { 
            waitUntil: 'networkidle0', // 等待所有资源加载完成
            timeout: 60000 
        });

        // 再次检查 CONFIGS
        console.log('Checking for window.CONFIGS...');
        await page.waitForFunction(() => typeof window.CONFIGS !== 'undefined', { timeout: 30000 });

        // --- API Key 注入 ---
        let apiKey = API_KEY; 
        let allSecrets = {};
        if (process.env.ALL_SECRETS) {
            try { allSecrets = JSON.parse(process.env.ALL_SECRETS); } catch (e) {}
        }
        const modelNameFromConfig = taskConfig.model;
        const envSafeModelName = modelNameFromConfig.replace(/[^a-zA-Z0-9_]/g, '').toUpperCase();
        
        const findKey = (envObj, keyName) => {
            if (!envObj) return null;
            const upperTarget = keyName.toUpperCase();
            return envObj[upperTarget] || envObj[upperTarget + '_KEY'];
        };

        let matchedKey = findKey(process.env, envSafeModelName) || findKey(allSecrets, envSafeModelName);
        if (matchedKey) {
            apiKey = matchedKey;
            console.log(`Matching key found for model "${modelNameFromConfig}"`);
        }

        if (apiKey) {
            await page.evaluate((key, modelName) => {
                if (window.CONFIGS && window.CONFIGS[modelName]) {
                    window.CONFIGS[modelName].key = key;
                } else {
                    for (let k in window.CONFIGS) {
                        if (k.toLowerCase().includes('gemini')) window.CONFIGS[k].key = key;
                    }
                }
            }, apiKey, modelNameFromConfig);
        }

        // --- 触发任务 ---
        const fileInput = await page.$('#importTaskInput');
        await fileInput.uploadFile(importZipPath);
        
        console.log('Task package uploaded. Waiting for analysis...');
        
        // 等待 state 对象初始化
        await page.waitForFunction(() => window.state !== undefined, { timeout: 10000 });

        // 等待处理开始
        await page.waitForFunction(() => window.state.isProcessing === true, { timeout: 90000 });
        console.log('Processing analysis started...');
        
        // 等待处理结束 (超时设定为 45 分钟，视频任务较久)
        await page.waitForFunction(() => window.state.isProcessing === false, { timeout: 2700000 });
        
        // 导出结果逻辑...
        const formats = (userConfig.exportFormat || 'yolo').split(',').map(s => s.trim());
        await page.evaluate(async (fmts) => {
            for (const fmt of fmts) {
                if (fmt === 'original') continue;
                if (fmt === 'yolo') {
                    if (window.state.isVideoMode) await window.exportBatchVideoFrames();
                    else await window.exportBatchImageLabels();
                } else if (fmt === 'tracked_video') {
                    if (window.state.isVideoMode) await window.exportAllTaggedVideos();
                }
                await new Promise(r => setTimeout(r, 5000));
            }
        }, formats);

        // 等待下载完成
        console.log('Exporting results...');
        let downloadWaitTime = 0;
        while (downloadWaitTime < 120) {
            const files = fs.readdirSync(outputDir);
            if (files.length > 0 && !files.some(f => f.endsWith('.crdownload'))) break;
            await new Promise(r => setTimeout(r, 2000));
            downloadWaitTime += 2;
        }

    } catch (err) {
        console.error('CRITICAL EXECUTION ERROR:', err.message);
        // 抓取当前页面截图以便调试
        if (page) await page.screenshot({ path: 'error_screenshot.png' });
        process.exit(1);
    } finally {
        if (browser) await browser.close();
        if (server) server.close();
        
        // 清理
        if (fs.existsSync('temp_import_task.zip')) fs.unlinkSync('temp_import_task.zip');
        if (fs.existsSync(tempFilesDir)) fs.rmSync(tempFilesDir, { recursive: true, force: true });
        
        console.log('Process finished.');
    }
})();
