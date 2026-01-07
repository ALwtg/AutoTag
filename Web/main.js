/**
 * 完整优化后的 main.js
 */
const $ = id => document.getElementById(id);

// UI 元素
const els = {
    modeToggle: $('modeToggle'), modeLabel: $('modeLabel'),
    fileInput: $('fileInput'), classesInput: $('classesInput'), promptInput: $('promptInput'), modelSelect: $('modelSelect'),
    videoOptions: $('videoOptions'), manualFrame: $('manualFrame'), frameRateDiv: $('frameRateDiv'),
    imageOptions: $('imageOptions'), // 新增
    startBtn: $('startBtn'), downloadBtn: $('downloadBtn'),
    scaleFactor: $('scaleFactor'), parallelCountGlobal: $('parallelCountGlobal'), apiRpm: $('apiRpm'),
    extractTransparent: $('extractTransparent'),
    exportAllTransparentBtn: $('exportAllTransparentBtn'), exportAllCropBtn: $('exportAllCropBtn'), exportAllTaggedVideosBtn: $('exportAllTaggedVideosBtn'),
    exportBatchImageLabelsBtn: $('exportBatchImageLabelsBtn'), exportBatchVideoFramesBtn: $('exportBatchVideoFramesBtn'),
    imageCanvas: $('imageCanvas'),
    videoPlayer: $('videoPlayer'), overlayCanvas: $('overlayCanvas'),
    statusMsg: $('statusMsg'), loader: $('loader'), btnText: $('btnText'),
    apiInfo: $('apiInfo'), // 新增引用
    timelineResults: $('timelineResults'), timelineContent: $('timelineContent'), cropPreview: $('cropPreview'), cropGallery: $('cropGallery'),
    progress: { box: $('progressContainer'), fill: $('progressFill'), text: $('progressText'), pct: $('progressPct') },
    exportCanvas: document.createElement('canvas') // 隐藏的离屏Canvas用于处理导出
};

// 状态变量
let state = {
    isVideoMode: false,
    file: null,
    files: [],
    img: null, // 图片模式下的原始图
    annotations: [], // 存储解析结果
    isProcessing: false,
    imageResults: [],
    videoResults: [],
    unifiedClassMap: new Map(), // label -> id
    nextClassId: 0,
    customClassesLoaded: false,
    apiHistory: [] // 记录API请求时间戳
};

// --- 初始化 ---
function initModelSelect() {
    els.modelSelect.innerHTML = '';
    Object.keys(CONFIGS).forEach(key => {
        const option = document.createElement('option');
        option.value = key;
        // 显示 config.js 中的键名，或者可以优化显示格式
        option.textContent = `${key} (${CONFIGS[key].model})`;
        els.modelSelect.appendChild(option);
    });
}

initModelSelect();
els.modeToggle.addEventListener('change', toggleMode);
els.fileInput.addEventListener('change', handleFileSelect);
els.classesInput.addEventListener('change', handleClassesSelect);
els.startBtn.addEventListener('click', startAnalysis);
if (els.exportAllTransparentBtn) els.exportAllTransparentBtn.addEventListener('click', exportAllTransparentImages);
if (els.exportBatchImageLabelsBtn) els.exportBatchImageLabelsBtn.addEventListener('click', exportBatchImageLabels);
if (els.exportBatchVideoFramesBtn) els.exportBatchVideoFramesBtn.addEventListener('click', exportBatchVideoFrames);
if (els.exportAllCropBtn) els.exportAllCropBtn.addEventListener('click', exportAllCroppedImages);
if (els.exportAllTaggedVideosBtn) els.exportAllTaggedVideosBtn.addEventListener('click', exportAllTaggedVideos);
els.videoPlayer.addEventListener('play', () => { requestAnimationFrame(videoLoop); });
els.videoPlayer.addEventListener('seeked', drawVideoOverlay);
// 初始化时执行一次模式切换逻辑，确保按钮状态正确
toggleMode();

els.manualFrame.addEventListener('change', () => {
    if (els.manualFrame.checked) {
        els.frameRateDiv.classList.remove('hidden');
    } else {
        els.frameRateDiv.classList.add('hidden');
    }
});

function toggleMode() {
    state.isVideoMode = els.modeToggle.checked;
    els.modeLabel.textContent = state.isVideoMode ? '当前: 视频模式' : '当前: 图片模式';
    els.fileInput.accept = state.isVideoMode ? 'video/*' : 'image/*';
    els.videoOptions.classList.toggle('hidden', !state.isVideoMode);
    els.imageCanvas.classList.toggle('hidden', state.isVideoMode);
    els.videoPlayer.classList.toggle('hidden', !state.isVideoMode);
    els.overlayCanvas.classList.remove('hidden');
    els.timelineResults.classList.add('hidden');
    
    // UI 显隐控制
    if (state.isVideoMode) {
        // 视频模式下：隐藏图片特有选项和按钮
        els.imageOptions.classList.add('hidden');
        els.exportAllTransparentBtn.classList.add('hidden');
        els.exportAllCropBtn.classList.add('hidden');
        els.exportBatchImageLabelsBtn.classList.add('hidden');
        
        // 显示视频特有按钮
        els.exportAllTaggedVideosBtn.classList.remove('hidden');
        els.exportBatchVideoFramesBtn.classList.remove('hidden');
        
        // 触发一次 manualFrame 的 change 事件以正确显示/隐藏 frameRateDiv
        els.manualFrame.dispatchEvent(new Event('change'));
    } else {
        // 图片模式下：显示图片特有选项和按钮
        els.imageOptions.classList.remove('hidden');
        els.exportAllTransparentBtn.classList.remove('hidden');
        els.exportAllCropBtn.classList.remove('hidden');
        els.exportBatchImageLabelsBtn.classList.remove('hidden');
        
        // 隐藏视频特有按钮
        els.exportAllTaggedVideosBtn.classList.add('hidden');
        els.exportBatchVideoFramesBtn.classList.add('hidden');
    }

    state.annotations = [];
    state.files = [];
    state.imageResults = [];
    state.videoResults = [];
    els.statusMsg.textContent = '模式已切换';
}

