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
            this.resume(); // 确保如果暂停中也能退出循环
            // UI更新会在任务循环退出后由主逻辑处理，或者在这里强制更新
            // 但最好等待 processImagesBatch 退出
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

    // 覆盖的并发执行器
    async runWithConcurrencyOverride(items, worker, concurrency) {
        this.startTaskLifecycle();
        
        // 找出还未处理的项目（如果是断点续传）
        // 这里假设 items 是完整列表，我们需要跳过已经有结果的
        // 但是 main.js 中的逻辑是每次重新 processImagesBatch 都会清空 imageResults 或者重新开始
        // 所以我们需要在 processImagesBatch 调用前处理好 items，或者在这里跳过
        
        // 由于 main.js 的 processImagesBatch 逻辑比较死板，我们主要控制 pause/stop
        // 对于断点续传，我们会在 importTask 中恢复 state.imageResults，
        // 并修改传入 processImagesBatch 的 files 列表，或者让 worker 检查是否已存在结果
        
        // 更好的方式：items 是 files。我们检查 state.imageResults 中是否已经有该 file 的结果
        // 但 file 对象可能不同（如果是导入的）。我们需要根据 fileName 匹配。
        
        const processedNames = new Set();
        if (state.isVideoMode) {
            // For videos, we don't just skip. We might need to resume PARTIALLY processed videos.
            // analyzeVideoFile handles partial resume internally by checking state.videoResults.
            // So we only skip if the video is FULLY processed (how to determine? maybe a flag or if user considers it done?)
            // Currently, analyzeVideoFile logic will resume from where it left off. 
            // So we should NOT skip files here for video mode unless we are sure it's 100% done.
            // But we don't have a 100% done flag.
            // However, analyzeVideoFile returns quickly if it's done. 
            // So for video mode, we can let the worker run, and analyzeVideoFile will handle it.
            // BUT, if we have multiple videos, and 4 are done, 1 is half done.
            // We want to skip the 4 done ones?
            // Let's assume for now we don't skip in TaskManager for video, relying on analyzeVideoFile's fast-forward.
            // Wait, if we don't skip, worker runs, creates video element, extracts frames... that takes time.
            // We should optimization skip if we know it's done.
            
            // Let's iterate and check if there's a COMPLETE result? 
            // Since we don't have a complete flag, let's just stick to the original logic:
            // IF it's in the results list, it's "processed" according to original logic.
            // BUT now we have partial results.
            // If we mark partial results with `isPartial` flag (added in main.js), we can check that.
            
            state.videoResults.forEach(r => {
                if (!r.isPartial) {
                     // Only skip if NOT partial (meaning it's fully done or imported as done)
                     // When importing, we don't set isPartial, so imported results are treated as "done" by default?
                     // If imported result is actually partial (from the user's perspective, lost frames),
                     // we want to process it.
                     // The issue is: Import logic just restores `state.videoResults`. It doesn't know if it was finished or not.
                     // So we probably should NOT skip here for videos, and let analyzeVideoFile check the frame count?
                     // Or we simply don't populate processedNames for video mode, and let analyzeVideoFile handle the "Resume" logic.
                     // Yes, let's clear processedNames for video to rely on frame-level resume.
                } else {
                    // It is partial, so we definitely need to process it.
                }
            });
            // processedNames.clear(); // Disable skipping for video to allow frame-level check
        } else {
            state.imageResults.forEach(r => processedNames.add(r.fileName));
        }

        let index = 0;
        const total = items.length;
        let completed = processedNames.size; // 初始进度

        const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
            while (index < items.length) {
                // Check Stop
                if (this.isStopped) break;

                // Check Pause
                while (this.isPaused) {
                    if (this.isStopped) break;
                    await new Promise(r => setTimeout(r, 500));
                }
                if (this.isStopped) break;

                // Get task
                // 必须原子操作获取 index
                // 由于 JS 单线程，这里是安全的
                const currentIndex = index++; 
                if (currentIndex >= items.length) break;
                
                const item = items[currentIndex];

                // Check if already processed (Resuming)
                if (!state.isVideoMode && processedNames.has(item.name)) {
                    // Skip images only
                    continue;
                }
                
                // For video, we don't skip here, we let analyzeVideoFile handle the resume logic.
                // UNLESS we want to optimize for fully completed videos?
                // If we assume imported results are "what we have", we always want to try to finish them if they have frames?
                // Actually, if a video is truly done, analyzeVideoFile will scan it and see "oh, frames match annotations length" and resolve.
                // So it is safe to run.

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
            
            // 1. 保存元数据 Task Config
            const taskConfig = {
                timestamp: Date.now(),
                mode: state.isVideoMode ? 'video' : 'image',
                model: els.modelSelect.value,
                prompt: els.promptInput.value,
                scaleFactor: els.scaleFactor.value,
                apiRpm: els.apiRpm.value,
                parallelCount: els.parallelCountGlobal.value,
                results: state.isVideoMode ? state.videoResults : state.imageResults
            };

            // 简化 results，去掉 file 引用 (它是 File 对象，无法 JSON)
            // 实际上 main.js 中 imageResults 存了 file 对象。
            // 我们只需要存 fileName，import 时重新关联
            const safeResults = (state.isVideoMode ? state.videoResults : state.imageResults).map(item => {
                const copy = { ...item };
                delete copy.file; // Remove File object
                return copy;
            });
            taskConfig.results = safeResults;

            zip.file("task_config.json", JSON.stringify(taskConfig, null, 2));

            // 2. 保存文件 (User Uploaded Files)
            const filesFolder = zip.folder("files");
            
            // 为了避免重复读取大文件，如果是从本地 File 对象读取
            for (const file of state.files) {
                filesFolder.file(file.name, file);
            }

            const content = await zip.generateAsync({ type: "blob" });
            
            if (isBackup) {
                // 自动下载备份
                const a = document.createElement('a');
                a.href = URL.createObjectURL(content);
                a.download = `autotag_backup_${Date.now()}.zip`;
                a.click();
                console.log('Auto backup completed.');
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
            
            // 1. 读取配置
            const configText = await zip.file("task_config.json").async("string");
            const taskConfig = JSON.parse(configText);

            // 2. 恢复 UI 状态
            if ((taskConfig.mode === 'video' && !state.isVideoMode) || (taskConfig.mode === 'image' && state.isVideoMode)) {
                els.modeToggle.checked = (taskConfig.mode === 'video');
                // Trigger change event
                els.modeToggle.dispatchEvent(new Event('change'));
            }
            
            els.modelSelect.value = taskConfig.model || els.modelSelect.value;
            els.promptInput.value = taskConfig.prompt || '';
            if (taskConfig.scaleFactor) els.scaleFactor.value = taskConfig.scaleFactor;
            if (taskConfig.apiRpm) els.apiRpm.value = taskConfig.apiRpm;
            if (taskConfig.parallelCount) els.parallelCountGlobal.value = taskConfig.parallelCount;

            // 3. 恢复文件
            const filesFolder = zip.folder("files");
            const restoredFiles = [];
            
            const filePromises = [];
            filesFolder.forEach((relativePath, fileEntry) => {
                filePromises.push(async () => {
                    const blob = await fileEntry.async("blob");
                    // 重建 File 对象
                    const file = new File([blob], relativePath, { type: blob.type });
                    restoredFiles.push(file);
                });
            });

            // 等待所有文件解压
            await Promise.all(filePromises.map(fn => fn()));
            
            // 排序可能乱了，不过通常不影响，或者按文件名排
            restoredFiles.sort((a, b) => a.name.localeCompare(b.name));
            
            // 更新 State
            state.files = restoredFiles;
            state.file = restoredFiles[0];
            renderFileList(); // Update Sidebar

            // 4. 恢复已有结果
            // 需要将 results 中的 file 引用指回 restoredFiles 中的对象
            const restoredResults = taskConfig.results.map(r => {
                const matchingFile = restoredFiles.find(f => f.name === r.fileName);
                return {
                    ...r,
                    file: matchingFile
                };
            });

            if (taskConfig.mode === 'video') {
                state.videoResults = restoredResults;
                els.statusMsg.textContent = `已恢复 ${restoredResults.length} 个视频的处理结果`;
            } else {
                state.imageResults = restoredResults;
                // 恢复时间轴和 Gallery
                document.getElementById('timelineContent').innerHTML = ''; // Clear
                document.getElementById('cropGallery').innerHTML = ''; // Clear
                
                restoredResults.forEach((r, idx) => {
                    appendTimelineItem(r.file, r.annotations, idx);
                    appendCropGallery(r.annotations);
                });
                
                els.statusMsg.textContent = `已恢复 ${restoredResults.length} 张图片的处理结果`;
            }

            // 5. 自动继续任务？
            // 询问用户是否继续
            if (confirm(`导入成功！共 ${restoredFiles.length} 个文件，已完成 ${restoredResults.length} 个。\n是否立即从断点继续执行？`)) {
                startAnalysis();
            }

        } catch (e) {
            console.error('Import failed', e);
            alert('导入任务失败: ' + e.message);
            els.statusMsg.textContent = '导入失败';
        }
    }
};

// 初始化
// 确保 DOM 加载完成后执行
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => TaskManager.init());
} else {
    TaskManager.init();
}
