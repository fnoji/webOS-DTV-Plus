# -*- coding: utf-8 -*-
"""
LGTV 実機上の DTV Plus 統合動作テストスクリプト

1. yt-dlp 常駐デーモン (/api/ping) のバージョン・稼働確認
2. TVer おすすめ一覧 & 公式 yt-dlp 経由のストリーム抽出 (/api/extract)
3. Abema TV 放送中チャンネル一覧 & 公式 yt-dlp + M3U8 プロキシ抽出確認

接続先は scripts/deploy_tv.py と同じ環境変数 (TV_HOST / TV_USER / TV_PASS) で指定する。
"""
import deploy_tv


REMOTE_VERIFY_SH = """
echo "=== 1. YTDLP DAEMON PING ==="
curl -sS http://127.0.0.1:7019/api/ping
echo ""

echo "=== 2. TVER EXTRACT VIA OFFICIAL YT-DLP ==="
curl -sS "http://127.0.0.1:7019/api/tver/home" > /tmp/dtvplus_tver.json
EP_URL=$(python3 -c 'import json; d=json.load(open("/tmp/dtvplus_tver.json")); print(d["sections"][0]["items"][0]["pageUrl"])')
echo "Testing TVer URL: $EP_URL"
curl -sS "http://127.0.0.1:7019/api/extract?url=${EP_URL}" | head -c 340
echo ""

echo "=== 3. ABEMA CHANNELS & EXTRACT VIA OFFICIAL YT-DLP ==="
curl -sS "http://127.0.0.1:7019/api/abema/channels" > /tmp/dtvplus_abema.json
python3 -c 'import json; d=json.load(open("/tmp/dtvplus_abema.json")); print("Abema live channels:", len(d.get("channels", [])))'
curl -sS "http://127.0.0.1:7019/api/extract?url=https://abema.tv/now-on-air/abema-news" | head -c 340
echo ""
rm -f /tmp/dtvplus_tver.json /tmp/dtvplus_abema.json
"""


def main():
    code, out = deploy_tv.run_ssh("sh -s", REMOTE_VERIFY_SH.replace("\r\n", "\n").encode("utf-8"))
    print(out)
    if code != 0:
        raise SystemExit(code)


if __name__ == "__main__":
    main()
