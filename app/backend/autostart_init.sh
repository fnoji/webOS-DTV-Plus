#!/bin/sh
# /var/lib/webosbrew/init.d/91-dtvplus として配置され、TV 起動時に
# yt-dlp 常駐デーモンを自動起動するための init スクリプト。
(
    i=0
    while [ "$i" -lt 45 ]; do
        if [ -f "/media/developer/apps/usr/palm/applications/tv.dtvplus.webos/backend/start_daemon.sh" ]; then
            break
        fi
        sleep 1
        i=$((i + 1))
    done
    [ -f "/media/developer/apps/usr/palm/applications/tv.dtvplus.webos/backend/start_daemon.sh" ] || exit 0

    sleep 2
    LD_PRELOAD="" /bin/sh "/media/developer/apps/usr/palm/applications/tv.dtvplus.webos/backend/start_daemon.sh" >/tmp/autostart_dtvplus.log 2>&1
) </dev/null >/dev/null 2>&1 &