function handleFileSelect(e) {
    const selected = Array.from(e.target.files || []);
    if (selected.length === 0) return;
    state.files = selected;
    state.file = selected[0];

    if (state.isVideoMode) {
        els.videoPlayer.src = URL.createObjectURL(state.file);
        els.videoPlayer.onloadedmetadata = () => {
            els.overlayCanvas.width = els.videoPlayer.videoWidth;
            els.overlayCanvas.height = els.videoPlayer.videoHeight;
        };
    } else {
        const reader = new FileReader();
        reader.onload = ev => {
            const img = new Image();
            img.onload = () => {
                state.img = img;
                els.imageCanvas.width = img.width;
                els.imageCanvas.height = img.height;
                els.overlayCanvas.width = img.width;
                els.overlayCanvas.height = img.height;
                resetImageDisplay();
                const octx = els.overlayCanvas.getContext('2d');
                octx.clearRect(0,0,els.overlayCanvas.width,els.overlayCanvas.height);
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(state.file);
    }
}

function handleClassesSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = ev => {
        const content = ev.target.result;
        const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l);
        state.unifiedClassMap.clear();
        state.nextClassId = 0;
        
        lines.forEach((label) => {
            if (!state.unifiedClassMap.has(label)) {
                state.unifiedClassMap.set(label, state.nextClassId++);
            }
        });
        state.customClassesLoaded = true;
        els.statusMsg.textContent = `已加载 ${state.unifiedClassMap.size} 个自定义类别`;
    };
    reader.readAsText(file);
}

function getClassId(label) {
    if (!state.unifiedClassMap.has(label)) {
        state.unifiedClassMap.set(label, state.nextClassId++);
    }
    return state.unifiedClassMap.get(label);
}

function getAllClasses() {
    const arr = new Array(state.unifiedClassMap.size);
    for (const [label, id] of state.unifiedClassMap.entries()) {
        arr[id] = label;
    }
    return arr;
}

// 还原/重绘背景图
function resetImageDisplay() {
    if (!state.img) return;
    const ctx = els.imageCanvas.getContext('2d');
    ctx.drawImage(state.img, 0, 0);
}

// --- 核心分析逻辑 ---

async function startAnalysis() {
    const hasFiles = (state.files && state.files.length > 0) || !!state.file;
    if (!hasFiles) return alert('请先上传文件');
    const config = CONFIGS[els.modelSelect.value];
    setLoading(true);
    els.progress.box.classList.remove('hidden');

    try {
        if (state.isVideoMode) {
            await processVideosBatch(config);
        } else {
            await processImagesBatch(config);
        }
    } catch (err) {
        els.statusMsg.textContent = `错误: ${err.message}`;
    } finally {
        setLoading(false);
        if(!state.isVideoMode) els.progress.box.classList.add('hidden');
    }
}

async function analyzeImage(config) {
    const base64 = els.imageCanvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    const prompt = els.promptInput.value.trim() || '物体';
    const systemPrompt = `任务：识别目标并返回JSON列表。
每个对象包含：{"label":"${prompt}", "polygon":[[y,x],...], "box_2d":[ymin,xmin,ymax,xmax]} 
坐标均为0-1000归一化。`;

    return await callAPI(config, [
        { role: "user", content: [
            { type: "text", text: systemPrompt },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }
        ]}
    ]);
}

// --- 绘图逻辑：框选与半透明填色 ---

function renderAllAnnotations() {
    if (state.isVideoMode) return;
    resetImageDisplay();
    const ctx = els.overlayCanvas.getContext('2d');
    ctx.clearRect(0,0,els.overlayCanvas.width,els.overlayCanvas.height);
    state.annotations.forEach(ann => drawStyledAnnotation(ctx, ann, els.overlayCanvas.width, els.overlayCanvas.height));
}

