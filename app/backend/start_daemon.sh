#!/bin/sh
# LGTV root環境で ytdlp-env (Alpine armv7 chroot + Python 3.12 + 公式 yt-dlp) を
# 自動確認・起動するバックグラウンド起動スクリプト

ENV_DIR="/mnt/lg/cmn_data/ytdlp-env"
APP_DIR="/media/developer/apps/usr/palm/applications/tv.dtvplus.webos"

# 万一 ytdlp-env が未構築の場合は自動セットアップ
if [ ! -x "$ENV_DIR/usr/bin/python3" ]; then
  mkdir -p "$ENV_DIR"
  curl -sSL -o /tmp/alpine.tar.gz https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/armv7/alpine-minirootfs-3.21.3-armv7.tar.gz
  tar -xzf /tmp/alpine.tar.gz -C "$ENV_DIR"
  rm -f /tmp/alpine.tar.gz
  cp /etc/resolv.conf "$ENV_DIR/etc/resolv.conf" 2>/dev/null || echo "nameserver 8.8.8.8" > "$ENV_DIR/etc/resolv.conf"
  chroot "$ENV_DIR" /sbin/apk add --no-cache python3 ca-certificates curl >/dev/null 2>&1
fi

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
if [ -f "$APP_DIR/backend/bin/tsreadex-armv7" ]; then
  cp "$APP_DIR/backend/bin/tsreadex-armv7" "$ENV_DIR/usr/local/bin/tsreadex"
  chmod a+rx "$ENV_DIR/usr/local/bin/tsreadex"
fi

# LGTV 純正内蔵の ARIB 放送局ロゴ (/mnt/lg/user/jlogo) と純正チャンネルDB情報を chroot 内へ同期
# (Mirakurun 側で BS一部・CS全局が hasLogoData=false の場合でも純正ロゴとショートカット番号を補完可能にする)
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

# デーモンとしてバックグラウンド起動 (FDを完全に閉じて hbchannel exec を即座に返す)
nohup chroot "$ENV_DIR" /usr/bin/python3 /opt/ytdlp_daemon.py </dev/null >/tmp/dtvplus_daemon.log 2>&1 &
exit 0
