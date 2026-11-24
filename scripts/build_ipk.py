# -*- coding: utf-8 -*-
"""
外部CLI (ares-package) 不要で webOS 標準形式の .ipk パッケージを生成するスクリプト。
- tv.dtvplus.webos_0.3.0_all.ipk (メインアプリ)
- tv.dtvplus.webos.overlay_0.3.0_all.ipk (純正LiveTV用 ニコニコ実況透過オーバーレイ)
※ pc/ フォルダはパッケージ対象外 (PC専用ファイルは .ipk に一切同梱しない)
"""
import gzip
import io
import json
import os
import shutil
import tarfile
import time


def make_ar_entry(name, data, mtime):
    header = (
        "%-16s%-12d%-6d%-6d%-8s%-10d`\n"
        % (name, int(mtime), 0, 0, "100644", len(data))
    ).encode("ascii")
    pad = b"\n" if (len(data) % 2 == 1) else b""
    return header + data + pad


def build_tar_gz(files_map, mtime):
    """{arcname: bytes_and_mode_tuple} から決定的な .tar.gz バイト列を作成する"""
    out_buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=out_buf, mtime=mtime) as gz:
        with tarfile.open(mode="w", fileobj=gz, format=tarfile.USTAR_FORMAT) as tf:
            dirs_added = set()
            for arcname in sorted(files_map.keys()):
                parts = arcname.split("/")
                for d_idx in range(1, len(parts)):
                    d_path = "/".join(parts[:d_idx])
                    if d_path and d_path not in dirs_added:
                        dirs_added.add(d_path)
                        ti_dir = tarfile.TarInfo(name=d_path + "/")
                        ti_dir.type = tarfile.DIRTYPE
                        ti_dir.mode = 0o755
                        ti_dir.uid = 0
                        ti_dir.gid = 0
                        ti_dir.uname = "root"
                        ti_dir.gname = "root"
                        ti_dir.mtime = mtime
                        tf.addfile(ti_dir)

                raw_bytes, mode = files_map[arcname]
                ti = tarfile.TarInfo(name=arcname)
                ti.size = len(raw_bytes)
                ti.mode = mode
                ti.uid = 0
                ti.gid = 0
                ti.uname = "root"
                ti.gname = "root"
                ti.mtime = mtime
                tf.addfile(ti, io.BytesIO(raw_bytes))
    return out_buf.getvalue()


def package_webos_app(app_dir, out_dir):
    with open(os.path.join(app_dir, "appinfo.json"), "r", encoding="utf-8-sig") as f:
        appinfo = json.load(f)

    app_id = appinfo["id"]
    version = appinfo.get("version", "0.1.0")
    desc = appinfo.get("appDescription") or appinfo.get("title") or app_id
    mtime = int(time.time())

    data_files = {}
    total_bytes = 0
    prefix = "usr/palm/applications/%s" % app_id

    for root, dirnames, filenames in os.walk(app_dir):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for fn in filenames:
            if fn.endswith((".pyc", ".pyo")):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, app_dir).replace("\\", "/")
            with open(full, "rb") as rf:
                content = rf.read()
            # テキストファイル内の CRLF を LF に統一 (TV上の Python/sh 実行互換性のため)
            if fn.endswith((".py", ".sh", ".js", ".css", ".html", ".json")):
                content = content.replace(b"\r\n", b"\n")
            is_exec = fn.endswith((".py", ".sh")) or ("/bin/" in ("/" + rel))
            mode = 0o755 if is_exec else 0o644
            data_files["%s/%s" % (prefix, rel)] = (content, mode)
            total_bytes += len(content)

    installed_kb = max(1, (total_bytes + 1023) // 1024)
    control_text = (
        "Package: %s\n"
        "Version: %s\n"
        "Section: misc\n"
        "Priority: optional\n"
        "Architecture: all\n"
        "Installed-Size: %d\n"
        "Maintainer: DTVPlus <noreply@example.com>\n"
        "Description: %s\n"
        "webOS-Package-Format-Version: 2\n"
        "webOS-Packager-Version: 1.12.0\n"
    ) % (app_id, version, installed_kb, desc)

    control_tar_gz = build_tar_gz({"./control": (control_text.encode("utf-8"), 0o644)}, mtime)
    data_tar_gz = build_tar_gz(data_files, mtime)
    debian_binary = b"2.0\n"

    ipk_bytes = (
        b"!<arch>\n"
        + make_ar_entry("debian-binary", debian_binary, mtime)
        + make_ar_entry("control.tar.gz", control_tar_gz, mtime)
        + make_ar_entry("data.tar.gz", data_tar_gz, mtime)
    )

    os.makedirs(out_dir, exist_ok=True)
    ipk_name = "%s_%s_all.ipk" % (app_id, version)
    ipk_path = os.path.join(out_dir, ipk_name)
    with open(ipk_path, "wb") as out_f:
        out_f.write(ipk_bytes)
    print("Built IPK: %s (%d bytes)" % (ipk_path, len(ipk_bytes)))
    return ipk_path


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    # アイコン未生成なら生成する
    icon_check = os.path.join(root, "app", "icon80.png")
    if not os.path.exists(icon_check):
        import generate_icons
        generate_icons

    # overlay-app にも共通の jikkyo.js を同期コピー
    shutil.copyfile(
        os.path.join(root, "app", "js", "jikkyo.js"),
        os.path.join(root, "overlay-app", "jikkyo.js"),
    )

    dist_dir = os.path.join(root, "dist")
    package_webos_app(os.path.join(root, "app"), dist_dir)
    package_webos_app(os.path.join(root, "overlay-app"), dist_dir)


if __name__ == "__main__":
    main()
