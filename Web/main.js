
        const $ = id => document.getElementById(id);
        
        // UI 元素
        const els = {
            modeToggle: $('modeToggle'), modeLabel: $('modeLabel'),
            fileInput: $('fileInput'), promptInput: $('promptInput'), modelSelect: $('modelSelect'),
            videoOptions: $('videoOptions'), manualFrame: $('manualFrame'), frameRateDiv: $('frameRateDiv'),
            startBtn: $('startBtn'), downloadBtn: $('downloadBtn'),
            imageCanvas: $('imageCanvas'), 
            videoPlayer: $('videoPlayer'), overlayCanvas: $('overlayCanvas'),
            statusMsg: $('statusMsg'), loader: $('loader'), btnText: $('btnText'),
            timelineResults: $('timelineResults'), timelineContent: $('timelineContent'),
            progress: { box: $('progressContainer'), fill: $('progressFill'), text: $('progressText'), pct: $('progressPct') },
            downloadText: $('downloadText'), exportCanvas: $('exportCanvas')
        };

        // 状态变量
        let state = {
            isVideoMode: false,
            file: null,
            img: null,
            videoAnnotations: [], // 原始AI返回数据
            trackedObjects: {},   // 【新增】处理后用于追踪的数据结构
            isProcessing: false,
            animationFrameId: null
        };

        // 初始化事件监听
        els.modeToggle.addEventListener('change', toggleMode);
        els.manualFrame.addEventListener('change', () => els.frameRateDiv.classList.toggle('hidden', !els.manualFrame.checked));
        els.fileInput.addEventListener('change', handleFileSelect);
        els.startBtn.addEventListener('click', startAnalysis);
        els.downloadBtn.addEventListener('click', handleDownload);
        els.videoPlayer.addEventListener('play', startVideoOverlayLoop);
        els.videoPlayer.addEventListener('pause', stopVideoOverlayLoop);
        els.videoPlayer.addEventListener('seeked', drawCurrentVideoFrameOverlay);

        function toggleMode() {
            state.isVideoMode = els.modeToggle.checked;
            els.modeLabel.textContent = state.isVideoMode ? '当前: 视频模式' : '当前: 图片模式';
            els.fileInput.accept = state.isVideoMode ? 'video/*' : 'image/*';
            els.videoOptions.classList.toggle('hidden', !state.isVideoMode);
            
            els.imageCanvas.classList.toggle('hidden', state.isVideoMode);
            els.videoPlayer.classList.toggle('hidden', !state.isVideoMode);
            els.overlayCanvas.classList.toggle('hidden', !state.isVideoMode);
            els.timelineResults.classList.add('hidden');
            els.downloadBtn.disabled = true;
            els.statusMsg.textContent = '模式已切换，请上传文件';
            state.videoAnnotations = [];
            state.trackedObjects = {};
            state.file = null;
            els.fileInput.value = '';
        }

        function handleFileSelect(e) {
            const file = e.target.files[0];
            if (!file) return;
            state.file = file;
            els.downloadBtn.disabled = true;

            if (state.isVideoMode) {
                const url = URL.createObjectURL(file);
                els.videoPlayer.src = url;
                els.statusMsg.textContent = '视频已加载，准备就绪';
                els.videoPlayer.onloadedmetadata = () => {
                    els.overlayCanvas.width = els.videoPlayer.videoWidth;
                    els.overlayCanvas.height = els.videoPlayer.videoHeight;
                    const ctx = els.overlayCanvas.getContext('2d');
                    ctx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
                };
            } else {
                const reader = new FileReader();
                reader.onload = ev => {
                    const img = new Image();
                    img.onload = () => {
                        state.img = img;
                        els.imageCanvas.width = img.width;
                        els.imageCanvas.height = img.height;
                        const ctx = els.imageCanvas.getContext('2d');
                        ctx.drawImage(img, 0, 0);
                        els.statusMsg.textContent = '图片已加载';
                    };
                    img.src = ev.target.result;
                };
                reader.readAsDataURL(file);
            }
        }

        async function startAnalysis() {
            if (!state.file) return alert('请先上传文件');
            const config = CONFIGS[els.modelSelect.value];
            setLoading(true);
            els.progress.box.classList.remove('hidden');
            $('apiInfo').innerText = `API: ${new URL(config.url).hostname}`;
            try {
                if (state.isVideoMode) await analyzeVideo(config);
                else await analyzeImage(config);
                els.downloadBtn.disabled = false;
            } catch (err) {
                console.error(err);
                els.statusMsg.textContent = `错误: ${err.message}`;
                alert('处理失败: ' + err.message);
            } finally {
                setLoading(false);
                if(!state.isVideoMode) els.progress.box.classList.add('hidden');
            }
        }

        async function analyzeImage(config) {
            updateProgress(10, '正在上传图片...');
            const base64 = els.imageCanvas.toDataURL('image/jpeg', 0.8).split(',')[1];
            updateProgress(50, 'AI 思考中...');
            const prompt = els.promptInput.value.trim() || '标注主要物体';
            const result = await callAPI(config, [{ role: "user", content: [{ type: "text", text: `${prompt}。\n请返回JSON数组，包含 label 和 box_2d [ymin, xmin, ymax, xmax] (0-1000归一化)。` }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }] }]);
            updateProgress(100, '渲染结果...');
            renderImageAnnotations(result);
            els.statusMsg.textContent = `识别成功: 找到 ${result.length} 个目标`;
        }
        
        /**
         * 将AI返回的扁平标注数组处理成按label分组的、有序的追踪对象
         */
        function processAnnotationsForTracking() {
            state.trackedObjects = {}; // 清空旧数据
            state.videoAnnotations.forEach(ann => {
                if (!ann.label || !ann.box_2d) return; // 过滤无效数据
                if (!state.trackedObjects[ann.label]) {
                    state.trackedObjects[ann.label] = [];
                }
                state.trackedObjects[ann.label].push(ann);
            });

            // 对每个物体的标注按时间排序，为插值做准备
            for (const label in state.trackedObjects) {
                state.trackedObjects[label].sort((a, b) => a.time - b.time);
            }
        }

        /**
         * 视频分析函数，在获取结果后调用新的处理函数
         */
        async function analyzeVideo(config) {
            state.videoAnnotations = [];
            state.trackedObjects = {}; // 清空
            const useManual = els.manualFrame.checked;
            
            if (useManual) {
                const fps = parseFloat($('frameRate').value) || 1;
                const parallel = parseInt($('parallelCount').value) || 3;
                await processVideoFrames(config, fps, parallel);
            } else {
                await processVideoDirect(config);
            }

            // 调用处理函数，生成用于平滑追踪的数据结构
            processAnnotationsForTracking();

            renderTimeline();
            els.statusMsg.textContent = `视频分析完成: 共 ${state.videoAnnotations.length} 个标注点`;
            els.videoPlayer.currentTime = 0;
            drawCurrentVideoFrameOverlay();
        }

        /**
         * 获取当前所有需要绘制的（插值计算后的）标注框
         * @param {number} currentTime - 视频当前播放时间
         * @returns {Array} - 计算好的标注对象数组
         */
        function getInterpolatedAnnotations(currentTime) {
            const interpolatedAnns = [];

            // 遍历所有被追踪的物体
            for (const label in state.trackedObjects) {
                const objectAnns = state.trackedObjects[label];
                if (objectAnns.length === 0) continue;
                
                // 找到当前时间点前后的两个关键帧
                const prevIndex = objectAnns.findLastIndex(ann => ann.time <= currentTime);
                if (prevIndex === -1) continue; // 物体尚未出现

                const prevAnn = objectAnns[prevIndex];
                const nextIndex = prevIndex + 1;
                const nextAnn = (nextIndex < objectAnns.length) ? objectAnns[nextIndex] : null;

                let currentBox;

                if (nextAnn) {
                    // 如果存在下一个关键帧，进行线性插值计算
                    const timeDiff = nextAnn.time - prevAnn.time;
                    // 防止除以0
                    const progress = (timeDiff > 0) ? (currentTime - prevAnn.time) / timeDiff : 0;
                    
                    const lerp = (start, end, t) => start + (end - start) * t;
                    
                    currentBox = [
                        lerp(prevAnn.box_2d[0], nextAnn.box_2d[0], progress), // ymin
                        lerp(prevAnn.box_2d[1], nextAnn.box_2d[1], progress), // xmin
                        lerp(prevAnn.box_2d[2], nextAnn.box_2d[2], progress), // ymax
                        lerp(prevAnn.box_2d[3], nextAnn.box_2d[3], progress)  // xmax
                    ];
                } else {
                    // 如果是最后一个关键帧，让框停留一段时间后消失
                    if (currentTime - prevAnn.time > 0.8) { // 停留0.8秒
                        continue;
                    }
                    currentBox = prevAnn.box_2d;
                }

                interpolatedAnns.push({ label: label, box_2d: currentBox });
            }
            return interpolatedAnns;
        }

        /**
         * 实时绘制覆盖层的核心函数
         */
        function drawCurrentVideoFrameOverlay() {
            if (!state.isVideoMode) return;
            const ctx = els.overlayCanvas.getContext('2d');
            const w = els.overlayCanvas.width;
            const h = els.overlayCanvas.height;
            const currentTime = els.videoPlayer.currentTime;
            
            // 获取插值计算后的所有标注框
            const annotationsToDraw = getInterpolatedAnnotations(currentTime);

            // 绘制
            ctx.clearRect(0, 0, w, h);
            annotationsToDraw.forEach(ann => drawBox(ctx, ann, w, h));
        }

        /**
         * 导出视频的录制循环
         */
        async function exportAnnotatedVideo() {
            if (!state.videoAnnotations.length) return alert("没有标注数据可导出");

            const originalBtnText = els.downloadText.textContent;
            els.downloadBtn.disabled = true;
            els.downloadText.textContent = "录制中(请勿切换)...";
            els.progress.box.classList.remove('hidden');

            const video = els.videoPlayer;
            const canvas = els.exportCanvas;
            const ctx = canvas.getContext('2d');
            
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;

            const stream = canvas.captureStream(30);
            // 修改为 mp4 格式
            const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/mp4' });
            const chunks = [];
            
            mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
            mediaRecorder.onstop = () => {
                // 修改为 mp4 格式
                const blob = new Blob(chunks, { type: 'video/mp4' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                // 修改为 .mp4 扩展名
                a.download = `tracked_video_${Date.now()}.mp4`;
                a.click();
                
                els.downloadBtn.disabled = false;
                els.downloadText.textContent = originalBtnText;
                els.progress.box.classList.add('hidden');
                els.statusMsg.textContent = "视频导出完成！";
                video.currentTime = 0;
            };

            mediaRecorder.start();
            video.pause();
            video.currentTime = 0;
            await new Promise(r => setTimeout(r, 200));

            video.play();
            updateProgress(0, "正在渲染导出的视频...");

            const recordLoop = () => {
                if (video.ended) {
                    mediaRecorder.stop();
                    video.pause();
                    return;
                }

                // 1. 绘制视频帧
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                
                // 2. 使用插值逻辑获取并绘制标注
                const annotationsToDraw = getInterpolatedAnnotations(video.currentTime);
                annotationsToDraw.forEach(ann => drawBox(ctx, ann, canvas.width, canvas.height));

                updateProgress((video.currentTime / video.duration) * 100, `录制中: ${Math.round(video.currentTime)}s / ${Math.round(video.duration)}s`);

                if (mediaRecorder.state === 'recording') {
                    requestAnimationFrame(recordLoop);
                }
            };
            recordLoop();
        }
        async function processVideoDirect(config) {
            updateProgress(10, '视频转码中...');
            const base64 = await fileToBase64(state.file);
            updateProgress(40, '发送完整视频 (可能较慢)...');
            const prompt = els.promptInput.value.trim() || '追踪主要物体';
            const result = await callAPI(config, [{ role: "user", content: [{ type: "text", text: `${prompt}。\n任务：追踪视频中的物体。\n返回格式：纯JSON数组。\n数组元素结构：{"time": 秒数(float), "label": "名称", "box_2d": [ymin, xmin, ymax, xmax] (0-1000归一化)}。\n请尽可能多地返回关键帧数据。` }, { type: "video_url", video_url: { url: `data:${state.file.type};base64,${base64}` } }] }]);
            state.videoAnnotations = result || [];
            updateProgress(100, '完成');
        }

        async function processVideoFrames(config, fps, parallel) {
            updateProgress(0, '提取视频帧...');
            const frames = await extractFrames(els.videoPlayer, fps);
            let completed = 0;
            const total = frames.length;
            const processBatch = async (batch) => {
                const promises = batch.map(async (frame) => {
                    try {
                        const result = await callAPI(config, [{ role: "user", content: [{ type: "text", text: `${els.promptInput.value || '标注物体'}。返回JSON数组: [{"label":"xx", "box_2d":[y1,x1,y2,x2]}] (0-1000)` }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${frame.base64}` } }] }]);
                        return (result || []).map(item => ({ ...item, time: frame.time }));
                    } catch (e) { console.error("帧处理失败", e); return []; } 
                    finally { completed++; updateProgress((completed / total) * 100, `AI 分析帧 ${completed}/${total}`); }
                });
                return (await Promise.all(promises)).flat();
            };
            for (let i = 0; i < total; i += parallel) {
                const batch = frames.slice(i, i + parallel);
                const batchResults = await processBatch(batch);
                state.videoAnnotations.push(...batchResults);
            }
        }

        function startVideoOverlayLoop() {
            if (state.animationFrameId) cancelAnimationFrame(state.animationFrameId);
            const loop = () => {
                drawCurrentVideoFrameOverlay();
                if (!els.videoPlayer.paused && !els.videoPlayer.ended) {
                    state.animationFrameId = requestAnimationFrame(loop);
                }
            };
            loop();
        }

        function stopVideoOverlayLoop() {
            if (state.animationFrameId) cancelAnimationFrame(state.animationFrameId);
            drawCurrentVideoFrameOverlay();
        }

        async function handleDownload() {
            if (!state.isVideoMode) {
                const link = document.createElement('a');
                link.download = `annotated_${Date.now()}.png`;
                link.href = els.imageCanvas.toDataURL('image/png');
                link.click();
            } else {
                await exportAnnotatedVideo();
            }
        }

        function drawImageAnnotation(annotations) {
            const ctx = els.imageCanvas.getContext('2d');
            ctx.drawImage(state.img, 0, 0);
            annotations.forEach(ann => drawBox(ctx, ann, els.imageCanvas.width, els.imageCanvas.height));
        }

        function renderImageAnnotations(annotations) {
            drawImageAnnotation(annotations);
        }

        function drawBox(ctx, ann, w, h) {
            if (!ann.box_2d || ann.box_2d.length !== 4) return;
            const [ymin, xmin, ymax, xmax] = ann.box_2d;
            const x = (xmin / 1000) * w;
            const y = (ymin / 1000) * h;
            const boxW = ((xmax - xmin) / 1000) * w;
            const boxH = ((ymax - ymin) / 1000) * h;
            const hash = ann.label.split('').reduce((a,b)=>a+b.charCodeAt(0),0);
            const color = `hsl(${hash % 360}, 80%, 50%)`;
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.max(3, w / 400);
            ctx.strokeRect(x, y, boxW, boxH);
            ctx.fillStyle = color;
            const fontSize = Math.max(14, w / 60);
            ctx.font = `bold ${fontSize}px Arial`;
            const text = ann.label;
            const textW = ctx.measureText(text).width;
            ctx.fillRect(x, y - fontSize - 6, textW + 10, fontSize + 6);
            ctx.fillStyle = 'white';
            ctx.fillText(text, x + 5, y - 6);
        }

        function renderTimeline() {
            els.timelineResults.classList.remove('hidden');
            const sorted = [...state.videoAnnotations].sort((a,b) => a.time - b.time);
            els.timelineContent.innerHTML = sorted.map(ann => `
                <div class="p-3 hover:bg-indigo-50 cursor-pointer flex justify-between items-center transition-colors" onclick="seekTo(${ann.time})">
                    <div>
                        <span class="font-mono text-indigo-600 font-bold mr-2">${ann.time.toFixed(2)}s</span>
                        <span class="font-medium text-gray-800">${ann.label}</span>
                    </div>
                    <span class="text-xs text-gray-400 font-mono">[${ann.box_2d.join(',')}]</span>
                </div>
            `).join('');
        }

        window.seekTo = (t) => {
            els.videoPlayer.currentTime = t;
            drawCurrentVideoFrameOverlay();
        };

        async function extractFrames(videoElement, fps) {
            const duration = videoElement.duration;
            const interval = 1 / fps;
            const frames = [];
            const canvas = document.createElement('canvas');
            canvas.width = videoElement.videoWidth;
            canvas.height = videoElement.videoHeight;
            const ctx = canvas.getContext('2d');
            const originalTime = videoElement.currentTime;
            for(let t = 0; t < duration; t += interval) {
                videoElement.currentTime = t;
                await new Promise(r => {
                    const h = () => { videoElement.removeEventListener('seeked', h); r(); };
                    videoElement.addEventListener('seeked', h);
                });
                ctx.drawImage(videoElement, 0, 0);
                frames.push({ time: t, base64: canvas.toDataURL('image/jpeg', 0.6).split(',')[1] });
                updateProgress((t/duration)*100, `提取帧: ${frames.length} (${Math.round(t)}s)`);
            }
            videoElement.currentTime = originalTime;
            return frames;
        }

        async function callAPI(config, messages) {
            const response = await fetch(config.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.key}` },
                body: JSON.stringify({ model: config.model, messages: messages })
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const content = data.choices[0].message.content;
            let jsonStr = content;
            const codeBlock = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/\[[\s\S]*\]/);
            if(codeBlock) jsonStr = codeBlock[1] || codeBlock[0];
            try { return JSON.parse(jsonStr); } catch (e) { console.warn("JSON Parse Failed", content); return []; }
        }

        function fileToBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.readAsDataURL(file);
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = error => reject(error);
            });
        }

        function updateProgress(pct, text) {
            els.progress.fill.style.width = `${pct}%`;
            els.progress.pct.innerText = `${Math.round(pct)}%`;
            if(text) els.progress.text.innerText = text;
        }

        function setLoading(isLoading) {
            els.startBtn.disabled = isLoading;
            els.loader.style.display = isLoading ? 'block' : 'none';
            els.btnText.innerText = isLoading ? 'AI 处理中...' : '开始分析';
        }