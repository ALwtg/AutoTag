import os
import json
import zipfile
import glob
import shutil
import base64
import time
import re
import requests
import cv2
import hashlib
import numpy as np
import threading
import tempfile
from datetime import datetime
from tqdm import tqdm
from concurrent.futures import ThreadPoolExecutor, as_completed

# 全局变量
CONFIGS = {}
DEFAULT_MODEL_KEY = 'gemini-3-flash' 

# --- 工具类：精准速率限制器 ---
class TimeWindowRateLimiter:
    """线程安全的滑动窗口限流器"""
    def __init__(self, rpm):
        self.rpm = int(rpm) if rpm else 60
        self.history = []
        self.lock = threading.Lock()
        
    def wait(self):
        if self.rpm <= 0: return
        with self.lock:
            while True:
                now = time.time()
                while self.history and self.history[0] <= now - 60:
                    self.history.pop(0)
                if len(self.history) < self.rpm:
                    self.history.append(now)
                    return
                wait_time = 60 - (now - self.history[0]) + 0.1
                if wait_time > 0: time.sleep(wait_time)

def load_config_from_js():
    """读取 config.js"""
    global CONFIGS
    current_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(current_dir)
    paths_to_check = [os.path.join(parent_dir, "config.js"), os.path.join(current_dir, "config.js")]
    
    config_path = None
    for p in paths_to_check:
        if os.path.exists(p):
            config_path = p
            break
            
    if not config_path:
        print(f"[ERROR] Config file not found.")
        return False

    print(f"[*] Loading config from: {config_path}")
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            content = f.read()
            
        main_block = re.search(r'const\s+CONFIGS\s*=\s*\{([\s\S]*?)\};', content)
        if not main_block: return False

        block_content = main_block.group(1)
        current_model = None
        lines = block_content.split('\n')
        for line in lines:
            line = line.strip()
            if not line or line.startswith('//'): continue
            model_match = re.match(r"['\"]?([\w\-\.]+)['\"]?\s*:\s*\{", line)
            if model_match:
                current_model = model_match.group(1)
                CONFIGS[current_model] = {}
                continue
            if current_model and ':' in line:
                val_match = re.match(r"['\"]?(\w+)['\"]?\s*:\s*['\"]([^'\"]+)['\"]", line)
                if val_match:
                    k, v = val_match.groups()
                    CONFIGS[current_model][k] = v
        return True
    except Exception as e:
        print(f"[EXCEPTION] Failed to parse config.js: {e}")
        return False