function drawStyledAnnotation(ctx, ann, w, h) {
    const hash = ann.label.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    const color = `hsl(${hash % 360}, 70%, 50%)`;

    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.fillStyle = color + '80';

    if (ann.polygon && ann.polygon.length > 2) {
        ctx.beginPath();
        ann.polygon.forEach((pt, i) => {
            const y = (pt[0] / 1000) * h;
            const x = (pt[1] / 1000) * w;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    } else if (ann.box_2d) {
        const [ymin, xmin, ymax, xmax] = ann.box_2d;
        const rx = (xmin/1000)*w, ry = (ymin/1000)*h, rw = ((xmax-xmin)/1000)*w, rh = ((ymax-ymin)/1000)*h;
        ctx.strokeRect(rx, ry, rw, rh);
    }
    
    // 绘制标签背景
    ctx.fillStyle = color;
    ctx.fillRect((ann.box_2d[1]/1000)*w, (ann.box_2d[0]/1000)*h - 25, ann.label.length * 10 + 20, 25);
    ctx.fillStyle = "#fff";
    ctx.fillText(ann.label, (ann.box_2d[1]/1000)*w + 5, (ann.box_2d[0]/1000)*h - 7);
}

// --- 导出逻辑：时间轴与结果列表 ---

function appendTimelineItem(file, annotations, fileIndex) {
    els.timelineResults.classList.remove('hidden');
    const fileName = file.name;
    
    // 创建文件头
    const header = document.createElement('div');
    header.className = 'p-2 bg-gray-100 font-bold text-gray-700 text-xs border-b sticky top-0';
    header.innerText = `文件: ${fileName} (${annotations.length} 个目标)`;
    els.timelineContent.appendChild(header);

    const fragment = document.createDocumentFragment();
    annotations.forEach((ann, i) => {
        const div = document.createElement('div');
        div.className = 'flex items-center justify-between p-3 border-b border-gray-100 hover:bg-gray-50 transition';
        div.innerHTML = `
            <div class="cursor-pointer" onclick="restoreAndGoTo(${fileIndex}, ${i})">
                <span class="text-indigo-600 font-bold">${state.isVideoMode ? ann.time.toFixed(2)+'s' : '#'+(i+1)}</span>
                <span class="ml-2 font-medium">${ann.label}</span>
            </div>
            <div class="flex gap-2">
                ${ann.previewDataUrl ? `<img src="${ann.previewDataUrl}" alt="预览" class="w-16 h-16 object-cover rounded border" />` : ''}
                ${ann.transparentPreviewUrl ? `<img src="${ann.transparentPreviewUrl}" alt="透明预览" class="w-16 h-16 object-contain rounded border" />` : ''}
            </div>
        `;
        fragment.appendChild(div);
    });
    els.timelineContent.appendChild(fragment);
}

// 替换原来的 renderTimeline
function renderTimeline(data) {
    // 此函数保留用于单文件模式或视频模式的内部刷新，但在多文件批处理中应使用 appendTimelineItem
    // 为了兼容，如果调用此函数，我们假设是当前 state.file
    if (!state.file) return;
    // 清空内容? 不，我们现在的逻辑是累加。
    // 如果是视频分析过程中的实时更新，可能需要清空？
    // 视频分析是逐步的，我们暂时保持视频分析的原有逻辑（它目前是全量更新 state.annotations）
    if (state.isVideoMode) {
        els.timelineResults.classList.remove('hidden');
        els.timelineContent.innerHTML = data.map((ann, index) => `
        <div class="flex items-center justify-between p-3 border-b border-gray-100 hover:bg-gray-50 transition">
            <div class="cursor-pointer" onclick="goToAnnotation(${index})">
                <span class="text-indigo-600 font-bold">${ann.time.toFixed(2)+'s'}</span>
                <span class="ml-2 font-medium">${ann.label}</span>
            </div>
             <div class="flex gap-2">
                ${ann.previewDataUrl ? `<img src="${ann.previewDataUrl}" alt="预览" class="w-16 h-16 object-cover rounded border" />` : ''}
            </div>
        </div>
        `).join('');
    }
}

// 新增恢复视图函数
window.restoreAndGoTo = function(fileIndex, annIndex) {
    // 在 imageResults 中查找
    const item = state.imageResults[fileIndex];
    if (item && item.dataUrl) {
        // 恢复图片
        const img = new Image();
        img.onload = () => {
            state.img = img;
            state.file = item.file; // 恢复当前文件引用
            state.annotations = item.annotations; // 恢复当前标注集
            els.imageCanvas.width = img.width;
            els.imageCanvas.height = img.height;
            els.overlayCanvas.width = img.width;
            els.overlayCanvas.height = img.height;
            resetImageDisplay();
            
            // 绘制高亮
            const octx = els.overlayCanvas.getContext('2d');
            octx.clearRect(0,0,els.overlayCanvas.width,els.overlayCanvas.height);
            // 绘制所有
            state.annotations.forEach(ann => drawStyledAnnotation(octx, ann, els.overlayCanvas.width, els.overlayCanvas.height));
            
            // 高亮选中的（可选）
            const ann = state.annotations[annIndex];
            // 可以画个特殊的框或者滚动到那里
        };
        img.src = item.dataUrl;
    }
};

function appendCropGallery(annotations) {
    const items = annotations.filter(a => a.previewDataUrl);
    if (items.length === 0) return;
    
    els.cropPreview.classList.remove('hidden');
    // 强制竖向排版：grid 默认是流式布局，只要容器宽度受限就会自动换行。
    // 如果用户感觉到横向滑动，可能是容器没有 wrap 或者 overflow-x 设置问题。
    // 我们确保容器是 flex-wrap 或者 grid
    
    const fragment = document.createDocumentFragment();
    items.forEach((a, i) => {
        const div = document.createElement('div');
        div.className = 'border rounded overflow-hidden bg-white shadow-sm flex flex-col';
        div.innerHTML = `
            <img src="${a.previewDataUrl}" class="w-full h-32 object-contain bg-gray-50" />
            <div class="p-2 text-xs text-gray-600 flex justify-between">
                <span>${a.label}</span>
                <span>box</span>
            </div>
        `;
        fragment.appendChild(div);
    });
    els.cropGallery.appendChild(fragment);
}

/**
 * 核心导出函数
 * @param {number} index 数据索引 
 * @param {string} mode 'transparent'(透明背景) 或 'crop'(原始截图)
 */
async function exportResult(index, mode) {
    const ann = state.annotations[index];
    let source;
    
    // 如果是视频，先跳转到对应时间并抓取当前视频帧
    if (state.isVideoMode) {
        els.videoPlayer.currentTime = ann.time;
        await new Promise(r => els.videoPlayer.onseeked = r);
        source = els.videoPlayer;
    } else {
        source = state.img;
    }

    const sw = source.videoWidth || source.width;
    const sh = source.videoHeight || source.height;

    // 获取边界矩形
    const [ymin, xmin, ymax, xmax] = ann.box_2d;
    const rx = (xmin/1000)*sw, ry = (ymin/1000)*sh, rw = ((xmax-xmin)/1000)*sw, rh = ((ymax-ymin)/1000)*sh;

    const canvas = els.exportCanvas;
    canvas.width = rw;
    canvas.height = rh;
    const ctx = canvas.getContext('2d');

    if (mode === 'transparent') {
        // 透明抠图逻辑
        ctx.clearRect(0,0,rw,rh);
        if (ann.polygon) {
            ctx.beginPath();
            ann.polygon.forEach((pt, i) => {
                const px = (pt[1] / 1000) * sw - rx;
                const py = (pt[0] / 1000) * sh - ry;
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            });
            ctx.closePath();
            ctx.clip(); // 建立裁剪区域
        }
        ctx.drawImage(source, rx, ry, rw, rh, 0, 0, rw, rh);
    } else {
        // 普通区域截图
        ctx.drawImage(source, rx, ry, rw, rh, 0, 0, rw, rh);
    }

    // 下载
    const link = document.createElement('a');
    link.download = `${mode}_${ann.label}_${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
}

function goToAnnotation(index) {
    const ann = state.annotations[index];
    if (state.isVideoMode) {
        els.videoPlayer.currentTime = ann.time;
    }
}

// --- 视频处理辅助 ---

async function analyzeVideo(config) {
    updateProgress(0, '正在处理视频帧...');
    const frames = await extractFrames(els.videoPlayer, 1); // 每秒1帧
    let allAnns = [];
    
    for (let i = 0; i < frames.length; i++) {
        const res = await callAPI(config, [{ role: "user", content: [
            { type: "text", text: `标注物体并返回 JSON: [{"label":"物体名", "box_2d":[y1,x1,y2,x2]}]` },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${frames[i].base64}` } }
        ]}]);
        const timedRes = res.map(r => ({ ...r, time: frames[i].time }));
        allAnns.push(...timedRes);
        updateProgress(((i+1)/frames.length)*100, `分析中: ${i+1}/${frames.length}`);
    }
    
    state.annotations = allAnns;
    renderTimeline(allAnns);
}

