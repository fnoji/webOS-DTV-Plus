# -*- coding: utf-8 -*-
"""
PC 版 (WebUI) 配布用アーカイブを生成するスクリプト。

- release/dtvplus-pc-webui-<version>.zip を作成する
- 同梱内容: app/ (フロントエンド + 共通バックエンド), pc/ (PCサーバー / 保存サーバー / アダプタ)
- 同梱しない: overlay-app/ (LGTV 専用), scripts/ (開発用), dist/

使い方:
    python scripts/build_pc_bundle.py

LGTV を所持していない環境でも、この zip を展開して pc/start_pc.bat を実行すれば
PC ブラウザ上で DTV Plus を WebUI として利用できる。
"""
import json
import os
import zipfile

EXCLUDE_DIRS = {"__pycache__", ".git", "dist"}
EXCLUDE_FILES = {".DS_Store", "Thumbs.db"}


def read_version(root):
    with open(os.path.join(root, "app", "appinfo.json"), "r", encoding="utf-8-sig") as f:
        return json.load(f).get("version", "0.0.0")


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    version = read_version(root)
    out_dir = os.path.join(root, "release")
    os.makedirs(out_dir, exist_ok=True)
    zip_path = os.path.join(out_dir, "dtvplus-pc-webui-%s.zip" % version)

    entries = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for base in ("app", "pc"):
            base_dir = os.path.join(root, base)
            for cur, dirnames, filenames in os.walk(base_dir):
                dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
                for fn in filenames:
                    if fn in EXCLUDE_FILES or fn.endswith(".pyc"):
                        continue
                    full = os.path.join(cur, fn)
                    rel = os.path.relpath(full, root).replace("\\", "/")
                    zf.write(full, rel)
                    entries += 1
        # 起動用の README
        readme = (
            "DTV Plus PC WebUI %s\n"
            "=========================\n\n"
            "1. Python 3.9+ と ffmpeg をインストールする\n"
            "2. このフォルダで pc\\\\start_pc.bat を実行する\n"
            "3. Chrome が --app ウィンドウで http://127.0.0.1:7019/ を開く\n\n"
            "TVer / ABEMA の保存機能を使う場合は pc\\\\start_save_server.bat も実行する。\n"
            "終了は pc\\\\stop_pc.bat / pc\\\\stop_save_server.bat。\n"
        ) % version
        zf.writestr("README-PC.txt", readme.encode("utf-8"))
        entries += 1

    size_mb = os.path.getsize(zip_path) / (1024.0 * 1024.0)
    print("Built PC bundle: %s (%d files, %.1f MB)" % (zip_path, entries, size_mb))
    return zip_path


if __name__ == "__main__":
    main()