class AutoTagRunner:
    def __init__(self, zip_path):
        self.zip_path = zip_path
        self.task_name = os.path.splitext(os.path.basename(zip_path))[0]
        self.base_dir = os.path.dirname(os.path.abspath(zip_path))
        
        self.result_dir = os.path.join(self.base_dir, "Result", self.task_name)
        self.work_dir = os.path.join(self.result_dir, "temp_work")
        self.cache_dir = os.path.join(self.work_dir, "cache_progress") 
        
        os.makedirs(self.result_dir, exist_ok=True)

        self.config = None
        self.files_dir = None
        self.unified_class_map = {}
        self.next_class_id = 0
        self.rate_limiter = None 
        self.parallel_count = 3 

    def log(self, msg):
        print(f"[{self.task_name}] {msg}")

    def extract_task(self):
        """
        核心修复：智能判断是解压还是续传
        优先检查 temp_work 中是否有有效缓存文件，有则强制续传，防止误删进度。
        """
        need_extract = True
        
        found_config_path = None
        if os.path.exists(self.work_dir):
            for root, dirs, files in os.walk(self.work_dir):
                if "task_config.json" in files:
                    found_config_path = os.path.join(root, "task_config.json")
                    break
        
        has_cache_data = False
        if os.path.exists(self.cache_dir):
            cache_files = [f for f in os.listdir(self.cache_dir) if f.endswith('.json')]
            if len(cache_files) > 0:
                has_cache_data = True

        if found_config_path:
            if has_cache_data:
                self.log(f"Found existing progress ({len(os.listdir(self.cache_dir))} cached items). RESUMING...")
                need_extract = False
            else:
                self.log("Found existing folder but no cache. Resuming/Retrying structure...")
                need_extract = False
                
        if need_extract:
            if os.path.exists(self.work_dir):
                self.log("Work dir outdated or corrupt, clearing...")
                try:
                    shutil.rmtree(self.work_dir)
                except Exception as e:
                    self.log(f"Warning: Failed to clean work dir: {e}")
                    
            os.makedirs(self.work_dir, exist_ok=True)
            self.log("Extracting task package...")
            try:
                with zipfile.ZipFile(self.zip_path, 'r') as zf:
                    zf.extractall(self.work_dir)
            except zipfile.BadZipFile:
                raise Exception("ZIP file is corrupted.")
        
        os.makedirs(self.cache_dir, exist_ok=True)

        config_path = None
        for root, dirs, files in os.walk(self.work_dir):
            if "task_config.json" in files:
                config_path = os.path.join(root, "task_config.json")
                self.files_dir = os.path.join(root, "files")
                break
        
        if not config_path or not os.path.exists(config_path):
            raise FileNotFoundError("task_config.json missing in extracted folder")
            
        with open(config_path, 'r', encoding='utf-8') as f:
            self.config = json.load(f)

        if 'results' not in self.config:
            self.config['results'] = []

        rpm_setting = self.config.get('apiRpm', 60)
        self.rate_limiter = TimeWindowRateLimiter(rpm_setting)
        self.log(f"Rate Limiter: {rpm_setting} RPM")

        self.parallel_count = int(self.config.get('parallelCount', 3))
        if self.parallel_count < 1: self.parallel_count = 1

    def get_class_id(self, label):
        if label not in self.unified_class_map:
            self.unified_class_map[label] = self.next_class_id
            self.next_class_id += 1
        return self.unified_class_map[label]

    def select_api_config(self):
        model_name = self.config.get('model', DEFAULT_MODEL_KEY)
        api_conf = CONFIGS.get(model_name)
        if not api_conf:
            if DEFAULT_MODEL_KEY in CONFIGS: api_conf = CONFIGS[DEFAULT_MODEL_KEY]
            elif len(CONFIGS) > 0: api_conf = list(CONFIGS.values())[0]
            else: raise Exception("No API config available.")
        return api_conf

    def call_api(self, api_conf, prompt, label, base64_img):
        if self.rate_limiter:
            self.rate_limiter.wait()
            
        # Check for multiple labels (space separated)
        labels_list = label.split() if label else []
        is_multi = len(labels_list) > 1
        
        target_label_example = labels_list[0] if is_multi else label
        
        instruction_extra = ""
        if is_multi:
            instruction_extra = f"\nDetect objects from this list: {json.dumps(labels_list)}. Return 'label' exactly as one of them."
        else:
            instruction_extra = f"\nOutput Label MUST be: '{label}'"

        headers = { 'Content-Type': 'application/json', 'Authorization': f"Bearer {api_conf['key']}" }
        system_prompt = f"""Task: Detect objects matching '{prompt}' in the image.
        Output: A strict JSON list of objects.
        Format: [{{"label":"{target_label_example}", "box_2d":[ymin,xmin,ymax,xmax]}}]
        - Coordinates must be normalized to 0-1000 integer scale.
        - [0,0] is top-left, [1000,1000] is bottom-right.
        - If no object is found, return strict empty list: []
        - Do not output markdown code blocks (```json), just raw JSON.{instruction_extra}"""

        payload = {

            "model": api_conf['model'],
            "messages": [{"role": "user", "content": [{"type": "text", "text": system_prompt}, {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_img}"}}]}],
            "response_format": {"type": "json_object"}
        }

        for attempt in range(3):
            try:
                resp = requests.post(api_conf['url'], headers=headers, json=payload, timeout=60)
                if resp.status_code == 429:
                    time.sleep(2 * (attempt + 1))
                    continue 
                if resp.status_code != 200:
                    return []
                
                data = resp.json()
                if 'choices' in data:
                    content = data['choices'][0]['message']['content']
                    json_match = re.search(r'\[[\s\S]*\]', content) or re.search(r'\{[\s\S]*\}', content)
                    
                    if json_match:
                        try:
                            parsed = json.loads(json_match.group(0))
                            if isinstance(parsed, dict):
                                if 'objects' in parsed: return parsed['objects']
                                return [parsed]
                            return parsed if isinstance(parsed, list) else []
                        except:
                            pass
                return []
            except Exception:
                time.sleep(1)
        return []

    def _get_cache_path(self, file_name):
        safe_name = hashlib.md5(file_name.encode('utf-8')).hexdigest()
        return os.path.join(self.cache_dir, safe_name + ".json")

    def _load_cache(self, file_name):
        cache_path = self._get_cache_path(file_name)
        if os.path.exists(cache_path):
            try:
                with open(cache_path, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                return []
        return []

    def _atomic_write_cache(self, file_name, data):
        """原子写入，防止中断导致JSON损坏"""
        cache_path = self._get_cache_path(file_name)
        dir_name = os.path.dirname(cache_path)
        try:
            with tempfile.NamedTemporaryFile('w', dir=dir_name, delete=False, encoding='utf-8') as tf:
                json.dump(data, tf)
                temp_name = tf.name
            
            if os.path.exists(cache_path):
                try:
                    os.replace(temp_name, cache_path)
                except OSError:
                    os.remove(cache_path)
                    os.renames(temp_name, cache_path)
            else:
                os.renames(temp_name, cache_path)
        except Exception as e:
            print(f"Write cache invalid: {e}")

    def _save_cache_simple(self, file_name, new_data):
        """图片模式的简单缓存保存"""
        current_data = self._load_cache(file_name)
        if isinstance(new_data, list):
            current_data.extend(new_data)
        elif isinstance(new_data, dict):
            current_data = [new_data]
        self._atomic_write_cache(file_name, current_data)
        return current_data
    def process_missing_items(self):
        mode = self.config.get('mode', 'image')
        if not self.files_dir or not os.path.exists(self.files_dir):
            self.log(f"Error: Files directory not found at {self.files_dir}")
            return

        all_files = [f for f in os.listdir(self.files_dir) if not f.startswith('.')]
        api_conf = self.select_api_config()
        params_prompt = self.config.get('prompt', 'object')
        params_label = self.config.get('classLabel', params_prompt) # 获取类别名，如果没有则回退到prompt
        
        self.log(f"Processing {len(all_files)} files in {mode} mode...")

        self.config['results'] = []

        if mode == 'image':
            files_to_process = []
            for f in all_files:
                cached = self._load_cache(f)
                cache_path = self._get_cache_path(f)
                if os.path.exists(cache_path):
                    self.config['results'].append({ "fileName": f, "annotations": cached })
                else:
                    files_to_process.append(f)

            if files_to_process:
                self.log(f"Resuming task. {len(files_to_process)} images remaining.")
                with ThreadPoolExecutor(max_workers=self.parallel_count) as executor:
                    # 传入 params_label
                    future_to_file = {
                        executor.submit(self._process_single_image, os.path.join(self.files_dir, f), api_conf, params_prompt, params_label): f 
                        for f in files_to_process
                    }
                    for future in tqdm(as_completed(future_to_file), total=len(files_to_process), desc="AI Tagging", ascii=True):
                        file_name = future_to_file[future]
                        try:
                            result_anns = future.result()
                            self._save_cache_simple(file_name, result_anns)
                            self.config['results'].append({ "fileName": file_name, "annotations": result_anns })
                        except Exception as e:
                            self.log(f"Error {file_name}: {e}")
            else:
                self.log("All images processed (Loaded from cache).")

        elif mode == 'video':
            fps_target = float(self.config.get('frameRate', 1.0))
            if fps_target <= 0.1: fps_target = 0.1
            self.log(f"Using extraction Frame Rate: {fps_target} FPS")
            
            for file_name in tqdm(all_files, desc="Processing Videos", ascii=True):
                file_path = os.path.join(self.files_dir, file_name)
                try:
                    # 传入 params_label
                    video_result = self._process_single_video_resumable(file_path, api_conf, params_prompt, params_label, fps_target)
                    self.config['results'].append(video_result)
                except Exception as e:
                    self.log(f"Error processing video {file_name}: {e}")

    def _process_single_image(self, file_path, api_conf, prompt, label):
        # 统一处理：读取图片 -> 这里处理文件IO -> 转base64 -> 调API
        with open(file_path, "rb") as img_file:
            b64_data = base64.b64encode(img_file.read()).decode('utf-8')
        return self.call_api(api_conf, prompt, label, b64_data)

    def _process_single_video_resumable(self, file_path, api_conf, prompt, label, fps_target):
        file_basename = os.path.basename(file_path)

        base_name_no_ext = os.path.splitext(file_basename)[0]
        
        # 1. 设定抽帧存储目录: Result/{task_name}/extracted_frames/{video_name}/
        frames_save_dir = os.path.join(self.result_dir, "extracted_frames", base_name_no_ext)
        os.makedirs(frames_save_dir, exist_ok=True)
        
        # 加载缓存标注
        current_annotations = self._load_cache(file_basename)
        processed_times = set()
        for item in current_annotations:
            t = item.get('time', -1)
            # 是否已处理过（只要缓存里有记录，不管有没有检测到物体，都算处理过）
            if t >= 0: processed_times.add(round(t, 2))
        
        # 打开视频获取元数据
        cap = cv2.VideoCapture(file_path)
        if not cap.isOpened(): raise Exception("Cannot open video file")

        video_fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if video_fps <= 0: video_fps = 25.0
        
        step = max(1, int(round(video_fps / fps_target)))
        
        # 计算所有需要处理的目标帧索引
        target_indices = list(range(0, total_frames, step))
        
        # --- 阶段 1: 检查并补充抽帧 ---
        missing_tasks = [] 
        # 构建索引到文件路径的映射
        index_to_path = {}
        
        for idx in target_indices:
            # 文件名带帧号，保证顺序和唯一性
            fname = f"{base_name_no_ext}_{idx:09d}.jpg"
            fpath = os.path.join(frames_save_dir, fname)
            index_to_path[idx] = fpath
            
            # 检查文件是否存在且有效
            if not os.path.exists(fpath) or os.path.getsize(fpath) == 0:
                missing_tasks.append(idx)
        
        if missing_tasks:
            self.log(f"Extracting {len(missing_tasks)} missing frames for {file_basename} ...")
            
            # 执行抽帧任务
            # 为了避免频繁seek，如果是大量连续缺失，也可以考虑顺序读取优化，
            # 但为了逻辑简单且支持任意断点，这里遍历缺失列表
            with tqdm(total=len(missing_tasks), desc=f"Extracting {file_basename}", unit="img", leave=False, ascii=True) as pbar:
                for idx in missing_tasks:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
                    ret, frame = cap.read()
                    if ret:
                        cv2.imwrite(index_to_path[idx], frame, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
                    pbar.update(1)
        else:
            self.log(f"Frames already extracted for {file_basename}. Skipping extraction.")
            
        cap.release()
        
        # --- 阶段 2: 将已保存的图片送入API分析 ---
        tasks_to_do = [] 
        
        for idx in target_indices:
            time_sec = idx / video_fps
            rounded_time = round(time_sec, 2)
            
            # 如果该时间点已经有结果（包括空结果标记），跳过
            if rounded_time in processed_times:
                continue
                
            fpath = index_to_path[idx]
            # 确保文件存在（理论上阶段1肯定生成了）
            if os.path.exists(fpath):
                tasks_to_do.append((time_sec, fpath))
        
        if tasks_to_do:
            with tqdm(total=len(tasks_to_do), desc=f"Tagging {file_basename}", leave=False, ascii=True) as pbar:
                with ThreadPoolExecutor(max_workers=self.parallel_count) as executor:
                    # 复用 _process_single_image，它负责读文件转base64调API
                    future_to_info = {
                        executor.submit(self._process_single_image, fpath, api_conf, prompt, label): (ts, fpath) 
                        for (ts, fpath) in tasks_to_do
                    }
                    
                    for future in as_completed(future_to_info):

                        ts, _ = future_to_info[future]
                        try:
                            res = future.result()
                            
                            # 结果处理：加上时间戳
                            if res:
                                for item in res:
                                    item['time'] = ts
                                current_annotations.extend(res)
                            else:
                                # 标记为已检查（空结果），防止重复跑
                                current_annotations.append({'time': ts, '_checked': True})
                            
                            # 实时写入缓存
                            self._atomic_write_cache(file_basename, current_annotations)
                            
                        except Exception as e:
                            # 忽略单帧错误，继续
                            print(f"Warning: Processing failed for timestamp {ts}: {e}")
                            pass 
                        pbar.update(1)
        
        # 整理结果，移除内部用的 _checked 标记
        current_annotations.sort(key=lambda x: x.get('time', 0))
        final_anns = [a for a in current_annotations if not a.get('_checked', False)]
        
        return {
            "fileName": file_basename,
            "annotations": final_anns,
            "fps": fps_target
        }

    def export_results(self):
        mode = self.config.get('mode', 'image')
        export_opts = self.config.get('exportOptions', [])
        if not export_opts:
            if mode == 'image': export_opts = ['source_image', 'yolo_txt', 'classes_txt']
            else: export_opts = ['source_video', 'yolo_txt', 'classes_txt', 'frames']

        out_dirs = {}
        if 'source_image' in export_opts: out_dirs['images'] = os.path.join(self.result_dir, "images")
        if 'yolo_txt' in export_opts: out_dirs['labels'] = os.path.join(self.result_dir, "labels")
        if 'visualized_image' in export_opts: out_dirs['visualized'] = os.path.join(self.result_dir, "visualized")
        if 'crop_image' in export_opts: out_dirs['crops'] = os.path.join(self.result_dir, "crops")
        if 'transparent_image' in export_opts: out_dirs['transparent'] = os.path.join(self.result_dir, "transparent")
        
        if mode == 'video':
            if 'source_video' in export_opts: out_dirs['videos'] = os.path.join(self.result_dir, "videos")
            if 'frames' in export_opts: out_dirs['frames'] = os.path.join(self.result_dir, "frames")
            if 'tagged_video' in export_opts: out_dirs['tagged_videos'] = os.path.join(self.result_dir, "tagged_videos")

        for d in out_dirs.values(): os.makedirs(d, exist_ok=True)
        results = self.config.get('results', [])
        
        def _get_anns(curr_item): return curr_item.get('annotations', [])

        if mode == 'image':
            for item in tqdm(results, desc="Exporting Images", ascii=True):
                file_name = item.get('fileName')
                anns = _get_anns(item)
                src_path = os.path.join(self.files_dir, file_name)
                if not os.path.exists(src_path): continue
                img = cv2.imread(src_path)
                if img is None: continue
                h, w = img.shape[:2]
                base_name = os.path.splitext(file_name)[0]

                if 'source_image' in export_opts: shutil.copy(src_path, os.path.join(out_dirs['images'], file_name))
                if 'yolo_txt' in export_opts:
                    with open(os.path.join(out_dirs['labels'], base_name + ".txt"), 'w') as f:
                        for ann in anns:
                            box = ann.get('box_2d')
                            if box:
                                cx, cy = (box[1]+box[3])/2000, (box[0]+box[2])/2000
                                bw, bh = (box[3]-box[1])/1000, (box[2]-box[0])/1000
                                f.write(f"{self.get_class_id(ann.get('label','unknown'))} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n")
                if 'visualized_image' in export_opts:
                    vis = img.copy()
                    for ann in anns: self.draw_annotation(vis, ann, w, h)
                    cv2.imwrite(os.path.join(out_dirs['visualized'], file_name), vis)

        elif mode == 'video':
            for item in tqdm(results, desc="Exporting Videos", ascii=True):
                file_name = item.get('fileName')
                src_path = os.path.join(self.files_dir, file_name)
                if not os.path.exists(src_path): continue
                base_name = os.path.splitext(file_name)[0]
                anns = _get_anns(item)
                
                if 'source_video' in export_opts: shutil.copy(src_path, os.path.join(out_dirs['videos'], file_name))
                if any(x in export_opts for x in ['frames', 'yolo_txt', 'tagged_video']):
                    cap = cv2.VideoCapture(src_path)
                    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
                    vw, vh = int(cap.get(3)), int(cap.get(4))
                    vid_writer = None
                    if 'tagged_video' in export_opts:
                        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
                        vid_writer = cv2.VideoWriter(os.path.join(out_dirs['tagged_videos'], f"{base_name}_tagged.mp4"), fourcc, fps, (vw, vh))
                    
                    f_idx = 0
                    # 计算抽帧步长，确保与分析时的帧对齐
                    export_step = max(1, int(round(fps / item.get('fps', 1.0))))
                    while True:
                        ret, frame = cap.read()
                        if not ret: break
                        
                        is_sampled_frame = (f_idx % export_step == 0)
                        curr_sec = f_idx / fps
                        # 匹配当前帧附近的标注
                        frame_anns = [a for a in anns if abs(a.get('time', -1) - curr_sec) < (1.0/fps)]
                        valid_anns = [a for a in frame_anns if 'box_2d' in a]

                        # 只要是采样帧，就导出图片（即使没有识别到物体）
                        if 'frames' in export_opts and is_sampled_frame:
                            cv2.imwrite(os.path.join(out_dirs['frames'], f"{base_name}_{f_idx:05d}.jpg"), frame)
                        
                        # 只要是采样帧，就导出txt标签（即使内容为空）
                        if 'yolo_txt' in export_opts and is_sampled_frame:
                            txt = ""
                            for ann in valid_anns:
                                box = ann.get('box_2d')
                                if box:
                                    cx, cy = (box[1]+box[3])/2000, (box[0]+box[2])/2000
                                    bw, bh = (box[3]-box[1])/1000, (box[2]-box[0])/1000
                                    txt += f"{self.get_class_id(ann.get('label','obj'))} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n"
                            # 修改文件路径到 out_dirs['labels'] 并始终写入（支持负样本）
                            with open(os.path.join(out_dirs['labels'], f"{base_name}_{f_idx:05d}.txt"), 'w') as f: f.write(txt)

                        
                        if vid_writer:
                            vis = frame.copy()
                            for ann in valid_anns: self.draw_annotation(vis, ann, vw, vh)
                            vid_writer.write(vis)
                        f_idx += 1
                    cap.release()
                    if vid_writer: vid_writer.release()

        if 'classes_txt' in export_opts:
            with open(os.path.join(self.result_dir, "classes.txt"), 'w') as f:
                for l, _ in sorted(self.unified_class_map.items(), key=lambda x:x[1]): f.write(f"{l}\n")

    def draw_annotation(self, img, ann, w, h):
        box = ann.get('box_2d')
        if not box: return

        label = ann.get('label', 'unknown')
        h_val = sum(ord(c) for c in label)
        import colorsys
        rgb = colorsys.hls_to_rgb((h_val%360)/360.0, 0.5, 1.0)
        c = (int(rgb[2]*255), int(rgb[1]*255), int(rgb[0]*255))
        
        ymin, xmin, ymax, xmax = box
        p1 = (int(xmin/1000*w), int(ymin/1000*h))
        p2 = (int(xmax/1000*w), int(ymax/1000*h))
        cv2.rectangle(img, p1, p2, c, 2)
        cv2.putText(img, label, (p1[0], p1[1]-5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, c, 1)

    def finalize(self):
        final_zip = os.path.join(self.base_dir, "Result", f"{self.task_name}_output.zip")
        with zipfile.ZipFile(final_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(self.result_dir):
                if 'temp_work' in root: continue
                for file in files:
                    if file == os.path.basename(final_zip): continue
                    fp = os.path.join(root, file)
                    zf.write(fp, os.path.relpath(fp, self.result_dir))
        
        self.log(f"SUCCESS. Output: {final_zip}")

    def run(self):
        try:
            self.extract_task()
            self.process_missing_items()
            self.export_results()
            self.finalize()
            return True
        except Exception as e:
            self.log(f"FATAL ERROR: {e}")
            import traceback
            traceback.print_exc()
            return False

def main():
    if not load_config_from_js(): return
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    backup_dir = os.path.join(script_dir, "Backup")
    os.makedirs(backup_dir, exist_ok=True)

    zips = [z for z in glob.glob(os.path.join(script_dir, "*.zip")) if "Backup" not in z and "Result" not in z and "_output" not in z]
    
    if not zips:
        print("[NOTICE] No task packages found.")
        return 
        
    print(f"\n[*] Found {len(zips)} task(s). Processing...\n")
    for i, zip_file in enumerate(zips):
        print(f"=== Task ({i+1}/{len(zips)}) : {os.path.basename(zip_file)} ===")
        runner = AutoTagRunner(zip_file)
        success = runner.run()
        
        if success:
            try:
                dst_path = os.path.join(backup_dir, os.path.basename(zip_file))
                if os.path.exists(dst_path):
                    os.remove(dst_path)
                shutil.move(zip_file, dst_path)
                print(f"[*] Moved source to Backup: {os.path.basename(zip_file)}")
            except Exception as e:
                print(f"[ERROR] Move/Delete failed: {e}")
        print("\n")

if __name__ == "__main__":
    main()
