#!/bin/sh
# DTV Plus バックエンドデーモン起動スクリプト (LGTV root 環境用)
#
# 1. 永続領域 /mnt/lg/cmn_data/ytdlp-env に Alpine armv7 chroot (Python 3.12) を構築
# 2. 公式 yt-dlp (zipapp) を取得
# 3. ytdlp_daemon.py と mmt2ts (BS4K MMT/TLV -> TS 変換) を chroot 内へ配置
# 4. 純正 ARIB 選局ロゴ (/mnt/lg/user/jlogo) とチャンネル DB を chroot 内へ同期
# 5. 127.0.0.1:7019 で yt-dlp 常駐デーモンを起動

ENV_DIR="/mnt/lg/cmn_data/ytdlp-env"
APP_DIR="/media/developer/apps/usr/palm/applications/tv.dtvplus.webos"

# 未構築なら Alpine minirootfs + Python をセットアップ
if [ ! -x "$ENV_DIR/usr/bin/python3" ]; then
  mkdir -p "$ENV_DIR"
  curl -sSL -o /tmp/alpine.tar.gz https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/armv7/alpine-minirootfs-3.21.3-armv7.tar.gz
  tar -xzf /tmp/alpine.tar.gz -C "$ENV_DIR"
  rm -f /tmp/alpine.tar.gz
  cp /etc/resolv.conf "$ENV_DIR/etc/resolv.conf" 2>/dev/null || echo "nameserver 8.8.8.8" > "$ENV_DIR/etc/resolv.conf"
  chroot "$ENV_DIR" /sbin/apk add --no-cache python3 ca-certificates curl >/dev/null 2>&1
fi

# 公式 yt-dlp (zipapp) が無ければ取得
if [ ! -f "$ENV_DIR/usr/local/bin/yt-dlp" ]; then
  mkdir -p "$ENV_DIR/usr/local/bin"
  curl -sSL -o "$ENV_DIR/usr/local/bin/yt-dlp" https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
  chmod a+rx "$ENV_DIR/usr/local/bin/yt-dlp"
fi

cp /etc/resolv.conf "$ENV_DIR/etc/resolv.conf" 2>/dev/null || true
mkdir -p "$ENV_DIR/opt" "$ENV_DIR/usr/local/bin"
cp "$APP_DIR/backend/ytdlp_daemon.py" "$ENV_DIR/opt/ytdlp_daemon.py"
chmod a+rx "$ENV_DIR/opt/ytdlp_daemon.py"
if [ -f "$APP_DIR/backend/bin/mmt2ts-armv7" ]; then
  cp "$APP_DIR/backend/bin/mmt2ts-armv7" "$ENV_DIR/usr/local/bin/mmt2ts"
  chmod a+rx "$ENV_DIR/usr/local/bin/mmt2ts"
fi

# LGTV 純正 ARIB 選局ロゴ (/mnt/lg/user/jlogo) と純正チャンネル DB 情報を chroot 内へ同期
# (Mirakurun 側で BS 一部・CS 全局が hasLogoData=false の場合でも純正ロゴとショートカット番号を埋められるようにする)
if [ -d "/mnt/lg/user/jlogo" ]; then
  mkdir -p "$ENV_DIR/opt/jlogo"
  cp -rf /mnt/lg/user/jlogo/* "$ENV_DIR/opt/jlogo/" 2>/dev/null || true
elif [ -d "/mnt/user/jlogo" ]; then
  mkdir -p "$ENV_DIR/opt/jlogo"
  cp -rf /mnt/user/jlogo/* "$ENV_DIR/opt/jlogo/" 2>/dev/null || true
fi

if command -v luna-send >/dev/null 2>&1; then
  luna-send -n 1 luna://com.palm.db/find '{"query":{"from":"com.webos.service.tv.channel.dblist:1","limit":500}}' \
    </dev/null >"$ENV_DIR/opt/tv_channel_db.json.tmp" 2>/dev/null && \
    mv "$ENV_DIR/opt/tv_channel_db.json.tmp" "$ENV_DIR/opt/tv_channel_db.json" 2>/dev/null || true
fi

# 既にポート 7019 で稼働中ならそのまま終了
if curl -sS --max-time 1 http://127.0.0.1:7019/api/ping >/dev/null 2>&1; then
  exit 0
fi

# デーモンとしてバックグラウンド起動 (FD を完全に閉じて hbchannel exec を即座に返す)
nohup chroot "$ENV_DIR" /usr/bin/python3 /opt/ytdlp_daemon.py </dev/null >/tmp/dtvplus_daemon.log 2>&1 &
exit 0
