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
        // UI 绑定逻辑保持不变...
        const pauseBtn = document.getElementById('pauseBtn');
        const resumeBtn = document.getElementById('resumeBtn');
        const stopBtn = document.getElementById('stopBtn');
        const taskMenuBtn = document.getElementById('taskMenuBtn');
        const taskMenu = document.getElementById('taskMenu');
        const exportTaskBtn = document.getElementById('exportTaskBtn');
        const exportGitHubBtn = document.getElementById('exportGitHubBtn');
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
        if (exportGitHubBtn) exportGitHubBtn.onclick = () => {
            this.showGitHubExportModal();
        };
        
        // Modal 逻辑
        const confirmExportBtn = document.getElementById('confirmExportBtn');
        const cancelExportBtn = document.getElementById('cancelExportBtn');
        const githubExportModal = document.getElementById('githubExportModal');

        if (confirmExportBtn) confirmExportBtn.onclick = () => {
            this.confirmGitHubExport();
        };
        if (cancelExportBtn) cancelExportBtn.onclick = () => {
            if (githubExportModal) githubExportModal.classList.add('hidden');
        };

        if (githubExportModal) {
            githubExportModal.addEventListener('click', (e) => {
                if (e.target === githubExportModal) githubExportModal.classList.add('hidden');
            });
        }
        
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
                if (e.target.files.length > 0) this.importTask(e.target.files[0]);
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

        this.originalRunWithConcurrency = window.runWithConcurrency;
        window.runWithConcurrency = this.runWithConcurrencyOverride.bind(this);
    },

    // 辅助逻辑... (startTaskLifecycle, pause, resume, stop 等保持不变)
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
            this.resume(); 
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
        if (!state.isVideoMode) {
            state.imageResults.forEach(r => processedNames.add(r.fileName));
        }

        let index = 0;
        const total = items.length;

        const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
            while (index < items.length) {
                if (this.isStopped) break;
                while (this.isPaused) {
                    if (this.isStopped) break;
                    await new Promise(r => setTimeout(r, 500));
                }
                if (this.isStopped) break;

                const currentIndex = index++; 
                if (currentIndex >= items.length) break;
                const item = items[currentIndex];

                if (!state.isVideoMode && processedNames.has(item.name)) continue;

                try {
                    await worker(item);
                } catch (err) {
                    console.error("Worker error:", err);
                }
            }
        });

        await Promise.all(runners);
        this.endTaskLifecycle();
        if (this.isStopped) els.statusMsg.textContent = '任务已手动结束';
    },

    /**
     * 导出/备份任务
     */
    async exportTask(isBackup = false) {
        if (!state.files || state.files.length === 0) {
            if (!isBackup) alert('没有可导出的任务数据');
            return;
        }

        const statusMsg = els.statusMsg.textContent;
        if (!isBackup) els.statusMsg.textContent = '正在打包任务数据...';

        try {
            const zip = new JSZip();
            
            // 关键点：保存模型名（CONFIGS 的键名）用于之后恢复 UI
            const taskConfig = {
                timestamp: Date.now(),
                mode: state.isVideoMode ? 'video' : 'image',
                model: els.modelSelect.value, // 模型名，例如 'gemini_3_flash_X666_'
                prompt: els.promptInput.value,
                scaleFactor: els.scaleFactor.value,
                frameRate: document.getElementById('frameRate') ? document.getElementById('frameRate').value : '1',
                apiRpm: els.apiRpm.value,
                parallelCount: els.parallelCountGlobal.value,
                results: (state.isVideoMode ? state.videoResults : state.imageResults).map(item => {
                    const copy = { ...item };
                    delete copy.file; 
                    return copy;
                })
            };

            zip.file("task_config.json", JSON.stringify(taskConfig, null, 2));

            const filesFolder = zip.folder("files");
            for (const file of state.files) {
                filesFolder.file(file.name, file);
            }

            const content = await zip.generateAsync({ type: "blob" });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(content);
            a.download = isBackup ? `autotag_backup_${Date.now()}.zip` : `autotag_task_export_${Date.now()}.zip`;
            a.click();
            if (!isBackup) els.statusMsg.textContent = '任务导出完成';

        } catch (e) {
            console.error('Export failed', e);
            els.statusMsg.textContent = '导出失败: ' + e.message;
        } finally {
            if (!isBackup) setTimeout(() => els.statusMsg.textContent = statusMsg, 2000);
        }
    },

    /**
     * 导入任务并恢复
     */
    async importTask(zipFile) {
        els.statusMsg.textContent = '正在导入任务...';
        try {
            const zip = await JSZip.loadAsync(zipFile);
            const configText = await zip.file("task_config.json").async("string");
            const taskConfig = JSON.parse(configText);

            // 恢复模式
            if ((taskConfig.mode === 'video' && !state.isVideoMode) || (taskConfig.mode === 'image' && state.isVideoMode)) {
                els.modeToggle.checked = (taskConfig.mode === 'video');
                els.modeToggle.dispatchEvent(new Event('change'));
            }
            
            // 关键点：恢复模型选中状态。由于 main.js 的 initModelSelect 将 option.value 设为模型名，
            // 这里的 taskConfig.model 正是对应的键名。
            els.modelSelect.value = taskConfig.model || els.modelSelect.value;
            els.promptInput.value = taskConfig.prompt || '';
            if (taskConfig.scaleFactor) els.scaleFactor.value = taskConfig.scaleFactor;
            if (taskConfig.frameRate) {
                const fpsInput = document.getElementById('frameRate');
                if (fpsInput) fpsInput.value = taskConfig.frameRate;
            }
            if (taskConfig.apiRpm) els.apiRpm.value = taskConfig.apiRpm;
            if (taskConfig.parallelCount) els.parallelCountGlobal.value = taskConfig.parallelCount;

            // 恢复文件
            const filesFolder = zip.folder("files");
            const restoredFiles = [];
            const filePromises = [];
            filesFolder.forEach((relativePath, fileEntry) => {
                filePromises.push(async () => {
                    const blob = await fileEntry.async("blob");
                    restoredFiles.push(new File([blob], relativePath, { type: blob.type }));
                });
            });
            await Promise.all(filePromises.map(fn => fn()));
            restoredFiles.sort((a, b) => a.name.localeCompare(b.name));
            
            state.files = restoredFiles;
            state.file = restoredFiles[0];
            renderFileList(); 

            // 恢复结果
            const restoredResults = taskConfig.results.map(r => {
                const matchingFile = restoredFiles.find(f => f.name === r.fileName);
                return { ...r, file: matchingFile };
            });

            if (taskConfig.mode === 'video') {
                state.videoResults = restoredResults;
            } else {
                state.imageResults = restoredResults;
                document.getElementById('timelineContent').innerHTML = ''; 
                document.getElementById('cropGallery').innerHTML = ''; 
                restoredResults.forEach((r, idx) => {
                    appendTimelineItem(r.file, r.annotations, idx);
                    appendCropGallery(r.annotations);
                });
            }
            els.statusMsg.textContent = `导入成功，已恢复 ${restoredResults.length} 个结果`;

            if (confirm(`导入成功！共 ${restoredFiles.length} 个文件，已完成 ${restoredResults.length} 个。\n是否立即继续任务？`)) {
                startAnalysis();
            }

        } catch (e) {
            console.error('Import failed', e);
            alert('导入任务失败: ' + e.message);
            els.statusMsg.textContent = '导入失败';
        }
    },

    // GitHub 导出 Modal 部分保持不变...
    showGitHubExportModal() {
        if (!state.files || state.files.length === 0) {
            alert('没有可导出的文件');
            return;
        }
        const modal = document.getElementById('githubExportModal');
        const modeLabel = document.getElementById('exportModeLabel');
        const optionsList = document.getElementById('exportOptionsList');
        const taskMenu = document.getElementById('taskMenu');
        if (taskMenu) taskMenu.classList.add('hidden');
        modeLabel.textContent = state.isVideoMode ? '视频模式' : '图片模式';
        optionsList.innerHTML = '';
        const options = state.isVideoMode ? [
            { id: 'original', label: '原视频 (Original Videos)', desc: '未处理的原始视频文件' },
            { id: 'tracked_video', label: '带有标记框的追踪视频 (Tracked Videos)', desc: 'Tracked Videos' },
            { id: 'frames', label: '视频抽帧图片 (Extracted Frames)', desc: '提取的原始图片序列' },
            { id: 'yolo_txt', label: '帧标记文件 (YOLO Labels .txt)', desc: '每一帧的 YOLO 标记文件' },
            { id: 'classes', label: '类别文件 (classes.txt)', desc: '类别列表' }
        ] : [
            { id: 'original', label: '原图片 (Original Images)', desc: '未处理的原始图片文件' },
            { id: 'tagged', label: '带有标记框的图片 (Tagged Images)', desc: '识别框渲染图片' },
            { id: 'crop', label: '裁剪预览图片 (Cropped Objects)', desc: '裁剪出的单个目标图片' },
            { id: 'transparent', label: '透明底图片 (Transparent Objects)', desc: '去除背景的 PNG 图片' },
            { id: 'yolo_txt', label: 'YOLO 标记文件 (YOLO Labels .txt)', desc: 'YOLO 坐标标记文件' },
            { id: 'classes', label: '类别文件 (classes.txt)', desc: '类别列表' }
        ];
        options.forEach(opt => {
            const div = document.createElement('div');
            div.className = 'flex items-start gap-2 p-2 rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition cursor-pointer';
            const isChecked = ['yolo_txt', 'classes'].includes(opt.id);
            div.innerHTML = `<input type="checkbox" id="opt_${opt.id}" value="${opt.id}" class="mt-1 w-4 h-4 text-indigo-600 rounded" ${isChecked ? 'checked' : ''}>
                <label for="opt_${opt.id}" class="cursor-pointer">
                    <div class="text-sm font-medium text-gray-700 dark:text-gray-200">${opt.label}</div>
                    <div class="text-xs text-gray-500 dark:text-gray-400">${opt.desc}</div>
                </label>`;
            optionsList.appendChild(div);
        });
        modal.classList.remove('hidden');
    },

    async confirmGitHubExport() {
        const modal = document.getElementById('githubExportModal');
        const checkboxes = modal.querySelectorAll('input[type="checkbox"]:checked');
        const selected = Array.from(checkboxes).map(cb => cb.value);
        if (selected.length === 0) return alert('请选择导出格式');
        modal.classList.add('hidden');
        await this.exportGitHubPackage(selected.join(','));
    },

    /**
     * 导出 GitHub 工作流包
     */
    async exportGitHubPackage(formatStr) {
        if (!state.files || state.files.length === 0) return alert('没有可导出的文件');
        
        const statusMsg = els.statusMsg.textContent;
        els.statusMsg.textContent = '正在打包 GitHub 工作流数据...';
        
        try {
            const zip = new JSZip();
            
            // 关键点：在 workflow_config.json 中保存模型名（键名）
            // 例如保存为 'gemini_3_flash_X666_'，GitHub Action 脚本会通过这个字符串去 Secret 找 KEY
            const config = {
                model: els.modelSelect.value, // 模型名，用于脚本匹配 Secret
                prompt: els.promptInput.value,
                mode: state.isVideoMode ? 'video' : 'image',
                exportFormat: formatStr,
                scaleFactor: els.scaleFactor.value,
                apiRpm: els.apiRpm.value,
                parallelCount: els.parallelCountGlobal.value
            };
            zip.file("workflow_config.json", JSON.stringify(config, null, 2));
            
            const mediaZip = new JSZip();
            for (const file of state.files) {
                mediaZip.file(file.name, file);
            }
            const mediaZipBlob = await mediaZip.generateAsync({ type: "blob" });
            zip.file("media.zip", mediaZipBlob);
            zip.file("README_FOR_GITHUB.txt", "请将本包内的 media.zip 和 workflow_config.json 解压并上传到您的 GitHub 仓库根目录。");
            
            const content = await zip.generateAsync({ type: "blob" });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(content);
            a.download = `autotag_github_package_${Date.now()}.zip`;
            a.click();
            
            els.statusMsg.textContent = 'GitHub 包导出完成';
        } catch (e) {
            console.error(e);
            els.statusMsg.textContent = '导出失败: ' + e.message;
        } finally {
            setTimeout(() => els.statusMsg.textContent = statusMsg, 2000);
        }
    }
};

// 初始化确保绑定
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => TaskManager.init());
} else {
    TaskManager.init();
}
