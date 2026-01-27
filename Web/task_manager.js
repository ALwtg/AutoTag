/**
 * 任务管理模块 (Task Manager)
 * 负责任务的暂停、恢复、结束、导出(备份)与导入(断点续传)
 */

const TaskManager = {
    isPaused: false,
    isStopped: false,
    backupIntervalId: null,
    autoBackupEnabled: true,
    backupIntervalMinutes: 30,

    init() {
        // UI Binding
        const pauseBtn = document.getElementById('pauseBtn');
        const resumeBtn = document.getElementById('resumeBtn');
        const stopBtn = document.getElementById('stopBtn');
        const taskMenuBtn = document.getElementById('taskMenuBtn');
        const taskMenu = document.getElementById('taskMenu');
        const exportTaskBtn = document.getElementById('exportTaskBtn');
        const importInput = document.getElementById('importTaskInput');
        const backupIntervalInput = document.getElementById('autoBackupInterval');
        const backupEnabledInput = document.getElementById('autoBackupEnabled');

        if (pauseBtn) pauseBtn.onclick = () => this.pause();
        if (resumeBtn) resumeBtn.onclick = () => this.resume();
        if (stopBtn) stopBtn.onclick = () => this.stop();
        if (exportTaskBtn) exportTaskBtn.onclick = () => {
            this.exportTask(false);
            taskMenu.classList.add('hidden');
        };
        
        if (taskMenuBtn && taskMenu) {
            taskMenuBtn.onclick = (e) => {
                e.stopPropagation();
                // 自动切换对应的导出选项显示
                const isVideo = els.modeToggle.checked;
                const optImg = document.getElementById('exportOptionsImage');
                const optVid = document.getElementById('exportOptionsVideo');
                if(optImg) optImg.classList.toggle('hidden', isVideo);
                if(optVid) optVid.classList.toggle('hidden', !isVideo);
                
                taskMenu.classList.toggle('hidden');
            };
            document.addEventListener('click', (e) => {
                if (!taskMenuBtn.contains(e.target) && !taskMenu.contains(e.target)) {
                    taskMenu.classList.add('hidden');
                }
            });
        }

        if (importInput) {
            importInput.onchange = (e) => {
                if (e.target.files.length > 0) {
                    this.importTask(e.target.files[0]);
                }
                // 清空 input，允许重复导入同名文件
                e.target.value = ''; 
                taskMenu.classList.add('hidden');
            };
        }

        if (backupIntervalInput) {
            backupIntervalInput.onchange = (e) => {
                this.backupIntervalMinutes = parseInt(e.target.value) || 30;
                this.resetAutoBackup();
            };
        }

        if (backupEnabledInput) {
            backupEnabledInput.onchange = (e) => {
                this.autoBackupEnabled = e.target.checked;
                this.resetAutoBackup();
            };
        }

        // 覆盖原始的并发执行函数以注入暂停/停止逻辑
        this.originalRunWithConcurrency = window.runWithConcurrency;
        window.runWithConcurrency = this.runWithConcurrencyOverride.bind(this);
    },

    startTaskLifecycle() {
        this.isPaused = false;
        this.isStopped = false;
        this.updateUIState('running');
        this.resetAutoBackup();
    },

    endTaskLifecycle() {
        this.isPaused = false;
        this.isStopped = false;
        this.updateUIState('idle');
        this.stopAutoBackup();
    },

    pause() {
        this.isPaused = true;
        this.updateUIState('paused');
        els.statusMsg.textContent = '任务已暂停...';
    },

    resume() {
        this.isPaused = false;
        this.updateUIState('running');
        els.statusMsg.textContent = '任务继续执行...';
    },

    stop() {
        if (confirm('确定要结束当前任务吗？结束后的数据可以正常导出。')) {
            this.isStopped = true;
            this.resume(); // 恢复以跳出循环
        }
    },

    updateUIState(state) {
       const startBtn = document.getElementById('startBtn');
        const taskControls = document.getElementById('taskControls');
        const pauseBtn = document.getElementById('pauseBtn');
        const resumeBtn = document.getElementById('resumeBtn');

        if (state === 'idle') {
            startBtn.classList.remove('hidden');
            taskControls.classList.add('hidden');
            // 确保按钮可用
            startBtn.disabled = false;
            startBtn.classList.remove('bg-gray-400', 'cursor-not-allowed');
            startBtn.classList.add('bg-indigo-600', 'hover:bg-indigo-700');
        } else if (state === 'running') {
            startBtn.classList.add('hidden');
            taskControls.classList.remove('hidden');
            pauseBtn.classList.remove('hidden');
            resumeBtn.classList.add('hidden');
        } else if (state === 'paused') {
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.remove('hidden');
        }
    },

    resetAutoBackup() {
        this.stopAutoBackup();
        if (this.autoBackupEnabled && (state.isProcessing || this.isPaused)) {
            console.log(`Auto backup scheduled every ${this.backupIntervalMinutes} minutes.`);
            this.backupIntervalId = setInterval(() => {
                this.exportTask(true);
            }, this.backupIntervalMinutes * 60 * 1000);
        }
    },

    stopAutoBackup() {
        if (this.backupIntervalId) {
            clearInterval(this.backupIntervalId);
            this.backupIntervalId = null;
        }
    },
    
    async runWithConcurrencyOverride(items, worker, concurrency) {
        this.startTaskLifecycle();
        const processedNames = new Set();
        
        // 只有非视频模式才跳过已处理的；视频模式可能需要继续
        if (!state.isVideoMode) {
            state.imageResults.forEach(r => processedNames.add(r.fileName));
        } else {
             // 视频模式下由 worker 内部逻辑判断是否断点续传，这里不跳过
        }

        let index = 0;
        const total = items.length;
        
        // 并发 Promise 池
        const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
            while (index < items.length) {
                if (this.isStopped) break;
                
                // 暂停检查
                while (this.isPaused) {
                    if (this.isStopped) break;
                    await new Promise(r => setTimeout(r, 500));
                }
                if (this.isStopped) break;

                // 取任务
                const currentIndex = index++; 
                if (currentIndex >= items.length) break;
                
                const item = items[currentIndex];

                // 图片模式跳过逻辑
                if (!state.isVideoMode && processedNames.has(item.name)) {
                    continue;
                }
                
                try {
                    await worker(item);
                } catch (err) {
                    console.error("Worker error:", err);
                }
            }
        });

        await Promise.all(runners);
        this.endTaskLifecycle();
        if (this.isStopped) {
            els.statusMsg.textContent = '任务已手动结束';
        }
    },

    async exportTask(isBackup = false) {
        if (!state.files || state.files.length === 0) {
            if (!isBackup) alert('没有可导出的任务数据');
            return;
        }

        const statusMsg = els.statusMsg.textContent;
        if (!isBackup) els.statusMsg.textContent = '正在打包任务数据...';

        try {
            const zip = new JSZip();
            
            const isVideo = state.isVideoMode;
            const exportOpts = [];
            const checkboxes = document.querySelectorAll(isVideo ? 'input[name="exportOptVid"]:checked' : 'input[name="exportOptImg"]:checked');
            checkboxes.forEach(cb => exportOpts.push(cb.value));

            // 获取视频相关的设置
            const frameRateInput = document.getElementById('frameRate');
            const manualFrameInput = document.getElementById('manualFrame');

            // 保存元数据
            const taskConfig = {
                timestamp: Date.now(),
                mode: isVideo ? 'video' : 'image',
                model: els.modelSelect.value,
                prompt: els.promptInput.value,
                classLabel: els.classLabelInput.value, // 保存类别名
                scaleFactor: els.scaleFactor.value,
                apiRpm: els.apiRpm.value,
                parallelCount: els.parallelCountGlobal.value,
                exportOptions: exportOpts,
                // [NEW] 保存视频设置，用于导入时恢复UI
                frameRate: frameRateInput ? frameRateInput.value : '1',
                manualFrame: manualFrameInput ? manualFrameInput.checked : false,
                // 保存结果数据 (移除 file 引用)
                results: isVideo ? state.videoResults : state.imageResults
            };

            const safeResults = (isVideo ? state.videoResults : state.imageResults).map(item => {
                const copy = { ...item };
                delete copy.file; // 移除 File 对象避免循环引用
                return copy;
            });
            taskConfig.results = safeResults;

            zip.file("task_config.json", JSON.stringify(taskConfig, null, 2));

            // 保存源文件
            const filesFolder = zip.folder("files");
            for (const file of state.files) {
                filesFolder.file(file.name, file);
            }

            const content = await zip.generateAsync({ type: "blob" });
            
            if (isBackup) {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(content);
                a.download = `autotag_backup_${Date.now()}.zip`;
                a.click();
            } else {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(content);
                a.download = `autotag_task_export_${Date.now()}.zip`;
                a.click();
                els.statusMsg.textContent = '任务导出完成';
            }

        } catch (e) {
            console.error('Export failed', e);
            els.statusMsg.textContent = '导出失败: ' + e.message;
        } finally {
            if (!isBackup) setTimeout(() => els.statusMsg.textContent = statusMsg, 2000);
        }
    },

    async importTask(zipFile) {
        els.statusMsg.textContent = '正在导入任务...';
        try {
            const zip = await JSZip.loadAsync(zipFile);
            const configText = await zip.file("task_config.json").async("string");
            const taskConfig = JSON.parse(configText);

            // 1. 恢复模式
            if ((taskConfig.mode === 'video' && !state.isVideoMode) || (taskConfig.mode === 'image' && state.isVideoMode)) {
                els.modeToggle.checked = (taskConfig.mode === 'video');
                els.modeToggle.dispatchEvent(new Event('change'));
            }
            
            // 2. 恢复通用UI设置
            els.modelSelect.value = taskConfig.model || els.modelSelect.value;
            els.promptInput.value = taskConfig.prompt || '';
            if (els.classLabelInput) els.classLabelInput.value = taskConfig.classLabel || ''; // 恢复类别名
            if (taskConfig.scaleFactor) els.scaleFactor.value = taskConfig.scaleFactor;
            if (taskConfig.parallelCount) els.parallelCountGlobal.value = taskConfig.parallelCount;
            
            // 3. [NEW] 恢复视频模式特有设置 (FPS 和 手动抽帧状态)
            if (taskConfig.mode === 'video') {
                if (taskConfig.frameRate && document.getElementById('frameRate')) {
                    document.getElementById('frameRate').value = taskConfig.frameRate;
                }
                if (taskConfig.manualFrame !== undefined && document.getElementById('manualFrame')) {
                    const cb = document.getElementById('manualFrame');
                    cb.checked = taskConfig.manualFrame;
                    // 触发事件以显示/隐藏 FPS 输入框（依赖 main.js 的事件监听）
                    cb.dispatchEvent(new Event('change')); 
                }
            }

            // 4. 恢复复选框 (导出选项)
            if (taskConfig.exportOptions) {
                const isVideo = (taskConfig.mode === 'video');
                const checkboxes = document.querySelectorAll(isVideo ? 'input[name="exportOptVid"]' : 'input[name="exportOptImg"]');
                checkboxes.forEach(cb => {
                    cb.checked = taskConfig.exportOptions.includes(cb.value);
                });
            }

            // 5. 恢复文件对象
            const filesFolder = zip.folder("files");
            const restoredFiles = [];
            const filePromises = [];
            filesFolder.forEach((relativePath, fileEntry) => {
                filePromises.push(async () => {
                    const blob = await fileEntry.async("blob");
                    const file = new File([blob], relativePath, { type: blob.type });
                    restoredFiles.push(file);
                });
            });

            await Promise.all(filePromises.map(fn => fn()));
            // 按文件名排序，保证列表顺序一致
            restoredFiles.sort((a, b) => a.name.localeCompare(b.name));
            
            state.files = restoredFiles;
            state.file = restoredFiles[0];
            
            // 重要：重置视频状态，因为导入后需要重新走“抽帧”流程（利用缓存或重新解码）
            if (taskConfig.mode === 'video') {
                state.videoAnalysisReady = false; 
                state.videoFramesCache = new Map(); // 清空旧缓存
                els.btnText.textContent = "开始抽帧";
            }
            
            renderFileList();

            // 6. 恢复分析结果
            const restoredResults = taskConfig.results.map(r => {
                const matchingFile = restoredFiles.find(f => f.name === r.fileName);
                return { ...r, file: matchingFile, fps: r.fps || parseFloat(taskConfig.frameRate || 1) };
            });

            if (taskConfig.mode === 'video') {
                state.videoResults = restoredResults;
                els.statusMsg.textContent = `已恢复 ${restoredResults.length} 个视频的处理记录`;
            } else {
                state.imageResults = restoredResults;
                document.getElementById('timelineContent').innerHTML = '';
                document.getElementById('cropGallery').innerHTML = '';
                restoredResults.forEach((r, idx) => {
                    if(r.annotations && r.annotations.length > 0) {
                        appendTimelineItem(r.file, r.annotations, idx);
                        appendCropGallery(r.annotations);
                    }
                });
                els.statusMsg.textContent = `已恢复 ${restoredResults.length} 张图片的处理结果`;
            }

            // 7. 自动开始/继续
            if (confirm(`导入成功！共 ${restoredFiles.length} 个文件。\n是否立即恢复现场并继续执行？\n(视频任务将根据保存的FPS自动重新定位，数据不会丢失)`)) {
                // 调用 main.js 的 startAnalysis，它会自动判断是抽帧还是分析
                window.startAnalysis(); 
            }

        } catch (e) {
            console.error('Import failed', e);
            alert('导入任务失败: ' + e.message);
            els.statusMsg.textContent = '导入失败';
        }
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => TaskManager.init());
} else {
    TaskManager.init();
}