function drawVideoOverlay() {
    if (!state.isVideoMode) return;
    const ctx = els.overlayCanvas.getContext('2d');
    const w = els.overlayCanvas.width, h = els.overlayCanvas.height;
    ctx.clearRect(0,0,w,h);
    
    // 找出当前时间附近的标注
    const now = els.videoPlayer.currentTime;
    const currentAnns = state.annotations.filter(a => Math.abs(a.time - now) < 0.5);
    currentAnns.forEach(ann => drawStyledAnnotation(ctx, ann, w, h));
}

function videoLoop() {
    if (els.videoPlayer.paused || els.videoPlayer.ended) return;
    drawVideoOverlay();
    requestAnimationFrame(videoLoop);
}

// --- 基础工具函数 ---

async function enforceRateLimit() {
    const rawVal = els.apiRpm && els.apiRpm.value ? els.apiRpm.value : '60';
    const limit = parseInt(rawVal, 10);

    // -1 表示无限制
    if (limit === -1) {
        els.apiInfo.textContent = `API速率: 无限制`;
        return;
    }

    // 默认值保护 (如果输入无效)
    const effectiveLimit = isNaN(limit) ? 60 : limit;
    const windowMs = 60000;
    const now = Date.now();
    
    // 清理过期记录
    while (state.apiHistory.length > 0 && state.apiHistory[0] <= now - windowMs) {
        state.apiHistory.shift();
    }
    
    if (state.apiHistory.length >= effectiveLimit) {
        const oldest = state.apiHistory[0];
        const waitTime = oldest + windowMs - now + 100; // 多等100ms
        if (waitTime > 0) {
            els.apiInfo.textContent = `触发流控: 等待 ${(waitTime/1000).toFixed(1)}s`;
            await new Promise(r => setTimeout(r, waitTime));
            return enforceRateLimit(); // 重新检查
        }
    }
    
    state.apiHistory.push(Date.now());
    els.apiInfo.textContent = `API速率: ${state.apiHistory.length}/${effectiveLimit} (1min)`;
}

