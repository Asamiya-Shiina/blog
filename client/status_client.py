"""
Blog 状态客户端 - Python 版
功能：检测当前窗口，上报到 blog 服务器显示"正在使用"
支持：系统托盘最小化、右键菜单
"""

import hashlib
import json
import os
import re
import sys
import time
import ctypes
import ctypes.wintypes
import threading
import tkinter as tk
from tkinter import ttk, messagebox
import requests
import pystray
from PIL import Image, ImageDraw

# ============ 单实例检测 ============

MUTEX_NAME = "BlogStatusClientMutex"
mutex = ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
if ctypes.windll.kernel32.GetLastError() == 183:
    root = tk.Tk()
    root.withdraw()
    messagebox.showinfo("提示", "客户端已在运行中，请查看系统托盘。")
    root.destroy()
    sys.exit(0)

# ============ Windows API ============

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

def get_foreground_window():
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None

    length = user32.GetWindowTextLengthW(hwnd)
    if length > 0:
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value
    else:
        title = ""

    pid = ctypes.wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))

    process_name = ""
    h_process = kernel32.OpenProcess(0x1000, False, pid.value)
    if h_process:
        buf = ctypes.create_unicode_buffer(260)
        size = ctypes.wintypes.DWORD(260)
        if kernel32.QueryFullProcessImageNameW(h_process, 0, buf, ctypes.byref(size)):
            process_name = os.path.splitext(os.path.basename(buf.value))[0]
        kernel32.CloseHandle(h_process)

    return {"process_name": process_name, "title": title}


IDLE_THRESHOLD_SEC = 300

def get_idle_seconds():
    class LASTINPUTINFO(ctypes.Structure):
        _fields_ = [("cbSize", ctypes.wintypes.UINT), ("dwTime", ctypes.wintypes.DWORD)]

    lii = LASTINPUTINFO()
    lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if user32.GetLastInputInfo(ctypes.byref(lii)):
        GetTickCount64 = kernel32.GetTickCount64
        GetTickCount64.restype = ctypes.c_uint64
        return (GetTickCount64() - lii.dwTime) / 1000.0
    return 0


# ============ HTTP 工具 ============

class HttpClient:
    def __init__(self):
        self.server = ""
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "BlogStatusClient/1.0"})

    def request(self, method, path, data=None, as_form=False):
        url = self.server + path
        headers = {"Referer": self.server + "/", "Origin": self.server}
        try:
            if as_form and data:
                resp = self.session.request(method, url, data=data, headers=headers, timeout=10)
            elif data:
                resp = self.session.request(method, url, json=data, headers=headers, timeout=10)
            else:
                resp = self.session.request(method, url, headers=headers, timeout=10)

            if resp.status_code == 204:
                return {}
            resp.raise_for_status()
            return resp.json() if resp.text else {}
        except requests.exceptions.HTTPError as e:
            try:
                error_json = e.response.json()
                raise Exception(error_json.get("error", f"HTTP {e.response.status_code}"))
            except (json.JSONDecodeError, AttributeError):
                raise Exception(f"HTTP {e.response.status_code}: {e.response.text}")
        except Exception as e:
            raise Exception(str(e))


# ============ 主应用 ============

