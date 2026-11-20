#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
launch_pc.py - DTV Plus PC版 ランチャー
1. ローカルサーバー (127.0.0.1:7019) が未起動なら非表示バックグラウンドで pc_server.py を起動
2. 起動完了を確認後、Chrome (--app 軽量ウィンドウ) で DTV Plus を開く
"""
import os
import subprocess
import sys
import time
import urllib.request

PC_DIR = os.path.dirname(os.path.abspath(__file__))
URL = "http://127.0.0.1:7019/"
PING_URL = "http://127.0.0.1:7019/api/ping"


def is_server_alive():
    try:
        with urllib.request.urlopen(PING_URL, timeout=1.0) as r:
            return r.status == 200
    except Exception:
        return False


def find_browser():
    cands = [
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
    ]
    for p in cands:
        if os.path.isfile(p):
            return p
    return None


def main():
    no_browser = ("--no-browser" in sys.argv)
    if not is_server_alive():
        server_py = os.path.join(PC_DIR, "pc_server.py")
        py_exe = sys.executable
        if py_exe.lower().endswith("python.exe"):
            pyw = py_exe[:-10] + "pythonw.exe"
            if os.path.isfile(pyw):
                py_exe = pyw
        flags = 0
        if os.name == "nt":
            flags = getattr(subprocess, "DETACHED_PROCESS", 0x00000008) | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        subprocess.Popen(
            [py_exe, server_py],
            cwd=PC_DIR,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
            close_fds=True,
        )
        for _ in range(40):
            if is_server_alive():
                break
            time.sleep(0.25)

    if no_browser:
        print("SERVER_READY:", is_server_alive())
        return

    browser = find_browser()
    if browser:
        subprocess.Popen(
            [
                browser,
                f"--app={URL}",
                "--window-size=1280,720",
                "--autoplay-policy=no-user-gesture-required",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    else:
        os.startfile(URL)


if __name__ == "__main__":
    main()