async function callAPI(config, messages) {
    await enforceRateLimit(); // 速率限制
    try {
        const response = await fetch(config.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.key}` },
            body: JSON.stringify({ model: config.model, messages, response_format: { type: "json_object" } })
        });
        const data = await response.json();
        const content = data.choices[0].message.content;
        const jsonMatch = content.match(/\[[\s\S]*\]/) || content.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch[0]);
        return Array.isArray(parsed) ? parsed : (parsed.objects || []);
    } catch (e) {
        console.error("API Error", e);
        return [];
    }
}

async function extractFrames(video, fps) {
    const duration = video.duration;
    const frames = [];
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    for (let t = 0; t < duration; t += (1/fps)) {
        video.currentTime = t;
        await new Promise(r => video.onseeked = r);
        ctx.drawImage(video, 0, 0);
        frames.push({ time: t, base64: canvas.toDataURL('image/jpeg', 0.6).split(',')[1] });
    }
    return frames;
}

function updateProgress(pct, text) {
    els.progress.fill.style.width = `${pct}%`;
    els.progress.pct.innerText = `${Math.round(pct)}%`;
    if(text) els.progress.text.innerText = text;
}

function setLoading(isLoading) {
    els.startBtn.disabled = isLoading;
    els.loader.style.display = isLoading ? 'block' : 'none';
    els.btnText.innerText = isLoading ? 'AI正在计算...' : '开始分析';
}

function renderCropGallery() {
    // 此函数现在仅用于单次刷新，如视频模式或非批处理模式
    // 但我们的新逻辑是 append，所以如果是批处理，不应该调用这个
    // 暂时保留，如果是非批处理单张分析，可能需要？
    // 我们的 processImageTwoStage 已经改为 appendCropGallery 了
    // 所以这个函数可能不再需要，或者只用于清空重绘？
    // 实际上 renderCropGallery 是被 appendCropGallery 替代了大部分功能
    // 为了兼容，如果其他地方调用了它：
    const items = state.annotations.filter(a => a.previewDataUrl);
    if (items.length === 0) {
        els.cropPreview.classList.add('hidden');
        els.cropGallery.innerHTML = '';
        return;
    }
    els.cropPreview.classList.remove('hidden');
    els.cropGallery.innerHTML = items.map((a, i) => `
        <div class="border rounded overflow-hidden bg-white shadow-sm flex flex-col">
            <img src="${a.previewDataUrl}" class="w-full h-32 object-contain bg-gray-50" />
            <div class="p-2 text-xs text-gray-600 flex justify-between">
                <span>${a.label}</span>
                <span>box</span>
            </div>
        </div>
    `).join('');
}
async function processImageTwoStage(config, reportProgress = true) {
    const t0 = performance.now();
    const base64 = els.imageCanvas.toDataURL('image/jpeg', 0.9).split(',')[1];
    const prompt = els.promptInput.value.trim() || '目标';
    
    let classInstruction = "";
    if (state.unifiedClassMap.size > 0) {
        const classes = getAllClasses();
        const classListStr = classes.map((c, i) => `${i}:${c}`).join(',');
        classInstruction = `\n请严格优先使用以下已知类别标准名称(ID:名称): [${classListStr}]。`;
    }

    const msg1 = [{ role: "user", content: [
        { type: "text", text: `仅检测并返回 [{"label":"${prompt}","box_2d":[ymin,xmin,ymax,xmax]}]，坐标归一化到0-1000。${classInstruction}` },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }
    ]}];
    const boxes = await callAPI(config, msg1);
    
    // 注册/更新类别ID
    boxes.forEach(b => getClassId(b.label));
    
    state.annotations = boxes;
    const octx = els.overlayCanvas.getContext('2d');
    octx.clearRect(0,0,els.overlayCanvas.width,els.overlayCanvas.height);
    boxes.forEach(b => drawStyledAnnotation(octx, { ...b, polygon: null }, els.overlayCanvas.width, els.overlayCanvas.height));
    const t1 = performance.now();
    const stage1Time = Math.round(t1 - t0);
    els.statusMsg.textContent = `阶段1完成：${stage1Time}ms`;
    const sw = state.img.width, sh = state.img.height;
    let apiTime = 0, cropTime = 0;
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const [ymin, xmin, ymax, xmax] = b.box_2d;
        const rx = (xmin/1000)*sw, ry = (ymin/1000)*sh, rw = ((xmax-xmin)/1000)*sw, rh = ((ymax-ymin)/1000)*sh;
        const c0 = performance.now();
        const c = els.exportCanvas;
        c.width = rw; c.height = rh;
        const cctx = c.getContext('2d');
        cctx.drawImage(state.img, rx, ry, rw, rh, 0, 0, rw, rh);
        let upCanvas = c;
        // 只有在需要透明图，或者用户设置了缩放倍数 > 1 时才进行放大处理
        // 如果未勾选提取透明图，通常不需要进行高倍数放大，这会浪费时间
        const isTransparentNeeded = els.extractTransparent && els.extractTransparent.checked;
        const scale = parseFloat(els.scaleFactor && els.scaleFactor.value ? els.scaleFactor.value : '4') || 4;
        
        // 如果不需要透明图，且只是为了预览，强制 scale = 1 或者一个较小的值来加速？
        // 为了保持“导出裁剪图”功能的有效性，我们还是尊重 scale 设置，但可以优化执行路径。
        // 如果不需要透明图，我们可以跳过 OpenCV 的高质量缩放，改用 Canvas 缩放，甚至如果 scale=1 直接用原图。
        
        const effectiveScale = isTransparentNeeded ? scale : 1; // 优化：如果不提取透明图，不做放大，大幅提升速度
        
        if (effectiveScale !== 1) {
            if (window.cvReady && isTransparentNeeded) {
                 // 只有需要透明图且有OpenCV时才用高质量缩放
                const src = cv.imread(c);
                const dst = new cv.Mat();
                const dsize = new cv.Size(Math.round(rw*effectiveScale), Math.round(rh*effectiveScale));
                cv.resize(src, dst, dsize, 0, 0, cv.INTER_LINEAR); 
                const oc = document.createElement('canvas');
                oc.width = dsize.width; oc.height = dsize.height;
                cv.imshow(oc, dst);
                src.delete(); dst.delete();
                upCanvas = oc;
            } else {
                const oc = document.createElement('canvas');
                oc.width = Math.round(rw*effectiveScale); oc.height = Math.round(rh*effectiveScale);
                const octx2 = oc.getContext('2d');
                octx2.imageSmoothingEnabled = true;
                octx2.imageSmoothingQuality = 'medium'; // 降低质量以提升速度
                octx2.drawImage(c, 0, 0, oc.width, oc.height);
                upCanvas = oc;
            }
        }
        
        const c1 = performance.now();
        cropTime += (c1 - c0);
        // 如果不需要导出裁剪图（即不需要预览也不需要后续透明图处理），可以跳过生成预览图的步骤
        // 但这里逻辑是：生成裁剪图 -> 显示预览 -> (可选)生成透明图
        // 如果用户只想要框选坐标，其实不需要生成裁剪图。
        // 但目前产品设计是必须显示预览。
        // 优化点：如果图片过大，toDataURL会非常慢。
        // 可以尝试降低预览图质量或尺寸，或者异步处理预览图生成。
        // 这里暂时保持原样，因为需要预览。
        
        const previewUrl = upCanvas.toDataURL('image/jpeg', 0.5); // 改为jpeg且降低质量，大幅提升速度
        b.previewDataUrl = previewUrl;
        // renderCropGallery(); // 移除这行，我们在最后统一 append

    if (els.extractTransparent && els.extractTransparent.checked) {
        const up64 = previewUrl.split(',')[1];
            const a0 = performance.now();
            const msg2 = [{ role: "user", content: [
                { type: "text", text: `返回精确多边形 [{"label":"${b.label}","polygon":[[y,x],...]]}]，坐标归一化到0-1000。尤其要包含向外突出或向内凹的尖角和转折处` },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${up64}` } }
            ]}];
            const polys = await callAPI(config, msg2);
            const a1 = performance.now();
            apiTime += (a1 - a0);
            if (polys && polys[0] && polys[0].polygon) {
                const mapped = polys[0].polygon.map(([y,x]) => {
                    const oy = ymin + (y/1000)*(ymax - ymin);
                    const ox = xmin + (x/1000)*(xmax - xmin);
                    return [oy, ox];
                });
                b.polygon = mapped;
                const tc = document.createElement('canvas');
                tc.width = rw; tc.height = rh;
                const tctx = tc.getContext('2d');
                tctx.clearRect(0,0,rw,rh);
                tctx.beginPath();
                b.polygon.forEach((pt, i) => {
                    const px = (pt[1] / 1000) * sw - rx;
                    const py = (pt[0] / 1000) * sh - ry;
                    if (i === 0) tctx.moveTo(px, py); else tctx.lineTo(px, py);
                });
                tctx.closePath();
                tctx.clip();
                tctx.drawImage(state.img, rx, ry, rw, rh, 0, 0, rw, rh);
                b.transparentPreviewUrl = tc.toDataURL('image/png');
            }
        }
        drawStyledAnnotation(octx, b, els.overlayCanvas.width, els.overlayCanvas.height);
        if (reportProgress) {
            updateProgress(Math.round(((i+1)/boxes.length)*100), `阶段2: ${i+1}/${boxes.length}`);
        }
    }
    const t2 = performance.now();
    els.statusMsg.textContent = `阶段1：${stage1Time}ms，裁剪缩放：${Math.round(cropTime)}ms，API：${Math.round(apiTime)}ms，总计：${Math.round(t2 - t0)}ms`;
    return state.annotations;
}