class StatusClient:
    def __init__(self):
        self.http = HttpClient()
        self.enabled = True
        self.logged_in = False
        self.config = None
        self.current_window = None
        self.last_sent = None
        self.last_sent_time = 0
        self.running = True
        self._custom_device_name = ''

        app_dir = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.dirname(os.path.abspath(__file__))
        self.config_file = os.path.join(app_dir, "client_config.json")
        self.saved_config = self.load_saved_config()

        if self.saved_config.get("deviceName"):
            self._custom_device_name = self.saved_config["deviceName"]

    def load_saved_config(self):
        try:
            if os.path.exists(self.config_file):
                with open(self.config_file, "r", encoding="utf-8") as f:
                    return json.load(f)
        except:
            pass
        return {"server": "", "username": "", "password": "", "remember": False}

    def save_saved_config(self):
        with open(self.config_file, "w", encoding="utf-8") as f:
            json.dump(self.saved_config, f, ensure_ascii=False, indent=2)

    def login(self, server, username, password):
        self.http.server = server.rstrip("/")
        pw_hash = hashlib.sha256(password.encode('utf-8')).hexdigest()
        self.http.request("POST", "/api/login", {"username": username, "password": password, "password_hash": pw_hash})
        self.logged_in = True

    def fetch_config(self):
        self.config = self.http.request("GET", "/api/data/config")

    def report_status(self, data):
        try:
            self.http.request("POST", "/api/data", data)
        except Exception as e:
            print(f"[status] report failed: {e}")

    def report_if_changed(self, body):
        key = json.dumps(body)
        now = time.time()
        if self.last_sent != key or (now - self.last_sent_time) >= 30:
            self.report_status(body)
            self.last_sent = key
            self.last_sent_time = now

    def is_blacklisted(self, process_name, title):
        if not self.config:
            return False
        name_lower = process_name.lower()
        for b in self.config.get("blacklist", []):
            if b.lower() == name_lower:
                return True
        for pattern in self.config.get("blacklistPatterns", []):
            try:
                if re.search(pattern, process_name, re.IGNORECASE) or re.search(pattern, title, re.IGNORECASE):
                    return True
            except:
                pass
        return False

    def resolve_app_name(self, process_name):
        if not self.config:
            return process_name
        app_names = self.config.get("appNames", {})
        if process_name in app_names:
            return app_names[process_name]
        lower = process_name.lower()
        for k, v in app_names.items():
            if k.lower() == lower:
                return v
        for item in self.config.get("appNamePatterns", []):
            try:
                if re.search(item["pattern"], process_name, re.IGNORECASE):
                    return item["name"]
            except:
                pass
        return process_name

    def should_show_title(self, process_name):
        if not self.config:
            return False
        if process_name in self.config.get("titleApps", []):
            return True
        lower = process_name.lower()
        for item in self.config.get("titleApps", []):
            if item.lower() == lower:
                return True
        for item in self.config.get("titleAppPatterns", []):
            try:
                if re.search(item["pattern"], process_name, re.IGNORECASE):
                    return True
            except:
                pass
        return False

    def get_device_name(self):
        return self._custom_device_name or os.environ.get('COMPUTERNAME', 'unknown')

    def tick(self):
        if not self.logged_in or not self.enabled:
            self.report_if_changed({"active": False, "deviceName": self.get_device_name()})
            self.current_window = None
            return

        idle_sec = get_idle_seconds()
        if idle_sec >= IDLE_THRESHOLD_SEC:
            self.report_if_changed({"active": True, "app": "休息中", "title": "", "icon": "break", "deviceName": self.get_device_name()})
            return

        win = get_foreground_window()
        self.current_window = win

        if not win or not win["process_name"]:
            if self.last_sent:
                self.report_if_changed(json.loads(self.last_sent))
            return

        process_lower = win["process_name"].lower()
        if process_lower in ("python", "pythonw", "状态客户端", "status_client"):
            if self.last_sent:
                self.report_if_changed(json.loads(self.last_sent))
            return

        if self.is_blacklisted(win["process_name"], win["title"]):
            self.report_if_changed({"active": True, "app": "休息一下,马上回来", "title": "", "icon": "break", "deviceName": self.get_device_name()})
            return

        app_name = self.resolve_app_name(win["process_name"])
        if process_lower == "explorer" and win["title"] == "Program Manager":
            app_name = "桌面"
        elif process_lower == "windowsterminal":
            app_name = "消耗Token死命调试中...."

        show_title = self.should_show_title(win["process_name"])
        self.report_if_changed({
            "active": True,
            "app": app_name,
            "title": win["title"] if show_title else "",
            "icon": process_lower,
            "deviceName": self.get_device_name(),
        })

    def background_loop(self):
        while self.running:
            try:
                self.tick()
            except Exception as e:
                print(f"[status] tick error: {e}")
            time.sleep(5)


# ============ 系统托盘图标 ============

def create_icon_image(color="#22c55e"):
    image = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
    ImageDraw.Draw(image).ellipse([8, 8, 56, 56], fill=color)
    return image


# ============ GUI ============

