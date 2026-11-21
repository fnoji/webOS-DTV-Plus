#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ytdlp_daemon.py - LGTV chroot (Python 3.12 + 公式 yt-dlp) 上で動作する常駐ストリーム抽出デーモン
- ストリームURL抽出はすべて公式 yt-dlp (yt_dlp.YoutubeDL) に一本化
- リモコン1クリックでの yt-dlp 自己更新 (/api/ytdlp/update -> yt-dlp -U + 自動ホットリロード)
- TVer おすすめ一覧・検索 & yt-dlp 抽出
- Abema TV 現在放送中チャンネル一覧 & yt-dlp 抽出 (abematv-license AES-128 鍵解決プロキシ内蔵)
- Mirakurun 生TSストリーム中継 (/stream/*.m2ts)
"""
import collections
import concurrent.futures
import ctypes
import datetime
import http.client
import ipaddress
import json
import os
import queue
import re
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# TV の通信環境で Akamai / CDN の IPv6 ルートが TLS handshake timeout を起こすため、
# デーモン内の名前解決は IPv4 (AF_INET) を最優先・強制する
_ORIG_GETADDRINFO = socket.getaddrinfo


def _ipv4_preferred_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    if family in (0, socket.AF_UNSPEC):
        try:
            v4 = _ORIG_GETADDRINFO(host, port, socket.AF_INET, type, proto, flags)
            if v4:
                return v4
        except Exception:
            pass
    return _ORIG_GETADDRINFO(host, port, family, type, proto, flags)


socket.getaddrinfo = _ipv4_preferred_getaddrinfo

# /usr/local/bin/yt-dlp (公式 zipapp) を直接 import 可能にする
YTDLP_BIN = "/usr/local/bin/yt-dlp"
if os.path.exists(YTDLP_BIN) and YTDLP_BIN not in sys.path:
    sys.path.insert(0, YTDLP_BIN)

PORT = 7019
PREFS_FILE = (
    os.path.join(os.environ.get("TEMP", "."), "dtvplus_jikkyo_prefs.json")
    if os.name == "nt"
    else "/opt/dtvplus_jikkyo_prefs.json"
)
SYNCED_SETTINGS_FILE = (
    os.path.join(os.environ.get("TEMP", "."), "dtvplus_synced_settings.json")
    if os.name == "nt"
    else "/opt/dtvplus_synced_settings.json"
)
TV_CHANNEL_DB_FILE = "/opt/tv_channel_db.json"
JLOGO_DIR = "/opt/jlogo"
PREFS_LOCK = threading.Lock()
SYNC_SETTINGS_LOCK = threading.Lock()
LOGO_LOCK = threading.Lock()
LOGO_CACHE = {}
TV_CHANNEL_INDEX = None
YDL_LOCK = threading.Lock()
YDL_READY_EVENT = threading.Event()
ABEMA_KEY_LOCK = threading.Lock()
ABEMA_KEY_CACHE = {}

yt_dlp = None
SHARED_YDL = None
ABEMA_IE = None
ABEMA_LICENSE_RH = None


def get_abema_videokey(ticket):
    """AbemaTV AES-128 復号鍵 (16B) をロック分離＆キャッシュ付きで取得する"""
    if not ticket:
        return b""
    with ABEMA_KEY_LOCK:
        cached = ABEMA_KEY_CACHE.get(ticket)
        if cached:
            return cached
    wait_ydl()
    with ABEMA_KEY_LOCK:
        cached = ABEMA_KEY_CACHE.get(ticket)
        if cached:
            return cached
        key_bytes = ABEMA_LICENSE_RH._get_videokey_from_ticket(ticket)
        if len(ABEMA_KEY_CACHE) > 256:
            ABEMA_KEY_CACHE.clear()
        ABEMA_KEY_CACHE[ticket] = key_bytes
        return key_bytes


# OpenSSL libcrypto (AES-128-CBC) 高速バインディング (C速度復号)
_OPENSSL_AES = None


def _init_openssl_aes():
    global _OPENSSL_AES
    if _OPENSSL_AES is not None:
        return _OPENSSL_AES
    lib_names = (
        ("libcrypto-3-x64.dll", "libcrypto-3.dll", "libcrypto-1_1-x64.dll")
        if os.name == "nt"
        else ("libcrypto.so.3", "libcrypto.so.1.1", "libcrypto.so")
    )
    for lib_name in lib_names:
        try:
            lib = ctypes.CDLL(lib_name)
            ctx_new = lib.EVP_CIPHER_CTX_new
            ctx_new.restype = ctypes.c_void_p
            ctx_free = lib.EVP_CIPHER_CTX_free
            ctx_free.argtypes = [ctypes.c_void_p]
            cipher_fn = lib.EVP_aes_128_cbc
            cipher_fn.restype = ctypes.c_void_p
            dec_init = lib.EVP_DecryptInit_ex
            dec_init.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
            dec_upd = lib.EVP_DecryptUpdate
            dec_upd.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.POINTER(ctypes.c_int), ctypes.c_char_p, ctypes.c_int]
            dec_fin = lib.EVP_DecryptFinal_ex
            dec_fin.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.POINTER(ctypes.c_int)]
            _OPENSSL_AES = (ctx_new, ctx_free, cipher_fn, dec_init, dec_upd, dec_fin)
            return _OPENSSL_AES
        except Exception:
            continue
    _OPENSSL_AES = False
    return _OPENSSL_AES


def decrypt_aes_128_cbc(data, key, iv):
    """HLS セグメントを AES-128-CBC 復号する (libcrypto C速度優先、フォールバックは yt_dlp.aes)"""
    api = _init_openssl_aes()
    if api:
        ctx_new, ctx_free, cipher_fn, dec_init, dec_upd, dec_fin = api
        ctx = ctx_new()
        try:
            dec_init(ctx, cipher_fn(), None, key, iv)
            out_buf = ctypes.create_string_buffer(len(data) + 32)
            out_len1 = ctypes.c_int()
            dec_upd(ctx, out_buf, ctypes.byref(out_len1), data, len(data))
            out_len2 = ctypes.c_int()
            tail_buf = ctypes.create_string_buffer(32)
            ok = dec_fin(ctx, tail_buf, ctypes.byref(out_len2))
            return out_buf.raw[:out_len1.value] + (tail_buf.raw[:out_len2.value] if ok else b"")
        finally:
            ctx_free(ctx)
    wait_ydl()
    from yt_dlp.aes import aes_cbc_decrypt_bytes
    dec = bytes(aes_cbc_decrypt_bytes(list(data), list(key), list(iv)))
    if dec:
        pad = dec[-1]
        if 1 <= pad <= 16 and dec[-pad:] == bytes([pad]) * pad:
            dec = dec[:-pad]
    return dec


def warmup_ytdlp():
    """HTTPポートの即時応答を妨げないよう、バックグラウンドで yt_dlp をプリロードする"""
    global yt_dlp, SHARED_YDL, ABEMA_IE, ABEMA_LICENSE_RH
    import yt_dlp as _yt_dlp
    from yt_dlp.extractor.abematv import AbemaLicenseRH as _AbemaLicenseRH, AbemaTVIE as _AbemaTVIE

    yt_dlp = _yt_dlp
    SHARED_YDL = _yt_dlp.YoutubeDL({
        "quiet": True,
        "no_warnings": True,
        "nocheckcertificate": False,
        "geo_verification_headers": {"X-Forwarded-For": ""},
    })
    ABEMA_IE = _AbemaTVIE(SHARED_YDL)
    ABEMA_LICENSE_RH = _AbemaLicenseRH(ie=ABEMA_IE, logger=None)
    YDL_READY_EVENT.set()


def wait_ydl():
    YDL_READY_EVENT.wait(timeout=30)

TVER_SESSION = {
    "uid": None,
    "token": None,
    "expires": 0.0,
}
TVER_LOCK = threading.Lock()


def http_json(url, method="GET", data=None, headers=None, timeout=10):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def ensure_tver_platform_session():
    """TVer 番組ブラウジング（一覧・検索）用の匿名トークンを取得する"""
    now = time.time()
    with TVER_LOCK:
        if TVER_SESSION["uid"] and TVER_SESSION["expires"] > now:
            return TVER_SESSION["uid"], TVER_SESSION["token"]

    res = http_json(
        "https://platform-api.tver.jp/v2/api/platform_users/browser/create",
        method="POST",
        data=b"device_type=pc",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://tver.jp",
            "Referer": "https://tver.jp/",
        },
    )
    uid = res["result"]["platform_uid"]
    tok = res["result"]["platform_token"]
    with TVER_LOCK:
        TVER_SESSION["uid"] = uid
        TVER_SESSION["token"] = tok
        TVER_SESSION["expires"] = now + 3600
    return uid, tok


def normalize_tver_ep(ct):
    if not isinstance(ct, dict) or ct.get("type") != "episode":
        return None
    c = ct.get("content") or {}
    ep_id = c.get("id")
    if not ep_id:
        return None
    if c.get("isAvailable") is False:
        return None
    end_at_sec = int(c.get("endAt") or 0)
    if end_at_sec > 0 and end_at_sec <= int(time.time()):
        return None
    ver = str(c.get("version") or "5")
    return {
        "id": ep_id,
        "provider": "tver",
        "pageUrl": f"https://tver.jp/episodes/{ep_id}",
        "version": ver,
        "title": c.get("title") or "",
        "seriesTitle": c.get("seriesTitle") or "",
        "broadcasterName": c.get("broadcasterName") or c.get("productionProviderName") or "TVer",
        "broadcastDateLabel": c.get("broadcastDateLabel") or "",
        "duration": c.get("duration") or 0,
        "expireAt": end_at_sec * 1000 if end_at_sec > 0 else 0,
        "thumbnail": f"https://statics.tver.jp/images/content/thumbnail/episode/medium/{ep_id}.jpg?v={ver}",
    }


TVER_HOME_CACHE = {"expires": 0.0, "data": None}
TVER_GOOD_COUNT_CACHE = {}  # ep_id -> {"goodCount": int, "expires": float}
TVER_GOOD_COUNT_LOCK = threading.Lock()
JIKKYO_FORCE_CACHE = {"expires": 0.0, "forces": {}, "updatedAt": 0}
JIKKYO_FORCE_LOCK = threading.Lock()


def fetch_jikkyo_forces():
    """KonomiTV 準拠: NX-Jikkyo /api/v1/channels から全実況チャンネルのリアルタイム勢い (コメ/分) を一括取得 (30秒キャッシュ)"""
    now = time.time()
    with JIKKYO_FORCE_LOCK:
        if JIKKYO_FORCE_CACHE["expires"] > now and JIKKYO_FORCE_CACHE["forces"]:
            return {
                "ok": True,
                "forces": dict(JIKKYO_FORCE_CACHE["forces"]),
                "updatedAt": JIKKYO_FORCE_CACHE["updatedAt"],
            }
    try:
        data = http_json(
            "https://nx-jikkyo.tsukumijima.net/api/v1/channels",
            headers={"User-Agent": "DTVPlus/1.0"},
            timeout=5,
        )
        forces = {}
        if isinstance(data, list):
            for ch in data:
                if not isinstance(ch, dict) or not ch.get("id"):
                    continue
                cid = str(ch["id"]).strip().lower()
                threads = ch.get("threads") or []
                active = None
                for th in threads:
                    if isinstance(th, dict) and th.get("status") == "ACTIVE":
                        active = th
                        break
                if active is not None and active.get("jikkyo_force") is not None:
                    forces[cid] = int(active["jikkyo_force"])
        now_ms = int(time.time() * 1000)
        with JIKKYO_FORCE_LOCK:
            if forces:
                JIKKYO_FORCE_CACHE["forces"] = forces
                JIKKYO_FORCE_CACHE["expires"] = time.time() + 30.0
                JIKKYO_FORCE_CACHE["updatedAt"] = now_ms
            return {
                "ok": True,
                "forces": dict(JIKKYO_FORCE_CACHE["forces"]),
                "updatedAt": JIKKYO_FORCE_CACHE["updatedAt"],
            }
    except Exception as e:
        with JIKKYO_FORCE_LOCK:
            return {
                "ok": False,
                "error": str(e),
                "forces": dict(JIKKYO_FORCE_CACHE["forces"]),
                "updatedAt": JIKKYO_FORCE_CACHE["updatedAt"],
            }


def fetch_tver_good_counts(episode_ids):
    """TVer エピソード ID 配列のグッド数 (goodCount) を 15 分キャッシュ＋控えめ並列で取得する"""
    if not isinstance(episode_ids, list):
        return {"ok": True, "counts": {}}
    clean_ids = []
    seen = set()
    for x in episode_ids:
        s = str(x or "").strip()
        if s and re.match(r"^ep[a-z0-9]{6,}$", s, re.I) and s not in seen:
            seen.add(s)
            clean_ids.append(s)
            if len(clean_ids) >= 24:
                break
    if not clean_ids:
        return {"ok": True, "counts": {}}

    now = time.time()
    out = {}
    missing = []
    with TVER_GOOD_COUNT_LOCK:
        for eid in clean_ids:
            c = TVER_GOOD_COUNT_CACHE.get(eid)
            if c and c["expires"] > now:
                out[eid] = c["goodCount"]
            else:
                missing.append(eid)

    if missing:
        try:
            uid, tok = ensure_tver_platform_session()
        except Exception:
            uid, tok = None, None
        if uid and tok:
            hdrs = _tver_headers({"x-tver-platform-type": "web", "Origin": "https://tver.jp", "Referer": "https://tver.jp/"})

            def _fetch_one(eid):
                try:
                    u = f"https://platform-api.tver.jp/service/api/v1/callEpisode/{eid}?platform_uid={uid}&platform_token={tok}"
                    d = http_json(u, headers=hdrs, timeout=5)
                    gc = (d.get("result") or {}).get("goodCount")
                    if gc is not None:
                        return eid, max(0, int(gc))
                except Exception:
                    pass
                return eid, None

            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
                for eid, gc in ex.map(_fetch_one, missing):
                    if gc is not None:
                        out[eid] = gc
                        with TVER_GOOD_COUNT_LOCK:
                            if len(TVER_GOOD_COUNT_CACHE) > 512:
                                TVER_GOOD_COUNT_CACHE.clear()
                            TVER_GOOD_COUNT_CACHE[eid] = {"goodCount": gc, "expires": time.time() + 900.0}

    return {"ok": True, "counts": out}


def fetch_tver_home():
    now = time.time()
    if TVER_HOME_CACHE["data"] is not None and TVER_HOME_CACHE["expires"] > now:
        return TVER_HOME_CACHE["data"]
    uid, tok = ensure_tver_platform_session()
    url = f"https://platform-api.tver.jp/service/api/v2/callHome?platform_uid={uid}&platform_token={tok}"
    data = http_json(url, headers={
        "x-tver-platform-type": "web",
        "Origin": "https://tver.jp",
        "Referer": "https://tver.jp/",
    })
    sections = []
    seen = set()
    for comp in data.get("result", {}).get("components", []):
        label = comp.get("label") or comp.get("componentID") or ""
        items = []
        for raw in comp.get("contents", []):
            ep = normalize_tver_ep(raw)
            if ep and ep["id"] not in seen:
                seen.add(ep["id"])
                items.append(ep)
                if len(items) >= 20:
                    break
        if items:
            sections.append({"label": label, "items": items})
            if len(sections) >= 10:
                break
    out = {"sections": sections}
    if sections:
        TVER_HOME_CACHE["data"] = out
        TVER_HOME_CACHE["expires"] = now + 180.0
    return out


def fetch_tver_search(keyword):
    uid, tok = ensure_tver_platform_session()
    q = urllib.parse.quote(keyword or "")
    url = f"https://platform-api.tver.jp/service/api/v2/callKeywordSearch?platform_uid={uid}&platform_token={tok}&keyword={q}"
    data = http_json(url, headers={
        "x-tver-platform-type": "web",
        "Origin": "https://tver.jp",
        "Referer": "https://tver.jp/",
    })
    items = []
    for raw in data.get("result", {}).get("contents", []):
        ep = normalize_tver_ep(raw)
        if ep:
            items.append(ep)
            if len(items) >= 60:
                break
    return {"items": items}


# =========================================================================
# TVer リアルタイム同時配信 (民放5局) & スペシャルライブ・24時間ニュース
# =========================================================================
TVER_STREAKS_CACHE = {
    "expires": 0.0,
    "data": None,
}
TVER_STREAKS_LOCK = threading.Lock()
TVER_SIMUL_DEFAULT_NAMES = {
    "ntv": "日テレ",
    "ex": "テレビ朝日",
    "tbs": "TBS",
    "tx": "テレ東",
    "cx": "フジテレビ",
}


def _tver_headers(extra=None):
    h = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Origin": "https://tver.jp",
        "Referer": "https://tver.jp/",
    }
    if extra:
        h.update(extra)
    return h


def _get_tver_streaks_info():
    """TVer ライブ再生・EPG 取得用の Streaks プロジェクト設定をキャッシュ取得する"""
    now = time.time()
    with TVER_STREAKS_LOCK:
        if TVER_STREAKS_CACHE["data"] and TVER_STREAKS_CACHE["expires"] > now:
            return TVER_STREAKS_CACHE["data"]
    data = http_json(
        "https://player.tver.jp/player/streaks_info_v2.json",
        headers=_tver_headers(),
        timeout=10,
    )
    with TVER_STREAKS_LOCK:
        TVER_STREAKS_CACHE["data"] = data
        TVER_STREAKS_CACHE["expires"] = now + 3600.0
    return data


def _get_streaks_api_key(sinfo, project_id):
    proj_cfg = (sinfo or {}).get(project_id) or {}
    ak_map = proj_cfg.get("api_key") or {}
    return ak_map.get("key01") or next(iter(ak_map.values()), "")


def _parse_iso_ms(iso_str):
    if not iso_str or not isinstance(iso_str, str):
        return 0
    try:
        s = iso_str.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return int(datetime.datetime.fromisoformat(s).timestamp() * 1000)
    except Exception:
        return 0


def _is_tver_epg_filler(prog):
    """
    Streaks EPG エントリが配信休止・配信準備中・お知らせフィラー枠かを判定する。
    各局で休止の表現が異なる (ntv/tbs: 配信休止, tx: 配信準備中, cx: 配信番組のお知らせ, ex: 枠なし) ため、
    公式カテゴリ program_category == "99" とタイトル両面から確実に判定する。
    """
    if not isinstance(prog, dict):
        return True
    mrss = prog.get("mrss") or {}
    if str(mrss.get("program_category") or "") == "99":
        return True
    title = str(prog.get("title") or "").strip()
    ser_title = str(prog.get("series_title") or "").strip()
    combined = f"{ser_title} {title}"
    for kw in ("配信休止", "配信準備中", "放送休止", "配信番組のお知らせ", "休止中"):
        if kw in combined:
            return True
    return False


def _fmt_jst_hm(ms):
    if not ms:
        return ""
    dt = datetime.datetime.fromtimestamp(ms / 1000.0, datetime.timezone(datetime.timedelta(hours=9)))
    return f"{dt.hour:02d}:{dt.minute:02d}"


def _fetch_tver_simul_channel_epg(ch_id, ch_name, sinfo, today_str, tomorrow_str, now_ms):
    """民放各局の Streaks EPG を取得し、配信中/配信休止・準備中および次回番組情報を組み立てる"""
    proj = f"tver-simul-{ch_id}"
    ak = _get_streaks_api_key(sinfo, proj)
    epg_url = (
        f"https://epg.api.streaks.jp/v1/projects/{proj}/channels/tver-simul-epg-{ch_id}"
        f"/programs?from={today_str}&to={tomorrow_str}"
    )
    contents = []
    epg_ok = False
    if ak:
        try:
            data = http_json(epg_url, headers=_tver_headers({"X-Streaks-Api-Key": ak}), timeout=8)
            contents = data.get("contents") or []
            epg_ok = True
        except Exception as e:
            print(f"[dtvplus-daemon] tver epg err ({ch_id}): {e}", flush=True)

    cur_prog = None
    next_real_prog = None
    for p in contents:
        st_ms = _parse_iso_ms(p.get("start_at"))
        ed_ms = _parse_iso_ms(p.get("end_at"))
        if st_ms <= now_ms < ed_ms:
            cur_prog = p
        elif st_ms >= now_ms and not _is_tver_epg_filler(p):
            if next_real_prog is None or st_ms < _parse_iso_ms(next_real_prog.get("start_at")):
                next_real_prog = p

    is_filler = _is_tver_epg_filler(cur_prog)
    next_start_ms = _parse_iso_ms(next_real_prog.get("start_at")) if next_real_prog else 0
    next_end_ms = _parse_iso_ms(next_real_prog.get("end_at")) if next_real_prog else 0
    next_series = (next_real_prog.get("series_title") or "") if next_real_prog else ""
    next_title_raw = (next_real_prog.get("title") or "") if next_real_prog else ""
    next_disp = next_series or next_title_raw
    if next_series and next_title_raw and next_title_raw != next_series:
        next_disp = f"{next_series} {next_title_raw}"
    next_label = f"次回 {_fmt_jst_hm(next_start_ms)}〜 {next_disp}" if (next_start_ms and next_disp) else ""

    if not is_filler and cur_prog:
        st_ms = _parse_iso_ms(cur_prog.get("start_at"))
        ed_ms = _parse_iso_ms(cur_prog.get("end_at"))
        ser_t = str(cur_prog.get("series_title") or "").strip()
        ep_t = str(cur_prog.get("title") or "").strip()
        thumb_raw = cur_prog.get("thumbnail_path") or ""
        return {
            "id": f"tver_live_{ch_id}",
            "channelId": ch_id,
            "channelName": ch_name,
            "provider": "tver",
            "liveKind": "simul",
            "isLive": True,
            "isOffAir": False,
            "liveStatus": "ON_AIR",
            "statusLabel": "配信中",
            "pageUrl": f"https://tver.jp/live/{ch_id}",
            "seriesTitle": ser_t or ep_t or ch_name,
            "title": ep_t if (ser_t and ep_t != ser_t) else "",
            "broadcasterName": ch_name,
            "broadcastDateLabel": f"{_fmt_jst_hm(st_ms)}〜{_fmt_jst_hm(ed_ms)}" if (st_ms and ed_ms) else "リアルタイム配信",
            "startAt": st_ms,
            "endAt": ed_ms,
            "nextLabel": next_label,
            "nextStartAt": next_start_ms,
            "nextEndAt": next_end_ms,
            "guideUrl": "",
            "thumbnail": _wrap_proxy_img(thumb_raw) if thumb_raw else "",
            "duration": 0,
        }

    # 配信休止・配信準備中（EPG枠なし / program_category=99）
    raw_cur_title = str((cur_prog or {}).get("title") or "")
    raw_cur_ser = str((cur_prog or {}).get("series_title") or "")
    if "準備中" in raw_cur_title or "準備中" in raw_cur_ser:
        off_reason = "配信準備中"
    elif not epg_ok:
        off_reason = "番組表確認中"
    else:
        off_reason = "配信休止中"

    guide_url = str((cur_prog or {}).get("guide_url") or "")
    thumb_raw = (next_real_prog or {}).get("thumbnail_path") or ""
    return {
        "id": f"tver_live_{ch_id}",
        "channelId": ch_id,
        "channelName": ch_name,
        "provider": "tver",
        "liveKind": "simul",
        "isLive": True,
        "isOffAir": True,
        "liveStatus": "OFF_AIR",
        "statusLabel": off_reason,
        "pageUrl": f"https://tver.jp/live/{ch_id}",
        "seriesTitle": ch_name,
        "title": next_label or f"現在は{off_reason}です",
        "broadcasterName": ch_name,
        "broadcastDateLabel": off_reason,
        "startAt": 0,
        "endAt": 0,
        "nextLabel": next_label,
        "nextStartAt": next_start_ms,
        "nextEndAt": next_end_ms,
        "guideUrl": guide_url,
        "thumbnail": _wrap_proxy_img(thumb_raw) if thumb_raw else "",
        "duration": 0,
    }


def _fetch_tver_special_live_onair(uid, tok):
    """TVer の配信中スペシャルライブ・24時間ニュース一覧を取得する"""
    url = f"https://contents-api.tver.jp/contents/api/v1/page/special_live?platform_uid={uid}&platform_token={tok}"
    try:
        res = http_json(url, headers=_tver_headers({"x-tver-platform-type": "web"}), timeout=10)
    except Exception as e:
        print(f"[dtvplus-daemon] tver special_live err: {e}", flush=True)
        return []

    items = []
    seen = set()
    all_secs = []
    hero = res.get("hero") or {}
    floor = res.get("floor") or {}
    all_secs.extend(hero.get("sections") or [])
    all_secs.extend(floor.get("sections") or [])

    for sec in all_secs:
        sec_title = str(sec.get("title") or "")
        for it in sec.get("items") or []:
            if not isinstance(it, dict):
                continue
            lid = it.get("id") or ""
            itype = it.get("item_type") or ""
            lstatus = str(it.get("live_status") or "").lower()
            if not lid or lid in seen:
                continue
            if itype not in ("special_live", "live"):
                continue
            if lstatus != "onair":
                continue
            seen.add(lid)
            img_path = it.get("image_path") or ""
            thumb_raw = ""
            if img_path:
                thumb_raw = img_path if img_path.startswith("http") else ("https://statics.tver.jp" + img_path)
            cap = str(it.get("caption") or "").strip()
            title = str(it.get("title") or "").strip()
            subtitle = str(it.get("subtitle") or "").strip()
            items.append({
                "id": f"tver_splive_{lid}",
                "channelId": lid,
                "channelName": title or lid,
                "provider": "tver",
                "liveKind": "special",
                "isLive": True,
                "isOffAir": False,
                "liveStatus": "ON_AIR",
                "statusLabel": "配信中",
                "sectionLabel": sec_title or "スペシャルライブ",
                "pageUrl": f"https://tver.jp/live/special/{lid}",
                "seriesTitle": title or lid,
                "title": subtitle if (subtitle and subtitle != title) else (sec_title or ""),
                "broadcasterName": cap or "TVer Special Live",
                "broadcastDateLabel": sec_title or "LIVE配信中",
                "thumbnail": _wrap_proxy_img(thumb_raw) if thumb_raw else "",
                "duration": 0,
            })
    return items


def fetch_tver_live_channels():
    """TVer 民放5局リアルタイム同時配信 + 配信中スペシャルライブ/24時間ニュースを一括取得する"""
    uid, tok = ensure_tver_platform_session()
    sinfo = _get_tver_streaks_info()

    # callLiveChannel から公式チャンネル定義を取得（失敗時は5局デフォルト）
    ch_defs = []
    try:
        lc = http_json(
            f"https://platform-api.tver.jp/service/api/v1/callLiveChannel?platform_uid={uid}&platform_token={tok}",
            headers=_tver_headers({"x-tver-platform-type": "web"}),
            timeout=10,
        )
        for raw in (lc.get("result") or {}).get("contents") or []:
            c = raw.get("content") or {}
            cid = c.get("id")
            cname = c.get("name")
            if cid and cname:
                ch_defs.append((cid, cname))
    except Exception as e:
        print(f"[dtvplus-daemon] callLiveChannel err: {e}", flush=True)

    if not ch_defs:
        ch_defs = list(TVER_SIMUL_DEFAULT_NAMES.items())

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    now_jst = now_utc.astimezone(datetime.timezone(datetime.timedelta(hours=9)))
    today_str = now_jst.strftime("%Y-%m-%d")
    tomorrow_str = (now_jst + datetime.timedelta(days=1)).strftime("%Y-%m-%d")
    now_ms = int(now_utc.timestamp() * 1000)

    simul_map = {}
    special_list = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        futs = {
            ex.submit(_fetch_tver_simul_channel_epg, cid, cname, sinfo, today_str, tomorrow_str, now_ms): ("simul", cid)
            for cid, cname in ch_defs
        }
        futs[ex.submit(_fetch_tver_special_live_onair, uid, tok)] = ("special", "")
        for fut in concurrent.futures.as_completed(futs):
            kind, cid = futs[fut]
            try:
                res = fut.result()
                if kind == "simul":
                    simul_map[cid] = res
                else:
                    special_list = res or []
            except Exception as e:
                print(f"[dtvplus-daemon] tver live worker err ({kind}/{cid}): {e}", flush=True)

    ordered_simul = [simul_map[cid] for cid, _ in ch_defs if cid in simul_map]
    return {
        "channels": ordered_simul,
        "specialChannels": special_list,
        "updatedAt": now_ms,
    }


def _parse_tver_live_url(target_url):
    """TVer ライブ URL から (kind, id) を抽出する。該当しなければ (None, None)"""
    if not target_url:
        return None, None
    m_sp = re.match(r"^https?://(?:www\.)?tver\.jp/live/special/([A-Za-z0-9_-]+)", target_url.strip())
    if m_sp:
        return "special", m_sp.group(1)
    m_sm = re.match(r"^https?://(?:www\.)?tver\.jp/live/(?:simul/)?(ntv|ex|tbs|tx|cx)(?:[/?#]|$)", target_url.strip())
    if m_sm:
        return "simul", m_sm.group(1)
    return None, None


def _resolve_tver_live_variant(kind, target_id):
    """
    TVer ライブ (simul / special) の Streaks PlaybackApi + SSAI SessionApi を実行し、
    最高画質 (720p/1080p以下) のメディアプレイリスト URL と初回プレイリスト文字列を返す。
    """
    sinfo = _get_tver_streaks_info()
    title_hint = ""
    broadcaster_hint = ""

    if kind == "simul":
        proj = f"tver-simul-{target_id}"
        media_ref = f"ref:simul-{target_id}"
        broadcaster_hint = TVER_SIMUL_DEFAULT_NAMES.get(target_id, target_id.upper())
        title_hint = f"{broadcaster_hint} リアルタイム配信"
    elif kind == "special":
        proj = "tver-splive"
        media_ref = f"ref:{target_id}"
        try:
            meta = http_json(
                f"https://statics.tver.jp/content/live/{target_id}.json",
                headers=_tver_headers(),
                timeout=8,
            )
            lv = meta.get("liveVideo") or {}
            if lv.get("projectID"):
                proj = lv["projectID"]
            if lv.get("mediaID"):
                media_ref = lv["mediaID"]
            title_hint = meta.get("title") or ""
            broadcaster_hint = meta.get("broadcastProviderLabel") or "TVer Special Live"
        except Exception as e:
            print(f"[dtvplus-daemon] tver special meta err ({target_id}): {e}", flush=True)
    else:
        raise RuntimeError("未対応の TVer ライブ種別です")

    ak = _get_streaks_api_key(sinfo, proj)
    if not ak:
        raise RuntimeError(f"TVer ライブの配信設定が見つかりません ({proj})")

    hdrs = _tver_headers({"X-Streaks-Api-Key": ak})
    try:
        pb = http_json(
            f"https://playback.api.streaks.jp/v1/projects/{proj}/medias/{media_ref}",
            headers=hdrs,
            timeout=10,
        )
    except urllib.error.HTTPError as e:
        if e.code in (403, 404, 410):
            raise RuntimeError("現在このチャンネルは配信を停止しています")
        raise RuntimeError(f"TVer ライブ情報の取得に失敗しました (HTTP {e.code})")

    sources = pb.get("sources") or []
    src_obj = None
    for s in sources:
        if isinstance(s, dict) and s.get("src") and "hls" in str(s.get("label") or s.get("type") or "").lower():
            src_obj = s
            break
    if not src_obj and sources:
        src_obj = sources[0]
    if not src_obj or not src_obj.get("src"):
        raise RuntimeError("現在このチャンネルは配信を停止しています")

    master_url = src_obj["src"]
    # SSAI が有効なライブ (民放5局同時配信) は SessionApi で session クエリを取得する
    if src_obj.get("ssai") and pb.get("id") and src_obj.get("id"):
        post_h = dict(hdrs)
        post_h["Content-Type"] = "application/json"
        payload = json.dumps({"id": src_obj["id"], "ads_params": {}}).encode("utf-8")
        try:
            sres = http_json(
                f"https://ssai.api.streaks.jp/v1/projects/{proj}/medias/{pb['id']}/ssai/session",
                method="POST",
                data=payload,
                headers=post_h,
                timeout=10,
            )
            items = sres if isinstance(sres, list) else [sres]
            q_str = (items[0] or {}).get("query") if items else ""
            if q_str:
                master_url = master_url + ("&" if "?" in master_url else "?") + q_str
        except Exception as e:
            print(f"[dtvplus-daemon] tver ssai session err ({kind}/{target_id}): {e}", flush=True)

    # マスタープレイリストの疎通確認とバリアント選択
    req = urllib.request.Request(master_url, headers=_tver_headers())
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            master_txt = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code in (403, 404, 410, 503):
            raise RuntimeError("現在このチャンネルは配信を停止しています")
        raise RuntimeError(f"ライブマニフェスト取得エラー (HTTP {e.code})")

    if "#EXTM3U" not in master_txt:
        raise RuntimeError("現在このチャンネルは配信を停止しています")

    variants = []
    cur_bw = 0
    cur_res_w = 0
    for line in master_txt.splitlines():
        s = line.strip()
        if s.startswith("#EXT-X-STREAM-INF:"):
            m_bw = re.search(r"BANDWIDTH=(\d+)", s)
            cur_bw = int(m_bw.group(1)) if m_bw else 0
            m_res = re.search(r"RESOLUTION=(\d+)x(\d+)", s)
            cur_res_w = int(m_res.group(1)) if m_res else 0
        elif s and not s.startswith("#"):
            variants.append((cur_res_w, cur_bw, urllib.parse.urljoin(master_url, s)))
            cur_bw = 0
            cur_res_w = 0

    if variants:
        cands = [v for v in variants if v[0] <= 1920] or variants
        cands.sort(key=lambda x: (x[0], x[1]), reverse=True)
        media_url = cands[0][2]
        initial_media_txt = None
    else:
        media_url = master_url
        initial_media_txt = master_txt

    return {
        "mediaUrl": media_url,
        "initialMediaText": initial_media_txt,
        "masterUrl": master_url,
        "title": title_hint or pb.get("name") or target_id,
        "broadcaster": broadcaster_hint or "TVer",
    }


def extract_tver_live_info(target_url):
    """TVer ライブ URL を検証・解決し、連続 MPEG-TS ストリーム URL を返す"""
    kind, target_id = _parse_tver_live_url(target_url)
    if not kind or not target_id:
        raise RuntimeError("無効な TVer ライブ URL です")
    resolved = _resolve_tver_live_variant(kind, target_id)
    stream_url = (
        f"http://127.0.0.1:{PORT}/api/tver/live.m2ts?kind="
        + urllib.parse.quote(kind, safe="")
        + "&id="
        + urllib.parse.quote(target_id, safe="")
    )
    return {
        "id": f"tver_{kind}_{target_id}",
        "streamUrl": stream_url,
        "hlsFallbackUrl": "",
        "streamType": "ts",
        "title": resolved["title"],
        "seriesTitle": resolved["broadcaster"],
        "description": "",
        "broadcaster": resolved["broadcaster"],
        "duration": 0,
        "isLive": True,
        "expireAt": 0,
        "extractor": "TVerLiveStreaks",
    }


def _fetch_tver_episode_expire_ms(ep_id):
    """TVer VOD エピソードの配信終了時刻 (ms) と視聴可否を statics JSON (+ callEpisode) から軽量取得する"""
    if not ep_id:
        return None, 0
    url = f"https://statics.tver.jp/content/episode/{ep_id}.json"
    req = urllib.request.Request(url, headers=_tver_headers())
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            meta = json.loads(resp.read().decode("utf-8", errors="replace"))
        vs = meta.get("viewStatus") or {}
        end_sec = int(vs.get("endAt") or 0)
        now_sec = int(time.time())
        if end_sec > 0 and end_sec <= now_sec:
            return True, end_sec * 1000
        return False, end_sec * 1000 if end_sec > 0 else 0
    except urllib.error.HTTPError as e:
        # statics.tver.jp は S3 オリジンのため非公開/削除済みエピソードで 403/404 を返す。
        # platform-api の callEpisode で 404 / isAvailable=False を裏付け確認して誤削除を防ぐ。
        if e.code in (403, 404, 410):
            try:
                uid, tok = ensure_tver_platform_session()
                ce_url = f"https://platform-api.tver.jp/service/api/v1/callEpisode/{ep_id}?platform_uid={uid}&platform_token={tok}"
                ce_req = urllib.request.Request(ce_url, headers=_tver_headers({"x-tver-platform-type": "web"}))
                with urllib.request.urlopen(ce_req, timeout=6) as r2:
                    d2 = json.loads(r2.read().decode("utf-8", errors="replace"))
                c2 = ((d2.get("result") or {}).get("episode") or {}).get("content") or {}
                end2 = int(c2.get("endAt") or 0)
                if c2.get("isAvailable") is False or (end2 > 0 and end2 <= int(time.time())):
                    return True, end2 * 1000 if end2 > 0 else 0
                return False, end2 * 1000 if end2 > 0 else 0
            except urllib.error.HTTPError as e2:
                if e2.code in (404, 410):
                    return True, 0
                return None, 0
            except Exception:
                return None, 0
        return None, 0
    except Exception:
        return None, 0


def check_vod_items_expired(items):
    """
    VOD 視聴履歴の期限切れ・配信終了状態を一括確認する (TVer VOD / ABEMA VOD)。
    通信エラーなど不確実な場合は expired=False を返し誤削除を防止する。
    """
    if not isinstance(items, list):
        return {"results": {}}
    target_items = items[:20]
    results = {}
    now_sec = int(time.time())

    # 1. TVer エピソードは statics.tver.jp を並列チェック (超高速)
    tver_targets = [it for it in target_items if isinstance(it, dict) and str(it.get("provider") or "").upper() == "TVER" and not it.get("isLive") and it.get("id")]
    if tver_targets:
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
            fmap = {ex.submit(_fetch_tver_episode_expire_ms, str(it["id"])): str(it["id"]) for it in tver_targets}
            for fut in concurrent.futures.as_completed(fmap):
                eid = fmap[fut]
                try:
                    is_exp, exp_ms = fut.result()
                    results[eid] = {"expired": bool(is_exp is True), "expireAt": exp_ms}
                except Exception:
                    results[eid] = {"expired": False, "expireAt": 0}

    # 2. ABEMA VOD エピソードは ABEMA API で無料期間・配信終了を確認
    abema_targets = [it for it in target_items if isinstance(it, dict) and str(it.get("provider") or "").upper() == "ABEMA" and not it.get("isLive") and it.get("id")]
    if abema_targets:
        try:
            wait_ydl()
            with YDL_LOCK:
                ABEMA_IE._get_device_token()
                for it in abema_targets:
                    eid = str(it["id"])
                    if "/" in eid or "http" in eid:
                        continue
                    try:
                        p = ABEMA_IE._call_api(f"v1/video/programs/{eid}", f"chk_{eid}", note=False)
                        if not isinstance(p, dict) or not p.get("id"):
                            results[eid] = {"expired": True, "expireAt": 0}
                            continue
                        is_free, _ = _extract_abema_free_badge(p, now_sec)
                        exp_ms = _extract_abema_expire_at_ms(p, now_sec, is_free)
                        end_sec = int(p.get("endAt") or 0)
                        is_exp = False
                        if end_sec > 0 and end_sec <= now_sec:
                            is_exp = True
                        elif not is_free:
                            # 無料視聴期間が終了してプレミアム限定になった場合は自動消去対象
                            is_exp = True
                        elif exp_ms > 0 and exp_ms <= now_sec * 1000:
                            is_exp = True
                        results[eid] = {"expired": is_exp, "expireAt": exp_ms}
                    except Exception as e:
                        msg = str(e).lower()
                        if "404" in msg or "not found" in msg or "410" in msg:
                            results[eid] = {"expired": True, "expireAt": 0}
                        else:
                            results[eid] = {"expired": False, "expireAt": 0}
        except Exception as e:
            print(f"[dtvplus-daemon] abema expiry check err: {e}", flush=True)

    return {"results": results}


ABEMA_DRM_CHANNELS_CACHE = {"expires": 0.0, "ids": set()}


def _get_abema_drm_channel_ids():
    """ABEMA v1/channels から status.drm=True の DRM 保護チャンネル ID 集合を取得する (30分キャッシュ)"""
    now = time.time()
    if ABEMA_DRM_CHANNELS_CACHE["expires"] > now:
        return ABEMA_DRM_CHANNELS_CACHE["ids"]
    try:
        ch_res = ABEMA_IE._call_api("v1/channels", "abema_drm_channels", note=False) or {}
        drm_ids = {
            str(c.get("id"))
            for c in (ch_res.get("channels") or [])
            if isinstance(c, dict) and c.get("id") and (c.get("status") or {}).get("drm")
        }
        ABEMA_DRM_CHANNELS_CACHE["ids"] = drm_ids
        ABEMA_DRM_CHANNELS_CACHE["expires"] = now + 1800.0
        return drm_ids
    except Exception:
        return ABEMA_DRM_CHANNELS_CACHE["ids"]


def fetch_abema_live_channels():
    """yt-dlp の AbemaTVIE 認証トークンを利用して現在放送中の Abema チャンネル・番組一覧を取得する"""
    jst = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
    ymd = jst.strftime("%Y%m%d")
    now_sec = int(time.time())

    wait_ydl()
    with YDL_LOCK:
        ABEMA_IE._get_device_token()
        drm_ids = _get_abema_drm_channel_ids()
        tt = ABEMA_IE._call_api(
            "v1/media",
            "timetable",
            query={"dateFrom": ymd, "dateTo": ymd},
            note=False,
        )

    channels = tt.get("channels") or []
    ch_Data_list = tt.get("channelSchedules") or []
    sched_map = {cs.get("channelId"): cs.get("slots") or [] for cs in ch_Data_list if isinstance(cs, dict)}

    result = []
    for ch in channels:
        cid = ch.get("id")
        cname = ch.get("name")
        if not cid or not cname:
            continue
        slots = sched_map.get(cid) or []
        cur_slot = None
        next_slot = None
        for s_idx, sl in enumerate(slots):
            st = sl.get("startAt") or 0
            ed = sl.get("endAt") or 0
            if st <= now_sec < ed:
                cur_slot = sl
                if s_idx + 1 < len(slots):
                    next_slot = slots[s_idx + 1]
                break
        if not cur_slot and slots:
            cur_slot = slots[0]
            if len(slots) > 1:
                next_slot = slots[1]

        prog_title = (cur_slot or {}).get("title") or cname
        slot_id = (cur_slot or {}).get("id") or ""
        start_at = (cur_slot or {}).get("startAt") or 0
        end_at = (cur_slot or {}).get("endAt") or 0
        # Abema 公式画像 CDN (image.p-c2-x.abema-tv.com) のクエリ付きサムネイルURL構築
        programs = (cur_slot or {}).get("programs") or []
        is_off_air = ("放送休止" in prog_title) or (cur_slot is None) or (not programs and "休止" in prog_title)
        p0 = programs[0] if programs else {}
        prog_id = p0.get("id") or ""
        thumb_img = (p0.get("providedInfo") or {}).get("thumbImg") or "thumb001"
        series_id = (p0.get("series") or {}).get("id") or ""
        desc_parts = []
        raw_desc = (
            (cur_slot or {}).get("content")
            or (p0.get("episode") or {}).get("content")
            or (p0.get("series") or {}).get("content")
            or ""
        )
        if raw_desc:
            desc_parts.append(str(raw_desc).strip())
        casts = (p0.get("credit") or {}).get("casts") or []
        if isinstance(casts, list) and casts:
            desc_parts.append("出演: " + " / ".join(str(c) for c in casts[:12] if c))
        desc_txt = "\n\n".join(desc_parts)
        next_title = str((next_slot or {}).get("title") or "")
        next_start_at = int((next_slot or {}).get("startAt") or 0)
        if is_off_air:
            thumb = ""
        elif prog_id:
            raw_thumb = f"https://image.p-c2-x.abema-tv.com/image/programs/{prog_id}/{thumb_img}.png?height=270&width=480"
            thumb = f"http://127.0.0.1:{PORT}/api/img?url=" + urllib.parse.quote(raw_thumb, safe="")
        elif series_id:
            raw_thumb = f"https://image.p-c2-x.abema-tv.com/image/series/{series_id}/thumb.png?height=270&width=480"
            thumb = f"http://127.0.0.1:{PORT}/api/img?url=" + urllib.parse.quote(raw_thumb, safe="")
        else:
            thumb = ""

        result.append({
            "id": cid,
            "slotId": slot_id,
            "provider": "abema",
            "isLive": True,
            "isOffAir": bool(is_off_air),
            "isDrm": bool(cid in drm_ids),
            "pageUrl": f"https://abema.tv/now-on-air/{cid}",
            "channelName": cname,
            "title": prog_title,
            "description": desc_txt,
            "nextTitle": next_title,
            "nextStartAt": next_start_at * 1000 if next_start_at else 0,
            "startAt": start_at * 1000 if start_at else 0,
            "endAt": end_at * 1000 if end_at else 0,
            "duration": max(0, end_at - start_at),
            "thumbnail": thumb,
            "viewCount": 0,
            "commentCount": 0,
        })

    # 公式アプリと同じ v1/slotAudience API で全放送中チャンネルのリアルタイム視聴数・コメント数を一括付与
    active_sids = [r["slotId"] for r in result if r.get("slotId") and not r.get("isOffAir")]
    if active_sids:
        try:
            with YDL_LOCK:
                aud_res = ABEMA_IE._call_api(
                    "v1/slotAudience",
                    "slot_audience",
                    query={"slotIds": ",".join(active_sids[:80])},
                    note=False,
                ) or {}
            aud_map = {}
            for a in aud_res.get("slotAudiences") or []:
                if isinstance(a, dict) and a.get("slotId"):
                    aud_map[a["slotId"]] = (int(a.get("viewCount") or 0), int(a.get("commentCount") or 0))
            for r in result:
                if r.get("slotId") in aud_map:
                    vc, cc = aud_map[r["slotId"]]
                    r["viewCount"] = vc
                    r["commentCount"] = cc
        except Exception:
            pass

    return {"channels": result}


ABEMA_VOD_HOME_CACHE = {}  # genre_key -> {"expires": float, "data": dict}
ABEMA_VOD_HOME_GENRES = [
    ("animation", "アニメ"),
    ("variety", "バラエティ"),
    ("drama", "ドラマ"),
    ("tvcatchup", "テレ朝見逃し"),
    ("news", "ニュース"),
    ("sports", "スポーツ"),
]
ABEMA_VOD_GENRE_NAMES = {
    "animation": "アニメ",
    "variety": "バラエティ",
    "drama": "ドラマ",
    "tvcatchup": "テレ朝見逃し",
    "news": "ニュース",
    "sports": "スポーツ",
    "movie": "映画",
    "reality": "リアリティーショー",
    "asia": "韓流・アジアドラマ",
    "music": "音楽",
}


def _wrap_proxy_img(raw_url):
    """TV 上の IPv6 タイムアウトを回避するため外部画像 URL をローカル IPv4 プロキシ経由に変換する"""
    if not raw_url:
        return ""
    if raw_url.startswith(f"http://127.0.0.1:{PORT}/api/img?"):
        return raw_url
    return f"http://127.0.0.1:{PORT}/api/img?url=" + urllib.parse.quote(raw_url, safe="")


def _build_abema_thumb_url(thumb_comp, prog_id="", thumb_img="", series_id=""):
    """ABEMA の thumbComponent / programId / seriesId からサムネイル URL を組み立てプロキシ化する"""
    if isinstance(thumb_comp, dict) and thumb_comp.get("urlPrefix") and thumb_comp.get("filename"):
        prefix = thumb_comp["urlPrefix"].rstrip("/")
        fname = thumb_comp["filename"].lstrip("/")
        q = thumb_comp.get("query") or ""
        sep = "&" if q else ""
        raw = f"{prefix}/{fname}?{q}{sep}height=270&width=480"
        return _wrap_proxy_img(raw)
    if prog_id:
        ti = thumb_img or "thumb001"
        return _wrap_proxy_img(
            f"https://image.p-c2-x.abema-tv.com/image/programs/{prog_id}/{ti}.png?height=270&width=480"
        )
    if series_id:
        return _wrap_proxy_img(
            f"https://image.p-c2-x.abema-tv.com/image/series/{series_id}/thumb.png?height=270&width=480"
        )
    return ""


def _extract_abema_free_badge(item_dict, now_sec):
    """ABEMA の作品・エピソード JSON から無料視聴可否と表示ラベルを判定する"""
    if not isinstance(item_dict, dict):
        return False, ""
    label = item_dict.get("label") or {}
    free_end = int(item_dict.get("freeEndAt") or 0)
    clabels = item_dict.get("contentLabels") or []
    badge_text = ""
    for cl in clabels:
        if isinstance(cl, dict):
            vt = cl.get("viewingTypeContentLabel") or {}
            if vt.get("name"):
                badge_text = str(vt["name"])
                break
    if label.get("free"):
        if not badge_text:
            badge_text = "無料"
        if free_end > now_sec and free_end < now_sec + 86400 * 120:
            dt = datetime.datetime.fromtimestamp(free_end, datetime.timezone(datetime.timedelta(hours=9)))
            return True, f"{badge_text} (〜{dt.month}/{dt.day})"
        return True, badge_text
    if free_end > now_sec:
        dt = datetime.datetime.fromtimestamp(free_end, datetime.timezone(datetime.timedelta(hours=9)))
        return True, f"無料 (〜{dt.month}/{dt.day})"
    if label.get("someFree"):
        return True, badge_text or "一部無料"
    # terms 配列に onDemandType == 3 (AVOD無料) が含まれる場合も無料扱い
    for tm in item_dict.get("terms") or []:
        if isinstance(tm, dict) and tm.get("onDemandType") == 3:
            t_end = int(tm.get("endAt") or 0)
            if t_end == 0 or t_end > now_sec:
                return True, badge_text or "無料"
    return False, badge_text or "プレミアム"


def _extract_abema_expire_at_ms(item_dict, now_sec, is_free):
    """ABEMA VOD エピソードの無料配信期限または配信終了時刻 (ミリ秒) を抽出する"""
    if not isinstance(item_dict, dict):
        return 0
    free_end = int(item_dict.get("freeEndAt") or 0)
    end_at = int(item_dict.get("endAt") or 0)
    if is_free:
        if free_end > 0:
            return free_end * 1000
        # terms の AVOD (onDemandType == 3) 終了時刻があればそれを採用
        best_term_end = 0
        for tm in item_dict.get("terms") or []:
            if isinstance(tm, dict) and tm.get("onDemandType") == 3:
                t_end = int(tm.get("endAt") or 0)
                if t_end > now_sec and (best_term_end == 0 or t_end > best_term_end):
                    best_term_end = t_end
        if best_term_end > 0:
            return best_term_end * 1000
    if end_at > 0:
        return end_at * 1000
    return 0


def _normalize_abema_vod_program(p, now_sec, fallback_series_title=""):
    """ABEMA エピソード JSON をフロントエンド共通の VOD カード形式へ変換する"""
    if not isinstance(p, dict):
        return None
    ep_id = p.get("id") or ""
    if not ep_id:
        return None
    ser = p.get("series") or {}
    ser_id = ser.get("id") or ""
    ser_title = ser.get("title") or fallback_series_title or ""
    ep_obj = p.get("episode") or {}
    ep_title = ep_obj.get("title") or p.get("title") or ep_id
    ep_num = ep_obj.get("number")
    info = p.get("info") or {}
    dur = int(info.get("duration") or 0)
    prov = p.get("providedInfo") or {}
    thumb_img = prov.get("thumbImg") or "thumb001"
    # エピソード専用サムネイルを優先し、なければシリーズサムネを使う
    thumb = _build_abema_thumb_url(
        p.get("timelineThumbComponent") or None,
        prog_id=ep_id,
        thumb_img=thumb_img,
        series_id=ser_id,
    )
    is_free, free_label = _extract_abema_free_badge(p, now_sec)
    expire_at_ms = _extract_abema_expire_at_ms(p, now_sec, is_free)
    genre_obj = p.get("genre") or {}
    genre_name = genre_obj.get("name") or ABEMA_VOD_GENRE_NAMES.get(str(genre_obj.get("id") or "").lower(), "") or "ABEMA VOD"
    return {
        "id": ep_id,
        "itemType": "episode",
        "seriesId": ser_id,
        "provider": "abema",
        "isLive": False,
        "isFree": bool(is_free),
        "expireAt": expire_at_ms,
        "pageUrl": f"https://abema.tv/video/episode/{ep_id}",
        "seriesTitle": ser_title or ep_title,
        "title": ep_title if ser_title else "",
        "episodeNumber": ep_num if ep_num is not None else 0,
        "genreName": genre_name if genre_name != "ABEMA VOD" else "",
        "broadcasterName": f"ABEMA {genre_name}" if genre_name != "ABEMA VOD" else "ABEMA VOD",
        "broadcastDateLabel": free_label,
        "duration": dur,
        "thumbnail": thumb,
    }


def fetch_abema_vod_home(genre_id=""):
    """ABEMA の無料見逃し VOD 作品一覧をジャンル別セクションとして取得する (5分キャッシュ)"""
    gkey = (genre_id or "").strip().lower()
    now = time.time()
    cached = ABEMA_VOD_HOME_CACHE.get(gkey)
    if cached and cached["expires"] > now:
        return cached["data"]

    now_sec = int(now)
    wait_ydl()
    sections = []

    if gkey:
        target_genres = [(gkey, ABEMA_VOD_GENRE_NAMES.get(gkey, gkey))]
        per_limit = "30"
    else:
        target_genres = ABEMA_VOD_HOME_GENRES
        per_limit = "12"

    with YDL_LOCK:
        ABEMA_IE._get_device_token()
        for gid, glabel in target_genres:
            try:
                res = ABEMA_IE._call_api(
                    f"v1/video/featureGenres/{gid}/cards",
                    f"vod_{gid}",
                    query={"limit": per_limit, "onlyFree": "true"},
                    note=False,
                )
            except Exception as e:
                print(f"[dtvplus-daemon] abema vod genre {gid} err: {e}", flush=True)
                continue
            items = []
            seen_sids = set()
            for card in res.get("cards") or []:
                if not isinstance(card, dict):
                    continue
                sid = card.get("seriesId") or ""
                title = card.get("title") or ""
                if not sid or not title or sid in seen_sids:
                    continue
                seen_sids.add(sid)
                is_free, free_label = _extract_abema_free_badge(card, now_sec)
                gname = ((card.get("genre") or {}).get("name")) or ABEMA_VOD_GENRE_NAMES.get(gid, "ABEMA")
                thumb = _build_abema_thumb_url(card.get("thumbComponent"), series_id=sid)
                items.append({
                    "id": sid,
                    "itemType": "series",
                    "seriesId": sid,
                    "provider": "abema",
                    "isLive": False,
                    "isFree": bool(is_free),
                    "pageUrl": f"https://abema.tv/video/title/{sid}",
                    "seriesTitle": title,
                    "title": "エピソード一覧を見る ▶",
                    "broadcasterName": f"ABEMA {gname}",
                    "broadcastDateLabel": free_label or "無料あり",
                    "duration": 0,
                    "thumbnail": thumb,
                })
            if items:
                sections.append({"id": gid, "label": glabel, "items": items})

    out = {"genre": gkey, "sections": sections}
    if sections:
        ABEMA_VOD_HOME_CACHE[gkey] = {"expires": now + 300.0, "data": out}
    return out


ABEMA_VOD_SERIES_CACHE = {}  # "sid:season" -> {"expires": float, "data": dict}


def fetch_abema_vod_series(series_id, season_id=""):
    """ABEMA の指定シリーズ ID に属するシーズン一覧・エピソード一覧を取得する (マルチシーズン対応・3分キャッシュ)"""
    sid = (series_id or "").strip()
    req_season = (season_id or "").strip()
    if not sid:
        return {"error": "missing series id", "items": []}
    now = time.time()
    cache_key = f"{sid}:{req_season}"
    cached = ABEMA_VOD_SERIES_CACHE.get(cache_key)
    if cached and cached["expires"] > now:
        return cached["data"]
    now_sec = int(now)
    wait_ydl()

    def _fetch_progs_for_season(target_se_id):
        q = {"limit": "100", "order": "seq"}
        if target_se_id:
            q["seasonId"] = target_se_id
        res = ABEMA_IE._call_api(
            f"v1/video/series/{sid}/programs",
            f"serp_{sid}_{target_se_id or 'all'}",
            query=q,
            note=False,
        ) or {}
        return res.get("programs") or []

    with YDL_LOCK:
        ABEMA_IE._get_device_token()
        s_info = {}
        try:
            s_info = ABEMA_IE._call_api(f"v1/video/series/{sid}", f"ser_{sid}", note=False) or {}
        except Exception:
            s_info = {}

        # 公式アプリ同様の seasons メタデータを抽出・整列
        raw_seasons = s_info.get("seasons") or []
        seasons = []
        for idx, se in enumerate(raw_seasons):
            if not isinstance(se, dict) or not se.get("id"):
                continue
            seasons.append({
                "id": str(se["id"]),
                "name": str(se.get("name") or f"シーズン{se.get('sequence') or (idx + 1)}"),
                "sequence": int(se.get("sequence") or (idx + 1)),
                "order": int(se.get("order") or (idx + 1)),
            })
        seasons.sort(key=lambda x: (x["order"], x["sequence"]))

        active_se_id = req_season
        if not active_se_id and seasons:
            active_se_id = seasons[0]["id"]

        raw_progs = _fetch_progs_for_season(active_se_id)

        # 初回 (season未指定) で複数シーズンがあり、シーズン1に無料話が1話も無ければ最新シーズンも確認して無料側を優先表示
        if not req_season and len(seasons) > 1:
            has_free_first = any(_extract_abema_free_badge(p, now_sec)[0] for p in raw_progs)
            if not has_free_first:
                latest_se_id = seasons[-1]["id"]
                if latest_se_id != active_se_id:
                    try:
                        alt_progs = _fetch_progs_for_season(latest_se_id)
                        if any(_extract_abema_free_badge(p, now_sec)[0] for p in alt_progs):
                            active_se_id = latest_se_id
                            raw_progs = alt_progs
                    except Exception:
                        pass

    ser_title = s_info.get("title") or sid
    ser_desc = s_info.get("content") or ""
    ser_genre_obj = s_info.get("genre") or {}
    ser_genre_name = ser_genre_obj.get("name") or ABEMA_VOD_GENRE_NAMES.get(str(ser_genre_obj.get("id") or "").lower(), "") or ""
    active_se_name = ""
    for se in seasons:
        if se["id"] == active_se_id:
            active_se_name = se["name"]
            break

    items = []
    free_count = 0
    for p in raw_progs:
        ep = _normalize_abema_vod_program(p, now_sec, fallback_series_title=ser_title)
        if ep:
            if not ep.get("genreName") and ser_genre_name:
                ep["genreName"] = ser_genre_name
            if ep["isFree"]:
                free_count += 1
            items.append(ep)

    # 無料話と有料話が混在する場合は、無料話を先頭にまとめて選びやすくする
    if free_count > 0 and free_count < len(items):
        free_items = [x for x in items if x["isFree"]]
        paid_items = [x for x in items if not x["isFree"]]
        items = free_items + paid_items

    out = {
        "seriesId": sid,
        "title": ser_title,
        "content": ser_desc,
        "genreName": ser_genre_name,
        "seasons": seasons,
        "activeSeasonId": active_se_id,
        "activeSeasonName": active_se_name,
        "freeCount": free_count,
        "totalCount": len(items),
        "items": items,
    }
    if items:
        if len(ABEMA_VOD_SERIES_CACHE) >= 64:
            ABEMA_VOD_SERIES_CACHE.clear()
        ABEMA_VOD_SERIES_CACHE[cache_key] = {"expires": time.time() + 180.0, "data": out}
    return out


def fetch_abema_vod_search(keyword):
    """ABEMA の見逃し VOD エピソードをキーワード検索する (無料エピソード優先)"""
    kw = (keyword or "").strip()
    if not kw:
        return {"keyword": "", "items": []}
    now_sec = int(time.time())
    wait_ydl()
    with YDL_LOCK:
        ABEMA_IE._get_device_token()
        res = ABEMA_IE._call_api(
            "v1/search/video/programs",
            "vod_search",
            query={"q": kw, "limit": "45"},
            note=False,
        ) or {}

    items = []
    seen = set()
    for p in res.get("programs") or []:
        ep = _normalize_abema_vod_program(p, now_sec)
        if ep and ep["id"] not in seen:
            seen.add(ep["id"])
            items.append(ep)

    # 無料エピソードを上位に優先表示
    items.sort(key=lambda x: (0 if x.get("isFree") else 1))
    return {"keyword": kw, "items": items}


ABEMA_SLOT_CACHE = {
    "expires": 0.0,
    "channel_to_slots": {},
}


def resolve_active_abema_slot(channel_id):
    """channelId から現在時刻の slotId を解決する（番組切り替わり時の自動追従用）"""
    now = time.time()
    if ABEMA_SLOT_CACHE["expires"] < now or channel_id not in ABEMA_SLOT_CACHE["channel_to_slots"]:
        jst = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
        ymd = jst.strftime("%Y%m%d")
        wait_ydl()
        with YDL_LOCK:
            ABEMA_IE._get_device_token()
            tt = ABEMA_IE._call_api("v1/media", "timetable", query={"dateFrom": ymd, "dateTo": ymd}, note=False)
        mp = {}
        for cs in tt.get("channelSchedules") or []:
            if isinstance(cs, dict) and cs.get("channelId"):
                mp[cs["channelId"]] = cs.get("slots") or []
        ABEMA_SLOT_CACHE["channel_to_slots"] = mp
        ABEMA_SLOT_CACHE["expires"] = now + 300

    now_sec = int(now)
    for sl in ABEMA_SLOT_CACHE["channel_to_slots"].get(channel_id, []):
        if (sl.get("startAt") or 0) <= now_sec < (sl.get("endAt") or 0):
            return sl.get("id")
    return None


def fetch_abema_comments(channel_id="", slot_id=""):
    """
    ABEMA ライブ枠の最新コメントを取得する (試験的機能・フェイルセーフ設計)
    将来 ABEMA 側のコメント API 仕様が変更されても動画再生に影響しないよう例外を隔離して空配列を返す
    """
    try:
        active_slot = slot_id
        if channel_id:
            resolved = resolve_active_abema_slot(channel_id)
            if resolved:
                active_slot = resolved
        if not active_slot:
            return {"ok": False, "slotId": "", "comments": []}

        wait_ydl()
        with YDL_LOCK:
            ABEMA_IE._get_device_token()
            res = ABEMA_IE._call_api(
                f"v1/slots/{active_slot}/comments",
                active_slot,
                query={"limit": "30"},
                note=False,
            )
        raw_list = res.get("comments") or []
        # 古い順 (時系列順) に並べ替えて返す
        items = []
        for c in raw_list:
            if isinstance(c, dict) and c.get("message"):
                items.append({
                    "id": str(c.get("id") or ""),
                    "message": str(c.get("message") or ""),
                    "createdAtMs": int(c.get("createdAtMs") or 0),
                })
        items.sort(key=lambda x: x["createdAtMs"])
        return {"ok": True, "slotId": active_slot, "comments": items}
    except Exception as e:
        return {"ok": False, "slotId": slot_id, "comments": [], "reason": str(e)}


def extract_stream_via_ytdlp(target_url):
    """
    すべての動画配信サイト（TVer / Abema TV / その他）の URL 解決を実行する。
    TVer ライブ (リアルタイム同時配信 / スペシャルライブ) は Streaks Live API で直接解決する。
    """
    tver_live_kind, tver_live_id = _parse_tver_live_url(target_url)
    if tver_live_kind and tver_live_id:
        return extract_tver_live_info(target_url)

    wait_ydl()
    with YDL_LOCK:
        info = SHARED_YDL.extract_info(target_url, download=False)

    if info.get("_type") == "playlist" and info.get("entries"):
        for entry in info["entries"]:
            if entry:
                info = entry
                break

    formats = info.get("formats") or []
    chosen_url = info.get("url")
    # HLS 1080p または最高ビットレートの映像+音声ストリームを選択
    best_fmt = None
    best_score = -1
    for f in formats:
        u = f.get("url") or ""
        if not u:
            continue
        vcodec = f.get("vcodec") or ""
        if vcodec == "none":
            continue
        h = f.get("height") or 0
        tbr = f.get("tbr") or 0
        acodec = f.get("acodec") or ""
        has_audio = 1 if (acodec and acodec != "none") else 0
        # webOS uMediaServer はマスターm3u8または音声同梱HLSを好む
        score = has_audio * 100000 + min(h, 1080) * 50 + tbr
        if score > best_score:
            best_score = score
            best_fmt = f

    if best_fmt and best_fmt.get("url"):
        chosen_url = best_fmt["url"]

    # マスターM3U8 URLが manifest_url にあればアダプティブ再生のためそちらを優先（ただし音声分離でない場合）
    manifest_url = (best_fmt or {}).get("manifest_url") or info.get("manifest_url")
    if manifest_url and (".m3u8" in manifest_url or "/hls/" in manifest_url):
        chosen_url = manifest_url

    is_live = bool(info.get("is_live"))
    is_abema = bool(chosen_url and ("abematv" in chosen_url or "abema.io" in chosen_url or "abema.tv" in target_url))
    hls_fallback_url = ""
    stream_type = "hls"

    # Abema TV は相対パス解決 & abematv-license:// 鍵変換をローカル中継。
    # 特にライブ放送時は TVCM (#EXT-X-DISCONTINUITY + 暗号切替 + PID/PTS不連続) での webOS uMediaServer フリーズを防ぐため、
    # AES復号＋統一PID＋PTS連続化を行った MPEG-2 TS ストリーム (/api/abema/live.m2ts) を優先供給する。
    if is_abema and chosen_url:
        hls_fallback_url = f"http://127.0.0.1:{PORT}/api/abema/m3u8?url=" + urllib.parse.quote(chosen_url, safe="")
        if is_live:
            chosen_url = f"http://127.0.0.1:{PORT}/api/abema/live.m2ts?url=" + urllib.parse.quote(chosen_url, safe="")
            stream_type = "ts"
        else:
            chosen_url = hls_fallback_url

    expire_at_ms = 0
    if not is_live:
        m_tv_ep = re.match(r"^https?://(?:www\.)?tver\.jp/episodes/([A-Za-z0-9_-]+)", target_url.strip())
        if m_tv_ep:
            _, expire_at_ms = _fetch_tver_episode_expire_ms(m_tv_ep.group(1))

    abema_meta = {}
    if not is_live and is_abema:
        m_ab_ep = re.match(r"^https?://abema\.tv/video/episode/([A-Za-z0-9_-]+)", target_url.strip())
        if m_ab_ep:
            abema_meta = _fetch_abema_episode_meta(m_ab_ep.group(1))

    return {
        "id": info.get("id") or "",
        "streamUrl": chosen_url,
        "hlsFallbackUrl": hls_fallback_url,
        "streamType": stream_type,
        "title": abema_meta.get("title") or info.get("title") or "",
        "seriesTitle": abema_meta.get("seriesTitle") or info.get("series") or "",
        "description": abema_meta.get("description") or info.get("description") or "",
        "broadcaster": abema_meta.get("broadcaster") or info.get("channel") or info.get("uploader") or "",
        "genreName": abema_meta.get("genreName") or "",
        "thumbnail": abema_meta.get("thumbnail") or "",
        "duration": info.get("duration") or 0,
        "isLive": is_live,
        "expireAt": abema_meta.get("expireAt") or expire_at_ms,
        "extractor": info.get("extractor_key") or "yt-dlp",
        "ytdlpVersion": yt_dlp.version.__version__,
    }


def _fetch_abema_episode_meta(ep_id):
    """ABEMA 公式 API (v1/video/programs) からエピソード固有の話タイトル・あらすじ・ジャンル・サムネ・期限を 1 回取得する"""
    try:
        wait_ydl()
        with YDL_LOCK:
            ABEMA_IE._get_device_token()
            p = ABEMA_IE._call_api(f"v1/video/programs/{ep_id}", f"epmeta_{ep_id}", note=False) or {}
        if not isinstance(p, dict) or not p.get("id"):
            return {}
        now_sec = int(time.time())
        ser = p.get("series") or {}
        ep = p.get("episode") or {}
        g = p.get("genre") or {}
        prov = p.get("providedInfo") or {}
        ser_title = str(ser.get("title") or "").strip()
        ep_title = str(ep.get("title") or "").strip()
        is_free, _ = _extract_abema_free_badge(p, now_sec)
        raw_thumb = _build_abema_thumb_url(
            p.get("timelineThumbComponent") or None,
            prog_id=ep_id,
            thumb_img=prov.get("thumbImg") or "thumb001",
            series_id=ser.get("id") or "",
        )
        g_name = str(g.get("name") or "").strip()
        return {
            "title": ep_title,
            "seriesTitle": ser_title,
            "description": str(ep.get("content") or ser.get("content") or "").strip(),
            "broadcaster": f"ABEMA {g_name}" if g_name else "ABEMA",
            "genreName": g_name,
            "thumbnail": raw_thumb or "",
            "expireAt": _extract_abema_expire_at_ms(p, now_sec, is_free),
        }
    except Exception:
        return {}


def rewrite_abema_m3u8(m3u8_url):
    """Abema TV の HLS マニフェスト内の相対URLと abematv-license:// 鍵URLをローカルブリッジ向けに書き換える"""
    req = urllib.request.Request(m3u8_url, headers={
        "User-Agent": "Mozilla/5.0",
        "Origin": "https://abema.tv",
        "Referer": "https://abema.tv/",
    })
    with urllib.request.urlopen(req, timeout=10) as resp:
        text = resp.read().decode("utf-8", errors="replace")

    out_lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            out_lines.append(line)
            continue
        if stripped.startswith("#EXT-X-KEY:") and "abematv-license://" in stripped:
            def repl_key(m):
                ticket = m.group(1)
                return f'URI="http://127.0.0.1:{PORT}/api/abema/key?ticket={urllib.parse.quote(ticket)}"'
            line = re.sub(r'URI="abematv-license://([^"]+)"', repl_key, stripped)
            out_lines.append(line)
        elif stripped.startswith("#EXT-X-MEDIA:") and 'URI="' in stripped:
            def repl_media(m):
                raw_u = urllib.parse.urljoin(m3u8_url, m.group(1))
                return f'URI="http://127.0.0.1:{PORT}/api/abema/m3u8?url={urllib.parse.quote(raw_u, safe="")}"'
            out_lines.append(re.sub(r'URI="([^"]+)"', repl_media, stripped))
        elif stripped.startswith("#"):
            out_lines.append(line)
        else:
            abs_u = urllib.parse.urljoin(m3u8_url, stripped)
            if ".m3u8" in abs_u.split("?")[0]:
                out_lines.append(f"http://127.0.0.1:{PORT}/api/abema/m3u8?url=" + urllib.parse.quote(abs_u, safe=""))
            else:
                out_lines.append(abs_u)
    return "\n".join(out_lines) + "\n"


def _abema_http_get(url, timeout=10):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0",
        "Origin": "https://abema.tv",
        "Referer": "https://abema.tv/",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _mpeg2_crc32(data):
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= (b << 24)
        for _ in range(8):
            if crc & 0x80000000:
                crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF
            else:
                crc = (crc << 1) & 0xFFFFFFFF
    return struct.pack(">I", crc)


def _read_ts33(buf, off):
    b0, b1, b2, b3, b4 = buf[off], buf[off + 1], buf[off + 2], buf[off + 3], buf[off + 4]
    return (((b0 >> 1) & 0x07) << 30) | (b1 << 22) | (((b2 >> 1) & 0x7F) << 15) | (b3 << 7) | ((b4 >> 1) & 0x7F)


def _write_ts33(buf, off, top4, val):
    val &= 0x1FFFFFFFF
    buf[off] = top4 | (((val >> 30) & 0x07) << 1) | 0x01
    buf[off + 1] = (val >> 22) & 0xFF
    buf[off + 2] = (((val >> 15) & 0x7F) << 1) | 0x01
    buf[off + 3] = (val >> 7) & 0xFF
    buf[off + 4] = ((val & 0x7F) << 1) | 0x01


def _read_pcr33(buf, off):
    return (buf[off] << 25) | (buf[off + 1] << 17) | (buf[off + 2] << 9) | (buf[off + 3] << 1) | (buf[off + 4] >> 7)


def _write_pcr33(buf, off, val):
    val &= 0x1FFFFFFFF
    buf[off] = (val >> 25) & 0xFF
    buf[off + 1] = (val >> 17) & 0xFF
    buf[off + 2] = (val >> 9) & 0xFF
    buf[off + 3] = (val >> 1) & 0xFF
    buf[off + 4] = ((val & 0x01) << 7) | (buf[off + 4] & 0x7F)


def _signed_ts33_diff(a, b):
    d = (a - b) & 0x1FFFFFFFF
    if d >= 0x100000000:
        d -= 0x200000000
    return d


class AbemaContinuousTSNormalizer:
    """
    ABEMA の暗号化本編・非暗号化 TVCM・sleep ループなど、異なる PID・PTS・暗号状態の TS セグメントを
    1本の途切れない標準 MPEG-2 TS (PAT=0x0000, PMT=0x1000, Video=0x0100, Audio=0x0101) へリアルタイム正規化する。
    """

    OUT_PMT_PID = 0x1000
    OUT_VIDEO_PID = 0x0100
    OUT_AUDIO_PID = 0x0101

    VIDEO_STYPES = frozenset({0x01, 0x02, 0x1B, 0x24})
    AUDIO_STYPES = frozenset({0x03, 0x04, 0x0F, 0x11})

    def __init__(self, normalize_pcr=False):
        self.cc = {0x0000: 0, self.OUT_PMT_PID: 0, self.OUT_VIDEO_PID: 0, self.OUT_AUDIO_PID: 0}
        self.offset_90k = None
        self.last_out_max_pts = None
        self.last_out_pcr = None
        self.normalize_pcr = bool(normalize_pcr)
        self.last_vid_stype = 0x1B
        self.last_aud_stype = 0x0F
        self.last_vid_pid = None
        self.last_aud_pid = None
        self.last_pcr_pid = None
        self.program_audio_sr_idx = None  # 本編の ADTS sampling_frequency_index (3=48kHz, 4=44.1kHz)
        # 統一 PAT セクション事前計算
        pat_sec = bytes([0x00, 0xB0, 0x0D, 0x00, 0x01, 0xC1, 0x00, 0x00, 0x00, 0x01, 0xF0, 0x00])
        self._pat_payload = b"\x00" + pat_sec + _mpeg2_crc32(pat_sec)
        self._pmt_cache = {}

    def _next_monotonic_pcr(self, ref_dts):
        """
        TVer Streaks 等の独立 HLS セグメントが毎セグメント境界で PCR を逆行 (-1.76秒等) させる問題を防ぐため、
        現在映像 DTS から 500ms (45000 ticks) 先行した厳密単調増加 PCR を生成する。
        """
        target = (ref_dts - 45000) & 0x1FFFFFFFF
        if self.last_out_pcr is not None:
            diff = _signed_ts33_diff(target, self.last_out_pcr)
            if diff <= 0:
                target = (self.last_out_pcr + 90) & 0x1FFFFFFFF
            elif diff > 90000 * 3:
                target = (self.last_out_pcr + 9000) & 0x1FFFFFFFF
        self.last_out_pcr = target
        return target

    def _build_psi_packet(self, pid, payload):
        cc = self.cc[pid]
        self.cc[pid] = (cc + 1) & 0x0F
        hdr = bytes([0x47, 0x40 | ((pid >> 8) & 0x1F), pid & 0xFF, 0x10 | cc])
        pad = 184 - len(payload)
        return hdr + payload + (b"\xff" * pad)

    def _get_pmt_payload(self, vid_stype, aud_stype):
        key = (vid_stype, aud_stype)
        if key not in self._pmt_cache:
            pmt_sec = bytes([
                0x02, 0xB0, 0x17, 0x00, 0x01, 0xC1, 0x00, 0x00,
                0xE1, 0x00,  # PCR_PID = 0x0100
                0xF0, 0x00,  # program_info_length = 0
                vid_stype, 0xE1, 0x00, 0xF0, 0x00,
                aud_stype, 0xE1, 0x01, 0xF0, 0x00,
            ])
            self._pmt_cache[key] = b"\x00" + pmt_sec + _mpeg2_crc32(pmt_sec)
        return self._pmt_cache[key]

    def _detect_segment_map(self, ts_bytes):
        n = len(ts_bytes)
        pmt_pid = None
        vid_pid = None
        aud_pid = None
        pcr_pid = None
        vid_stype = self.last_vid_stype
        aud_stype = self.last_aud_stype
        seg_base_pts = None

        scan_limit = min(n, 188 * 2500)
        for i in range(0, scan_limit - 187, 188):
            if ts_bytes[i] != 0x47:
                continue
            pid = ((ts_bytes[i + 1] & 0x1F) << 8) | ts_bytes[i + 2]
            pusi = (ts_bytes[i + 1] & 0x40) != 0
            afc = (ts_bytes[i + 3] >> 4) & 0x03

            if afc in (0, 2):
                continue
            off = i + 4 + (1 + ts_bytes[i + 4] if afc == 3 else 0)
            end = i + 188
            if off >= end:
                continue

            if pid == 0 and pusi and off + 1 < end:
                ptr = ts_bytes[off]
                sec_start = off + 1 + ptr
                if sec_start + 12 <= end and ts_bytes[sec_start] == 0x00:
                    pmt_pid = ((ts_bytes[sec_start + 10] & 0x1F) << 8) | ts_bytes[sec_start + 11]
            elif pmt_pid and pid == pmt_pid and pusi and vid_pid is None and off + 1 < end:
                ptr = ts_bytes[off]
                s = off + 1 + ptr
                if s + 12 <= end and ts_bytes[s] == 0x02:
                    slen = ((ts_bytes[s + 1] & 0x0F) << 8) | ts_bytes[s + 2]
                    pcr_pid = ((ts_bytes[s + 8] & 0x1F) << 8) | ts_bytes[s + 9]
                    pil = ((ts_bytes[s + 10] & 0x0F) << 8) | ts_bytes[s + 11]
                    pos = s + 12 + pil
                    sec_end = min(end, s + 3 + slen - 4)
                    while pos + 5 <= sec_end:
                        st = ts_bytes[pos]
                        epid = ((ts_bytes[pos + 1] & 0x1F) << 8) | ts_bytes[pos + 2]
                        esl = ((ts_bytes[pos + 3] & 0x0F) << 8) | ts_bytes[pos + 4]
                        if st in self.VIDEO_STYPES and vid_pid is None:
                            vid_pid = epid
                            vid_stype = st
                        elif st in self.AUDIO_STYPES and aud_pid is None:
                            aud_pid = epid
                            aud_stype = st
                        pos += 5 + esl
            elif pusi and ((vid_pid is not None and pid == vid_pid) or (aud_pid is not None and pid == aud_pid)):
                # PCR は DTS より 1.2秒前後先行するため絶対に混ぜず、映像/音声の純粋な PTS/DTS のみを使う
                if off + 14 <= end and ts_bytes[off] == 0x00 and ts_bytes[off + 1] == 0x00 and ts_bytes[off + 2] == 0x01:
                    pts_flags = (ts_bytes[off + 7] >> 6) & 0x03
                    if pts_flags >= 2:
                        p_val = _read_ts33(ts_bytes, off + 9)
                        if seg_base_pts is None or _signed_ts33_diff(p_val, seg_base_pts) < 0:
                            seg_base_pts = p_val
                        if pts_flags == 3 and off + 19 <= end:
                            d_val = _read_ts33(ts_bytes, off + 14)
                            if _signed_ts33_diff(d_val, seg_base_pts) < 0:
                                seg_base_pts = d_val

            if vid_pid is not None and aud_pid is not None and seg_base_pts is not None and i > 188 * 250:
                break

        return vid_pid, aud_pid, pcr_pid, vid_stype, aud_stype, seg_base_pts

    @staticmethod
    def _detect_adts_sr_index(ts_bytes, aud_pid):
        """TS セグメント内の音声 PES 先頭から ADTS sampling_frequency_index (3=48kHz, 4=44.1kHz) を検出する"""
        if aud_pid is None or not ts_bytes:
            return None
        n = min(len(ts_bytes), 188 * 1200)
        for i in range(0, n - 187, 188):
            if ts_bytes[i] != 0x47:
                continue
            pid = ((ts_bytes[i + 1] & 0x1F) << 8) | ts_bytes[i + 2]
            if pid != aud_pid:
                continue
            pusi = (ts_bytes[i + 1] & 0x40) != 0
            if not pusi:
                continue
            afc = (ts_bytes[i + 3] >> 4) & 0x03
            if afc in (0, 2):
                continue
            off = i + 4 + (1 + ts_bytes[i + 4] if afc == 3 else 0)
            end = i + 188
            if off + 16 < end and ts_bytes[off] == 0x00 and ts_bytes[off + 1] == 0x00 and ts_bytes[off + 2] == 0x01:
                hdr_len = ts_bytes[off + 8]
                p = off + 9 + hdr_len
                if p + 4 <= end and ts_bytes[p] == 0xFF and (ts_bytes[p + 1] & 0xF0) == 0xF0:
                    return (ts_bytes[p + 2] >> 2) & 0x0F
        return None

    def process_segment(self, ts_bytes, is_discontinuity=False, is_ad_segment=False):
        if not ts_bytes:
            return b""
        sync_pos = ts_bytes.find(0x47)
        if sync_pos > 0:
            ts_bytes = ts_bytes[sync_pos:]
        elif sync_pos < 0:
            return b""

        vid_pid, aud_pid, pcr_pid, vid_stype, aud_stype, seg_base_pts = self._detect_segment_map(ts_bytes)
        # 本編(48kHz等)と異なるサンプルレートの CM (/tsad/: 44.1kHz) 音声が混入すると
        # TV ハードウェアデコーダが低ピッチに張り付くため、異レート CM 音声のみ除外して本編ピッチを守る
        seg_sr_idx = self._detect_adts_sr_index(ts_bytes, aud_pid if aud_pid is not None else self.last_aud_pid)
        if not is_ad_segment and seg_sr_idx is not None:
            self.program_audio_sr_idx = seg_sr_idx
        drop_ad_audio = bool(
            is_ad_segment
            and self.program_audio_sr_idx is not None
            and seg_sr_idx is not None
            and seg_sr_idx != self.program_audio_sr_idx
        )
        if vid_pid is None and self.last_vid_pid is not None:
            vid_pid = self.last_vid_pid
            aud_pid = self.last_aud_pid if aud_pid is None else aud_pid
            pcr_pid = self.last_pcr_pid if pcr_pid is None else pcr_pid
        else:
            self.last_vid_pid = vid_pid
            self.last_aud_pid = aud_pid
            self.last_pcr_pid = pcr_pid
        self.last_vid_stype = vid_stype
        self.last_aud_stype = aud_stype

        if seg_base_pts is not None:
            if self.offset_90k is None:
                # PCR (DTSより約1.2秒手前) が負にならないよう先頭基準を 180000 (2.0秒) に設定
                self.offset_90k = (180000 - seg_base_pts) & 0x1FFFFFFFF
            elif self.last_out_max_pts is not None:
                proj = (seg_base_pts + self.offset_90k) & 0x1FFFFFFFF
                gap = _signed_ts33_diff(proj, self.last_out_max_pts)
                if is_discontinuity or gap < -180000 or gap > (90000 * 10):
                    target = (self.last_out_max_pts + 3003) & 0x1FFFFFFFF
                    self.offset_90k = (target - seg_base_pts) & 0x1FFFFFFFF

        offset = self.offset_90k or 0
        out = bytearray()
        # セグメント先頭に統一 PAT + PMT を1回出力
        out.extend(self._build_psi_packet(0x0000, self._pat_payload))
        out.extend(self._build_psi_packet(self.OUT_PMT_PID, self._get_pmt_payload(vid_stype, aud_stype)))

        # パケット書き換え用の作業バッファ
        has_separate_pcr = (pcr_pid is not None and pcr_pid not in (vid_pid, aud_pid))
        n = len(ts_bytes)
        pkt_buf = bytearray(188)
        seg_max_out_pts = self.last_out_max_pts
        cur_ref_dts = ((seg_base_pts + offset) & 0x1FFFFFFFF) if seg_base_pts is not None else (
            ((self.last_out_max_pts + 3003) & 0x1FFFFFFFF) if self.last_out_max_pts is not None else 180000
        )

        for i in range(0, n - 187, 188):
            if ts_bytes[i] != 0x47:
                continue
            pid = ((ts_bytes[i + 1] & 0x1F) << 8) | ts_bytes[i + 2]

            if pid == vid_pid:
                target_pid = self.OUT_VIDEO_PID
            elif pid == aud_pid:
                if drop_ad_audio:
                    continue
                target_pid = self.OUT_AUDIO_PID
            elif has_separate_pcr and pid == pcr_pid:
                afc = (ts_bytes[i + 3] >> 4) & 0x03
                if afc in (2, 3) and ts_bytes[i + 4] >= 7 and (ts_bytes[i + 5] & 0x10):
                    # 独立 PCR パケットは adaptation-field only として 0x0100 へ統合 (CC進めない)
                    pkt_buf[:] = ts_bytes[i : i + 188]
                    pkt_buf[1] = (pkt_buf[1] & 0xE0) | ((self.OUT_VIDEO_PID >> 8) & 0x1F)
                    pkt_buf[2] = self.OUT_VIDEO_PID & 0xFF
                    pkt_buf[3] = (pkt_buf[3] & 0xCF) | 0x20
                    if self.normalize_pcr:
                        pcr_val = self._next_monotonic_pcr(cur_ref_dts)
                    else:
                        pcr_val = (_read_pcr33(pkt_buf, 6) + offset) & 0x1FFFFFFFF
                    _write_pcr33(pkt_buf, 6, pcr_val)
                    out.extend(pkt_buf)
                continue
            else:
                continue

            pkt_buf[:] = ts_bytes[i : i + 188]
            pkt_buf[1] = (pkt_buf[1] & 0xE0) | ((target_pid >> 8) & 0x1F)
            pkt_buf[2] = target_pid & 0xFF

            afc = (pkt_buf[3] >> 4) & 0x03
            if afc in (1, 3):
                cc = self.cc[target_pid]
                self.cc[target_pid] = (cc + 1) & 0x0F
                pkt_buf[3] = (pkt_buf[3] & 0xF0) | cc

            # 先に PES の PTS/DTS を更新してから PCR を書き換える (同一パケットに PCR と PES がある場合に最新 DTS を参照するため)
            if afc in (1, 3) and (pkt_buf[1] & 0x40):
                pay_off = 4 + (1 + pkt_buf[4] if afc == 3 else 0)
                if pay_off + 14 <= 188 and pkt_buf[pay_off] == 0 and pkt_buf[pay_off + 1] == 0 and pkt_buf[pay_off + 2] == 1:
                    pts_flags = (pkt_buf[pay_off + 7] >> 6) & 0x03
                    if pts_flags >= 2:
                        new_pts = (_read_ts33(pkt_buf, pay_off + 9) + offset) & 0x1FFFFFFFF
                        _write_ts33(pkt_buf, pay_off + 9, 0x20 if pts_flags == 2 else 0x30, new_pts)
                        if seg_max_out_pts is None or _signed_ts33_diff(new_pts, seg_max_out_pts) > 0:
                            seg_max_out_pts = new_pts
                        if target_pid == self.OUT_VIDEO_PID and pts_flags == 2:
                            cur_ref_dts = new_pts
                    if pts_flags == 3 and pay_off + 19 <= 188:
                        new_dts = (_read_ts33(pkt_buf, pay_off + 14) + offset) & 0x1FFFFFFFF
                        _write_ts33(pkt_buf, pay_off + 14, 0x10, new_dts)
                        if target_pid == self.OUT_VIDEO_PID:
                            cur_ref_dts = new_dts

            if afc in (2, 3) and pkt_buf[4] >= 7 and (pkt_buf[5] & 0x10):
                if self.normalize_pcr:
                    pcr_val = self._next_monotonic_pcr(cur_ref_dts)
                else:
                    pcr_val = (_read_pcr33(pkt_buf, 6) + offset) & 0x1FFFFFFFF
                _write_pcr33(pkt_buf, 6, pcr_val)

            out.extend(pkt_buf)

        if seg_max_out_pts is not None:
            self.last_out_max_pts = seg_max_out_pts
        return bytes(out)


def _select_abema_variant_url(master_url):
    text = _abema_http_get(master_url, timeout=8).decode("utf-8", errors="replace")
    lines = text.splitlines()
    variants = []
    cur_bw = 0
    cur_res_w = 0
    for line in lines:
        s = line.strip()
        if s.startswith("#EXT-X-STREAM-INF:"):
            m_bw = re.search(r"BANDWIDTH=(\d+)", s)
            cur_bw = int(m_bw.group(1)) if m_bw else 0
            m_res = re.search(r"RESOLUTION=(\d+)x(\d+)", s)
            cur_res_w = int(m_res.group(1)) if m_res else 0
        elif s and not s.startswith("#"):
            variants.append((cur_res_w, cur_bw, urllib.parse.urljoin(master_url, s)))
            cur_bw = 0
            cur_res_w = 0
    if not variants:
        return master_url, text
    # 1080p 以下で最高帯域バリアントを固定選択 (途中画質変更によるデコーダ負荷防止)
    cands = [v for v in variants if v[0] <= 1920] or variants
    cands.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return cands[0][2], None


def _parse_media_playlist_segments(playlist_url, initial_text=None):
    txt = initial_text if initial_text is not None else _abema_http_get(playlist_url, timeout=8).decode("utf-8", errors="replace")
    media_seq = 0
    cur_ticket = None
    cur_iv = None
    pending_disc = False
    cur_dur = 5.0
    segs = []
    seg_idx = 0
    for line in txt.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            try:
                media_seq = int(s.split(":", 1)[1].strip())
            except Exception:
                pass
        elif s == "#EXT-X-DISCONTINUITY":
            pending_disc = True
        elif s.startswith("#EXT-X-KEY:"):
            if "METHOD=NONE" in s:
                cur_ticket = None
                cur_iv = None
            else:
                m_t = re.search(r'URI="abematv-license://([^"]+)"', s)
                cur_ticket = m_t.group(1) if m_t else None
                m_iv = re.search(r"IV=0x([0-9a-fA-F]+)", s)
                cur_iv = bytes.fromhex(m_iv.group(1).zfill(32)) if m_iv else None
        elif s.startswith("#EXTINF:"):
            try:
                cur_dur = float(s.split(":", 1)[1].split(",", 1)[0])
            except Exception:
                cur_dur = 5.0
        elif not s.startswith("#"):
            seq_num = media_seq + seg_idx
            seg_idx += 1
            segs.append({
                "seq": seq_num,
                "disc": pending_disc,
                "ticket": cur_ticket,
                "iv": cur_iv,
                "dur": cur_dur,
                "url": urllib.parse.urljoin(playlist_url, s),
            })
            pending_disc = False
    return segs


class _AbemaKeepAliveFetcher:
    """ライブ CDN 向け HTTPS Keep-Alive クライアント (毎セグメントの TLS 再接続遅延を排除)"""

    def __init__(self, origin="https://abema.tv", referer="https://abema.tv/"):
        self._conns = {}
        self._ssl_ctx = ssl.create_default_context()
        self._origin = origin
        self._referer = referer

    def get(self, url, timeout=10):
        u = urllib.parse.urlparse(url)
        key = (u.scheme, u.hostname, u.port or (443 if u.scheme == "https" else 80))
        path = (u.path or "/") + (("?" + u.query) if u.query else "")
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Origin": self._origin,
            "Referer": self._referer,
            "Connection": "keep-alive",
        }
        for attempt in range(2):
            conn = self._conns.get(key)
            if conn is None:
                if u.scheme == "https":
                    conn = http.client.HTTPSConnection(key[1], key[2], timeout=timeout, context=self._ssl_ctx)
                else:
                    conn = http.client.HTTPConnection(key[1], key[2], timeout=timeout)
                self._conns[key] = conn
            try:
                conn.request("GET", path, headers=headers)
                resp = conn.getresponse()
                data = resp.read()
                if resp.status >= 400:
                    raise RuntimeError(f"HTTP {resp.status}")
                return data
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass
                self._conns.pop(key, None)
                if attempt == 1:
                    raise

    def close_all(self):
        for conn in list(self._conns.values()):
            try:
                conn.close()
            except Exception:
                pass
        self._conns.clear()


def stream_abema_live_ts(handler, source_m3u8_url):
    """ABEMA ライブ HLS を Keep-Alive 先読み + 連続 MPEG-2 TS として配信し、フリーズを根絶する"""
    media_url, initial_txt = _select_abema_variant_url(source_m3u8_url)

    handler.send_response(200)
    handler._cors()
    handler.send_header("Content-Type", "video/mp2t")
    handler.send_header("Accept-Ranges", "none")
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    try:
        handler.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except Exception:
        pass

    seg_queue = queue.Queue(maxsize=8)
    stop_ev = threading.Event()

    def producer():
        fetcher = _AbemaKeepAliveFetcher()
        normalizer = AbemaContinuousTSNormalizer(normalize_pcr=True)
        last_seq = -1
        first_round = True
        idle_errors = 0
        init_txt = initial_txt
        try:
            while not stop_ev.is_set():
                try:
                    if first_round and init_txt is not None:
                        pl_txt = init_txt
                        init_txt = None
                    else:
                        pl_txt = fetcher.get(media_url, timeout=8).decode("utf-8", errors="replace")
                    segs = _parse_media_playlist_segments(media_url, pl_txt)
                    if not segs:
                        stop_ev.wait(0.8)
                        continue

                    if first_round:
                        # ライブ先端ギリギリでの枯渇を防ぐため末尾4セグメント (約8〜12秒分) から開始
                        todo = segs[-4:] if len(segs) >= 4 else segs
                        first_round = False
                    else:
                        todo = [sg for sg in segs if sg["seq"] > last_seq]
                        if not todo:
                            if segs[-1]["seq"] + 30 < last_seq:
                                todo = segs[-3:]
                            else:
                                stop_ev.wait(0.55)
                                continue

                    idle_errors = 0
                    for sg in todo:
                        if stop_ev.is_set():
                            break
                        last_seq = sg["seq"]
                        raw = fetcher.get(sg["url"], timeout=10)
                        if sg["ticket"]:
                            key = get_abema_videokey(sg["ticket"])
                            iv = sg["iv"] if sg["iv"] is not None else sg["seq"].to_bytes(16, "big")
                            raw = decrypt_aes_128_cbc(raw, key, iv)
                        is_ad_seg = ("/tsad/" in str(sg.get("url") or "").lower())
                        normalized = normalizer.process_segment(raw, is_discontinuity=sg["disc"], is_ad_segment=is_ad_seg)
                        if normalized:
                            while not stop_ev.is_set():
                                try:
                                    seg_queue.put(normalized, timeout=0.5)
                                    break
                                except queue.Full:
                                    continue
                except Exception:
                    idle_errors += 1
                    if idle_errors >= 8:
                        break
                    stop_ev.wait(0.9)
        finally:
            fetcher.close_all()
            try:
                seg_queue.put_nowait(None)
            except Exception:
                pass

    th = threading.Thread(target=producer, daemon=True)
    th.start()
    try:
        while True:
            try:
                chunk = seg_queue.get(timeout=20.0)
            except queue.Empty:
                if not th.is_alive():
                    break
                continue
            if chunk is None:
                break
            handler.wfile.write(chunk)
            handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        stop_ev.set()


def _parse_tver_live_playlist(playlist_url, txt):
    """TVer Streaks HLS メディアプレイリストからセグメント・AES-128鍵URL・不連続フラグを抽出する"""
    media_seq = 0
    cur_key_url = None
    cur_iv = None
    pending_disc = False
    cur_dur = 4.0
    ended = False
    segs = []
    seg_idx = 0
    for line in txt.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            try:
                media_seq = int(s.split(":", 1)[1].strip())
            except Exception:
                pass
        elif s == "#EXT-X-DISCONTINUITY":
            pending_disc = True
        elif s == "#EXT-X-ENDLIST":
            ended = True
        elif s.startswith("#EXT-X-KEY:"):
            if "METHOD=NONE" in s:
                cur_key_url = None
                cur_iv = None
            else:
                m_u = re.search(r'URI="([^"]+)"', s)
                cur_key_url = urllib.parse.urljoin(playlist_url, m_u.group(1)) if m_u else None
                m_iv = re.search(r"IV=0x([0-9a-fA-F]+)", s)
                cur_iv = bytes.fromhex(m_iv.group(1).zfill(32)) if m_iv else None
        elif s.startswith("#EXTINF:"):
            try:
                cur_dur = float(s.split(":", 1)[1].split(",", 1)[0])
            except Exception:
                cur_dur = 4.0
        elif not s.startswith("#"):
            seq_num = media_seq + seg_idx
            seg_idx += 1
            segs.append({
                "seq": seq_num,
                "disc": pending_disc,
                "keyUrl": cur_key_url,
                "iv": cur_iv,
                "dur": cur_dur,
                "url": urllib.parse.urljoin(playlist_url, s),
            })
            pending_disc = False
    return segs, ended


def stream_tver_live_ts(handler, kind, target_id):
    """
    TVer ライブ (民放5局同時配信 / スペシャルライブ) を AES-128 復号 + 連続 MPEG-2 TS として配信する。
    SSAI の CM 切替不連続やトークン有効期限切れ時のセッション再取得を吸収し、webOS で安定再生させる。
    """
    resolved = _resolve_tver_live_variant(kind, target_id)
    media_url = resolved["mediaUrl"]
    initial_txt = resolved["initialMediaText"]

    handler.send_response(200)
    handler._cors()
    handler.send_header("Content-Type", "video/mp2t")
    handler.send_header("Accept-Ranges", "none")
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    try:
        handler.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except Exception:
        pass

    seg_queue = queue.Queue(maxsize=8)
    stop_ev = threading.Event()

    def producer():
        nonlocal media_url
        fetcher = _AbemaKeepAliveFetcher(origin="https://tver.jp", referer="https://tver.jp/")
        # TVer (Streaks) の独立 4秒セグメントは境界ごとに PCR が -1.76秒逆行するため、
        # normalize_pcr=True で DTS 基準の厳密単調増加 PCR へ再生成して 4〜5秒ごとのプチフリーズを根絶する
        normalizer = AbemaContinuousTSNormalizer(normalize_pcr=True)
        key_cache = {}
        last_seq = -1
        first_round = True
        idle_errors = 0
        force_next_disc = False
        init_txt = initial_txt
        try:
            while not stop_ev.is_set():
                try:
                    if first_round and init_txt is not None:
                        pl_txt = init_txt
                        init_txt = None
                    else:
                        pl_txt = fetcher.get(media_url, timeout=8).decode("utf-8", errors="replace")
                    segs, ended = _parse_tver_live_playlist(media_url, pl_txt)
                    if not segs:
                        if ended:
                            break
                        stop_ev.wait(0.8)
                        continue

                    if first_round:
                        # 4秒セグメント x 末尾3本 (約12秒バッファ) から開始して枯渇を防止
                        todo = segs[-3:] if len(segs) >= 3 else segs
                        first_round = False
                    else:
                        todo = [sg for sg in segs if sg["seq"] > last_seq]
                        if not todo:
                            if ended:
                                break
                            if segs[-1]["seq"] + 30 < last_seq:
                                todo = segs[-3:]
                                force_next_disc = True
                            else:
                                stop_ev.wait(0.55)
                                continue

                    idle_errors = 0
                    for sg in todo:
                        if stop_ev.is_set():
                            break
                        last_seq = sg["seq"]
                        raw = fetcher.get(sg["url"], timeout=10)
                        if sg["keyUrl"]:
                            k_bytes = key_cache.get(sg["keyUrl"])
                            if k_bytes is None:
                                k_bytes = fetcher.get(sg["keyUrl"], timeout=8)
                                if len(key_cache) > 16:
                                    key_cache.clear()
                                key_cache[sg["keyUrl"]] = k_bytes
                            iv = sg["iv"] if sg["iv"] is not None else sg["seq"].to_bytes(16, "big")
                            raw = decrypt_aes_128_cbc(raw, k_bytes, iv)
                        is_disc = bool(sg["disc"] or force_next_disc)
                        force_next_disc = False
                        normalized = normalizer.process_segment(raw, is_discontinuity=is_disc)
                        if normalized:
                            while not stop_ev.is_set():
                                try:
                                    seg_queue.put(normalized, timeout=0.5)
                                    break
                                except queue.Full:
                                    continue
                    if ended:
                        break
                except Exception as e:
                    idle_errors += 1
                    err_s = str(e)
                    # SSAI セッションやトークン有効期限切れ (HTTP 401/403) は自動再解決して継続
                    if ("HTTP 401" in err_s or "HTTP 403" in err_s) and idle_errors <= 4:
                        try:
                            re_res = _resolve_tver_live_variant(kind, target_id)
                            media_url = re_res["mediaUrl"]
                            force_next_disc = True
                            key_cache.clear()
                            print(f"[dtvplus-daemon] tver live session refreshed ({kind}/{target_id})", flush=True)
                            continue
                        except Exception:
                            pass
                    if idle_errors >= 8:
                        break
                    stop_ev.wait(0.9)
        finally:
            fetcher.close_all()
            try:
                seg_queue.put_nowait(None)
            except Exception:
                pass

    th = threading.Thread(target=producer, daemon=True)
    th.start()
    try:
        while True:
            try:
                chunk = seg_queue.get(timeout=20.0)
            except queue.Empty:
                if not th.is_alive():
                    break
                continue
            if chunk is None:
                break
            handler.wfile.write(chunk)
            handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        stop_ev.set()


def run_ytdlp_self_update():
    """公式 yt-dlp -U を実行してバイナリ自体を最新版へ更新する"""
    wait_ydl()
    old_ver = yt_dlp.version.__version__
    proc = subprocess.run(
        [sys.executable, YTDLP_BIN, "-U"],
        capture_output=True,
        text=True,
        timeout=90,
    )
    output = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
    # 更新後のバージョンを取得
    ver_proc = subprocess.run(
        [sys.executable, YTDLP_BIN, "--version"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    new_ver = (ver_proc.stdout or "").strip() or old_ver
    updated = (new_ver != old_ver)
    return {
        "ok": proc.returncode == 0,
        "oldVersion": old_ver,
        "newVersion": new_ver,
        "updated": updated,
        "output": output.strip(),
    }


def read_shared_jikkyo_prefs():
    default_prefs = {
        "enabled": True,
        "fontSizeKey": "medium",
        "opacity": 0.85,
        "jkId": "jk1",
    }
    with PREFS_LOCK:
        if os.path.exists(PREFS_FILE):
            try:
                with open(PREFS_FILE, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                if isinstance(saved, dict):
                    default_prefs.update(saved)
            except Exception:
                pass
    return default_prefs


def write_shared_jikkyo_prefs(updates):
    cur = read_shared_jikkyo_prefs()
    if isinstance(updates, dict):
        for k in ("enabled", "fontSizeKey", "opacity", "jkId"):
            if k in updates and updates[k] is not None:
                cur[k] = updates[k]
    with PREFS_LOCK:
        os.makedirs(os.path.dirname(PREFS_FILE), exist_ok=True)
        with open(PREFS_FILE, "w", encoding="utf-8") as f:
            json.dump(cur, f, ensure_ascii=False)
    return cur


def _map_jlogo_path(raw_path):
    """LGTV DB 内の /mnt/user/jlogo/... パスを chroot 内の /opt/jlogo/... へ変換する"""
    if not raw_path or not isinstance(raw_path, str):
        return ""
    for prefix in ("/mnt/lg/user/jlogo/", "/mnt/user/jlogo/"):
        if raw_path.startswith(prefix):
            cand = os.path.join(JLOGO_DIR, raw_path[len(prefix):])
            if os.path.isfile(cand):
                return cand
    return ""


def load_tv_channel_index():
    """
    LGTV 純正チャンネル DB (com.webos.service.tv.channel.dblist:1) を解析し、
    (networkId, serviceId) ごとの純正チャンネル番号・ワンタッチ番号 (shortCut)・内蔵ロゴパスを構築する
    """
    global TV_CHANNEL_INDEX
    if TV_CHANNEL_INDEX is not None:
        return TV_CHANNEL_INDEX

    idx = {}
    onid_fallback_logo = {}
    if os.path.isfile(TV_CHANNEL_DB_FILE):
        try:
            with open(TV_CHANNEL_DB_FILE, "r", encoding="utf-8", errors="replace") as f:
                data = json.load(f)
            for r in data.get("results") or []:
                if not isinstance(r, dict):
                    continue
                onid = r.get("ONID")
                svcid = r.get("SVCID")
                if onid is None or svcid is None:
                    continue
                key = f"{int(onid)}_{int(svcid)}"
                raw_logo = r.get("logoPathLarge") or r.get("logoPathSmall") or ""
                local_logo = _map_jlogo_path(raw_logo)
                sc = r.get("shortCut")
                shortcut_num = int(sc) if (isinstance(sc, int) and 1 <= sc <= 12) else 0
                ch_num = str(r.get("channelNumber") or "")
                ch_mode = str(r.get("channelMode") or "")
                entry = {
                    "channelNumber": ch_num,
                    "shortCut": shortcut_num,
                    "channelMode": ch_mode,
                    "logoFile": local_logo,
                }
                # 既にロゴ付きエントリがある場合はロゴ情報を優先保持
                if key in idx and idx[key].get("logoFile") and not local_logo:
                    entry["logoFile"] = idx[key]["logoFile"]
                if key in idx and idx[key].get("shortCut") and not shortcut_num:
                    entry["shortCut"] = idx[key]["shortCut"]
                idx[key] = entry
                if local_logo and int(onid) >= 30000 and int(onid) not in onid_fallback_logo:
                    onid_fallback_logo[int(onid)] = local_logo
        except Exception:
            pass

    # サブチャンネル等で直接ロゴが空の場合に備え、同一局のメインサービスロゴを補完
    for key, entry in list(idx.items()):
        if entry.get("logoFile"):
            continue
        parts = key.split("_")
        onid_i, svcid_i = int(parts[0]), int(parts[1])
        if onid_i >= 30000 and onid_i in onid_fallback_logo:
            entry["logoFile"] = onid_fallback_logo[onid_i]
        elif onid_i == 4:
            # BS サブチャンネル (102->101, 142->141, 232->231 等)
            base_sid = (svcid_i // 10) * 10 + 1
            parent = idx.get(f"4_{base_sid}")
            if parent and parent.get("logoFile"):
                entry["logoFile"] = parent["logoFile"]

    TV_CHANNEL_INDEX = idx
    return idx


def get_public_tv_channel_map():
    idx = load_tv_channel_index()
    out = {}
    for k, v in idx.items():
        out[k] = {
            "channelNumber": v.get("channelNumber") or "",
            "shortCut": v.get("shortCut") or 0,
            "channelMode": v.get("channelMode") or "",
            "hasNativeLogo": bool(v.get("logoFile")),
        }
    return {"channels": out}


def resolve_channel_logo(nid_str, sid_str, svc_id_str, mirakurun_base):
    """
    1. Mirakurun にロゴデータが存在する場合は取得してメモリキャッシュから返す
    2. Mirakurun が 503 (BS一部・CS全チャンネル等) の場合は LGTV 純正内蔵 jlogo から PNG を補完して返す
    """
    cache_key = f"{mirakurun_base}|{svc_id_str}|{nid_str}_{sid_str}"
    with LOGO_LOCK:
        if cache_key in LOGO_CACHE:
            return LOGO_CACHE[cache_key]

    img_bytes = None
    content_type = "image/png"

    # 1. Mirakurun ロゴ API 試行
    if mirakurun_base and svc_id_str:
        mk_url = mirakurun_base.rstrip("/") + f"/api/services/{svc_id_str}/logo"
        try:
            req = urllib.request.Request(mk_url, headers={"User-Agent": "LGDTVPlus/0.3"})
            with urllib.request.urlopen(req, timeout=2.5) as resp:
                if resp.status == 200:
                    raw = resp.read()
                    if raw and len(raw) > 64:
                        img_bytes = raw
                        ct = resp.headers.get("Content-Type") or ""
                        if ct.startswith("image/"):
                            content_type = ct.split(";")[0].strip()
        except Exception:
            pass

    # 2. LGTV 本体内蔵 ARIB ロゴ (/opt/jlogo) フォールバック
    if not img_bytes and nid_str and sid_str:
        idx = load_tv_channel_index()
        key = f"{nid_str}_{sid_str}"
        entry = idx.get(key)
        # BS4K (networkId=11) の場合は対応する BS2K (networkId=4) 同番サービスのロゴもフォールバック参照
        if (not entry or not entry.get("logoFile")) and nid_str == "11":
            entry = idx.get(f"4_{sid_str}")
        # BS サブチャンネル補完
        if (not entry or not entry.get("logoFile")) and nid_str in ("4", "11") and sid_str.isdigit():
            base_sid = (int(sid_str) // 10) * 10 + 1
            entry = idx.get(f"4_{base_sid}")

        logo_file = (entry or {}).get("logoFile") or ""
        if logo_file and os.path.isfile(logo_file):
            try:
                with open(logo_file, "rb") as lf:
                    raw = lf.read()
                if raw:
                    img_bytes = raw
                    content_type = "image/png"
            except Exception:
                pass

    result = (content_type, img_bytes) if img_bytes else None
    with LOGO_LOCK:
        if len(LOGO_CACHE) < 512:
            LOGO_CACHE[cache_key] = result
    return result


class TSSidebandFilter:
    """
    生 MPEG-2 TS ストリームから映像・音声・EIT等の巨大ペイロードを除去し、
    ARIB 字幕/文字スーパー PES (0x06)・必要SIテーブル (PAT/PMT/TOT/BIT/SIT)・間引きPCR（base系）と
    BML データ放送 DSM-CC カルーセル (0x0D)（bml系）を分離抽出する超軽量フィルタ。
    """

    SI_PIDS = frozenset({
        0x0000,  # PAT
        0x0010,  # NIT (networkId 取得に必須)
        0x0011,  # SDT / BAT (originalNetworkId / transportStreamId 取得に必須)
        0x0014,  # TDT / TOT
        0x001F,  # SIT (部分TS / 録画TS番組情報)
        0x0024,  # BIT (放送局識別・NVRAM系列情報)
        0x1FC8,  # ワンセグ固定PMTフォールバック
    })

    def __init__(self, target_sid=0):
        self.lock = threading.Lock()
        self.rem = b""
        self.target_sid = int(target_sid or 0)
        self.pmt_pids = set()
        self.caption_pids = set()  # 0x06 (字幕 / 文字スーパー)
        self.bml_pids = set()      # 0x0D (BML DSM-CC カルーセル)
        self.pcr_pids = set()
        self.pmt_ready = False
        self.pmt_secs = {}
        self.last_pcr_sec = None
        self.latest_pcr_sec = None
        self.first_pcr_emitted = False
        self.eit_keep = False

    def _extract_psi_payload(self, pkt):
        pusi = (pkt[1] & 0x40) != 0
        afc = (pkt[3] >> 4) & 0x03
        if afc == 0 or afc == 2:
            return pusi, b""
        off = 4
        if afc == 3:
            off = 5 + pkt[4]
        if off >= 188:
            return pusi, b""
        return pusi, pkt[off:188]

    def _parse_pat_section(self, sec):
        if len(sec) < 8 or sec[0] != 0x00:
            return
        sec_len = ((sec[1] & 0x0F) << 8) | sec[2]
        end = min(len(sec), 3 + sec_len - 4)
        if end < 8:
            return
        matched = set()
        all_pmts = []
        pos = 8
        while pos + 4 <= end:
            pnum = (sec[pos] << 8) | sec[pos + 1]
            mpid = ((sec[pos + 2] & 0x1F) << 8) | sec[pos + 3]
            if pnum != 0:
                all_pmts.append((pnum, mpid))
                if self.target_sid and pnum == self.target_sid:
                    matched.add(mpid)
            pos += 4
        if matched:
            self.pmt_pids = matched
        elif all_pmts:
            # target_sid 未指定時は先頭サービス (および最大2サービス) のPMTを追跡
            self.pmt_pids = {mpid for _, mpid in all_pmts[:2]}

    def _parse_pmt_section(self, sec):
        if len(sec) < 12 or sec[0] != 0x02:
            return
        sec_len = ((sec[1] & 0x0F) << 8) | sec[2]
        end = min(len(sec), 3 + sec_len - 4)
        if end < 12:
            return
        pnum = (sec[3] << 8) | sec[4]
        if self.target_sid and pnum != self.target_sid and len(self.pmt_pids) > 1:
            return
        pcr_pid = ((sec[8] & 0x1F) << 8) | sec[9]
        prog_info_len = ((sec[10] & 0x0F) << 8) | sec[11]
        pos = 12 + prog_info_len
        cap_pids = set()
        dsm_pids = set()
        while pos + 5 <= end:
            stype = sec[pos]
            epid = ((sec[pos + 1] & 0x1F) << 8) | sec[pos + 2]
            es_len = ((sec[pos + 3] & 0x0F) << 8) | sec[pos + 4]
            if stype == 0x06:
                cap_pids.add(epid)
            elif stype == 0x0D:
                dsm_pids.add(epid)
            pos += 5 + es_len
        self.caption_pids = cap_pids
        self.bml_pids = dsm_pids
        if pcr_pid != 0x1FFF:
            self.pcr_pids = {pcr_pid}
        self.pmt_ready = True

    def process_split(self, data):
        with self.lock:
            buf = self.rem + data
            n = len(buf)
            i = 0
            base_out = bytearray()
            bml_out = bytearray()
            while i + 188 <= n:
                if buf[i] != 0x47:
                    sync = buf.find(0x47, i + 1)
                    if sync == -1:
                        i = n
                        break
                    i = sync
                    continue
                pkt = buf[i : i + 188]
                i += 188
                pid = ((pkt[1] & 0x1F) << 8) | pkt[2]
                if pid == 0x1FFF:
                    continue

                if pid == 0x0000:
                    pusi, pay = self._extract_psi_payload(pkt)
                    if pusi and len(pay) > 1:
                        ptr = pay[0]
                        if 1 + ptr < len(pay):
                            self._parse_pat_section(pay[1 + ptr :])
                    base_out.extend(pkt)
                    continue

                if pid in self.pmt_pids:
                    pusi, pay = self._extract_psi_payload(pkt)
                    if pusi and len(pay) > 1:
                        ptr = pay[0]
                        sec_buf = bytearray(pay[1 + ptr :])
                        self.pmt_secs[pid] = sec_buf
                        if len(sec_buf) >= 3:
                            slen = ((sec_buf[1] & 0x0F) << 8) | sec_buf[2]
                            if len(sec_buf) >= 3 + slen:
                                self._parse_pmt_section(sec_buf)
                    elif pid in self.pmt_secs and pay:
                        sec_buf = self.pmt_secs[pid]
                        sec_buf.extend(pay)
                        if len(sec_buf) >= 3:
                            slen = ((sec_buf[1] & 0x0F) << 8) | sec_buf[2]
                            if len(sec_buf) >= 3 + slen:
                                self._parse_pmt_section(sec_buf)
                                del self.pmt_secs[pid]
                    base_out.extend(pkt)
                    continue

                if pid == 0x0012:
                    # H-EIT のうち BML が使う現在/次の番組情報 (table_id == 0x4E) のみ通し、巨大な週間EPG (0x50..0x6F) はカット
                    pusi, pay = self._extract_psi_payload(pkt)
                    if pusi and len(pay) > 1:
                        ptr = pay[0]
                        prev_keep = self.eit_keep
                        new_keep = False
                        if 1 + ptr < len(pay):
                            new_keep = (pay[1 + ptr] == 0x4E)
                        self.eit_keep = new_keep
                        if new_keep or (prev_keep and ptr > 0):
                            base_out.extend(pkt)
                    elif self.eit_keep:
                        base_out.extend(pkt)
                    continue

                if pid in self.SI_PIDS or pid in self.caption_pids:
                    base_out.extend(pkt)
                    continue

                if pid in self.bml_pids:
                    # MPEG-2 TS の Continuity Counter 連続性を 100% 保つためパケット欠損なしでそのまま通す
                    bml_out.extend(pkt)
                    continue

                if self.pmt_ready and pid in self.pcr_pids:
                    b3 = pkt[3]
                    if (b3 & 0x20) and pkt[4] >= 7 and (pkt[5] & 0x10):
                        pcr_base = (
                            (pkt[6] << 25)
                            | (pkt[7] << 17)
                            | (pkt[8] << 9)
                            | (pkt[9] << 1)
                            | (pkt[10] >> 7)
                        )
                        pcr_sec = pcr_base / 90000.0
                        self.latest_pcr_sec = pcr_sec
                        emit_pcr = False
                        if not self.first_pcr_emitted or self.last_pcr_sec is None:
                            emit_pcr = True
                        else:
                            dp = pcr_sec - self.last_pcr_sec
                            if dp < -40000.0:
                                dp += (1 << 33) / 90000.0
                            # 壁時計ではなくストリーム内 PCR 基準で 0.20秒ごとに間引く (録画先読み時も正確な PCR を維持)
                            if dp >= 0.20 or dp < -0.5:
                                emit_pcr = True
                        if emit_pcr:
                            self.first_pcr_emitted = True
                            self.last_pcr_sec = pcr_sec
                            base_out.extend(pkt[0:3])
                            base_out.append((b3 & 0xCF) | 0x20)
                            base_out.append(183)
                            base_out.append(0x10)
                            base_out.extend(pkt[6:12])
                            base_out.extend(b"\xff" * 176)

            self.rem = buf[i:]
            return bytes(base_out), bytes(bml_out)


class TSSidebandHub:
    """
    現在アクティブな TS ストリームを
    1) base 系統 (PAT/PMT/TOT/BIT/SIT/間引きPCR/字幕PES: 数KB/s)
    2) bml 系統 (0x0D DSM-CC データ放送カルーセル: 最大 2.5MB リングバッファ)
    の 2 ストリームで保持し、必要な系統のみを低負荷でクライアントへ供給するハブ。
    """

    MAX_BASE_BYTES = 2097152   # 2 MB (録画再生時の先読みバーストでも字幕PESを取りこぼさない十分な余裕)
    MAX_BML_BYTES = 4194304    # 4 MB (BSの大型データ放送カルーセル 1〜2周分を欠損なく保持)

    def __init__(self):
        self.lock = threading.Lock()
        self.session_id = 0
        self.service_id = 0
        self.base_total = 0
        self.base_chunks = collections.deque()
        self.base_buffered = 0
        self.bml_total = 0
        self.bml_chunks = collections.deque()
        self.bml_buffered = 0
        self.ts_filter = None
        self.last_key = ""
        self.last_start_ts = 0.0

    def begin_session(self, target_url="", explicit_sid=0, range_start=0):
        sid = int(explicit_sid or 0)
        if not sid and target_url:
            m = re.search(r"/api/services/(\d+)/stream", target_url)
            if m:
                try:
                    full_id = int(m.group(1))
                    sid = full_id % 100000
                except Exception:
                    sid = 0
        stream_key = f"{target_url}|{range_start}|{sid}"
        now = time.time()
        with self.lock:
            # uMediaServer の初回プローブ接続 -> 本接続の連続リクエスト時はバッファを破棄せず引き継ぐ
            if self.session_id > 0 and self.last_key == stream_key and (now - self.last_start_ts) < 2.5:
                self.last_start_ts = now
                return self.session_id
            self.session_id += 1
            if self.session_id > 0x7FFFFFFF:
                self.session_id = 1
            cur_sess = self.session_id
            self.service_id = sid
            self.base_total = 0
            self.base_chunks.clear()
            self.base_buffered = 0
            self.bml_total = 0
            self.bml_chunks.clear()
            self.bml_buffered = 0
            self.ts_filter = TSSidebandFilter(sid)
            self.last_key = stream_key
            self.last_start_ts = now
            return cur_sess

    def feed(self, session_id, raw_ts_bytes):
        if not raw_ts_bytes:
            return
        with self.lock:
            if session_id != self.session_id or self.ts_filter is None:
                return
            flt = self.ts_filter
        base_bytes, bml_bytes = flt.process_split(raw_ts_bytes)
        if not base_bytes and not bml_bytes:
            return
        with self.lock:
            if session_id != self.session_id:
                return
            if base_bytes:
                s0 = self.base_total
                e0 = s0 + len(base_bytes)
                self.base_total = e0
                self.base_chunks.append((s0, e0, base_bytes))
                self.base_buffered += len(base_bytes)
                while self.base_buffered > self.MAX_BASE_BYTES and len(self.base_chunks) > 1:
                    old_s, old_e, _ = self.base_chunks.popleft()
                    self.base_buffered -= (old_e - old_s)
            if bml_bytes:
                s1 = self.bml_total
                e1 = s1 + len(bml_bytes)
                self.bml_total = e1
                self.bml_chunks.append((s1, e1, bml_bytes))
                self.bml_buffered += len(bml_bytes)
                while self.bml_buffered > self.MAX_BML_BYTES and len(self.bml_chunks) > 1:
                    old_s, old_e, _ = self.bml_chunks.popleft()
                    self.bml_buffered -= (old_e - old_s)

    def get_latest_pcr_sec(self, session_id):
        """指定セッションの直近ストリーム PCR (秒) を返す (録画ペーシング用)"""
        with self.lock:
            if session_id != self.session_id or self.ts_filter is None:
                return None
            return self.ts_filter.latest_pcr_sec

    def read_since(self, req_session, cursor, mode="base"):
        with self.lock:
            cur_sess = self.session_id
            cur_sid = self.service_id
            is_bml = (mode == "bml")
            chunks = self.bml_chunks if is_bml else self.base_chunks
            cur_total = self.bml_total if is_bml else self.base_total
            if cur_sess == 0 or not chunks:
                return struct.pack(">4sIIQ", b"DTVS", cur_sess, cur_sid, cur_total)
            if req_session != cur_sess or cursor < 0 or cursor > cur_total:
                cursor = chunks[0][0]
            earliest = chunks[0][0]
            if cursor < earliest:
                cursor = earliest
            parts = []
            total_sent = 0
            max_read = (188 * 2400) if is_bml else (188 * 800)
            next_cursor = cursor
            for s_off, e_off, data in chunks:
                if e_off <= cursor:
                    continue
                seg = data[cursor - s_off :] if s_off < cursor else data
                remain = max_read - total_sent
                if remain <= 0:
                    break
                if len(seg) > remain:
                    cut = (remain // 188) * 188
                    if cut <= 0 and total_sent == 0:
                        cut = min(len(seg), max_read)
                    if cut <= 0:
                        break
                    seg = seg[:cut]
                    parts.append(seg)
                    total_sent += len(seg)
                    next_cursor = cursor + total_sent
                    break
                parts.append(seg)
                total_sent += len(seg)
                next_cursor = e_off
            payload = b"".join(parts)
            hdr = struct.pack(">4sIIQ", b"DTVS", cur_sess, cur_sid, next_cursor)
            return hdr + payload


SIDEBAND_HUB = TSSidebandHub()


# =============================================================================
# LAN 内サーバー自動検出 (Mirakurun / EPGStation / 保存サーバー / TV) & 設定同期
# =============================================================================
_LOOPBACK_NETS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
]
_PRIVATE_LAN_NETS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("::1/128"),
]

SYNCABLE_SETTING_KEYS = {
    "mirakurunUrl",
    "bs4kMirakurunUrl",
    "bs4kMirakurunCleared",
    "showSubChannels",
    "autoPlayLastChannel",
    "enableGR",
    "enableBS",
    "enableBS4K",
    "enableCS",
    "enableTver",
    "enableAbema",
    "enableAbemaComments",
    "jikkyoEnabled",
    "jikkyoFontSize",
    "jikkyoOpacity",
    "captionEnabled",
    "bmlPrefetchEnabled",
    "enableRecordingMode",
    "epgstationUrl",
    "epgstationReadOnly",
    "epgstationServers",
    "activeEpgstationId",
    "mediaSaveServerUrl",
    "mediaSaveServerCleared",
}


def _ip_in_nets(ip_str, nets):
    if not ip_str:
        return False
    try:
        clean = str(ip_str).split("%")[0]
        addr = ipaddress.ip_address(clean)
        if getattr(addr, "ipv4_mapped", None):
            addr = addr.ipv4_mapped
        return any(addr in n for n in nets)
    except Exception:
        return False


def is_loopback_ip(ip_str):
    return _ip_in_nets(ip_str, _LOOPBACK_NETS)


def is_private_lan_ip(ip_str):
    return _ip_in_nets(ip_str, _PRIVATE_LAN_NETS)


def get_local_lan_ip():
    """外部通信を行わずに自端末のプライマリ LAN IPv4 アドレスを取得する"""
    for target in (("192.168.0.1", 80), ("10.0.0.1", 80), ("8.8.8.8", 80)):
        s = None
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(0.2)
            s.connect(target)
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127.") and is_private_lan_ip(ip):
                return ip
        except Exception:
            pass
        finally:
            if s:
                try:
                    s.close()
                except Exception:
                    pass
    try:
        for info in _ORIG_GETADDRINFO(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and is_private_lan_ip(ip):
                return ip
    except Exception:
        pass
    return ""


def _tcp_probe(host, port, timeout=0.35):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        return s.connect_ex((host, int(port))) == 0
    except Exception:
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass


def _http_get_json_fast(url, timeout=1.5):
    req = urllib.request.Request(url, headers={"User-Agent": "DTVPlus/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw)


def _format_http_url(host, port):
    return f"http://{host}" if int(port) == 80 else f"http://{host}:{int(port)}"


def discover_lan_servers(kind):
    """LAN (/24) 内の対象サーバーを高速並列スキャンして検証済み候補一覧を返す"""
    k = str(kind or "").strip().lower()
    if k not in ("mirakurun", "epgstation", "mediasave", "tv"):
        return {"ok": False, "error": "invalid kind", "items": []}

    local_ip = get_local_lan_ip()
    hosts = []
    if local_ip:
        parts = local_ip.split(".")
        if len(parts) == 4:
            prefix = ".".join(parts[:3])
            hosts = [f"{prefix}.{i}" for i in range(1, 255)]

    items = []
    seen_urls = set()

    if k == "mirakurun":
        targets = [("127.0.0.1", 40772)] + [(h, 40772) for h in hosts]

        def _check_mk(hp):
            host, port = hp
            if not _tcp_probe(host, port, 0.35):
                return None
            base = _format_http_url(host, port)
            try:
                # /api/version は Mirakurun v4 で npm registry 照会が走り 4 秒以上かかるため、
                # ローカル即応の /api/status と /api/tuners で高速・確実に判定する (mirakc / webostuner 両対応)
                ver_str = ""
                status_ok = False
                try:
                    st = _http_get_json_fast(f"{base}/api/status", timeout=1.5)
                    if isinstance(st, dict) and (st.get("version") or "epgReady" in st or "streamCount" in st or "process" in st):
                        ver_str = str(st.get("version") or "")
                        status_ok = True
                except Exception:
                    pass

                types = []
                tuners_ok = False
                try:
                    tuners = _http_get_json_fast(f"{base}/api/tuners", timeout=1.5)
                    if isinstance(tuners, list):
                        tuners_ok = True
                        tset = []
                        for t in tuners:
                            if isinstance(t, dict) and isinstance(t.get("types"), list):
                                for tp in t["types"]:
                                    if tp not in tset:
                                        tset.append(str(tp))
                        types = tset
                except Exception:
                    pass

                if not status_ok and not tuners_ok:
                    return None
                return {
                    "url": base,
                    "host": host,
                    "port": port,
                    "version": ver_str,
                    "types": types,
                    "isLocal": host == "127.0.0.1",
                }
            except Exception:
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=64) as ex:
            for res in ex.map(_check_mk, targets):
                if res and res["url"] not in seen_urls:
                    seen_urls.add(res["url"])
                    items.append(res)
        # 自端末 LAN IP と 127.0.0.1 の重複は LAN IP 側を優先 (TV 内蔵は別扱い)
        if local_ip and any(x["host"] == local_ip for x in items):
            items = [x for x in items if x["host"] != "127.0.0.1"]

    elif k == "epgstation":
        epg_ports = (8888, 80, 8889)
        targets = [("127.0.0.1", p) for p in epg_ports]
        for h in hosts:
            for p in epg_ports:
                targets.append((h, p))

        def _check_epg(hp):
            host, port = hp
            if not _tcp_probe(host, port, 0.28):
                return None
            base = _format_http_url(host, port)
            try:
                ver = _http_get_json_fast(f"{base}/api/version", timeout=1.4)
                if not isinstance(ver, dict) or not ver.get("version"):
                    return None
                # Mirakurun 誤検出防止のため EPGStation 固有の /api/config を確認
                try:
                    cfg = _http_get_json_fast(f"{base}/api/config", timeout=1.4)
                    if not isinstance(cfg, dict) or not (
                        "recorded" in cfg or "socketIoPath" in cfg or "isEnableTSStreaming" in cfg or "urlscheme" in cfg or "broadcast" in cfg
                    ):
                        return None
                except Exception:
                    return None
                return {
                    "url": base,
                    "host": host,
                    "port": port,
                    "version": str(ver.get("version") or ""),
                    "isLocal": host == "127.0.0.1",
                }
            except Exception:
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=96) as ex:
            for res in ex.map(_check_epg, targets):
                if res and res["url"] not in seen_urls:
                    seen_urls.add(res["url"])
                    items.append(res)
        if local_ip:
            lan_ports = {x["port"] for x in items if x["host"] == local_ip}
            items = [x for x in items if not (x["host"] == "127.0.0.1" and x["port"] in lan_ports)]

    elif k == "mediasave":
        targets = [("127.0.0.1", 7020)] + [(h, 7020) for h in hosts]

        def _check_ms(hp):
            host, port = hp
            if not _tcp_probe(host, port, 0.32):
                return None
            base = _format_http_url(host, port)
            try:
                info = _http_get_json_fast(f"{base}/api/ping", timeout=1.4)
                if not isinstance(info, dict) or info.get("service") != "dtvplus-media-save-server":
                    return None
                return {
                    "url": base,
                    "host": host,
                    "port": port,
                    "itemCount": int(info.get("itemCount") or 0),
                    "freeGb": info.get("freeGb"),
                    "isLocal": host == "127.0.0.1",
                }
            except Exception:
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=64) as ex:
            for res in ex.map(_check_ms, targets):
                if res and res["url"] not in seen_urls:
                    seen_urls.add(res["url"])
                    items.append(res)
        if local_ip and any(x["host"] == local_ip for x in items):
            items = [x for x in items if x["host"] != "127.0.0.1"]

    elif k == "tv":
        targets = [(h, PORT) for h in hosts if h != local_ip]

        def _check_tv(hp):
            host, port = hp
            if not _tcp_probe(host, port, 0.35):
                return None
            base = _format_http_url(host, port)
            try:
                info = _http_get_json_fast(f"{base}/api/device/info", timeout=1.4)
                if not isinstance(info, dict) or info.get("app") != "dtvplus-tv":
                    return None
                return {
                    "ip": host,
                    "url": base,
                    "platform": str(info.get("platform") or "webos"),
                    "ytdlpVersion": str(info.get("ytdlpVersion") or ""),
                }
            except Exception:
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=64) as ex:
            for res in ex.map(_check_tv, targets):
                if res and res["url"] not in seen_urls:
                    seen_urls.add(res["url"])
                    items.append(res)

    return {
        "ok": True,
        "kind": k,
        "localIp": local_ip,
        "items": items,
    }


def sanitize_synced_settings(raw):
    """PC 同期で受信した設定からホワイトリストのキーのみ安全に抽出する (履歴・個人データは除外)"""
    if not isinstance(raw, dict):
        return {}
    clean = {}
    for k, v in raw.items():
        if k not in SYNCABLE_SETTING_KEYS:
            continue
        if k == "epgstationServers":
            arr = []
            if isinstance(v, list):
                for item in v[:20]:
                    if not isinstance(item, dict):
                        continue
                    u = str(item.get("url") or "").strip().rstrip("/")
                    if not u:
                        continue
                    arr.append({
                        "id": str(item.get("id") or f"epg_{len(arr) + 1}")[:64],
                        "name": str(item.get("name") or "録画サーバー")[:80],
                        "url": u[:256],
                        "readOnly": bool(item.get("readOnly", True)),
                    })
            clean[k] = arr
        elif isinstance(v, (bool, int, float)):
            clean[k] = v
        elif isinstance(v, str):
            clean[k] = v.strip()[:256]
    return clean


def save_pending_synced_settings(raw_settings, from_ip=""):
    clean = sanitize_synced_settings(raw_settings)
    if not clean:
        return None
    payload = {
        "pending": True,
        "fromIp": str(from_ip or ""),
        "receivedAt": int(time.time() * 1000),
        "settings": clean,
    }
    with SYNC_SETTINGS_LOCK:
        tmp = SYNCED_SETTINGS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, SYNCED_SETTINGS_FILE)
    return payload


def read_pending_synced_settings():
    with SYNC_SETTINGS_LOCK:
        if not os.path.isfile(SYNCED_SETTINGS_FILE):
            return {"pending": False}
        try:
            with open(SYNCED_SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and data.get("pending") and isinstance(data.get("settings"), dict):
                return data
        except Exception:
            pass
    return {"pending": False}


def clear_pending_synced_settings():
    with SYNC_SETTINGS_LOCK:
        try:
            if os.path.isfile(SYNCED_SETTINGS_FILE):
                os.remove(SYNCED_SETTINGS_FILE)
        except Exception:
            pass


class DaemonHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def _enforce_local_or_sync_acl(self, method, path):
        """TV 本体デーモン用アクセス制御: ループバックは全許可、LAN は設定同期と機器認識のみ許可"""
        client_ip = (self.client_address[0] if self.client_address else "") or ""
        if is_loopback_ip(client_ip):
            return True
        if is_private_lan_ip(client_ip):
            if path == "/api/device/info" and method in ("GET", "OPTIONS"):
                return True
            if path == "/api/sync/settings" and method in ("POST", "OPTIONS"):
                return True
        self._send_json({"error": "forbidden"}, 403)
        return False

    @staticmethod
    def _extract_ts_pcrs(buf):
        """MPEG-TS バッファから PCR (秒) 一覧を高速抽出する"""
        pcrs = []
        n = len(buf)
        off = -1
        for i in range(0, min(max(0, n - 376), 2048)):
            if buf[i] == 0x47 and buf[i + 188] == 0x47 and buf[i + 376] == 0x47:
                off = i
                break
        if off < 0:
            return pcrs
        for pos in range(off, n - 187, 188):
            if buf[pos] != 0x47:
                continue
            afc = (buf[pos + 3] >> 4) & 0x03
            if afc in (2, 3):
                afl = buf[pos + 4]
                if afl >= 7 and (buf[pos + 5] & 0x10):
                    b0 = buf[pos + 6]
                    b1 = buf[pos + 7]
                    b2 = buf[pos + 8]
                    b3 = buf[pos + 9]
                    b4 = buf[pos + 10]
                    base = (b0 << 25) | (b1 << 17) | (b2 << 9) | (b3 << 1) | (b4 >> 7)
                    pcrs.append(base / 90000.0)
        return pcrs

    def _probe_recorded_duration(self, target_url):
        """
        録画 TS ファイルの先頭128KB・末尾256KB のみを HTTP Range で読み取り、
        PCR 差分から実録画秒数と最新ファイルサイズを約 0.07 秒で算出する。
        (EPG 番組枠長ではなく実際の録画長をタイムライン・シークへ反映するため)
        """
        try:
            req1 = urllib.request.Request(target_url, headers={"Range": "bytes=0-131071", "User-Agent": "DTVPlus/0.3"})
            with urllib.request.urlopen(req1, timeout=6) as r1:
                head = r1.read()
                cr = r1.headers.get("Content-Range") or ""
                cl = r1.headers.get("Content-Length") or "0"
            total_size = 0
            m_cr = re.search(r"/(\d+)\s*$", cr)
            if m_cr:
                total_size = int(m_cr.group(1))
            elif cl.isdigit():
                total_size = int(cl)

            if total_size <= 0:
                return {"ok": False, "durationSec": 0, "sizeBytes": 0}

            p1 = self._extract_ts_pcrs(head)
            if total_size <= 262144:
                p2 = p1
            else:
                tail_start = max(0, total_size - 262144)
                req2 = urllib.request.Request(
                    target_url,
                    headers={"Range": f"bytes={tail_start}-{total_size - 1}", "User-Agent": "DTVPlus/0.3"},
                )
                with urllib.request.urlopen(req2, timeout=6) as r2:
                    tail = r2.read()
                p2 = self._extract_ts_pcrs(tail)

            if p1 and p2:
                dur = p2[-1] - p1[0]
                if dur < 0:
                    dur += (1 << 33) / 90000.0
                if 1.0 <= dur <= 86400.0:
                    return {"ok": True, "durationSec": int(round(dur)), "sizeBytes": total_size, "method": "pcr"}

            # BS4K (MMT/TLV) 等で TS PCR が取れない場合のフォールバック推定
            est_bps = 3750000.0 if (len(head) > 0 and head[0] == 0x7F) else 2000000.0
            est_dur = max(1, int(round(total_size / est_bps)))
            return {"ok": True, "durationSec": est_dur, "sizeBytes": total_size, "method": "estimate"}
        except Exception as e:
            return {"ok": False, "error": str(e), "durationSec": 0, "sizeBytes": 0}

    def _proxy_epgstation(self, method):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        target = (qs.get("target") or [""])[0]
        if not target or not (target.startswith("http://") or target.startswith("https://")):
            return self._send_json({"error": "invalid target"}, 400)

        body_bytes = None
        headers = {"User-Agent": "LGDTVPlus/0.3", "Accept": "application/json, */*"}
        if method in ("POST", "PUT"):
            length = int(self.headers.get("Content-Length") or "0")
            body_bytes = self.rfile.read(length) if length > 0 else b"{}"
            headers["Content-Type"] = self.headers.get("Content-Type") or "application/json; charset=utf-8"

        req = urllib.request.Request(target, data=body_bytes, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read()
                ctype = resp.headers.get("Content-Type") or "application/json; charset=utf-8"
                self.send_response(resp.status)
                self._cors()
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        except urllib.error.HTTPError as he:
            err_raw = he.read() if he.fp else b""
            self.send_response(he.code)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(err_raw)))
            self.end_headers()
            if err_raw:
                self.wfile.write(err_raw)
        except Exception as e:
            self._send_json({"error": str(e)}, 502)

    def _proxy_bml_http(self, method):
        """データ放送 (BML) の双方向通信 (IP.get / transmitTextDataOverIP) 用 CORS プロキシ"""
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        target = (qs.get("target") or [""])[0]
        if not target or not (target.startswith("http://") or target.startswith("https://")):
            return self._send_json({"error": "invalid target"}, 400)

        body_bytes = None
        headers = {
            "User-Agent": "Mozilla/5.0 (BMLHTML/001.000; LGDTVPlus/0.3)",
            "Accept": "*/*",
        }
        if method == "POST":
            length = int(self.headers.get("Content-Length") or "0")
            body_bytes = self.rfile.read(length) if length > 0 else b""
            headers["Content-Type"] = self.headers.get("Content-Type") or "application/x-www-form-urlencoded"

        req = urllib.request.Request(target, data=body_bytes, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw = resp.read()
                ctype = resp.headers.get("Content-Type") or "application/octet-stream"
                cc_hdr = resp.headers.get("Cache-Control") or "no-store"
                self.send_response(resp.status)
                self._cors()
                self.send_header("Access-Control-Expose-Headers", "Content-Type, Cache-Control, X-BML-Status")
                self.send_header("X-BML-Status", str(resp.status))
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", cc_hdr)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        except urllib.error.HTTPError as he:
            err_raw = he.read() if he.fp else b""
            self.send_response(he.code)
            self._cors()
            self.send_header("Access-Control-Expose-Headers", "Content-Type, Cache-Control, X-BML-Status")
            self.send_header("X-BML-Status", str(he.code))
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(err_raw)))
            self.end_headers()
            if err_raw:
                self.wfile.write(err_raw)
        except Exception as e:
            self._send_json({"error": str(e)}, 502)

    def _pipe_ts_stream(self, target_url, range_start_byte=0, explicit_sid=0, stream_mode=""):
        tsreadex_bin = "/usr/local/bin/tsreadex"
        mmt2ts_bin = "/usr/local/bin/mmt2ts"
        req_headers = {
            "User-Agent": "LGDTVPlus/0.3",
            "X-Mirakurun-Priority": "2",
        }
        if range_start_byte > 0:
            req_headers["Range"] = f"bytes={range_start_byte}-"

        # SMB400 等の 1チューナー機では Mirakurun:getEPG() 巡回と重なって一時的に 503 が返るため自動リトライする
        up = None
        last_err = None
        max_tries = 6 if (stream_mode == "bs4k" or "/BS4K/" in target_url) else 2
        for attempt in range(max_tries):
            try:
                req = urllib.request.Request(target_url, headers=req_headers)
                up = urllib.request.urlopen(req, timeout=18)
                break
            except urllib.error.HTTPError as he:
                last_err = he
                if he.code == 503 and attempt + 1 < max_tries:
                    time.sleep(0.85)
                    continue
                raise
            except Exception as e:
                last_err = e
                if attempt + 1 < max_tries:
                    time.sleep(0.5)
                    continue
                raise
        if up is None:
            raise last_err or RuntimeError("upstream stream open failed")

        # 先頭チャンクを少し読んで生 MMT/TLV (BS4K: 0x7F TLVチェーン) か通常 MPEG-2 TS かを自動判別する
        first_chunk = up.read(32768)
        if not first_chunk:
            try:
                up.close()
            except Exception:
                pass
            return self._send_json({"error": "empty upstream stream"}, 502)

        def _detect_mmt_tlv(buf):
            n = len(buf)
            # 先頭付近で MPEG-2 TS (188B周期の 0x47 が 5連続) が成立すれば通常 TS
            scan_ts = min(n - 188 * 5, 4096)
            for off in range(0, max(0, scan_ts)):
                if (
                    buf[off] == 0x47
                    and buf[off + 188] == 0x47
                    and buf[off + 376] == 0x47
                    and buf[off + 564] == 0x47
                    and buf[off + 752] == 0x47
                ):
                    return False
            # 録画開始位置や Range シーク途中では先頭バイトが 0x7F とは限らないため、
            # チャンク内で TLV パケット (0x7F + 有効タイプ + 長さ) が 3連続する箇所を探索する
            valid_tlv_types = (0x01, 0x02, 0x03, 0xFE, 0xFF)
            limit = min(n - 12, 28672)
            for off in range(0, max(0, limit)):
                if buf[off] != 0x7F or buf[off + 1] not in valid_tlv_types:
                    continue
                ln1 = (buf[off + 2] << 8) | buf[off + 3]
                p1 = off + 4 + ln1
                if p1 + 4 >= n or buf[p1] != 0x7F or buf[p1 + 1] not in valid_tlv_types:
                    continue
                ln2 = (buf[p1 + 2] << 8) | buf[p1 + 3]
                p2 = p1 + 4 + ln2
                if p2 + 4 <= n and buf[p2] == 0x7F and buf[p2 + 1] in valid_tlv_types:
                    return True
            return buf[0] == 0x7F and buf[0] != 0x47

        is_mmt_tlv = (stream_mode == "bs4k") or _detect_mmt_tlv(first_chunk)

        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "video/mp2t")
        self.send_header("Accept-Ranges", "none")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception:
            pass

        # BS4K (MMT/TLV -> HEVC/H.265 + AAC-ADTS MPEG-2 TS リアルタイム無劣化リマックス)
        if is_mmt_tlv and os.path.exists(mmt2ts_bin):
            cmd = [mmt2ts_bin]
            if explicit_sid and int(explicit_sid) > 0:
                cmd.extend(["--sid", str(int(explicit_sid))])
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=0,
            )

            def feed_mmt():
                try:
                    proc.stdin.write(first_chunk)
                    read_fn = getattr(up, "read1", up.read)
                    while True:
                        data = read_fn(65536)
                        if not data:
                            break
                        proc.stdin.write(data)
                except Exception:
                    pass
                finally:
                    try:
                        proc.stdin.close()
                    except Exception:
                        pass
                    try:
                        up.close()
                    except Exception:
                        pass

            feeder = threading.Thread(target=feed_mmt, daemon=True)
            feeder.start()
            try:
                try:
                    self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                except Exception:
                    pass
                while True:
                    out_chunk = proc.stdout.read(65536)
                    if not out_chunk:
                        break
                    self.wfile.write(out_chunk)
            finally:
                try:
                    up.close()
                except Exception:
                    pass
                try:
                    proc.kill()
                    proc.wait(timeout=2)
                except Exception:
                    pass
            return

        sb_session = SIDEBAND_HUB.begin_session(target_url, explicit_sid, range_start_byte)

        if os.path.exists(tsreadex_bin):
            proc = subprocess.Popen(
                [
                    tsreadex_bin,
                    "-x", "18/38/39",
                    "-n", "-1",
                    "-a", "13",
                    "-b", "7",
                    "-c", "2",
                    "-u", "2",
                    "-",
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=0,
            )

            def feed_ts():
                try:
                    try:
                        SIDEBAND_HUB.feed(sb_session, first_chunk)
                    except Exception:
                        pass
                    proc.stdin.write(first_chunk)
                    while True:
                        data = up.read(65536)
                        if not data:
                            break
                        try:
                            SIDEBAND_HUB.feed(sb_session, data)
                        except Exception:
                            pass
                        proc.stdin.write(data)
                except Exception:
                    pass
                finally:
                    try:
                        proc.stdin.close()
                    except Exception:
                        pass
                    try:
                        up.close()
                    except Exception:
                        pass

            feeder = threading.Thread(target=feed_ts, daemon=True)
            feeder.start()
            try:
                while True:
                    out_chunk = proc.stdout.read(65536)
                    if not out_chunk:
                        break
                    self.wfile.write(out_chunk)
            finally:
                try:
                    up.close()
                except Exception:
                    pass
                try:
                    proc.kill()
                    proc.wait(timeout=2)
                except Exception:
                    pass
        else:
            try:
                try:
                    SIDEBAND_HUB.feed(sb_session, first_chunk)
                except Exception:
                    pass
                self.wfile.write(first_chunk)
                while True:
                    chunk = up.read(65536)
                    if not chunk:
                        break
                    try:
                        SIDEBAND_HUB.feed(sb_session, chunk)
                    except Exception:
                        pass
                    self.wfile.write(chunk)
            finally:
                try:
                    up.close()
                except Exception:
                    pass

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self._enforce_local_or_sync_acl("OPTIONS", parsed.path):
            return
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self._enforce_local_or_sync_acl("POST", parsed.path):
            return
        if parsed.path == "/api/sync/settings":
            try:
                length = int(self.headers.get("Content-Length") or "0")
                if length <= 0 or length > 65536:
                    return self._send_json({"error": "invalid payload size"}, 400)
                raw = self.rfile.read(length).decode("utf-8", errors="replace")
                payload = json.loads(raw)
                raw_settings = payload.get("settings") if isinstance(payload, dict) and isinstance(payload.get("settings"), dict) else payload
                from_ip = (self.client_address[0] if self.client_address else "") or ""
                saved = save_pending_synced_settings(raw_settings, from_ip=from_ip)
                if not saved:
                    return self._send_json({"error": "no valid settings provided"}, 400)
                return self._send_json({
                    "ok": True,
                    "receivedAt": saved["receivedAt"],
                    "keyCount": len(saved["settings"]),
                })
            except Exception as e:
                return self._send_json({"error": str(e)}, 400)
        if parsed.path == "/api/sync/settings/ack":
            clear_pending_synced_settings()
            return self._send_json({"ok": True})
        if parsed.path == "/api/epgstation/proxy":
            return self._proxy_epgstation("POST")
        if parsed.path == "/api/bml/http":
            return self._proxy_bml_http("POST")
        if parsed.path == "/api/tver/good_counts":
            try:
                length = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(length).decode("utf-8", errors="replace") if length > 0 else "{}"
                payload = json.loads(raw)
                return self._send_json(fetch_tver_good_counts(payload.get("ids") or []))
            except Exception as e:
                return self._send_json({"error": str(e)}, 400)
        if parsed.path == "/api/vod/check_expired":
            try:
                length = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(length).decode("utf-8", errors="replace") if length > 0 else "{}"
                payload = json.loads(raw)
                return self._send_json(check_vod_items_expired(payload.get("items") or []))
            except Exception as e:
                return self._send_json({"error": str(e)}, 400)
        if parsed.path == "/api/prefs/jikkyo":
            try:
                length = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(length).decode("utf-8", errors="replace") if length > 0 else "{}"
                payload = json.loads(raw)
                saved = write_shared_jikkyo_prefs(payload)
                return self._send_json({"ok": True, "prefs": saved})
            except Exception as e:
                return self._send_json({"error": str(e)}, 400)
        return self._send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self._enforce_local_or_sync_acl("DELETE", parsed.path):
            return
        if parsed.path == "/api/epgstation/proxy":
            return self._proxy_epgstation("DELETE")
        return self._send_json({"error": "not found"}, 404)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        if not self._enforce_local_or_sync_acl("GET", path):
            return

        try:
            if path == "/api/device/info":
                ver_str = yt_dlp.version.__version__ if (YDL_READY_EVENT.is_set() and yt_dlp) else "loading..."
                return self._send_json({
                    "ok": True,
                    "app": "dtvplus-tv",
                    "platform": "webos" if os.name != "nt" else "windows",
                    "port": PORT,
                    "lanIp": get_local_lan_ip(),
                    "ytdlpVersion": ver_str,
                })

            if path == "/api/jikkyo/forces":
                return self._send_json(fetch_jikkyo_forces())

            if path == "/api/lan/discover":
                kind = (qs.get("type") or [""])[0]
                return self._send_json(discover_lan_servers(kind))

            if path == "/api/sync/settings/pending":
                return self._send_json(read_pending_synced_settings())

            if path == "/api/ping":
                ver_str = yt_dlp.version.__version__ if (YDL_READY_EVENT.is_set() and yt_dlp) else "loading..."
                return self._send_json({
                    "ok": True,
                    "ready": YDL_READY_EVENT.is_set(),
                    "lanIp": get_local_lan_ip(),
                    "ytdlpVersion": ver_str,
                    "pythonVersion": sys.version.split()[0],
                    "ts": int(time.time() * 1000),
                })

            if path == "/api/tv/channelmap":
                return self._send_json(get_public_tv_channel_map())

            if path == "/api/logo":
                nid_s = (qs.get("nid") or [""])[0]
                sid_s = (qs.get("sid") or [""])[0]
                id_s = (qs.get("id") or [""])[0]
                base_s = (qs.get("base") or [""])[0]
                resolved = resolve_channel_logo(nid_s, sid_s, id_s, base_s)
                if not resolved:
                    self.send_response(404)
                    self._cors()
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                ctype, raw_img = resolved
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "public, max-age=86400")
                self.send_header("Content-Length", str(len(raw_img)))
                self.end_headers()
                self.wfile.write(raw_img)
                return

            if path == "/api/prefs/jikkyo":
                # クエリパラメータでの簡易更新にも対応 (?save=1&fontSizeKey=...&opacity=...&enabled=...)
                if (qs.get("save") or [""])[0] == "1":
                    upd = {}
                    if "enabled" in qs:
                        upd["enabled"] = qs["enabled"][0].lower() in ("1", "true", "yes")
                    if "fontSizeKey" in qs:
                        upd["fontSizeKey"] = qs["fontSizeKey"][0]
                    if "opacity" in qs:
                        upd["opacity"] = float(qs["opacity"][0])
                    if "jkId" in qs:
                        upd["jkId"] = qs["jkId"][0]
                    return self._send_json(write_shared_jikkyo_prefs(upd))
                return self._send_json(read_shared_jikkyo_prefs())

            if path == "/api/ytdlp/update":
                res = run_ytdlp_self_update()
                self._send_json(res)
                if res.get("updated"):
                    # 新しい yt-dlp モジュールをメモリに反映するためプロセスを自己再起動
                    threading.Timer(0.5, lambda: os.execv(sys.executable, [sys.executable] + sys.argv)).start()
                return

            if path == "/api/tver/home":
                return self._send_json(fetch_tver_home())

            if path == "/api/tver/live/channels":
                return self._send_json(fetch_tver_live_channels())

            if path == "/api/tver/live.m2ts":
                kind = (qs.get("kind") or ["simul"])[0]
                tid = (qs.get("id") or [""])[0]
                if not tid:
                    return self._send_json({"error": "missing id"}, 400)
                stream_tver_live_ts(self, kind, tid)
                return

            if path == "/api/tver/search":
                q = (qs.get("q") or [""])[0]
                return self._send_json(fetch_tver_search(q))

            if path == "/api/abema/channels":
                return self._send_json(fetch_abema_live_channels())

            if path == "/api/abema/vod/home":
                g = (qs.get("genre") or [""])[0]
                return self._send_json(fetch_abema_vod_home(g))

            if path == "/api/abema/vod/series":
                sid = (qs.get("id") or [""])[0]
                seid = (qs.get("seasonId") or [""])[0]
                if not sid:
                    return self._send_json({"error": "missing id"}, 400)
                return self._send_json(fetch_abema_vod_series(sid, seid))

            if path == "/api/abema/vod/search":
                q = (qs.get("q") or [""])[0]
                return self._send_json(fetch_abema_vod_search(q))

            if path == "/api/abema/comments":
                cid = (qs.get("channelId") or [""])[0]
                sid = (qs.get("slotId") or [""])[0]
                return self._send_json(fetch_abema_comments(cid, sid))

            if path == "/api/extract":
                u = (qs.get("url") or [""])[0]
                if not u:
                    return self._send_json({"error": "missing url"}, 400)
                return self._send_json(extract_stream_via_ytdlp(u))

            # 旧互換エンドポイントもすべて yt-dlp 抽出へ委譲
            if path == "/api/tver/stream":
                ep_id = (qs.get("id") or [""])[0]
                if not ep_id:
                    return self._send_json({"error": "missing id"}, 400)
                return self._send_json(extract_stream_via_ytdlp(f"https://tver.jp/episodes/{ep_id}"))

            if path == "/api/abema/m3u8":
                u = (qs.get("url") or [""])[0]
                m3u8_text = rewrite_abema_m3u8(u).encode("utf-8")
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(m3u8_text)))
                self.end_headers()
                self.wfile.write(m3u8_text)
                return

            if path == "/api/abema/live.m2ts":
                u = (qs.get("url") or [""])[0]
                if not u:
                    return self._send_json({"error": "missing url"}, 400)
                stream_abema_live_ts(self, u)
                return

            if path == "/api/abema/key":
                ticket = (qs.get("ticket") or [""])[0]
                key_bytes = get_abema_videokey(ticket)
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(key_bytes)))
                self.end_headers()
                self.wfile.write(key_bytes)
                return

            if path == "/api/epgstation/proxy":
                return self._proxy_epgstation("GET")

            if path == "/api/recorded/duration":
                target = (qs.get("target") or [""])[0]
                if not target or not (target.startswith("http://") or target.startswith("https://")):
                    return self._send_json({"error": "invalid target"}, 400)
                return self._send_json(self._probe_recorded_duration(target))

            if path == "/api/img":
                img_url = (qs.get("url") or [""])[0]
                if not img_url or not (img_url.startswith("https://") or img_url.startswith("http://")):
                    return self._send_json({"error": "invalid url"}, 400)
                req = urllib.request.Request(img_url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=8) as resp:
                    raw_i = resp.read()
                    ct = resp.headers.get("Content-Type") or "image/png"
                    self.send_response(200)
                    self._cors()
                    self.send_header("Content-Type", ct)
                    self.send_header("Cache-Control", "public, max-age=1800")
                    self.send_header("Content-Length", str(len(raw_i)))
                    self.end_headers()
                    self.wfile.write(raw_i)
                return

            if path == "/api/bml/http":
                return self._proxy_bml_http("GET")

            if path == "/api/ts/sideband":
                req_sess = int((qs.get("session") or ["0"])[0] or 0)
                cursor = int((qs.get("cursor") or ["0"])[0] or 0)
                mode = (qs.get("mode") or ["base"])[0]
                blob = SIDEBAND_HUB.read_since(req_sess, cursor, mode=mode)
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(blob)))
                self.end_headers()
                self.wfile.write(blob)
                return

            if path.startswith("/recorded") and qs.get("target"):
                target = qs["target"][0]
                offset_sec = float((qs.get("offsetSec") or ["0"])[0] or 0)
                dur_sec = float((qs.get("durationSec") or ["0"])[0] or 0)
                total_size = int((qs.get("size") or ["0"])[0] or 0)
                explicit_sid = int((qs.get("sid") or ["0"])[0] or 0)
                stream_mode = (qs.get("mode") or [""])[0]
                start_byte = 0
                if offset_sec > 1.0 and dur_sec > 5.0 and total_size > 18800:
                    ratio = max(0.0, min(0.992, offset_sec / dur_sec))
                    start_byte = (int(ratio * total_size) // 188) * 188
                self._pipe_ts_stream(target, start_byte, explicit_sid, stream_mode)
                return

            if path.startswith("/stream") and qs.get("target"):
                target = qs["target"][0]
                explicit_sid = int((qs.get("sid") or ["0"])[0] or 0)
                stream_mode = (qs.get("mode") or [""])[0]
                self._pipe_ts_stream(target, 0, explicit_sid, stream_mode)
                return

            return self._send_json({"error": "not found", "path": path}, 404)
        except BrokenPipeError:
            pass
        except Exception as e:
            try:
                self._send_json({"error": str(e)}, 500)
            except Exception:
                pass


def main():
    try:
        # 0.0.0.0 で待受 (LAN からは設定同期・機器認識のみ許可、その他は 127.0.0.1 のみ厳格制限)
        srv = ThreadingHTTPServer(("0.0.0.0", PORT), DaemonHandler)
    except OSError:
        sys.exit(0)

    threading.Thread(target=warmup_ytdlp, daemon=True).start()
    srv.serve_forever()


if __name__ == "__main__":
    main()