async function processImagesBatch(config) {
    const files = state.files && state.files.length ? state.files : (state.file ? [state.file] : []);
    if (files.length === 0) return;
    const concurrency = 1;
    state.imageResults = [];
    
    let completed = 0;
    const total = files.length;
    // 如果是单文件，允许内部报告详细进度；如果是多文件，禁用内部报告，改用外部计数
    const isSingleFile = total === 1;

    const worker = async (file) => {
        state.file = file;
        await new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = ev => {
                const img = new Image();
                img.onload = () => {
                    state.img = img;
                    els.imageCanvas.width = img.width;
                    els.imageCanvas.height = img.height;
                    els.overlayCanvas.width = img.width;
                    els.overlayCanvas.height = img.height;
                    resetImageDisplay();
                    resolve();
                };
                img.src = ev.target.result;
            };
            fr.readAsDataURL(file);
        });
        const anns = await processImageTwoStage(config, isSingleFile);
        const dataUrl = els.imageCanvas.toDataURL();
        state.imageResults.push({ fileName: file.name, file, annotations: JSON.parse(JSON.stringify(anns)), dataUrl });
        appendTimelineItem(file, anns, state.imageResults.length - 1);
        appendCropGallery(anns);
        
        if (!isSingleFile) {
            completed++;
            updateProgress(Math.round((completed / total) * 100), `批量处理中: ${completed}/${total}`);
        }
    };
    
    if (!isSingleFile) updateProgress(0, `准备处理 ${total} 张图片...`);
    
    // 如果只有一张图，不需要 concurrency 逻辑，直接跑
    if (isSingleFile) {
        await worker(files[0]);
    } else {
        await runWithConcurrency(files, worker, concurrency);
    }
    
    els.statusMsg.textContent = `图片批量处理完成：${state.imageResults.length}项`;
}

async function processVideosBatch(config) {
    const files = state.files && state.files.length ? state.files : (state.file ? [state.file] : []);
    if (files.length === 0) return;
    const concurrency = parseInt(els.parallelCountGlobal && els.parallelCountGlobal.value ? els.parallelCountGlobal.value : '3', 10) || 3;
    state.videoResults = [];
    
    let completed = 0;
    const total = files.length;
    const isSingleFile = total === 1;

    const worker = async (file) => {
        // 如果是单文件，传入进度回调；如果是多文件，不传回调（或者传空）
        const onProgress = isSingleFile 
            ? (pct, text) => updateProgress(pct, text)
            : null;

        const result = await analyzeVideoFile(file, config, onProgress);
        state.videoResults.push({ fileName: file.name, file, annotations: result.annotations, fps: result.fps });
        
        if (!isSingleFile) {
            completed++;
            updateProgress(Math.round((completed / total) * 100), `视频批量处理中: ${completed}/${total}`);
        }
    };
    
    if (!isSingleFile) updateProgress(0, `准备处理 ${total} 个视频...`);

    await runWithConcurrency(files, worker, concurrency);
    els.statusMsg.textContent = `视频批量处理完成：${state.videoResults.length}项`;
}