class StatusGUI:
    def __init__(self):
        self.client = StatusClient()
        self.root = tk.Tk()
        self.root.title("状态客户端")
        self.root.geometry("380x500")
        self.root.resizable(False, False)
        self.tray_icon = None
        self.is_minimized = False

        try:
            self.root.iconbitmap(default="")
        except:
            pass

        style = ttk.Style()
        style.configure("TButton", padding=6)
        style.configure("TEntry", padding=4)

        self.create_login_view()
        self.create_status_view()
        self.root.protocol("WM_DELETE_WINDOW", self.minimize_to_tray)

        if self.client.saved_config.get("server") and self.client.saved_config.get("password"):
            self.root.after(500, self.auto_login)
        else:
            self.show_login_view()

    def create_tray_icon(self):
        menu = pystray.Menu(
            pystray.MenuItem("显示窗口", self.show_window, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("启用" if not self.client.enabled else "禁用", self.toggle_from_tray),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出", self.quit_app)
        )
        icon_color = "#22c55e" if self.client.enabled else "#999999"
        self.tray_icon = pystray.Icon("状态客户端", create_icon_image(icon_color), "状态客户端", menu)
        threading.Thread(target=self.tray_icon.run, daemon=True).start()

    def minimize_to_tray(self):
        if not self.tray_icon:
            self.create_tray_icon()
        self.root.withdraw()
        self.is_minimized = True

    def show_window(self, icon=None, item=None):
        self.root.after(0, self._show_window_main_thread)

    def _show_window_main_thread(self):
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()
        self.is_minimized = False

    def toggle_from_tray(self, icon=None, item=None):
        self.client.enabled = not self.client.enabled
        self.update_tray_icon()
        self.update_status_display()

    def update_tray_icon(self):
        if self.tray_icon:
            self.tray_icon.icon = create_icon_image("#22c55e" if self.client.enabled else "#999999")

    def quit_app(self, icon=None, item=None):
        self.client.running = False
        if self.client.logged_in:
            try:
                self.client.report_status({"active": False, "deviceName": self.client.get_device_name()})
            except:
                pass
        if self.tray_icon:
            self.tray_icon.stop()
        self.root.destroy()

    def create_login_view(self):
        self.login_frame = ttk.LabelFrame(self.root, text="登录", padding=20)

        ttk.Label(self.login_frame, text="Blog 地址:").pack(anchor="w")
        self.server_entry = ttk.Entry(self.login_frame, width=40)
        self.server_entry.pack(fill="x", pady=(0, 10))

        ttk.Label(self.login_frame, text="用户名:").pack(anchor="w")
        self.username_entry = ttk.Entry(self.login_frame, width=40)
        self.username_entry.pack(fill="x", pady=(0, 10))

        ttk.Label(self.login_frame, text="密码:").pack(anchor="w")
        self.password_entry = ttk.Entry(self.login_frame, width=40, show="*")
        self.password_entry.pack(fill="x", pady=(0, 10))

        self.remember_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(self.login_frame, text="记住登录信息", variable=self.remember_var).pack(anchor="w", pady=(0, 15))

        self.login_btn = ttk.Button(self.login_frame, text="登录", command=self.do_login)
        self.login_btn.pack(fill="x")

        self.login_error = ttk.Label(self.login_frame, text="", foreground="red")
        self.login_error.pack(pady=(10, 0))

        saved = self.client.saved_config
        if saved.get("server"):
            self.server_entry.insert(0, saved["server"])
        if saved.get("username"):
            self.username_entry.insert(0, saved["username"])
        if saved.get("password"):
            self.password_entry.insert(0, saved["password"])

    def create_status_view(self):
        self.status_frame = ttk.LabelFrame(self.root, text="状态", padding=20)

        self.status_label = ttk.Label(self.status_frame, text="已启用", font=("", 14, "bold"))
        self.status_label.pack(pady=(0, 10))

        self.status_dot = tk.Canvas(self.status_frame, width=20, height=20, highlightthickness=0)
        self.status_dot.pack()
        self.dot_id = self.status_dot.create_oval(2, 2, 18, 18, fill="gray")

        device_frame = ttk.Frame(self.status_frame)
        device_frame.pack(fill="x", pady=(15, 5))
        ttk.Label(device_frame, text="设备名:").pack(side="left")
        self.device_name_entry = ttk.Entry(device_frame, width=20)
        self.device_name_entry.pack(side="left", padx=(8, 0))
        self.device_name_entry.insert(0, self.client.get_device_name())
        ttk.Button(device_frame, text="保存", command=self.save_device_name, width=6).pack(side="left", padx=(8, 0))

        ttk.Label(self.status_frame, text="当前窗口:", font=("", 10)).pack(anchor="w", pady=(10, 5))
        self.window_label = ttk.Label(self.status_frame, text="-", wraplength=300)
        self.window_label.pack(anchor="w")

        self.server_label = ttk.Label(self.status_frame, text="", foreground="gray")
        self.server_label.pack(anchor="w", pady=(20, 0))

        self.toggle_btn = ttk.Button(self.status_frame, text="禁用", command=self.do_toggle)
        self.toggle_btn.pack(fill="x", pady=(20, 10))

        ttk.Button(self.status_frame, text="退出登录", command=self.do_logout).pack(fill="x")

    def show_login_view(self):
        self.status_frame.pack_forget()
        self.login_frame.pack(fill="both", expand=True, padx=20, pady=20)

    def show_status_view(self):
        self.login_frame.pack_forget()
        self.status_frame.pack(fill="both", expand=True, padx=20, pady=20)
        self.update_status_display()

    def auto_login(self):
        saved = self.client.saved_config
        try:
            self.client.login(saved["server"], saved["username"], saved["password"])
            self.client.fetch_config()
            self.show_status_view()
            self.start_background_loop()
        except Exception as e:
            self.show_login_view()
            self.login_error.config(text=f"自动登录失败: {e}")

    def do_login(self):
        server = self.server_entry.get().strip().rstrip("/")
        username = self.username_entry.get().strip()
        password = self.password_entry.get()

        if not server or not username or not password:
            self.login_error.config(text="请填写所有字段")
            return

        try:
            self.client.login(server, username, password)
            self.client.fetch_config()

            if self.remember_var.get():
                self.client.saved_config = {"server": server, "username": username, "password": password, "remember": True}
            else:
                self.client.saved_config = {"server": server, "username": username, "password": "", "remember": False}
            self.client.save_saved_config()

            self.show_status_view()
            self.start_background_loop()
            self.login_error.config(text="")
        except Exception as e:
            self.login_error.config(text=f"登录失败: {e}")

    def save_device_name(self):
        name = self.device_name_entry.get().strip()
        if name:
            self.client._custom_device_name = name
            self.client.saved_config["deviceName"] = name
            self.client.save_saved_config()

    def do_toggle(self):
        self.client.enabled = not self.client.enabled
        self.update_status_display()
        self.update_tray_icon()

    def do_logout(self):
        self.client.logged_in = False
        self.client.enabled = True
        self.client.saved_config["password"] = ""
        self.client.save_saved_config()
        self.show_login_view()

    def update_status_display(self):
        if self.client.enabled:
            self.status_label.config(text="已启用")
            self.status_dot.itemconfig(self.dot_id, fill="#22c55e")
            self.toggle_btn.config(text="禁用")
        else:
            self.status_label.config(text="已禁用")
            self.status_dot.itemconfig(self.dot_id, fill="gray")
            self.toggle_btn.config(text="启用")

        if not self.client.enabled:
            self.window_label.config(text="-")
        elif get_idle_seconds() >= IDLE_THRESHOLD_SEC:
            self.window_label.config(text="休息中（已离开）")
        elif self.client.current_window:
            win = self.client.current_window
            text = win["process_name"]
            if win["title"]:
                text += " - " + win["title"]
            self.window_label.config(text=text)
        else:
            self.window_label.config(text="检测中...")

        self.server_label.config(text=f"服务器: {self.client.http.server}")

    def start_background_loop(self):
        threading.Thread(target=self.client.background_loop, daemon=True).start()

        def update_ui():
            if self.client.running:
                self.update_status_display()
                self.root.after(2000, update_ui)

        update_ui()

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    app = StatusGUI()
    app.run()
