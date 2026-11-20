# -*- coding: utf-8 -*-
"""
ビルドした .ipk パッケージを LGTV 実機へデプロイし、
chroot 内の Python 3.12 + 公式 yt-dlp 常駐デーモンを起動・検証するスクリプト。

接続先は環境変数で上書きできる (既定値は開発機のもの):
    TV_HOST (既定: 192.168.100.18)
    TV_USER (既定: root)
    TV_PASS (既定: alpine)

使い方:
    $env:TV_HOST="192.168.0.10"
    python scripts/deploy_tv.py
"""
import glob
import os
import subprocess
import sys
import tempfile


TV_HOST = os.environ.get("TV_HOST", "192.168.100.18")
TV_USER = os.environ.get("TV_USER", "root")
TV_PASS = os.environ.get("TV_PASS", "alpine")


def make_ssh_env():
    askpass = os.path.join(tempfile.gettempdir(), "dtvplus_askpass.cmd")
    with open(askpass, "w", encoding="ascii") as f:
        f.write("@echo %s\r\n" % TV_PASS)
    env = os.environ.copy()
    env["SSH_ASKPASS"] = askpass
    env["SSH_ASKPASS_REQUIRE"] = "force"
    env["DISPLAY"] = "1"
    return env, askpass


def run_ssh(remote_cmd, stdin_bytes=None):
    env, askpass = make_ssh_env()
    try:
        p = subprocess.Popen(
            [
                "ssh",
                "-T",
                "-o", "StrictHostKeyChecking=no",
                "-o", "ConnectTimeout=10",
                "%s@%s" % (TV_USER, TV_HOST),
                remote_cmd,
            ],
            stdin=subprocess.PIPE if stdin_bytes is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
        )
        out, _ = p.communicate(input=stdin_bytes)
        return p.returncode, out.decode("utf-8", errors="replace")
    finally:
        try:
            os.remove(askpass)
        except OSError:
            pass


def sync_tar_directly(ipk_path):
    with open(ipk_path, "rb") as f:
        raw = f.read()
    idx = raw.find(b"data.tar.gz")
    if idx == -1:
        raise RuntimeError("data.tar.gz not found in IPK")
    size_str = raw[idx + 48 : idx + 58].decode("ascii").strip()
    data_size = int(size_str)
    data_start = idx + 60
    data_tar_gz = raw[data_start : data_start + data_size]

    app_id = os.path.basename(ipk_path).split("_")[0]
    print("Syncing %s to /media/developer/apps ..." % app_id)
    run_ssh("rm -rf /media/developer/apps/usr/palm/applications/%s" % app_id)
    code, out = run_ssh("tar -xzf - -C /media/developer/apps", stdin_bytes=data_tar_gz)
    if code != 0:
        raise RuntimeError("Direct tar sync failed: %s" % out)
    print("Synced %s." % app_id)


def install_ipk(ipk_path):
    ipk_name = os.path.basename(ipk_path)
    app_id = ipk_name.split("_")[0]
    remote_tmp = "/tmp/%s" % ipk_name

    _, lp_out = run_ssh(
        "luna-send -n 1 luna://com.webos.applicationManager/listLaunchPoints '{}' </dev/null"
    )
    if ('"%s"' % app_id) in lp_out or ('"%s_default"' % app_id) in lp_out:
        sync_tar_directly(ipk_path)
        return

    with open(ipk_path, "rb") as f:
        data = f.read()

    print("Uploading %s (%d bytes) ..." % (ipk_name, len(data)))
    code, out = run_ssh("cat > %s" % remote_tmp, stdin_bytes=data)
    if code != 0:
        raise RuntimeError("Upload failed: %s" % out)

    install_cmd = (
        "luna-send -i -w 14000 luna://com.webos.appInstallService/dev/install "
        '\'{"id":"com.ares.defaultName","ipkUrl":"%s","subscribe":true}\' </dev/null; '
        "rm -f %s"
    ) % (remote_tmp, remote_tmp)

    code, out = run_ssh(install_cmd)
    if "installed" not in out.lower() and '"statusValue":30' not in out:
        sync_tar_directly(ipk_path)
    else:
        print("Installed %s via appInstallService." % ipk_name)


def remove_legacy_app_if_present(old_app_id):
    _, lp_out = run_ssh(
        "luna-send -n 1 luna://com.webos.applicationManager/listLaunchPoints '{}' </dev/null"
    )
    if ('"%s"' % old_app_id) in lp_out or ('"%s_default"' % old_app_id) in lp_out:
        print("Removing legacy app ID %s ..." % old_app_id)
        run_ssh(
            "luna-send -i -w 8000 luna://com.webos.appInstallService/dev/remove "
            '\'{"id":"%s","subscribe":true}\' </dev/null' % old_app_id
        )
        run_ssh("rm -rf /media/developer/apps/usr/palm/applications/%s" % old_app_id)


def find_ipks(dist_dir):
    """dist/ から本体とオーバーレイの .ipk を自動検出する (バージョン非依存)"""
    found = []
    for app_id in ("tv.dtvplus.webos", "tv.dtvplus.webos.overlay"):
        hits = sorted(glob.glob(os.path.join(dist_dir, "%s_*_all.ipk" % app_id)))
        if hits:
            found.append(hits[-1])
    return found


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dist_dir = os.path.join(root, "dist")
    ipks = find_ipks(dist_dir)
    if len(ipks) < 2:
        print("Missing IPK under %s (run scripts/build_ipk.py first)" % dist_dir)
        sys.exit(1)
    for ipk in ipks:
        install_ipk(ipk)

    # 旧 ID が残っていればクリーンアップしてランチャー重複を防ぐ
    remove_legacy_app_if_present("tv.konomi.webos")
    remove_legacy_app_if_present("tv.konomi.webos.overlay")

    # init.d 自動起動スクリプトの登録と yt-dlp 常駐デーモンの起動・確認
    restart_sh = """
chmod +x /media/developer/apps/usr/palm/applications/tv.dtvplus.webos/backend/start_daemon.sh
chmod +x /media/developer/apps/usr/palm/applications/tv.dtvplus.webos/backend/autostart_init.sh
chmod +x /media/developer/apps/usr/palm/applications/tv.dtvplus.webos/backend/ytdlp_daemon.py
mkdir -p /var/lib/webosbrew/init.d
cp /media/developer/apps/usr/palm/applications/tv.dtvplus.webos/backend/autostart_init.sh /var/lib/webosbrew/init.d/91-dtvplus
chmod +x /var/lib/webosbrew/init.d/91-dtvplus

for pid in $(ps aux 2>/dev/null | awk '/helper\\.js|ytdlp_daemon\\.py/ && !/awk/ {print $2}'); do
  kill -9 "$pid" 2>/dev/null || true
done
/bin/sh /media/developer/apps/usr/palm/applications/tv.dtvplus.webos/backend/start_daemon.sh
for i in 1 2 3 4 5 6; do
  sleep 1
  if curl -sS --max-time 2 http://127.0.0.1:7019/api/ping 2>/dev/null | grep -q pythonVersion; then
    break
  fi
done
curl -sS http://127.0.0.1:7019/api/ping
echo ""
ls -la /var/lib/webosbrew/init.d/91-dtvplus
"""
    code, out = run_ssh("sh -s", restart_sh.replace("\r\n", "\n").encode("utf-8"))
    print("Daemon restart output:\n" + out.strip())


if __name__ == "__main__":
    main()