async function analyzeVideoFile(file, config, onProgress) {
    return new Promise(async (resolve) => {
        const video = document.createElement('video');
        video.playsInline = true;
        video.muted = true;
        video.src = URL.createObjectURL(file);
        video.onloadedmetadata = async () => {
            const fpsInput = $('frameRate');
            const fps = fpsInput ? parseFloat(fpsInput.value || '1') : 1;
            const frames = await extractFrames(video, fps);
            let allAnns = [];
            const prompt = els.promptInput.value.trim() || '物体';
            for (let i = 0; i < frames.length; i++) {
                let classInstruction = "";
                if (state.unifiedClassMap.size > 0) {
                    const classes = getAllClasses();
                    const classListStr = classes.map((c, i) => `${i}:${c}`).join(',');
                    classInstruction = `\n请严格优先使用以下已知类别标准名称(ID:名称): [${classListStr}]。`;
                }

                const res = await callAPI(config, [{ role: "user", content: [
                    { type: "text", text: `标注${prompt}并返回 JSON: [{"label":"${prompt}", "box_2d":[y1,x1,y2,x2]}]${classInstruction}` },
                    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${frames[i].base64}` } }
                ]}]);
                
                // 注册/更新类别ID
                res.forEach(b => getClassId(b.label));

                const timedRes = res.map(r => ({ ...r, time: frames[i].time }));
                allAnns.push(...timedRes);
                
                if (onProgress) {
                    onProgress(Math.round(((i + 1) / frames.length) * 100), `视频分析中: ${i + 1}/${frames.length} 帧`);
                }
            }
            resolve({ annotations: allAnns, fps });
        };
    });
}

async function runWithConcurrency(items, worker, concurrency) {
    let index = 0;
    const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
        while (index < items.length) {
            const current = index++;
            await worker(items[current]);
        }
    });
    await Promise.all(runners);
}

async function exportAllTransparentImages() {
    if (!state.imageResults || state.imageResults.length === 0) return alert('暂无可导出的透明图');
    const zip = new JSZip();
    const folder = zip.folder('transparent');
    for (const item of state.imageResults) {
        const sub = folder.folder(item.fileName);
        let idx = 1;
        for (const ann of item.annotations) {
            if (!ann.transparentPreviewUrl) continue;
            const base64 = ann.transparentPreviewUrl.split(',')[1];
            sub.file(`${ann.label}_${idx}.png`, base64, { base64: true });
            idx++;
        }
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `transparent_all_${Date.now()}.zip`;
    a.click();
}

async function exportBatchImageLabels() {
    if (!state.imageResults || state.imageResults.length === 0) return alert('暂无图片标注结果');
    const zip = new JSZip();
    
    // 确保所有结果中的标签都已注册到统一映射中
    state.imageResults.forEach(item => {
        if (item.annotations && item.annotations.length > 0) {
            item.annotations.forEach(ann => getClassId(ann.label));
        }
    });
    
    const classes = getAllClasses();
    
    // 即使 classes 为空（全都没识别到），也应该生成 zip
    if (classes.length > 0) {
        zip.file('classes.txt', classes.join('\n'));
    }

    // ...
    
    // 修正：我们重新遍历所有输入文件 state.files，而不是只遍历 state.imageResults
    // 但 state.imageResults 保存了分析结果。我们需要将文件名映射回结果。
    
    const resultMap = new Map(state.imageResults.map(r => [r.fileName, r]));
    
    // 调试日志
    console.log("Files:", state.files.map(f => f.name));
    console.log("Results:", state.imageResults.map(r => r.fileName));

    for (const file of state.files) {
        const item = resultMap.get(file.name);
        
        // ... (文件名处理保持不变)
        let baseName = file.name;
        const lastDotIndex = file.name.lastIndexOf('.');
        if (lastDotIndex !== -1) {
            baseName = file.name.substring(0, lastDotIndex);
        }
        const txtName = baseName + '.txt';

        // ... (写入逻辑)
        if (item && item.annotations && item.annotations.length > 0) {
            const lines = item.annotations.map(ann => {
                const clsId = getClassId(ann.label);
                // ...
                if (!ann.box_2d || ann.box_2d.length !== 4) return null;
                const [ymin, xmin, ymax, xmax] = ann.box_2d;
                // ...
                const cx = ((xmin + xmax) / 2) / 1000;
                const cy = ((ymin + ymax) / 2) / 1000;
                const w = (xmax - xmin) / 1000;
                const h = (ymax - ymin) / 1000;
                return `${clsId} ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`;
            }).filter(line => line !== null);
            
            if (lines.length > 0) {
                zip.file(txtName, lines.join('\n'));
            } else {
                 zip.file(txtName, "");
            }
        } else {
            zip.file(txtName, "");
        }
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `image_labels_yolo_${Date.now()}.zip`;
    a.click();
}

async function exportBatchVideoFrames() {
    if (!state.videoResults || state.videoResults.length === 0) return alert('暂无视频标注结果');
    const zip = new JSZip();
    const imgFolder = zip.folder('images');
    const lblFolder = zip.folder('labels');

    // 确保所有结果中的标签都已注册到统一映射中
    state.videoResults.forEach(item => {
        item.annotations.forEach(ann => getClassId(ann.label));
    });
    const classes = getAllClasses();
    zip.file('classes.txt', classes.join('\n'));

    els.statusMsg.textContent = '正在导出视频帧...';

    for (const item of state.videoResults) {
        // 重新提取帧
        const video = document.createElement('video');
        video.src = URL.createObjectURL(item.file);
        // 等待元数据以确保提取准确
        await new Promise(r => video.onloadedmetadata = r);
        
        const fps = item.fps || 1;
        const frames = await extractFrames(video, fps);
        
        // 基础文件名（无扩展名）
        const baseName = item.fileName.substring(0, item.fileName.lastIndexOf('.'));

        for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            const frameName = `${baseName}_${String(i).padStart(5, '0')}`;
            
            // 保存图片
            const base64 = frame.base64; 
            imgFolder.file(`${frameName}.jpg`, base64, { base64: true });

            // 查找该帧的标注
            // 使用时间匹配，允许小误差
            const frameAnns = item.annotations.filter(ann => Math.abs(ann.time - frame.time) < (0.5/fps));
            
            if (frameAnns.length > 0) {
                const lines = frameAnns.map(ann => {
                    const clsId = getClassId(ann.label);
                    const [ymin, xmin, ymax, xmax] = ann.box_2d;
                    const cx = ((xmin + xmax) / 2) / 1000;
                    const cy = ((ymin + ymax) / 2) / 1000;
                    const w = (xmax - xmin) / 1000;
                    const h = (ymax - ymin) / 1000;
                    return `${clsId} ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`;
                });
                lblFolder.file(`${frameName}.txt`, lines.join('\n'));
            } else {
                lblFolder.file(`${frameName}.txt`, "");
            }
        }
    }

    els.statusMsg.textContent = '正在打包...';
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `video_frames_yolo_${Date.now()}.zip`;
    a.click();
    els.statusMsg.textContent = '导出完成';
}

async function exportAllCroppedImages() {
    if (!state.imageResults || state.imageResults.length === 0) return alert('暂无可导出的截取图');
    const zip = new JSZip();
    const folder = zip.folder('crop');
    for (const item of state.imageResults) {
        const sub = folder.folder(item.fileName);
        let idx = 1;
        for (const ann of item.annotations) {
            if (!ann.previewDataUrl) continue;
            const base64 = ann.previewDataUrl.split(',')[1];
            sub.file(`${ann.label}_${idx}.png`, base64, { base64: true });
            idx++;
        }
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `crop_all_${Date.now()}.zip`;
    a.click();
}

async function exportAllTaggedVideos() {
    if (!state.videoResults || state.videoResults.length === 0) return alert('暂无可导出的视频');
    
    // 1. 为所有结果分配追踪ID (Track IDs)
    state.videoResults.forEach(item => {
        if (item.annotations && item.annotations.length > 0) {
            item.annotations = assignTrackIds(item.annotations);
        }
    });

    const zip = new JSZip();
    const folder = zip.folder('videos_tagged');
    
    els.statusMsg.textContent = '正在准备导出...';
    els.progress.box.classList.remove('hidden'); // 显示进度条容器
    
    let completed = 0;
    const total = state.videoResults.length;

    // 2. 逐个处理视频导出
    for (const item of state.videoResults) {
        if (!item.annotations || item.annotations.length === 0) {
            completed++;
            continue;
        }
        
        // 定义单个视频的进度回调
        const onProgress = (pct) => {
            const currentVideoProgress = pct / 100;
            // 总进度 = (已完成视频数 + 当前视频进度) / 总视频数
            const totalProgress = ((completed + currentVideoProgress) / total) * 100;
            
            updateProgress(totalProgress, `正在导出 ${completed + 1}/${total}: ${item.fileName} (${Math.round(pct)}%)`);
        };

        els.statusMsg.textContent = `正在渲染并导出视频 ${completed + 1}/${total}: ${item.fileName}`;
        
        try {
            const videoBlob = await exportTaggedVideo(item, onProgress);
            // 默认导出为 webm 格式，兼容性最好
            const ext = videoBlob.type.includes('mp4') ? '.mp4' : '.webm';
            const outName = item.fileName.substring(0, item.fileName.lastIndexOf('.')) + '_tagged' + ext;
            folder.file(outName, videoBlob);
        } catch (e) {
            console.error(`Export failed for ${item.fileName}`, e);
            els.statusMsg.textContent = `导出失败: ${item.fileName}`;
        }
        
        completed++;
    }

    els.statusMsg.textContent = '正在打包所有视频...';
    updateProgress(100, '正在打包...');
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `videos_tagged_tracked_${Date.now()}.zip`;
    a.click();
    
    els.statusMsg.textContent = '所有视频导出完成';
    els.progress.box.classList.add('hidden'); // 隐藏进度条
}

// --- 追踪与导出辅助函数 ---

function assignTrackIds(annotations) {
    // 按时间排序
    const sorted = [...annotations].sort((a, b) => a.time - b.time);
    const result = sorted.map(ann => ({ ...ann, trackId: -1 }));
    
    let nextTrackId = 1;
    // 按时间分组
    const frames = {};
    result.forEach(ann => {
        const key = Math.round(ann.time * 100) / 100; // 0.01s 精度
        if (!frames[key]) frames[key] = [];
        frames[key].push(ann);
    });
    
    const timeKeys = Object.keys(frames).sort((a, b) => parseFloat(a) - parseFloat(b));
    const activeTracks = []; // { id, label, box, time }
    
    timeKeys.forEach(t => {
        const time = parseFloat(t);
        const currentAnns = frames[t];
        
        // 移除超过 5.0 秒未更新的轨迹 (增加容错，避免断连)
        for(let i = activeTracks.length - 1; i >= 0; i--) {
            if (time - activeTracks[i].time > 5.0) {
                activeTracks.splice(i, 1);
            }
        }
        
        currentAnns.forEach(ann => {
            // 贪心匹配：寻找最近的同类轨迹
            let bestMatch = -1;
            let minDist = 200; // 阈值：归一化坐标 200 (即 1/5 屏幕宽度)
            
            activeTracks.forEach((track, idx) => {
                if (track.label === ann.label) {
                    const dist = getDistance(track.box, ann.box_2d);
                    if (dist < minDist) {
                        minDist = dist;
                        bestMatch = idx;
                    }
                }
            });
            
            if (bestMatch !== -1) {
                ann.trackId = activeTracks[bestMatch].id;
                // 更新轨迹
                activeTracks[bestMatch].box = ann.box_2d;
                activeTracks[bestMatch].time = time;
            } else {
                // 新轨迹
                ann.trackId = nextTrackId++;
                activeTracks.push({ id: ann.trackId, label: ann.label, box: ann.box_2d, time: time });
            }
        });
    });
    
    return result;
}

function getDistance(box1, box2) {
    const cx1 = (box1[1] + box1[3]) / 2;
    const cy1 = (box1[0] + box1[2]) / 2;
    const cx2 = (box2[1] + box2[3]) / 2;
    const cy2 = (box2[0] + box2[2]) / 2;
    return Math.sqrt(Math.pow(cx1 - cx2, 2) + Math.pow(cy1 - cy2, 2));
}

function exportTaggedVideo(item, onProgress) {
    return new Promise(async (resolve, reject) => {
        const video = document.createElement('video');
        video.muted = true;
        video.src = URL.createObjectURL(item.file);
        video.crossOrigin = "anonymous";
        video.playsInline = true; // 关键：防止全屏
        
        await new Promise(r => video.onloadedmetadata = r);
        
        const width = video.videoWidth;
        const height = video.videoHeight;
        const duration = video.duration;
        
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        
        // 30fps 录制
        const stream = canvas.captureStream(30);
        
        // 优先使用 MP4 格式
        let mimeType = 'video/webm';
        if (MediaRecorder.isTypeSupported('video/mp4')) {
            mimeType = 'video/mp4';
        } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
            mimeType = 'video/webm;codecs=vp9';
        }
        
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 }); // 5Mbps
        const chunks = [];
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        
        recorder.onstop = () => {
            const blob = new Blob(chunks, { type: mimeType });
            resolve(blob);
        };
        
        recorder.start();
        video.play();
        
        // 预处理：按 trackId 分组并排序
        const tracks = {}; // trackId -> [sorted annotations]
        item.annotations.forEach(ann => {
            if (ann.trackId !== -1) {
                if (!tracks[ann.trackId]) tracks[ann.trackId] = [];
                tracks[ann.trackId].push(ann);
            }
        });
        Object.values(tracks).forEach(list => list.sort((a, b) => a.time - b.time));
        
        const trackHistory = {}; // trackId -> [{x, y}]
        
        const drawFrame = () => {
            if (video.paused || video.ended) {
                recorder.stop();
                return;
            }
            
            // 绘制视频帧
            ctx.drawImage(video, 0, 0, width, height);
            
            const now = video.currentTime;
            
            if (onProgress && duration > 0) {
                const pct = Math.min(100, (now / duration) * 100);
                onProgress(pct);
            }
            
            // 计算当前帧的插值框
            const currentBoxes = [];
            const MAX_GAP = 5.0; // 最大插值间隔，超过此值认为物体暂时消失或重置
            
            Object.entries(tracks).forEach(([trackId, list]) => {
                // 找到 now 前后的关键帧
                let prev = null, next = null;
                for (let i = 0; i < list.length; i++) {
                    if (list[i].time <= now) {
                        prev = list[i];
                    } else {
                        next = list[i];
                        break; // 找到第一个大于 now 的即为 next
                    }
                }
                
                let interpolatedBox = null;
                
                if (prev && next) {
                    // 在两个关键帧之间，进行线性插值
                    const gap = next.time - prev.time;
                    if (gap < MAX_GAP) {
                        const alpha = (now - prev.time) / gap;
                        // 线性插值：box = prev + alpha * (next - prev)
                        const b1 = prev.box_2d;
                        const b2 = next.box_2d;
                        interpolatedBox = [
                            b1[0] + alpha * (b2[0] - b1[0]), // ymin
                            b1[1] + alpha * (b2[1] - b1[1]), // xmin
                            b1[2] + alpha * (b2[2] - b1[2]), // ymax
                            b1[3] + alpha * (b2[3] - b1[3])  // xmax
                        ];
                    }
                } else if (prev) {
                    // 只有前一帧（可能是最后一帧，或者暂时没找到下一帧）
                    // 如果离得很近，可以显示（保持最后一帧的位置，或者淡出）
                    // 为了平滑，如果距离 prev 时间很短（例如 < 0.2s），显示静止框
                    if (now - prev.time < 0.2) {
                        interpolatedBox = prev.box_2d;
                    }
                } else if (next) {
                    // 只有后一帧（刚开始出现）
                     if (next.time - now < 0.2) {
                        interpolatedBox = next.box_2d;
                    }
                }
                
                if (interpolatedBox) {
                    currentBoxes.push({
                        label: list[0].label, // 假设同 trackId label 一致
                        box_2d: interpolatedBox,
                        trackId: parseInt(trackId)
                    });
                }
            });
            
            // 2. 绘制插值后的标注框
            currentBoxes.forEach(ann => {
                 drawStyledAnnotation(ctx, ann, width, height);
            });
            
            requestAnimationFrame(drawFrame);
        };
        
        drawFrame();
    });
}
