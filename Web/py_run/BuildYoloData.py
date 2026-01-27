import os
import shutil
import threading
import random
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox
import ttkbootstrap as ttk
from ttkbootstrap.constants import *

class YoloSplitterApp(ttk.Window):
    def __init__(self):
        super().__init__(themename="cosmo") 
        self.title("YOLO 数据集划分工具 (智能路径版)")
        self.geometry("800x700")
        self.minsize(750, 650)  # 设置最小尺寸，防止布局错乱
        self.resizable(True, True) # 允许全屏和缩放

        # 核心变量
        self.source_dir = tk.StringVar()
        self.image_dir = tk.StringVar()
        self.label_dir = tk.StringVar()
        self.target_dir = tk.StringVar()
        self.split_ratio = tk.DoubleVar(value=80.0)
        self.allow_overlap = tk.BooleanVar(value=False)
        self.is_running = False
        
        self.create_ui()

    def create_ui(self):
        # 使用 main_frame 包裹所有内容
        main_frame = ttk.Frame(self, padding=20)
        main_frame.pack(fill=BOTH, expand=YES)

        ttk.Label(main_frame, text="YOLO 数据集自动划分生成器", 
                  font=("微软雅黑", 20, "bold"), bootstyle=PRIMARY).pack(pady=(0, 20))

        # --- 1. 数据源设置 ---
        src_frame = ttk.Labelframe(main_frame, text="数据源设置", padding=15)
        src_frame.pack(fill=X, pady=5)
        
        # 封装一行路径选择的通用函数
        def create_path_row(parent, label, var, browse_cmd):
            row = ttk.Frame(parent)
            row.pack(fill=X, pady=5)
            ttk.Label(row, text=label, width=12).pack(side=LEFT)
            ttk.Entry(row, textvariable=var).pack(side=LEFT, padx=5, fill=X, expand=YES)
            ttk.Button(row, text="浏览", command=browse_cmd, bootstyle=OUTLINE, width=8).pack(side=LEFT)

        create_path_row(src_frame, "数据根目录:", self.source_dir, self.select_source)
        create_path_row(src_frame, "图片文件夹:", self.image_dir, lambda: self.image_dir.set(filedialog.askdirectory() or self.image_dir.get()))
        create_path_row(src_frame, "标签文件夹:", self.label_dir, lambda: self.label_dir.set(filedialog.askdirectory() or self.label_dir.get()))

        # --- 2. 输出设置 ---
        tgt_frame = ttk.Labelframe(main_frame, text="输出设置", padding=15)
        tgt_frame.pack(fill=X, pady=5)
        
        create_path_row(tgt_frame, "保存位置:", self.target_dir, self.select_target)
        
        sync_btn = ttk.Button(tgt_frame, text="🔄 同步数据源目录", command=self.sync_target_path, 
                              bootstyle="secondary-link", cursor="hand2")
        sync_btn.pack(anchor=E)

        # --- 3. 参数配置 ---
        param_frame = ttk.Labelframe(main_frame, text="参数配置", padding=15)
        param_frame.pack(fill=X, pady=5)

        self.ratio_label_text = tk.StringVar(value="训练集: 80% | 验证集: 20%")
        ttk.Label(param_frame, textvariable=self.ratio_label_text, font=("微软雅黑", 10, "bold"), bootstyle=INFO).pack(anchor=W)
        ttk.Scale(param_frame, from_=10, to=90, variable=self.split_ratio, command=self.update_ratio_label, bootstyle=INFO).pack(fill=X, pady=10)
        ttk.Checkbutton(param_frame, text="允许训练集与验证集数据重复 (数据泄露模式)", variable=self.allow_overlap, bootstyle="round-toggle").pack(anchor=W)

        # --- 4. 运行与进度 ---
        btn_frame = ttk.Frame(main_frame)
        btn_frame.pack(fill=X, pady=15)
        self.btn_run = ttk.Button(btn_frame, text="🚀 开始生成数据集", command=self.handle_start_click, bootstyle=SUCCESS, width=30)
        self.btn_run.pack(pady=5)

        self.progress = ttk.Floodgauge(main_frame, bootstyle=SUCCESS, font=("微软雅黑", 10), 
                                      mask="当前进度: {}%", maximum=100, orient=HORIZONTAL, value=0)
        self.progress.pack(fill=X, pady=5)

        # --- 5. 日志 ---
        log_frame = ttk.Labelframe(main_frame, text="运行日志", padding=5)
        log_frame.pack(fill=BOTH, expand=YES, pady=(10, 0))
        
        self.log_text = ttk.Text(log_frame, height=5, font=("Consolas", 10))
        self.log_text.pack(side=LEFT, fill=BOTH, expand=YES)
        
        scrollbar = ttk.Scrollbar(log_frame, command=self.log_text.yview)
        scrollbar.pack(side=RIGHT, fill=Y)
        self.log_text.config(yscrollcommand=scrollbar.set)

    # --- 逻辑功能 ---

    def select_source(self):
        path = filedialog.askdirectory()
        if path:
            abs_path = os.path.abspath(path)
            self.source_dir.set(abs_path)
            for item in os.listdir(abs_path):
                full_item = os.path.join(abs_path, item)
                if os.path.isdir(full_item):
                    if item.lower() in ["images", "image", "frames", "frame"]:
                        self.image_dir.set(full_item)
                    elif item.lower() in ["labels", "label"]:
                        self.label_dir.set(full_item)

    def select_target(self):
        path = filedialog.askdirectory()
        if path:
            self.target_dir.set(os.path.abspath(path))

    def sync_target_path(self):
        if self.source_dir.get():
            self.target_dir.set(self.source_dir.get())
        else:
            messagebox.showwarning("提示", "请先选择数据源目录")

    def update_ratio_label(self, val):
        ratio = int(float(val))
        self.ratio_label_text.set(f"训练集: {ratio}% | 验证集: {100-ratio}%")

    def log(self, message):
        self.log_text.insert(END, f"{message}\n")
        self.log_text.see(END)

    def handle_start_click(self):
        src = self.source_dir.get()
        tgt = self.target_dir.get()

        if not src or not os.path.exists(src):
            messagebox.showerror("错误", "请选择有效的数据源！")
            return
        if not self.image_dir.get() or not self.label_dir.get():
            messagebox.showerror("错误", "请指定图片和标签文件夹！")
            return
        if not tgt:
            messagebox.showerror("错误", "请选择输出保存位置！")
            return

        target_bvn = Path(tgt) / "bvn"
        if target_bvn.exists():
            res = messagebox.askyesno("覆盖询问", f"目标位置已存在 'bvn' 文件夹。\n执行将彻底删除并重新生成，是否继续？")
            if not res: return

        self.is_running = True
        self.btn_run.config(state=DISABLED)
        self.log_text.delete(1.0, END)
        threading.Thread(target=self.process_data, args=(src, tgt), daemon=True).start()

    def process_data(self, source_path, target_path):
        try:
            source_path_obj = Path(source_path)
            target_path_obj = Path(target_path)
            
            # --- 读取 classes.txt ---
            class_names = []
            found_classes = list(source_path_obj.rglob('classes.txt'))
            if found_classes:
                p = found_classes[0]
                content = None
                for enc in ['utf-8', 'gbk', 'gb2312', 'latin1']:
                    try:
                        with open(p, 'r', encoding=enc) as f:
                            content = f.readlines()
                        self.log(f"📖 成功以 {enc} 编码读取 classes.txt")
                        break
                    except Exception:
                        continue
                
                if content:
                    class_names = [line.strip() for line in content if line.strip()]

            # 递归匹配
            image_extensions = {'.jpg', '.jpeg', '.png', '.bmp'}
            valid_pairs = []
            
            self.log("🔎 开始扫描指定目录文件...")
            forbidden_path = target_path_obj / "bvn"

            img_path_obj = Path(self.image_dir.get())
            lbl_path_obj = Path(self.label_dir.get())
            file_map = {}

            # 扫描图片
            for f in img_path_obj.rglob('*'):
                if not f.is_file(): continue
                if forbidden_path in f.parents: continue
                if f.suffix.lower() in image_extensions:
                    file_map.setdefault(f.stem, {})['img'] = f

            # 扫描标签
            for f in lbl_path_obj.rglob('*'):
                if not f.is_file(): continue
                if forbidden_path in f.parents: continue
                if f.suffix.lower() == '.txt' and f.name != 'classes.txt':
                    file_map.setdefault(f.stem, {})['txt'] = f
            
            for stem, paths in file_map.items():
                if 'img' in paths and 'txt' in paths:
                    valid_pairs.append((paths['img'], paths['txt']))

            total_pairs = len(valid_pairs)
            if total_pairs == 0:
                self.log("❌ 未找到有效的文件配对。")
                self.after(0, lambda: messagebox.showwarning("结束", "未扫描到有效数据对。"))
                self.finish_process(); return

            # 划分逻辑
            random.shuffle(valid_pairs)
            train_ratio = self.split_ratio.get() / 100.0
            split_idx = int(total_pairs * train_ratio)
            train_set = valid_pairs[:split_idx]
            val_set = random.sample(valid_pairs, k=max(1, total_pairs-split_idx)) if self.allow_overlap.get() else valid_pairs[split_idx:]

            # 创建目录
            base_dir = target_path_obj.absolute() / "bvn"
            dirs = {'it': base_dir/"images"/"train", 'iv': base_dir/"images"/"val",
                    'lt': base_dir/"labels"/"train", 'lv': base_dir/"labels"/"val"}
            
            if base_dir.exists(): shutil.rmtree(base_dir)
            for d in dirs.values(): d.mkdir(parents=True, exist_ok=True)

            # 复制文件
            self.log(f"🚚 准备复制 {len(train_set) + len(val_set)} 对文件...")
            total_ops = len(train_set) + len(val_set)
            self.curr_count = 0
            
            def copy_logic(dataset, img_d, lbl_d):
                for img_s, txt_s in dataset:
                    shutil.copy2(img_s, img_d / img_s.name)
                    shutil.copy2(txt_s, lbl_d / txt_s.name)
                    self.curr_count += 1
                    if self.curr_count % 5 == 0:
                        prog = (self.curr_count / total_ops) * 100
                        self.after(0, lambda v=prog: self.progress.configure(value=v))

            copy_logic(train_set, dirs['it'], dirs['lt'])
            copy_logic(val_set, dirs['iv'], dirs['lv'])

            # 生成 YAML
            yaml_path = base_dir / "data.yaml"
            names_str = "\n".join([f"  {i}: {n}" for i, n in enumerate(class_names)]) if class_names else "  0: object"
            yaml_content = f"path: {base_dir.as_posix()}\ntrain: images/train\nval: images/val\n\nnames:\n{names_str}"
            with open(yaml_path, "w", encoding="utf-8") as f:
                f.write(yaml_content)

            self.log(f"✨ 任务成功完成！")
            self.after(0, lambda: messagebox.showinfo("成功", f"数据集已生成在:\n{base_dir}"))

        except Exception as e:
            self.log(f"❌ 运行报错: {str(e)}")
        finally:
            self.finish_process()

    def finish_process(self):
        self.is_running = False
        self.after(0, lambda: self.btn_run.config(state=NORMAL))
        self.after(0, lambda: self.progress.configure(value=0))

if __name__ == "__main__":
    app = YoloSplitterApp()
    app.mainloop()
