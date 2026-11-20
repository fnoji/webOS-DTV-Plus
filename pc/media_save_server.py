#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
media_save_server.py - DTV Plus TVer / ABEMA 配信保存＆ライブラリ配信サーバー
- 指定フォルダ (デフォルト: D:\\tver_hozon) の既存保存動画 (MP4/MKV/TS等) を自動スキャン＆キャッシュ
- yt-dlp バックグラウンドキューワーカーで TVer / ABEMA の MP4 ダウンロード保存＆進捗追跡
- Range シーク完全対応 (206 Partial Content) で LG webOS TV / PC Chrome / Tailscale すべてから軽量再生
- キャッシュ (メタデータJSON / サムネJPEG) は <保存先>\\.dtvplus_cache\\ に隔離し、動画フォルダを汚さない
"""
import datetime
import hashlib
import ipaddress
import json
import mimetypes
import os
import queue
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("DTVPLUS_SAVE_PORT", "7020"))
DEFAULT_SAVE_DIR = os.environ.get("DTVPLUS_SAVE_DIR", r"D:\tver_hozon")
PC_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(PC_DIR)
BACKEND_DIR = os.path.join(ROOT_DIR, "app", "backend")
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)
try:
    import ytdlp_daemon as yd
except Exception:
    yd = None

CONFIG_PATH = os.path.join(PC_DIR, "save_server_config.json")

VIDEO_EXTS = {".mp4", ".mkv", ".m2ts", ".ts", ".webm", ".mov"}
FFMPEG_BIN = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE_BIN = shutil.which("ffprobe") or "ffprobe"
YTDLP_BIN = shutil.which("yt-dlp")

ALLOWED_CLIENT_NETS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def _is_allowed_client(ip_str):
    if not ip_str:
        return False
    try:
        addr = ipaddress.ip_address(ip_str.split("%")[0])
        if getattr(addr, "ipv4_mapped", None):
            addr = addr.ipv4_mapped
        return any(addr in net for net in ALLOWED_CLIENT_NETS)
    except Exception:
        return False


def _load_save_dirs():
    dirs = []
    if os.path.isfile(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            for d in cfg.get("dirs") or []:
                if d and isinstance(d, str):
                    dirs.append(os.path.abspath(d))
        except Exception:
            pass
    if not dirs:
        dirs = [os.path.abspath(DEFAULT_SAVE_DIR)]
    # プライマリ保存先フォルダが無ければ作成を試みる
    try:
        os.makedirs(dirs[0], exist_ok=True)
    except Exception:
        pass
    return dirs


SAVE_DIRS = _load_save_dirs()
PRIMARY_SAVE_DIR = SAVE_DIRS[0]
CACHE_ROOT = os.path.join(PRIMARY_SAVE_DIR, ".dtvplus_cache")
META_CACHE_DIR = os.path.join(CACHE_ROOT, "meta")
THUMB_CACHE_DIR = os.path.join(CACHE_ROOT, "thumbs")
TEMP_WORK_DIR = os.path.join(CACHE_ROOT, "tmp")
ABEMA_TIMETABLE_CACHE_PATH = os.path.join(CACHE_ROOT, "abema_timetable.json")
ABEMA_RESERVES_PATH = os.path.join(CACHE_ROOT, "abema_reserves.json")
ABEMA_TIMETABLE_TTL_SEC = 1800  # 30分ごとに番組表キャッシュを自動更新
ABEMA_TIMETABLE_DAYS = 7        # 今日〜6日先の計7日間をキャッシュ
os.makedirs(META_CACHE_DIR, exist_ok=True)
os.makedirs(THUMB_CACHE_DIR, exist_ok=True)
os.makedirs(TEMP_WORK_DIR, exist_ok=True)

ITEMS_LOCK = threading.Lock()
ITEMS_BY_ID = {}
ITEMS_LIST = []
LAST_SCAN_AT = 0.0
LAST_ORPHAN_PRUNE_AT = 0.0

JOBS_LOCK = threading.Lock()
JOBS = {}
JOB_ORDER = []
JOB_QUEUE = queue.Queue()
EPISODE_META_HINTS = {}  # episodeId -> {title, series, broadcaster, provider, thumbnail, description, url}

ABEMA_TIMETABLE_LOCK = threading.Lock()
ABEMA_TIMETABLE_DATA = None
ABEMA_TIMETABLE_FETCHING = False

ABEMA_RESERVES_LOCK = threading.Lock()
ABEMA_RESERVES = {}  # reserveId -> dict

ABEMA_GENRE_ID_MAP = {
    "animation": "アニメ",
    "news": "ニュース",
    "variety": "バラエティ",
    "drama": "ドラマ",
    "asia": "ドラマ",
    "romance": "バラエティ",
    "sports": "スポーツ",
    "fighting": "スポーツ",
    "movie": "映画",
    "mahjong": "趣味・実用",
    "shogi": "趣味・実用",
    "music": "音楽",
    "hiphop": "音楽",
    "k-pop": "音楽",
    "documentary": "ドキュメンタリー",
    "reality": "バラエティ",
    "world": "ニュース",
}


def _file_id(abs_path):
    return hashlib.sha1(abs_path.lower().encode("utf-8")).hexdigest()[:16]


def _format_bytes(n):
    n = float(n or 0)
    if n >= 1024 ** 3:
        return f"{n / (1024 ** 3):.2f} GB"
    if n >= 1024 ** 2:
        return f"{n / (1024 ** 2):.0f} MB"
    if n >= 1024:
        return f"{n / 1024:.0f} KB"
    return f"{int(n)} B"


def _parse_filename_meta(abs_path, base_dir):
    stem = os.path.splitext(os.path.basename(abs_path))[0]
    ep_id = ""
    m = re.search(r"\[([A-Za-z0-9_-]{6,32})\]\s*$", stem)
    if m:
        ep_id = m.group(1)
        clean_title = stem[:m.start()].strip()
    else:
        clean_title = stem.strip()

    provider = "LOCAL"
    if re.match(r"^ep[a-z0-9]{6,}$", ep_id, re.I):
        provider = "TVER"
    elif re.match(r"^\d+-\d+_s\d+_p\d+", ep_id, re.I) or ep_id.lower().startswith("abema-"):
        provider = "ABEMA"

    rel_dir = os.path.relpath(os.path.dirname(abs_path), base_dir)
    if rel_dir and rel_dir != ".":
        series = rel_dir.split(os.sep)[0]
    else:
        # タイトル先頭トークンから簡易シリーズ名推定 (例: "VIVANT 第二十三話 ..." -> "VIVANT")
        parts = re.split(r"[\s\u3000]+", clean_title, maxsplit=1)
        series = parts[0] if len(parts) > 1 and 1 <= len(parts[0]) <= 24 else ""

    return {
        "title": clean_title or stem,
        "episodeId": ep_id,
        "provider": provider,
        "series": series,
    }


def _ffprobe_file(abs_path):
    info = {"durationSec": 0, "tags": {}, "hasAttachedPic": False, "width": 0, "height": 0, "vcodec": "", "acodec": ""}
    try:
        proc = subprocess.run(
            [FFPROBE_BIN, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", abs_path],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        if proc.returncode != 0 or not proc.stdout:
            return info
        data = json.loads(proc.stdout)
        fmt = data.get("format") or {}
        try:
            info["durationSec"] = int(round(float(fmt.get("duration") or 0)))
        except Exception:
            info["durationSec"] = 0
        raw_tags = fmt.get("tags") or {}
        info["tags"] = {str(k).lower(): str(v) for k, v in raw_tags.items() if v is not None}
        for s in data.get("streams") or []:
            ctype = s.get("codec_type")
            disp = s.get("disposition") or {}
            if disp.get("attached_pic") == 1:
                info["hasAttachedPic"] = True
            elif ctype == "video" and not info["vcodec"]:
                info["vcodec"] = str(s.get("codec_name") or "")
                info["width"] = int(s.get("width") or 0)
                info["height"] = int(s.get("height") or 0)
            elif ctype == "audio" and not info["acodec"]:
                info["acodec"] = str(s.get("codec_name") or "")
    except Exception:
        pass
    return info


META_CACHE_VERSION = 7
_META_FETCH_LOCK = threading.Lock()
_LAST_META_FETCH_AT = 0.0

TVER_ARTIST_MAP = {
    "tver-ntv": "日テレ",
    "tver-ytv": "読売テレビ",
    "tver-tbs": "TBS",
    "tver-mbs": "MBS毎日放送",
    "tver-ex": "テレビ朝日",
    "tver-abc": "ABCテレビ",
    "tver-tx": "テレ東",
    "tver-cx": "フジテレビ",
    "tver-ktv": "カンテレ",
    "tver-nhk": "NHK",
    "tver-nhk-g": "NHK総合",
    "tver-nhk-e": "NHK Eテレ",
    "tver-ctv": "中京テレビ",
    "tver-cbc": "CBCテレビ",
    "tver-thk": "東海テレビ",
    "tver-nbn": "メ〜テレ",
    "tver-tvo": "テレビ大阪",
    "tver-stv": "STV札幌テレビ",
    "tver-htb": "HTB北海道テレビ",
    "tver-hbc": "HBC北海道放送",
    "tver-uhb": "UHB北海道文化放送",
    "tver-tvh": "TVhテレビ北海道",
    "tver-fbs": "FBS福岡放送",
    "tver-rkb": "RKB毎日放送",
    "tver-kbc": "KBC九州朝日放送",
    "tver-tnc": "TNCテレビ西日本",
    "tver-bsntv": "BS日テレ",
    "tver-bsasahi": "BS朝日",
    "tver-bstbs": "BS-TBS",
    "tver-bstx": "BSテレ東",
    "tver-bsfuji": "BSフジ",
}


def _normalize_broadcaster(raw_name, fallback="その他"):
    s = str(raw_name or "").strip()
    if not s:
        return fallback
    low = s.lower()
    if low in TVER_ARTIST_MAP:
        return TVER_ARTIST_MAP[low]
    if low.startswith("tver-"):
        return s[5:].upper()
    if low in ("tver", "local"):
        return fallback
    return s


def _unwrap_proxy_url(u):
    s = str(u or "").strip()
    if "/api/img?url=" in s:
        try:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(s).query)
            if q.get("url"):
                return q["url"][0]
        except Exception:
            pass
    return s


def _infer_genre(raw_genre, provider, series, title, description):
    """メタデータのジャンル、またはタイトル・シリーズ・説明文から日本語ジャンル区分を判定する"""
    g = str(raw_genre or "").strip()
    g_low = g.lower()
    if g:
        if g_low in ABEMA_GENRE_ID_MAP:
            g = ABEMA_GENRE_ID_MAP[g_low]
            g_low = g.lower()
        if any(k in g_low for k in ("anime", "animation", "アニメ")):
            return "アニメ"
        if any(k in g_low for k in ("drama", "ドラマ")):
            return "ドラマ"
        if any(k in g_low for k in ("variety", "comedy", "バラエティ")):
            return "バラエティ"
        if any(k in g_low for k in ("news", "documentary", "information", "報道", "ニュース", "情報", "ドキュメンタリー")):
            return "報道・情報"
        if any(k in g_low for k in ("sport", "スポーツ")):
            return "スポーツ"
        if any(k in g_low for k in ("music", "音楽")):
            return "音楽"
        if any(k in g_low for k in ("movie", "film", "映画")):
            return "映画"
        return g

    # 1) 番組名・シリーズ名からの優先判定 (説明文内の話題キーワードによる誤分類を防ぐ)
    # ※「第N話」はアニメ・ドラマ共通の表記のためここでは即断せず、説明文判定後の最終フォールバックで扱う
    head = f"{series} {title}"
    if any(k in head for k in ("アニメ", "薬屋のひとりごと", "けいおん", "ガンダム", "ワンピース", "鬼滅", "呪術", "名探偵コナン", "クレヨンしんちゃん", "ドラえもん")):
        return "アニメ"
    if re.search(r"#\d+\s*[『「]", title) and provider == "ABEMA":
        return "アニメ"
    if any(k in head for k in ("夜ふかし", "アメトーーク", "ロンドンハーツ", "水曜日のダウンタウン", "しゃべくり", "イッテQ", "上田と女", "有吉", "千鳥", "かまいたち", "バラエティ")):
        return "バラエティ"
    if any(k in head for k in ("委員会", "ニュース", "報道", "サンデーモーニング", "クローズアップ現代", "ガイアの夜明け", "カンブリア宮殿", "WBS", "ドキュメンタリー", "情熱大陸", "プロフェッショナル")):
        return "報道・情報"
    if any(k in head for k in ("ミュージック", "Mステ", "歌謡", "紅白", "CDTV")):
        return "音楽"
    if any(k in head for k in ("プロ野球", "MLB", "Jリーグ", "サッカー", "ゴルフ", "競馬", "相撲", "スポーツ", "格闘", "RIZIN", "K-1")):
        return "スポーツ"

    # 2) 説明文・放送局ラベルを含めた判定
    blob = f"{head} {description}"
    if any(k in blob for k in ("アニメ", "CV.", "CV:", "声優", "原作コミック", "アニメーション", "abema-anime")):
        return "アニメ"
    if any(k in blob for k in ("日曜劇場", "月9", "木曜劇場", "火曜ドラマ", "金曜ドラマ", "連続ドラマ", "ドラマ", "主演・", "主演：", "脚本：", "asia-drama")):
        return "ドラマ"
    if any(k in blob for k in ("バラエティ", "お笑い", "芸人", "マツコ", "村上信五", "調査した件", "ドッキリ", "クイズ", "グルメ", "旅番組")):
        return "バラエティ"
    if any(k in blob for k in ("報道", "討論", "激論", "パネラー", "ドキュメンタリー", "密着", "ワイドショー", "情報番組", "政界", "選挙", "abema-news")):
        return "報道・情報"
    if any(k in blob for k in ("ミュージック", "音楽番組", "歌謡", "ライブ映像", "hiphop", "k-pop")):
        return "音楽"
    if any(k in blob for k in ("プロ野球", "MLB", "サッカー", "Jリーグ", "W杯", "格闘技", "プロレス", "ゴルフ", "競馬", "相撲", "fighting-sports", "world-sports")):
        return "スポーツ"
    if any(k in head for k in ("映画", "劇場版")):
        return "映画"
    # 3) 最終フォールバック: アニメ・バラエティ等の手がかりが無い「第N話」形式はドラマ扱い
    if re.search(r"第[一二三四五六七八九十百0-9]+話", title):
        return "ドラマ"
    return "その他"


def _throttle_meta_fetch(min_interval=0.2):
    """初回メタデータ取得時の連続リクエストを抑えるための控えめな間隔制御"""
    global _LAST_META_FETCH_AT
    with _META_FETCH_LOCK:
        now = time.time()
        wait = (_LAST_META_FETCH_AT + min_interval) - now
        if wait > 0:
            time.sleep(wait)
        _LAST_META_FETCH_AT = time.time()


def _extract_tver_ep_id(ep_id, raw_url=""):
    s = str(ep_id or "").strip()
    if re.match(r"^ep[a-z0-9]{6,}$", s, re.I):
        return s
    m = re.search(r"tver\.jp/episodes/(ep[a-z0-9]{6,})", str(raw_url or ""), re.I)
    return m.group(1) if m else ""


def _extract_abema_vod_ep_id(ep_id, raw_url=""):
    m = re.search(r"abema\.tv/video/episode/([A-Za-z0-9_-]{6,40})", str(raw_url or ""), re.I)
    if m:
        return m.group(1)
    s = str(ep_id or "").strip()
    if re.match(r"^\d+-\d+(?:_s\d+)?_p\d+", s, re.I):
        return s
    return ""


def _fetch_tver_static_meta(ep_id, raw_url=""):
    """TVer エピソード URL / ID (ep...) から公開静的 JSON で放送局・シリーズ名・あらすじ・公式サムネを初回 1 回だけ補完する"""
    target_id = _extract_tver_ep_id(ep_id, raw_url)
    if not target_id:
        return {}
    _throttle_meta_fetch(0.2)
    url = f"https://statics.tver.jp/content/episode/{target_id}.json"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=3.0) as r:
            d = json.loads(r.read().decode("utf-8", errors="replace"))
        bc = d.get("broadcastProviderLabel") or d.get("broadcasterName") or ""
        desc = d.get("description") or ""
        series_title = ""
        series_desc = ""
        sid = d.get("seriesID") or ""
        if sid:
            try:
                sreq = urllib.request.Request(f"https://statics.tver.jp/content/series/{sid}.json", headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(sreq, timeout=2.5) as sr:
                    sd = json.loads(sr.read().decode("utf-8", errors="replace"))
                series_title = str(sd.get("title") or "").strip()
                series_desc = str(sd.get("description") or "").strip()
                if not bc and isinstance(sd.get("broadcastProvider"), dict):
                    bc = sd["broadcastProvider"].get("name") or ""
            except Exception:
                pass
        return {
            "broadcaster": str(bc).strip(),
            "series": series_title,
            "description": str(desc or series_desc).strip(),
            "seriesDescription": series_desc,
            "thumbnail": f"https://statics.tver.jp/images/content/thumbnail/episode/xlarge/{target_id}.jpg",
        }
    except Exception:
        return {}


def _fetch_abema_vod_static_meta(ep_id, raw_url=""):
    """ABEMA VOD の元 URL / エピソード ID から公式 API を初回 1 回だけ参照し公式ジャンル・シリーズ・あらすじを取得する"""
    target_id = _extract_abema_vod_ep_id(ep_id, raw_url)
    if not target_id or yd is None:
        return {}
    _throttle_meta_fetch(0.2)
    try:
        if not yd.YDL_READY_EVENT.is_set() or yd.yt_dlp is None:
            yd.warmup_ytdlp()
        with yd.YDL_LOCK:
            yd.ABEMA_IE._get_device_token()
            p = yd.ABEMA_IE._call_api(f"v1/video/programs/{target_id}", f"meta_{target_id}", note=False)
        if not isinstance(p, dict) or not p.get("id"):
            return {}
        g_obj = p.get("genre") or {}
        g_raw = str(g_obj.get("name") or g_obj.get("id") or "").strip()
        ser_obj = p.get("series") or {}
        ep_obj = p.get("episode") or {}
        prov_obj = p.get("providedInfo") or {}
        thumb_img = str(prov_obj.get("thumbImg") or "thumb001").strip()
        thumb_url = f"https://image.p-c2-x.abema-tv.com/image/programs/{target_id}/{thumb_img}.png?height=270&width=480"
        return {
            "genre": g_raw,
            "series": str(ser_obj.get("title") or "").strip(),
            "title": str(ep_obj.get("title") or "").strip(),
            "description": str(ep_obj.get("content") or ser_obj.get("content") or "").strip(),
            "broadcaster": f"ABEMA {g_raw}" if g_raw else "ABEMA",
            "thumbnail": thumb_url,
        }
    except Exception:
        return {}


def _load_or_build_item(abs_path, base_dir):
    fid = _file_id(abs_path)
    st = os.stat(abs_path)
    mtime_ms = int(st.st_mtime * 1000)
    size_bytes = int(st.st_size)

    cache_path = os.path.join(META_CACHE_DIR, f"{fid}.json")
    if os.path.isfile(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                cached = json.load(f)
            if (
                cached.get("metaVersion") == META_CACHE_VERSION
                and cached.get("sizeBytes") == size_bytes
                and cached.get("mtimeMs") == mtime_ms
                and cached.get("absPath") == abs_path
                and int(cached.get("durationSec") or 0) > 0
                and bool(cached.get("vcodec"))
            ):
                return cached
        except Exception:
            pass

    fn_meta = _parse_filename_meta(abs_path, base_dir)
    probe = _ffprobe_file(abs_path)
    tags = probe["tags"]

    # 隣に .info.json があれば優先利用
    sidecar = {}
    info_json_path = os.path.splitext(abs_path)[0] + ".info.json"
    if os.path.isfile(info_json_path):
        try:
            with open(info_json_path, "r", encoding="utf-8") as f:
                sidecar = json.load(f)
        except Exception:
            sidecar = {}

    hint = dict(EPISODE_META_HINTS.get(fn_meta["episodeId"], {})) if fn_meta["episodeId"] else {}
    # ABEMA 予約履歴に一致する録画情報があればジャンル・あらすじ・チャンネル名を補完
    if not hint and fn_meta["episodeId"]:
        with ABEMA_RESERVES_LOCK:
            for r in ABEMA_RESERVES.values():
                if str(r.get("channelId") or "") == fn_meta["episodeId"] and str(r.get("title") or "") and str(r.get("title") or "") in os.path.basename(abs_path):
                    hint = {
                        "title": r.get("title") or "",
                        "series": r.get("series") or "",
                        "genre": r.get("genre") or "",
                        "broadcaster": r.get("channelName") or "ABEMA",
                        "provider": "ABEMA",
                        "thumbnail": r.get("thumbnail") or "",
                        "description": r.get("description") or "",
                    }
                    break

    # MP4 メタデータ内の元 URL / エピソード ID から初回 1 回だけ公式情報を補完する
    # (結果はディスクキャッシュに永続化されるため、2 回目以降は外部リクエスト 0 回)
    raw_comment = str(tags.get("comment") or "").strip()
    source_url = hint.get("url") or (raw_comment if (raw_comment.startswith("http://") or raw_comment.startswith("https://")) else "")

    tver_static = {}
    raw_bc_pre = (
        hint.get("broadcaster")
        or sidecar.get("channel")
        or sidecar.get("uploader")
        or tags.get("network")
        or tags.get("artist")
        or ""
    )
    raw_series_pre = hint.get("series") or sidecar.get("series") or tags.get("show") or tags.get("album") or ""
    raw_desc_pre = hint.get("description") or sidecar.get("description") or tags.get("description") or tags.get("synopsis") or ""
    if _extract_tver_ep_id(fn_meta["episodeId"], source_url) and (not raw_bc_pre or not raw_series_pre or not raw_desc_pre):
        tver_static = _fetch_tver_static_meta(fn_meta["episodeId"], source_url)

    abema_static = {}
    raw_genre_pre = hint.get("genre") or sidecar.get("genre") or tags.get("genre") or ""
    if not raw_genre_pre and _extract_abema_vod_ep_id(fn_meta["episodeId"], source_url):
        abema_static = _fetch_abema_vod_static_meta(fn_meta["episodeId"], source_url)

    title = (
        hint.get("title")
        or sidecar.get("title")
        or tags.get("title")
        or abema_static.get("title")
        or fn_meta["title"]
    )
    series = (
        hint.get("series")
        or abema_static.get("series")
        or tver_static.get("series")
        or sidecar.get("series")
        or tags.get("show")
        or tags.get("album")
        or fn_meta["series"]
    )
    prov_blob = " ".join([
        str(sidecar.get("extractor_key") or ""),
        str(tags.get("artist") or ""),
        str(tags.get("network") or ""),
        str(tags.get("comment") or ""),
    ]).lower()
    provider = (
        hint.get("provider")
        or ("TVER" if "tver" in prov_blob else "")
        or ("ABEMA" if "abema" in prov_blob else "")
        or fn_meta["provider"]
    )
    broadcaster = _normalize_broadcaster(
        hint.get("broadcaster")
        or abema_static.get("broadcaster")
        or tver_static.get("broadcaster")
        or sidecar.get("channel")
        or sidecar.get("uploader")
        or tags.get("network")
        or tags.get("artist")
        or ("ABEMA" if provider == "ABEMA" else ""),
        fallback="その他",
    )
    comment_desc = "" if (raw_comment.startswith("http://") or raw_comment.startswith("https://")) else raw_comment
    description = (
        hint.get("description")
        or abema_static.get("description")
        or sidecar.get("description")
        or tags.get("description")
        or tags.get("synopsis")
        or comment_desc
        or tver_static.get("description")
        or ""
    )
    genre = _infer_genre(
        raw_genre_pre or abema_static.get("genre") or "",
        provider,
        series,
        title,
        description + " " + (tver_static.get("seriesDescription") or "") + " " + fn_meta["episodeId"] + " " + broadcaster,
    )

    # ヒントまたは初回公式メタデータのサムネイル URL があればローカル未保存時のみ取得
    hint_thumb = _unwrap_proxy_url(
        hint.get("thumbnail")
        or sidecar.get("thumbnail")
        or abema_static.get("thumbnail")
        or tver_static.get("thumbnail")
        or ""
    )
    thumb_file = os.path.join(THUMB_CACHE_DIR, f"{fid}.jpg")
    if hint_thumb and not os.path.isfile(thumb_file):
        try:
            req = urllib.request.Request(hint_thumb, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as r:
                raw_img = r.read()
            if raw_img and len(raw_img) > 1000:
                with open(thumb_file, "wb") as tf:
                    tf.write(raw_img)
        except Exception:
            pass

    item = {
        "metaVersion": META_CACHE_VERSION,
        "id": fid,
        "absPath": abs_path,
        "fileName": os.path.basename(abs_path),
        "ext": os.path.splitext(abs_path)[1].lower(),
        "episodeId": fn_meta["episodeId"],
        "provider": provider,
        "genre": genre,
        "series": series,
        "title": title,
        "broadcaster": broadcaster,
        "description": description[:600],
        "durationSec": probe["durationSec"],
        "width": probe["width"],
        "height": probe["height"],
        "vcodec": probe["vcodec"],
        "acodec": probe["acodec"],
        "hasAttachedPic": probe["hasAttachedPic"],
        "sizeBytes": size_bytes,
        "sizeLabel": _format_bytes(size_bytes),
        "mtimeMs": mtime_ms,
    }
    # ffprobe 失敗 (durationSec==0) の不完全データはキャッシュ保存しない (次回スキャンで自動復旧)
    if probe["durationSec"] > 0 and probe["vcodec"]:
        try:
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump(item, f, ensure_ascii=False)
        except Exception:
            pass
    return item


def _prune_orphan_caches_safe(valid_ids):
    """
    暴走防止ガード付きの孤立キャッシュ (.dtvplus_cache/meta, thumbs) 自動掃除。
    - 保存先ドライブ未マウント時や異常0件時は絶対に実行しない
    - 動画ファイル本体には一切触れず、16桁hexのキャッシュJSON/JPGのみを対象とする
    """
    global LAST_ORPHAN_PRUNE_AT
    if not os.path.isdir(PRIMARY_SAVE_DIR):
        return
    try:
        meta_files = [fn for fn in os.listdir(META_CACHE_DIR) if re.match(r"^[0-9a-f]{16}\.json$", fn)] if os.path.isdir(META_CACHE_DIR) else []
        # ドライブ瞬断等で一時的に 0 件になった場合の誤削除を防止
        if len(valid_ids) == 0 and len(meta_files) >= 3:
            return
        for cdir, ext in ((META_CACHE_DIR, ".json"), (THUMB_CACHE_DIR, ".jpg")):
            if not os.path.isdir(cdir):
                continue
            pat = re.compile(r"^[0-9a-f]{16}" + re.escape(ext) + r"$")
            for fn in os.listdir(cdir):
                if not pat.match(fn):
                    continue
                if fn[:-len(ext)] not in valid_ids:
                    try:
                        os.remove(os.path.join(cdir, fn))
                    except Exception:
                        pass
        LAST_ORPHAN_PRUNE_AT = time.time()
    except Exception:
        pass


def scan_library(force=False):
    global ITEMS_BY_ID, ITEMS_LIST, LAST_SCAN_AT
    now = time.time()
    if not force and (now - LAST_SCAN_AT) < 5.0 and ITEMS_LIST:
        return ITEMS_LIST

    prev_count = len(ITEMS_LIST)
    found = []
    by_id = {}
    for base_dir in SAVE_DIRS:
        if not os.path.isdir(base_dir):
            continue
        for dp, dns, fns in os.walk(base_dir):
            # キャッシュ・隠しフォルダをスキップ
            dns[:] = [d for d in dns if not d.startswith(".")]
            for fn in fns:
                if fn.startswith(".") or fn.endswith(".part") or fn.endswith(".ytdl"):
                    continue
                # yt-dlp の結合前の一時分離トラック (.fhls-xxx.mp4 等) はスキャン除外
                if re.search(r"\.f(?:hls-|dash-|\d+)[^.]*\.(?:mp4|m4a|webm|ts)$", fn, re.I):
                    continue
                ext = os.path.splitext(fn)[1].lower()
                if ext not in VIDEO_EXTS:
                    continue
                full = os.path.abspath(os.path.join(dp, fn))
                try:
                    item = _load_or_build_item(full, base_dir)
                    by_id[item["id"]] = item
                    found.append(item)
                except Exception:
                    continue

    found.sort(key=lambda x: x.get("mtimeMs", 0), reverse=True)
    with ITEMS_LOCK:
        ITEMS_BY_ID = by_id
        ITEMS_LIST = found
        LAST_SCAN_AT = time.time()

    # 動画数が減った直後、または 1 時間おきに孤立キャッシュのみ安全に自動掃除
    if (len(found) < prev_count) or (time.time() - LAST_ORPHAN_PRUNE_AT > 3600.0):
        _prune_orphan_caches_safe(set(by_id.keys()))
    return found


def ensure_thumbnail(item):
    """サムネイル JPEG を確保してパスを返す (既存キャッシュ -> 内蔵カバーアート -> ffmpeg フレーム切り出し)"""
    fid = item["id"]
    thumb_path = os.path.join(THUMB_CACHE_DIR, f"{fid}.jpg")
    if os.path.isfile(thumb_path) and os.path.getsize(thumb_path) > 500:
        return thumb_path

    abs_path = item["absPath"]
    if not os.path.isfile(abs_path):
        return None

    # 1) MP4 内蔵カバーアートがあれば抽出
    if item.get("hasAttachedPic"):
        try:
            proc = subprocess.run(
                [FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error", "-i", abs_path, "-an", "-vcodec", "mjpeg", "-frames:v", "1", thumb_path],
                capture_output=True,
                timeout=10,
                creationflags=0x08000000 if os.name == "nt" else 0,
            )
            if proc.returncode == 0 and os.path.isfile(thumb_path) and os.path.getsize(thumb_path) > 500:
                return thumb_path
        except Exception:
            pass

    # 2) 本編の途中フレーム (開始15% または最大180秒地点) を高速シーク切り出し
    dur = int(item.get("durationSec") or 0)
    seek_sec = max(5, min(180, int(dur * 0.15))) if dur > 30 else 3
    try:
        proc = subprocess.run(
            [
                FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error",
                "-ss", str(seek_sec),
                "-i", abs_path,
                "-frames:v", "1",
                "-vf", "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2",
                "-q:v", "4",
                thumb_path,
            ],
            capture_output=True,
            timeout=15,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        if proc.returncode == 0 and os.path.isfile(thumb_path) and os.path.getsize(thumb_path) > 500:
            return thumb_path
    except Exception:
        pass
    return None


def cleanup_storage(clear_finished_jobs=True):
    """
    一時ファイルの残骸・孤立キャッシュ・終了済みジョブ履歴を安全にクリーンアップする。
    - 実行中/待機中のジョブ作業フォルダは絶対に保護する
    - 保存済みの動画本体 (.mp4 等) は一切削除しない (0バイト・.part・.ytdl の残骸のみ対象)
    """
    removed_files = 0
    freed_bytes = 0
    cleared_jobs = 0

    with JOBS_LOCK:
        active_job_ids = {jid for jid, j in JOBS.items() if j.get("status") in ("queued", "downloading")}
        has_active = len(active_job_ids) > 0

    # 1) .dtvplus_cache/tmp 内の未使用一時ファイル・フォルダを全削除
    if os.path.isdir(TEMP_WORK_DIR):
        for entry in os.listdir(TEMP_WORK_DIR):
            if entry in active_job_ids:
                continue
            full = os.path.join(TEMP_WORK_DIR, entry)
            try:
                if os.path.isdir(full):
                    for dp, _, fns in os.walk(full):
                        for fn in fns:
                            fp = os.path.join(dp, fn)
                            try:
                                freed_bytes += os.path.getsize(fp)
                                removed_files += 1
                            except Exception:
                                pass
                    shutil.rmtree(full, ignore_errors=True)
                elif os.path.isfile(full):
                    if has_active:
                        continue
                    freed_bytes += os.path.getsize(full)
                    os.remove(full)
                    removed_files += 1
            except Exception:
                pass

    # 2) 保存先フォルダ直下に残った .part / .ytdl / 結合前分離ファイル / 0バイト残骸を掃除 (実行中ジョブが無いときのみ)
    if not has_active:
        for base_dir in SAVE_DIRS:
            if not os.path.isdir(base_dir):
                continue
            for fn in os.listdir(base_dir):
                if fn.startswith("."):
                    continue
                fp = os.path.join(base_dir, fn)
                if not os.path.isfile(fp):
                    continue
                is_junk = (
                    fn.endswith(".part")
                    or fn.endswith(".ytdl")
                    or bool(re.search(r"\.f(?:hls-|dash-|\d+)[^.]*\.(?:mp4|m4a|webm|ts)$", fn, re.I))
                    or (os.path.splitext(fn)[1].lower() in VIDEO_EXTS and os.path.getsize(fp) == 0)
                )
                if is_junk:
                    try:
                        freed_bytes += os.path.getsize(fp)
                        os.remove(fp)
                        removed_files += 1
                    except Exception:
                        pass

    # 3) 元動画が PC 側で削除済みの孤立メタデータ (.json) と孤立サムネ (.jpg) を掃除
    valid_items = scan_library(force=True)
    valid_ids = {it["id"] for it in valid_items}
    for cdir, ext in ((META_CACHE_DIR, ".json"), (THUMB_CACHE_DIR, ".jpg")):
        if not os.path.isdir(cdir):
            continue
        for fn in os.listdir(cdir):
            if not fn.endswith(ext):
                continue
            stem = fn[:-len(ext)]
            if stem not in valid_ids:
                fp = os.path.join(cdir, fn)
                try:
                    freed_bytes += os.path.getsize(fp)
                    os.remove(fp)
                    removed_files += 1
                except Exception:
                    pass

    # 4) 終了済み (done / error / cancelled) のジョブ履歴をクリア
    if clear_finished_jobs:
        with JOBS_LOCK:
            keep_order = []
            for jid in JOB_ORDER:
                j = JOBS.get(jid)
                if j and j.get("status") in ("queued", "downloading"):
                    keep_order.append(jid)
                else:
                    if jid in JOBS:
                        del JOBS[jid]
                        cleared_jobs += 1
            JOB_ORDER[:] = keep_order

    return {
        "ok": True,
        "removedFiles": removed_files,
        "freedBytes": freed_bytes,
        "freedLabel": _format_bytes(freed_bytes),
        "clearedJobs": cleared_jobs,
        "itemCount": len(valid_items),
    }


def _resolve_console_python():
    """pythonw.exe 起動時でも子プロセスの stdout を確実に取得するため python.exe を優先解決する"""
    exe = sys.executable
    if exe.lower().endswith("pythonw.exe"):
        cand = exe[:-11] + "python.exe"
        if os.path.isfile(cand):
            return cand
    return exe


def _parse_hms_sec(hms_str):
    try:
        parts = hms_str.split(":")
        return float(parts[0]) * 3600.0 + float(parts[1]) * 60.0 + float(parts[2])
    except Exception:
        return 0.0


def _sanitize_filename(name):
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", str(name or "")).strip()
    s = re.sub(r"\s{2,}", " ", s)
    return (s[:110].strip() if s else "live_recording")


def _decrypt_aes128_cbc(data, key, iv):
    """Windows でも確実に動く AES-128-CBC (PKCS#7 unpad) 復号 (pycryptodomex 優先)"""
    try:
        from Cryptodome.Cipher import AES
        cipher = AES.new(key, AES.MODE_CBC, iv)
        dec = cipher.decrypt(data)
        if dec:
            pad = dec[-1]
            if 1 <= pad <= 16 and dec[-pad:] == bytes([pad]) * pad:
                dec = dec[:-pad]
        return dec
    except Exception:
        if yd is not None:
            return yd.decrypt_aes_128_cbc(data, key, iv)
        raise


def _read_mp4_header_dims(mp4_path):
    """MP4 の avc1 / tkhd ボックスから Windows 等が参照するコンテナ解像度 (width, height) を読み取る"""
    avc_h = 0
    tkhd_h = 0
    try:
        with open(mp4_path, "rb") as f:
            head = f.read(4 * 1024 * 1024)
        p = 0
        while True:
            idx = head.find(b"avc1", p)
            if idx == -1 or idx + 32 > len(head):
                break
            w, h = struct.unpack(">HH", head[idx + 28 : idx + 32])
            if 100 <= w <= 7680 and 100 <= h <= 4320:
                avc_h = max(avc_h, h)
            p = idx + 4
        p = 0
        while True:
            idx = head.find(b"tkhd", p)
            if idx == -1 or idx + 100 > len(head):
                break
            ver = head[idx + 4]
            off = (idx + 80) if ver == 0 else (idx + 92)
            if off + 8 <= len(head):
                wf, hf = struct.unpack(">II", head[off : off + 8])
                w, h = wf >> 16, hf >> 16
                if 100 <= w <= 7680 and 100 <= h <= 4320:
                    tkhd_h = max(tkhd_h, h)
            p = idx + 4
    except Exception:
        pass
    return avc_h, tkhd_h


def _extract_mp4_metadata_args(mp4_path):
    """既存 MP4 のタグ (title/show/album/artist/network/genre/description/synopsis/comment) を引き継ぐ"""
    args = []
    try:
        pr = subprocess.run(
            [FFPROBE_BIN, "-v", "error", "-show_entries", "format_tags", "-of", "json", mp4_path],
            capture_output=True,
            timeout=10,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        if pr.returncode == 0:
            tags = (json.loads(pr.stdout.decode("utf-8", errors="replace")).get("format") or {}).get("tags") or {}
            low_tags = {str(k).lower(): str(v) for k, v in tags.items() if v is not None}
            for k in ("title", "show", "album", "artist", "network", "genre", "description", "synopsis", "comment"):
                val = low_tags.get(k)
                if val:
                    args.extend(["-metadata", f"{k}={val}"])
    except Exception:
        pass
    return args


class _TsAdtsSampleRateFixer:
    """
    MPEG-TS 内の音声 PES ストリームを ADTS フレーム長単位で厳密に辿り、
    圧縮音声データ本体には一切触れず ADTS ヘッダの sampling_frequency_index だけを無劣化訂正する。
    (冒頭 48kHz バンパー由来のヘッダ誤認による 44.1kHz 本編の漸進音ズレを根絶)
    """

    def __init__(self, target_sr_idx):
        self.target_sr_idx = int(target_sr_idx) & 0x0F
        self.rem = b""
        self.aud_pids = set()
        # ADTS 状態機械: payload_rem > 0 は圧縮データ通過中、0 は 7B ヘッダ収集中
        self.payload_rem = 0
        self.hdr_pos = 0
        self.hdr_buf = bytearray(7)
        self.patched_count = 0

    def process_chunk(self, chunk):
        if not chunk:
            return b""
        data = self.rem + chunk
        usable = (len(data) // 188) * 188
        self.rem = data[usable:]
        if usable == 0:
            return b""
        b = bytearray(data[:usable])
        for i in range(0, usable, 188):
            if b[i] != 0x47:
                continue
            pid = ((b[i + 1] & 0x1F) << 8) | b[i + 2]
            pusi = (b[i + 1] & 0x40) != 0
            afc = (b[i + 3] >> 4) & 0x03
            if afc not in (1, 3):
                continue
            off = i + 4 + (1 + b[i + 4] if afc == 3 else 0)
            end = i + 188
            if off >= end:
                continue
            if pusi and off + 9 <= end and b[off] == 0 and b[off + 1] == 0 and b[off + 2] == 1:
                sid = b[off + 3]
                if 0xC0 <= sid <= 0xDF:
                    self.aud_pids.add(pid)
                    off = off + 9 + b[off + 8]
                    self.payload_rem = 0
                    self.hdr_pos = 0
                else:
                    continue
            if pid not in self.aud_pids or off >= end:
                continue

            p = off
            while p < end:
                if self.payload_rem > 0:
                    skip = min(self.payload_rem, end - p)
                    self.payload_rem -= skip
                    p += skip
                    continue
                # ADTS 7バイトヘッダを収集中 (同期語 0xFF 0xF? を厳密検証)
                cur = b[p]
                if self.hdr_pos == 0:
                    if cur != 0xFF:
                        p += 1
                        continue
                    self.hdr_buf[0] = cur
                    self.hdr_pos = 1
                    p += 1
                    continue
                if self.hdr_pos == 1:
                    if (cur & 0xF6) != 0xF0:
                        self.hdr_pos = 1 if cur == 0xFF else 0
                        p += 1
                        continue
                    self.hdr_buf[1] = cur
                    self.hdr_pos = 2
                    p += 1
                    continue
                if self.hdr_pos == 2:
                    # 3バイト目の bit5..2 が sampling_frequency_index -> 対象レートへ訂正
                    new_b2 = (cur & 0xC3) | (self.target_sr_idx << 2)
                    b[p] = new_b2
                    self.hdr_buf[2] = new_b2
                    self.hdr_pos = 3
                    self.patched_count += 1
                    p += 1
                    continue
                self.hdr_buf[self.hdr_pos] = cur
                self.hdr_pos += 1
                p += 1
                if self.hdr_pos == 7:
                    frame_len = ((self.hdr_buf[3] & 0x03) << 11) | (self.hdr_buf[4] << 3) | ((self.hdr_buf[5] >> 5) & 0x07)
                    self.hdr_pos = 0
                    self.payload_rem = max(0, frame_len - 7) if frame_len >= 7 else 0
        return bytes(b)


def _measure_mid_audio_real_sr(mp4_path, total_dur):
    """
    動画の中盤 (全尺の 35% 付近) の連続した音声パケット約 150 個から、
    CM ギャップの影響を受けない純粋な 1 フレームあたりの実時間間隔 -> 真のサンプルレートを実測する。
    (正当な 48kHz ニュース/将棋番組での誤判定を 0% にする安全装置)
    """
    try:
        mid_t = max(10.0, total_dur * 0.35) if total_dur > 40.0 else 5.0
        pr = subprocess.run(
            [
                FFPROBE_BIN, "-v", "error", "-select_streams", "a:0",
                "-read_intervals", f"{mid_t:.2f}%+5",
                "-show_packets", "-show_entries", "packet=pts_time",
                "-of", "csv=p=0", mp4_path,
            ],
            capture_output=True,
            timeout=15,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        if pr.returncode != 0:
            return 0.0
        pts = []
        for l in pr.stdout.decode("utf-8", errors="replace").splitlines():
            s = l.strip().split(",")[0]
            if not s or s == "N/A":
                continue
            try:
                pts.append(float(s))
            except Exception:
                continue
        if len(pts) < 40:
            return 0.0
        # 大きなギャップ (>0.2s: CMスキップ境界等) を除いた連続区間ごとの平均フレーム間隔を集計
        deltas = []
        for i in range(1, len(pts)):
            dt = pts[i] - pts[i - 1]
            if 0.005 <= dt <= 0.15:
                deltas.append(dt)
        if len(deltas) < 30:
            return 0.0
        avg_dt = sum(deltas) / len(deltas)
        if avg_dt <= 0:
            return 0.0
        return 1024.0 / avg_dt
    except Exception:
        return 0.0


def _fix_mp4_leading_resolution_if_needed(mp4_path, work_dir, trim_tail=False, metadata_args=None):
    """
    ABEMA ライブ録画・保存完了ファイルの後処理 (無劣化):
    1) フロント自動カット: 冒頭 60 秒以内に 720p バンパー -> 1080p 本編の切替があれば 1080p 開始点からトリム
    2) リア自動カット (trim_tail=True): 末尾 180 秒以内に 1080p 本編 -> 720p 待機画面/バンパーへ落ちる地点があればそこで終了カット
    3) 音声サンプルレート矛盾の自動訂正: 冒頭 48kHz バンパー等で 44.1kHz 本編が 48kHz 扱いになり
       再生中に漸進音ズレする問題を、ADTS ヘッダのサンプルレート訂正のみで完全無劣化修復
    4) コンテナヘッダ再構築: MP4 -> MPEG-TS パイプ -> MP4 の完全無劣化リマックスにより、
       Windows 等が参照する avc1 / avcC / tkhd / mp4a ボックスを純粋な本編仕様で再生成する。
    """
    try:
        pr = subprocess.run(
            [
                FFPROBE_BIN, "-v", "error",
                "-show_entries", "stream=codec_type,codec_name,width,height,sample_rate,nb_frames,duration:format=duration",
                "-of", "json", mp4_path,
            ],
            capture_output=True,
            timeout=12,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        if pr.returncode != 0:
            return mp4_path
        info = json.loads(pr.stdout.decode("utf-8", errors="replace"))
        streams = info.get("streams") or []
        v_st = next((s for s in streams if s.get("codec_type") == "video"), {})
        a_st = next((s for s in streams if s.get("codec_type") == "audio"), {})
        cur_h = int(v_st.get("height") or 0)
        total_dur = float((info.get("format") or {}).get("duration") or 0.0)
        if cur_h <= 0:
            return mp4_path

        # 音声サンプルレート矛盾チェック (全体フレーム密度 + 中盤連続パケット実測の 2重一致でのみ発火し誤爆を完全防止)
        target_adts_sr_idx = None
        if a_st.get("codec_name") == "aac":
            a_sr = int(a_st.get("sample_rate") or 0)
            a_frames = int(a_st.get("nb_frames") or 0)
            a_dur = float(a_st.get("duration") or total_dur or 0.0)
            if a_frames > 200 and a_dur > 15.0:
                inferred_sr = (a_frames * 1024.0) / a_dur
                if a_sr == 48000 and 42500.0 <= inferred_sr <= 45500.0:
                    mid_sr = _measure_mid_audio_real_sr(mp4_path, total_dur)
                    if 43300.0 <= mid_sr <= 44900.0:
                        target_adts_sr_idx = 4  # 44100 Hz 確定
                elif a_sr == 44100 and 46500.0 <= inferred_sr <= 49500.0:
                    mid_sr = _measure_mid_audio_real_sr(mp4_path, total_dur)
                    if 47200.0 <= mid_sr <= 48800.0:
                        target_adts_sr_idx = 3  # 48000 Hz 確定

        avc_h, tkhd_h = _read_mp4_header_dims(mp4_path)
        header_is_sub_fhd = (avc_h > 0 and avc_h < 1000) or (tkhd_h > 0 and tkhd_h < 1000)

        trim_start = 0.0
        has_fhd_main = (cur_h >= 1000)

        # 1) フロント検査: 先頭が 1080p 未満なら冒頭 60 秒から 1080p 開始点を検出
        if cur_h < 1000:
            pr2 = subprocess.run(
                [
                    FFPROBE_BIN, "-v", "error", "-select_streams", "v:0",
                    "-read_intervals", "0%+60",
                    "-show_frames", "-show_entries", "frame=pts_time,width,height",
                    "-of", "csv=p=0", mp4_path,
                ],
                capture_output=True,
                timeout=25,
                creationflags=0x08000000 if os.name == "nt" else 0,
            )
            if pr2.returncode == 0:
                for line in pr2.stdout.decode("utf-8", errors="replace").splitlines():
                    parts = [p.strip() for p in line.split(",")]
                    if len(parts) >= 3:
                        try:
                            t = float(parts[0])
                            h = int(parts[2])
                        except Exception:
                            continue
                        if h >= 1000 and t <= 55.0:
                            has_fhd_main = True
                            if t > 0.1:
                                trim_start = t + 0.002
                            break

        # 2) リア検査 (予約/ライブ録画時): 末尾 120 秒以内に 1080p -> 720p が 3 秒以上連続するバンパーがあればそこでカット
        trim_end = None
        if has_fhd_main and trim_tail and total_dur > 240.0:
            tail_from = max(trim_start + 60.0, total_dur - 120.0)
            pr_tail = subprocess.run(
                [
                    FFPROBE_BIN, "-v", "error", "-select_streams", "v:0",
                    "-read_intervals", f"{tail_from:.2f}%+140",
                    "-show_frames", "-show_entries", "frame=pts_time,width,height",
                    "-of", "csv=p=0", mp4_path,
                ],
                capture_output=True,
                timeout=35,
                creationflags=0x08000000 if os.name == "nt" else 0,
            )
            if pr_tail.returncode == 0:
                seen_fhd_in_tail = False
                low_res_start = None
                for line in pr_tail.stdout.decode("utf-8", errors="replace").splitlines():
                    parts = [p.strip() for p in line.split(",")]
                    if len(parts) >= 3:
                        try:
                            t = float(parts[0])
                            h = int(parts[2])
                        except Exception:
                            continue
                        if h >= 1000:
                            seen_fhd_in_tail = True
                            low_res_start = None
                        elif seen_fhd_in_tail and h > 0 and h < 1000:
                            if low_res_start is None:
                                low_res_start = t
                            elif (t - low_res_start) >= 3.0:
                                trim_end = max(trim_start + 10.0, low_res_start - 0.05)
                                break
                # ファイル末尾まで 720p が続いて終了した場合 (残り 1秒以上) もカット対象
                if trim_end is None and low_res_start is not None and (total_dur - low_res_start) >= 1.5:
                    trim_end = max(trim_start + 10.0, low_res_start - 0.05)

        needs_remux = (
            (has_fhd_main and ((trim_start > 0.0) or (trim_end is not None) or header_is_sub_fhd))
            or (target_adts_sr_idx is not None)
        )
        if not needs_remux:
            return mp4_path

        fixed_mp4 = os.path.join(work_dir, "recording_1080_fixed.mp4")
        meta_args = list(metadata_args) if metadata_args else _extract_mp4_metadata_args(mp4_path)

        cmd1 = [FFMPEG_BIN, "-hide_banner", "-loglevel", "error"]
        if trim_start > 0.0:
            cmd1.extend(["-ss", f"{trim_start:.3f}"])
        cmd1.extend(["-i", mp4_path])
        if trim_end is not None:
            dur_len = max(10.0, trim_end - trim_start)
            cmd1.extend(["-t", f"{dur_len:.3f}"])
        cmd1.extend(["-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-f", "mpegts", "pipe:1"])

        cmd2 = [
            FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error",
            "-fflags", "+genpts",
            "-f", "mpegts", "-i", "pipe:0",
            "-map", "0:v:0", "-map", "0:a:0?",
            "-c", "copy",
            "-bsf:a", "aac_adtstoasc",
            "-movflags", "+faststart",
        ] + meta_args + ["-f", "mp4", fixed_mp4]

        cflag = 0x08000000 if os.name == "nt" else 0
        if target_adts_sr_idx is not None:
            # ストリーミングで ADTS サンプルレートを訂正しながら p1 -> p2 へ無劣化中継
            p1 = subprocess.Popen(cmd1, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0, creationflags=cflag)
            p2 = subprocess.Popen(cmd2, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, bufsize=0, creationflags=cflag)
            fixer = _TsAdtsSampleRateFixer(target_adts_sr_idx)
            try:
                while True:
                    chunk = p1.stdout.read(262144)
                    if not chunk:
                        break
                    out_c = fixer.process_chunk(chunk)
                    if out_c:
                        p2.stdin.write(out_c)
            finally:
                try:
                    p1.stdout.close()
                except Exception:
                    pass
                try:
                    p2.stdin.flush()
                    p2.stdin.close()
                except Exception:
                    pass
            _, err2 = p2.communicate(timeout=180)
            p1.wait(timeout=15)
        else:
            p1 = subprocess.Popen(cmd1, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=cflag)
            p2 = subprocess.Popen(cmd2, stdin=p1.stdout, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, creationflags=cflag)
            p1.stdout.close()
            _, err2 = p2.communicate(timeout=180)
            p1.wait(timeout=15)

        if p2.returncode == 0 and os.path.isfile(fixed_mp4) and os.path.getsize(fixed_mp4) > 32768:
            new_avc_h, new_tkhd_h = _read_mp4_header_dims(fixed_mp4)
            ok_vid = (not has_fhd_main) or ((new_avc_h >= 1000 or new_avc_h == 0) and (new_tkhd_h >= 1000 or new_tkhd_h == 0))
            if ok_vid:
                print(
                    f"[dtvplus-save] Clean MP4 rebuilt (front={trim_start:.2f}s, tail_end={trim_end}, sr_fix={target_adts_sr_idx}, avc1={new_avc_h}, tkhd={new_tkhd_h})",
                    flush=True,
                )
                return fixed_mp4
            try:
                os.remove(fixed_mp4)
            except Exception:
                pass
    except Exception as e:
        print(f"[dtvplus-save] leading/tail/audio fix skipped: {e}", flush=True)
    return mp4_path


def _run_abema_live_save_job(job_id):
    """
    ABEMA ライブ専用録画ワーカー:
    ytdlp_daemon.py の連続 TS 正規化エンジン (AbemaContinuousTSNormalizer + abematv-license 鍵復号)
    をそのまま使い、TVCM (#EXT-X-DISCONTINUITY / 鍵切替) で一切コケずに無劣化 MP4 として保存する。
    - 番組終了時刻 (endAt + 30秒) または ユーザーの録画停止指示で stdin を正常クローズし、
      そこまでに録画した映像を破損のない再生可能 MP4 として保存する。
    """
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job or job["status"] == "cancelled":
            return
        job["status"] = "downloading"
        job["statusText"] = "ABEMA ライブ接続中..."
        job["startedAt"] = int(time.time() * 1000)
        stop_ev = job.get("stopEvent")
        if stop_ev is None:
            stop_ev = threading.Event()
            job["stopEvent"] = stop_ev

    if yd is None:
        with JOBS_LOCK:
            job["status"] = "error"
            job["error"] = "ytdlp_daemon モジュールを読み込めませんでした"
            job["finishedAt"] = int(time.time() * 1000)
        return

    # ABEMA ライセンス鍵取得・スロット解決に必要な yt_dlp を確実にロード済みとする
    if not yd.YDL_READY_EVENT.is_set() or yd.yt_dlp is None:
        yd.warmup_ytdlp()

    url = job["url"]
    m_slug = re.search(r"/now-on-air/([^/?#]+)", url)
    slug = m_slug.group(1) if m_slug else (job.get("episodeId") or "abema-live")

    # 番組終了時刻が未指定なら ABEMA API から現在スロットの終了時刻を自動取得
    end_at_ms = int(job.get("endAt") or 0)
    if end_at_ms <= int(time.time() * 1000):
        try:
            slot = yd.resolve_active_abema_slot(slug)
            if slot and slot.get("endAt"):
                end_at_ms = int(slot["endAt"])
                with JOBS_LOCK:
                    job["endAt"] = end_at_ms
        except Exception:
            pass

    now_ms = int(time.time() * 1000)
    # 終了時刻 + 30秒マージン (不明または3時間超の場合は安全上限 3時間)
    max_dur_sec = 3 * 3600
    if end_at_ms > now_ms + 15000:
        target_end_ts = min(time.time() + max_dur_sec, (end_at_ms / 1000.0) + 30.0)
    else:
        target_end_ts = time.time() + max_dur_sec
    start_ts = time.time()
    planned_dur_sec = max(60.0, target_end_ts - start_ts)

    # マスター M3U8 の解決 (高速直結 -> 失敗時は resolve_stream へフォールバック)
    master_url = f"https://linear-abematv.akamaized.net/channel/{slug}/playlist.m3u8"
    media_url = None
    init_txt = None
    try:
        media_url, init_txt = yd._select_abema_variant_url(master_url)
    except Exception:
        try:
            yd.warmup_ytdlp()
            res = yd.resolve_stream(url)
            raw_u = res.get("hlsFallbackUrl") or res.get("streamUrl") or ""
            if "/api/abema/m3u8?url=" in raw_u:
                q = urllib.parse.parse_qs(urllib.parse.urlparse(raw_u).query)
                master_url = (q.get("url") or [master_url])[0]
            media_url, init_txt = yd._select_abema_variant_url(master_url)
        except Exception as e:
            with JOBS_LOCK:
                job["status"] = "error"
                job["error"] = f"ABEMA ライブ取得失敗: {e}"
                job["finishedAt"] = int(time.time() * 1000)
            return

    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M")
    title_clean = _sanitize_filename(job.get("title") or slug)
    series_clean = str(job.get("series") or job.get("broadcaster") or "ABEMA LIVE").strip()
    final_name = f"{title_clean} {stamp} [{slug}].mp4"
    final_path = os.path.join(PRIMARY_SAVE_DIR, final_name)
    job_tmp_dir = os.path.join(TEMP_WORK_DIR, job_id)
    os.makedirs(job_tmp_dir, exist_ok=True)
    tmp_mp4 = os.path.join(job_tmp_dir, "recording.mp4")

    EPISODE_META_HINTS[slug] = {
        "title": job.get("title") or title_clean,
        "series": series_clean,
        "genre": job.get("genre") or "",
        "broadcaster": job.get("broadcaster") or "ABEMA",
        "provider": "ABEMA",
        "thumbnail": job.get("thumbnail") or "",
        "description": job.get("description") or "",
        "url": url,
    }

    broadcaster_clean = str(job.get("broadcaster") or "ABEMA").strip()
    genre_clean = str(job.get("genre") or "").strip()
    desc_clean = str(job.get("description") or "").strip()[:600]
    live_meta_args = [
        "-metadata", f"title={job.get('title') or title_clean}",
        "-metadata", f"show={series_clean}",
        "-metadata", f"album={series_clean}",
        "-metadata", "artist=ABEMA",
        "-metadata", f"network={broadcaster_clean}",
        "-metadata", f"comment={url}",
    ]
    if genre_clean:
        live_meta_args.extend(["-metadata", f"genre={genre_clean}"])
    if desc_clean:
        live_meta_args.extend(["-metadata", f"description={desc_clean}", "-metadata", f"synopsis={desc_clean}"])

    ffmpeg_cmd = [
        FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error",
        "-fflags", "+genpts+discardcorrupt",
        "-f", "mpegts",
        "-i", "pipe:0",
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c", "copy",
        "-bsf:a", "aac_adtstoasc",
        "-movflags", "+faststart",
    ] + live_meta_args + [
        "-f", "mp4",
        tmp_mp4,
    ]

    proc = None
    fetcher = yd._AbemaKeepAliveFetcher()
    normalizer = yd.AbemaContinuousTSNormalizer()
    bytes_written = 0
    seg_count = 0
    last_err = ""

    try:
        proc = subprocess.Popen(
            ffmpeg_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            bufsize=0,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        with JOBS_LOCK:
            job["proc"] = proc
            job["statusText"] = "ABEMA ライブ録画中..."

        last_seq = -1
        first_round = True
        idle_errors = 0
        skipped_cm_since_last = False
        cm_skipped_count = 0
        cm_skipped_sec = 0.0
        target_slot_id = str(job.get("slotId") or "").strip()
        target_slot_marker = f"/{target_slot_id.lower()}/" if (target_slot_id and not target_slot_id.startswith("rsv_")) else ""
        start_at_sec = (int(job.get("startAt") or 0) / 1000.0) if int(job.get("startAt") or 0) > 0 else 0.0
        end_at_sec = (end_at_ms / 1000.0) if end_at_ms > 0 else 0.0
        # 予約録画で事前接続した場合は、対象番組の slotId セグメントが来るまで前番組/720pバンパーをスキップする
        waiting_target_slot = bool(target_slot_marker and start_at_sec > 0 and time.time() < start_at_sec + 12.0)
        seen_target_slot = False
        ended_by_slot_switch = False

        while not stop_ev.is_set() and not ended_by_slot_switch and time.time() < target_end_ts:
            if proc.poll() is not None:
                break
            try:
                if first_round and init_txt is not None:
                    pl_txt = init_txt
                    init_txt = None
                else:
                    pl_txt = fetcher.get(media_url, timeout=8).decode("utf-8", errors="replace")
                segs = yd._parse_media_playlist_segments(media_url, pl_txt)
                if not segs:
                    stop_ev.wait(0.8)
                    continue

                if first_round:
                    if waiting_target_slot:
                        # 対象 slotId が既に含まれていればその先頭から、未到達なら末尾から待機
                        matched_idx = -1
                        for si, sg0 in enumerate(segs):
                            if target_slot_marker in str(sg0.get("url") or "").lower():
                                matched_idx = si
                                break
                        if matched_idx >= 0:
                            todo = segs[matched_idx:]
                            waiting_target_slot = False
                        else:
                            todo = segs[-1:]
                    else:
                        todo = segs[-3:] if len(segs) >= 3 else segs
                    first_round = False
                else:
                    todo = [sg for sg in segs if sg["seq"] > last_seq]
                    if not todo:
                        if segs[-1]["seq"] + 30 < last_seq:
                            todo = segs[-2:]
                        else:
                            stop_ev.wait(0.6)
                            continue

                idle_errors = 0
                for sg in todo:
                    if stop_ev.is_set() or time.time() >= target_end_ts:
                        break
                    last_seq = sg["seq"]

                    # ABEMA ライブの TVCM セグメント (/tsad/ パス) は取得・書き込み自体をスキップし、
                    # 本編復帰時に PTS を連続接続することで CM カットの無劣化 MP4 を生成する
                    seg_url_low = str(sg.get("url") or "").lower()
                    if waiting_target_slot:
                        # abema-news (/tsnews/) 等、URL に slotId を持たない生放送チャンネルは
                        # 放送開始時刻 (startAt) ちょうどで待機解除し、冒頭取りこぼしを防止する
                        is_slotless_stream = ("/tsnews/" in seg_url_low)
                        if target_slot_marker in seg_url_low:
                            waiting_target_slot = False
                        elif is_slotless_stream:
                            if time.time() >= start_at_sec - 1.0:
                                waiting_target_slot = False
                            else:
                                with JOBS_LOCK:
                                    job["statusText"] = "放送開始時刻まで待機中..."
                                continue
                        elif time.time() < start_at_sec + 15.0:
                            with JOBS_LOCK:
                                job["statusText"] = "番組本編の開始を待機中..."
                            continue
                        else:
                            waiting_target_slot = False

                    is_cm_seg = ("/tsad/" in seg_url_low)
                    if is_cm_seg:
                        skipped_cm_since_last = True
                        cm_skipped_count += 1
                        cm_skipped_sec += float(sg.get("dur") or 5.0)
                        elapsed = max(1.0, time.time() - start_ts)
                        pct = min(99.0, round((elapsed / planned_dur_sec) * 100.0, 1))
                        mb = bytes_written / (1024.0 * 1024.0)
                        with JOBS_LOCK:
                            job["progress"] = pct
                            job["statusText"] = f"CM自動スキップ中 (CM {int(cm_skipped_sec)}秒カット済 / {mb:.1f}MB)"
                        continue

                    # 予約録画のリア自動カット: 対象 slotId を録画中に終了間際 (終了3分前以降) で
                    # 対象外の別スロット / 待機バンパーに切り替わったら即座に本編終了とする
                    if target_slot_marker:
                        if target_slot_marker in seg_url_low:
                            seen_target_slot = True
                        elif seen_target_slot and end_at_sec > 0 and time.time() >= end_at_sec - 180.0:
                            print(f"[dtvplus-save] Target slot ended (switched to non-target segment), finishing cleanly", flush=True)
                            ended_by_slot_switch = True
                            break

                    raw = fetcher.get(sg["url"], timeout=10)
                    if sg["ticket"]:
                        key = yd.get_abema_videokey(sg["ticket"])
                        iv = sg["iv"] if sg["iv"] is not None else sg["seq"].to_bytes(16, "big")
                        raw = _decrypt_aes128_cbc(raw, key, iv)
                    # CM スキップ直後の本編先頭は強制 discontinuity=True にして PTS/PCR を隙間ゼロ接続
                    force_disc = bool(sg["disc"]) or skipped_cm_since_last
                    skipped_cm_since_last = False
                    normalized = normalizer.process_segment(raw, is_discontinuity=force_disc)
                    if normalized:
                        proc.stdin.write(normalized)
                        bytes_written += len(normalized)
                        seg_count += 1
                        elapsed = max(1.0, time.time() - start_ts)
                        pct = min(99.0, round((elapsed / planned_dur_sec) * 100.0, 1))
                        em, es = int(elapsed // 60), int(elapsed % 60)
                        mb = bytes_written / (1024.0 * 1024.0)
                        cm_note = f" / CM {int(cm_skipped_sec)}秒カット" if cm_skipped_count > 0 else ""
                        end_hint = ""
                        if end_at_ms > now_ms:
                            end_dt = datetime.datetime.fromtimestamp(end_at_ms / 1000.0)
                            end_hint = f" (〜{end_dt.strftime('%H:%M')}自動終了)"
                        with JOBS_LOCK:
                            job["progress"] = pct
                            job["statusText"] = f"ライブ録画中 {em:02d}:{es:02d} / {mb:.1f}MB{cm_note}{end_hint}"
            except Exception as e:
                idle_errors += 1
                last_err = str(e)
                if idle_errors >= 12:
                    break
                stop_ev.wait(1.0)

        # 正常終了シーケンス: stdin を閉じて ffmpeg に MP4 の moov ボックスを安全に書き出させる
        with JOBS_LOCK:
            job["statusText"] = "MP4 仕上げ保存中..."
            job["progress"] = 99.0
        try:
            proc.stdin.flush()
            proc.stdin.close()
        except Exception:
            pass
        try:
            _, err_b = proc.communicate(timeout=25)
            if err_b and not last_err:
                last_err = err_b.decode("utf-8", errors="replace").strip()[:200]
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)

        saved_ok = os.path.isfile(tmp_mp4) and os.path.getsize(tmp_mp4) > 32768
        if saved_ok:
            # フロント/リアの 720p バンパー自動カット + avc1/tkhd 完全 1920x1080 ヘッダ再構築 (無劣化)
            ready_mp4 = _fix_mp4_leading_resolution_if_needed(
                tmp_mp4, job_tmp_dir, trim_tail=True, metadata_args=live_meta_args
            )
            shutil.move(ready_mp4, final_path)
            # ヒントサムネを即キャッシュ保存
            thumb_u = _unwrap_proxy_url(job.get("thumbnail") or "")
            if thumb_u:
                try:
                    fid = _file_id(final_path)
                    req = urllib.request.Request(thumb_u, headers={"User-Agent": "Mozilla/5.0"})
                    with urllib.request.urlopen(req, timeout=6) as r:
                        raw_img = r.read()
                    if raw_img and len(raw_img) > 1000:
                        with open(os.path.join(THUMB_CACHE_DIR, f"{fid}.jpg"), "wb") as tf:
                            tf.write(raw_img)
                except Exception:
                    pass
            with JOBS_LOCK:
                job["proc"] = None
                job["status"] = "done"
                job["progress"] = 100.0
                job["finishedAt"] = int(time.time() * 1000)
                job["statusText"] = "ライブ録画保存完了"
            scan_library(force=True)
        else:
            with JOBS_LOCK:
                job["proc"] = None
                job["status"] = "error"
                job["error"] = last_err or "ライブ録画データが取得できませんでした"
                job["finishedAt"] = int(time.time() * 1000)
    except Exception as e:
        with JOBS_LOCK:
            job["proc"] = None
            job["status"] = "error"
            job["error"] = str(e)
            job["finishedAt"] = int(time.time() * 1000)
    finally:
        fetcher.close_all()
        shutil.rmtree(job_tmp_dir, ignore_errors=True)
        try:
            _sync_reserve_from_job(job)
        except Exception:
            pass


# =========================================================================
# ABEMA 番組表キャッシュ & 録画予約永続管理・自動実行スケジューラ
# =========================================================================
def _atomic_write_json(path, obj):
    tmp_p = f"{path}.tmp.{os.getpid()}.{threading.get_ident()}"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp_p, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
        os.replace(tmp_p, path)
    except Exception:
        try:
            if os.path.isfile(tmp_p):
                os.remove(tmp_p)
        except Exception:
            pass


def _infer_abema_slot_genre(genre_id, ch_name, title, desc=""):
    gid = str(genre_id or "").strip().lower()
    if gid in ABEMA_GENRE_ID_MAP:
        return ABEMA_GENRE_ID_MAP[gid]
    return _infer_genre("", "ABEMA", ch_name or "", title or "", desc or "")


def _load_abema_timetable_from_disk():
    global ABEMA_TIMETABLE_DATA
    if not os.path.isfile(ABEMA_TIMETABLE_CACHE_PATH):
        return None
    try:
        with open(ABEMA_TIMETABLE_CACHE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("channels"), list):
            with ABEMA_TIMETABLE_LOCK:
                ABEMA_TIMETABLE_DATA = data
            return data
    except Exception:
        pass
    return None


def refresh_abema_timetable_cache(days=ABEMA_TIMETABLE_DAYS):
    """ABEMA v1/media API から複数日分の番組表を取得し、軽量化・キャッシュ保存する"""
    global ABEMA_TIMETABLE_DATA, ABEMA_TIMETABLE_FETCHING
    if yd is None:
        return ABEMA_TIMETABLE_DATA
    with ABEMA_TIMETABLE_LOCK:
        if ABEMA_TIMETABLE_FETCHING:
            return ABEMA_TIMETABLE_DATA
        ABEMA_TIMETABLE_FETCHING = True

    try:
        if not yd.YDL_READY_EVENT.is_set() or yd.yt_dlp is None:
            yd.warmup_ytdlp()
        jst = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
        d_from = jst.strftime("%Y%m%d")
        d_to = (jst + datetime.timedelta(days=max(1, int(days) - 1))).strftime("%Y%m%d")

        with yd.YDL_LOCK:
            yd.ABEMA_IE._get_device_token()
            drm_ids = yd._get_abema_drm_channel_ids() if hasattr(yd, "_get_abema_drm_channel_ids") else set()
            tt = yd.ABEMA_IE._call_api(
                "v1/media",
                "timetable",
                query={"dateFrom": d_from, "dateTo": d_to},
                note=False,
            )

        raw_channels = tt.get("channels") or []
        raw_scheds = tt.get("channelSchedules") or []

        # チャンネル一覧を公式 order 順に整理
        ch_list = []
        ch_name_map = {}
        for ch in raw_channels:
            cid = str(ch.get("id") or "").strip()
            cname = str(ch.get("name") or "").strip()
            if not cid or not cname:
                continue
            ch_name_map[cid] = cname
            ch_list.append({
                "id": cid,
                "name": cname,
                "order": int(ch.get("order") or 9999),
                "isDrm": bool(cid in drm_ids),
            })
        ch_list.sort(key=lambda x: (x["order"], x["id"]))

        # チャンネルごとに全日付スロットをマージ＆重複排除
        slots_by_ch = {c["id"]: {} for c in ch_list}
        for cs in raw_scheds:
            if not isinstance(cs, dict):
                continue
            cid = str(cs.get("channelId") or "").strip()
            if cid not in slots_by_ch:
                continue
            cname = ch_name_map.get(cid, cid)
            bucket = slots_by_ch[cid]
            for sl in cs.get("slots") or []:
                if not isinstance(sl, dict):
                    continue
                sid = str(sl.get("id") or "").strip()
                st_s = int(sl.get("startAt") or 0)
                ed_s = int(sl.get("endAt") or 0)
                if not sid or st_s <= 0 or ed_s <= st_s:
                    continue
                title = str(sl.get("title") or "").strip() or cname
                progs = sl.get("programs") or []
                p0 = progs[0] if (progs and isinstance(progs[0], dict)) else {}
                prog_id = str(p0.get("id") or sl.get("displayProgramId") or "").strip()
                prov = p0.get("providedInfo") if isinstance(p0.get("providedInfo"), dict) else {}
                thumb_img = str(prov.get("thumbImg") or "thumb001").strip()
                ser_obj = p0.get("series") if isinstance(p0.get("series"), dict) else {}
                ser_id = str(ser_obj.get("id") or "").strip()
                genre_id = str(ser_obj.get("genreId") or "").strip()
                is_off = ("放送休止" in title) or (not progs and "休止" in title)

                thumb_url = ""
                if not is_off:
                    if prog_id:
                        thumb_url = f"https://image.p-c2-x.abema-tv.com/image/programs/{prog_id}/{thumb_img}.png?height=270&width=480"
                    elif ser_id:
                        thumb_url = f"https://image.p-c2-x.abema-tv.com/image/series/{ser_id}/thumb.png?height=270&width=480"

                highlight = str(sl.get("highlight") or "").strip()
                content = str(sl.get("content") or "").strip()
                desc = content if content else highlight
                if len(desc) > 500:
                    desc = desc[:500] + "…"
                # シリーズ名推定 (highlight から話数・記号を軽く整形)
                series_name = highlight or title
                series_name = re.sub(r"[\s　]*[#♯第]\d+.*$", "", series_name).strip()
                series_name = re.sub(r"[\s　]*【[^】]+】$", "", series_name).strip()
                if not series_name or len(series_name) > 40:
                    series_name = cname

                genre_ja = _infer_abema_slot_genre(genre_id, cname, title)

                bucket[sid] = {
                    "id": sid,
                    "channelId": cid,
                    "title": title,
                    "series": series_name,
                    "genre": genre_ja,
                    "description": desc,
                    "highlight": highlight,
                    "startAt": st_s * 1000,
                    "endAt": ed_s * 1000,
                    "thumbnail": thumb_url,
                    "isOffAir": bool(is_off),
                }

        final_slots = {}
        total_slots = 0
        for c in ch_list:
            arr = sorted(slots_by_ch[c["id"]].values(), key=lambda x: x["startAt"])
            final_slots[c["id"]] = arr
            total_slots += len(arr)

        payload = {
            "updatedAt": int(time.time() * 1000),
            "dateFrom": d_from,
            "dateTo": d_to,
            "days": int(days),
            "totalSlots": total_slots,
            "channels": ch_list,
            "slotsByChannel": final_slots,
        }
        with ABEMA_TIMETABLE_LOCK:
            ABEMA_TIMETABLE_DATA = payload
        _atomic_write_json(ABEMA_TIMETABLE_CACHE_PATH, payload)
        print(
            f"[dtvplus-save] ABEMA timetable cached: {len(ch_list)} ch / {total_slots} slots ({d_from}-{d_to})",
            flush=True,
        )
        return payload
    except Exception as e:
        print(f"[dtvplus-save] ABEMA timetable fetch error: {e}", flush=True)
        return ABEMA_TIMETABLE_DATA
    finally:
        with ABEMA_TIMETABLE_LOCK:
            ABEMA_TIMETABLE_FETCHING = False


def get_abema_timetable_cached(force=False):
    """キャッシュ済み ABEMA 番組表を返す (期限切れはバックグラウンド自動更新)"""
    with ABEMA_TIMETABLE_LOCK:
        cur = ABEMA_TIMETABLE_DATA
        is_fetching = ABEMA_TIMETABLE_FETCHING
    if cur is None:
        cur = _load_abema_timetable_from_disk()

    now_ms = int(time.time() * 1000)
    is_stale = (cur is None) or ((now_ms - int(cur.get("updatedAt") or 0)) > ABEMA_TIMETABLE_TTL_SEC * 1000)

    if force or cur is None:
        refreshed = refresh_abema_timetable_cache()
        if refreshed is not None:
            return refreshed
        return cur or {
            "updatedAt": 0,
            "channels": [],
            "slotsByChannel": {},
            "totalSlots": 0,
        }

    if is_stale and not is_fetching:
        threading.Thread(target=refresh_abema_timetable_cache, daemon=True).start()
    return cur


def _save_abema_reserves_unlocked():
    arr = sorted(ABEMA_RESERVES.values(), key=lambda x: (int(x.get("startAt") or 0), str(x.get("id") or "")))
    _atomic_write_json(ABEMA_RESERVES_PATH, {"updatedAt": int(time.time() * 1000), "reserves": arr})


def load_abema_reserves():
    if not os.path.isfile(ABEMA_RESERVES_PATH):
        return
    try:
        with open(ABEMA_RESERVES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        arr = data.get("reserves") if isinstance(data, dict) else (data if isinstance(data, list) else [])
        now_ms = int(time.time() * 1000)
        with ABEMA_RESERVES_LOCK:
            ABEMA_RESERVES.clear()
            for r in arr:
                if not isinstance(r, dict) or not r.get("id"):
                    continue
                # 前回サーバー終了時に録画中だった予約の復旧判定
                if r.get("status") == "recording":
                    if int(r.get("endAt") or 0) > now_ms + 30000:
                        r["status"] = "scheduled"
                        r["jobId"] = ""
                    else:
                        r["status"] = "done"
                ABEMA_RESERVES[str(r["id"])] = r
            _save_abema_reserves_unlocked()
    except Exception as e:
        print(f"[dtvplus-save] ABEMA reserves load error: {e}", flush=True)


def _sync_reserve_from_job(job):
    rsv_id = str((job or {}).get("reserveId") or "").strip()
    if not rsv_id:
        return
    j_status = str(job.get("status") or "")
    j_err = str(job.get("error") or "")
    with ABEMA_RESERVES_LOCK:
        rsv = ABEMA_RESERVES.get(rsv_id)
        if not rsv:
            return
        if j_status == "done":
            rsv["status"] = "done"
            rsv["error"] = ""
            rsv["finishedAt"] = int(time.time() * 1000)
        elif j_status == "cancelled":
            rsv["status"] = "cancelled"
            rsv["finishedAt"] = int(time.time() * 1000)
        elif j_status == "error":
            rsv["status"] = "error"
            rsv["error"] = j_err
            rsv["finishedAt"] = int(time.time() * 1000)
        _save_abema_reserves_unlocked()


def _trigger_abema_reserve_recording(rsv_id):
    """予約レコードから ABEMA ライブ録画ジョブを専用スレッドで即起動する"""
    with ABEMA_RESERVES_LOCK:
        rsv = ABEMA_RESERVES.get(rsv_id)
        if not rsv or rsv.get("status") != "scheduled":
            return None
        ch_id = str(rsv.get("channelId") or "").strip()
        url = str(rsv.get("url") or f"https://abema.tv/now-on-air/{ch_id}").strip()
        job_id = f"job_rsv_{int(time.time() * 1000)}_{len(JOB_ORDER) + 1}"
        job = {
            "id": job_id,
            "reserveId": rsv_id,
            "slotId": str(rsv.get("slotId") or ""),
            "url": url,
            "episodeId": ch_id,
            "title": str(rsv.get("title") or ch_id),
            "series": str(rsv.get("series") or rsv.get("channelName") or "ABEMA LIVE"),
            "genre": str(rsv.get("genre") or ""),
            "broadcaster": str(rsv.get("channelName") or "ABEMA"),
            "provider": "ABEMA",
            "thumbnail": _unwrap_proxy_url(rsv.get("thumbnail") or ""),
            "description": str(rsv.get("description") or ""),
            "durationSec": max(0.0, (int(rsv.get("endAt") or 0) - int(rsv.get("startAt") or 0)) / 1000.0),
            "isLive": True,
            "startAt": int(rsv.get("startAt") or 0),
            "endAt": int(rsv.get("endAt") or 0),
            "stopEvent": threading.Event(),
            "status": "queued",
            "progress": 0.0,
            "statusText": "予約録画を開始中...",
            "error": "",
            "createdAt": int(time.time() * 1000),
            "startedAt": 0,
            "finishedAt": 0,
            "proc": None,
        }
        with JOBS_LOCK:
            JOBS[job_id] = job
            JOB_ORDER.append(job_id)
        rsv["status"] = "recording"
        rsv["jobId"] = job_id
        rsv["error"] = ""
        _save_abema_reserves_unlocked()

    # VOD ダウンロードキューに待たされず時刻どおり録画開始するため専用スレッドで即起動
    threading.Thread(target=_run_abema_live_save_job, args=(job_id,), daemon=True).start()
    print(f"[dtvplus-save] ABEMA reserved recording started: {rsv_id} -> {job_id} ({job['title']})", flush=True)
    return job_id


def list_abema_reserves_public():
    """クライアント向け ABEMA 予約一覧 (進行中ジョブの最新状態もマージして返す)"""
    now_ms = int(time.time() * 1000)
    with JOBS_LOCK:
        jobs_snap = {jid: _serialize_job(j) for jid, j in JOBS.items()}
    with ABEMA_RESERVES_LOCK:
        out = []
        for rsv in sorted(ABEMA_RESERVES.values(), key=lambda x: (int(x.get("startAt") or 0), str(x.get("id") or ""))):
            st = rsv.get("status")
            # 終了から 24 時間以上経った完了・キャンセル・ミスは返さない
            if st in ("done", "cancelled", "missed", "error"):
                ref_ts = int(rsv.get("finishedAt") or rsv.get("endAt") or 0)
                if ref_ts > 0 and (now_ms - ref_ts) > 86400 * 1000:
                    continue
            item = dict(rsv)
            jid = item.get("jobId") or ""
            if jid and jid in jobs_snap:
                item["jobProgress"] = jobs_snap[jid].get("progress", 0)
                item["jobStatusText"] = jobs_snap[jid].get("statusText", "")
            out.append(item)
    # 予約外で手動録画中の ABEMA ライブジョブも参照用に返す
    manual_live = []
    for js in jobs_snap.values():
        if js.get("isLive") and js.get("status") in ("queued", "downloading"):
            manual_live.append(js)
    return out, manual_live


def add_abema_reserve(body):
    now_ms = int(time.time() * 1000)
    ch_id = str(body.get("channelId") or "").strip()
    slot_id = str(body.get("slotId") or "").strip()
    start_at = int(body.get("startAt") or 0)
    end_at = int(body.get("endAt") or 0)
    if not ch_id or start_at <= 0 or end_at <= start_at:
        return None, "channelId / startAt / endAt が不正です", 400
    if end_at <= now_ms + 10000:
        return None, "すでに放送終了した番組は予約できません", 400

    rsv_id = f"rsv_{slot_id}" if slot_id else f"rsv_{ch_id}_{start_at}"
    url = str(body.get("url") or f"https://abema.tv/now-on-air/{ch_id}").strip()
    ch_name = str(body.get("channelName") or ch_id).strip()
    title = str(body.get("title") or ch_name).strip()

    with ABEMA_RESERVES_LOCK:
        existing = ABEMA_RESERVES.get(rsv_id)
        if existing and existing.get("status") in ("scheduled", "recording"):
            return dict(existing), None, 200
        rsv = {
            "id": rsv_id,
            "slotId": slot_id or rsv_id,
            "channelId": ch_id,
            "channelName": ch_name,
            "title": title,
            "series": str(body.get("series") or ch_name).strip(),
            "genre": str(body.get("genre") or "").strip(),
            "description": str(body.get("description") or "").strip()[:500],
            "thumbnail": _unwrap_proxy_url(body.get("thumbnail") or ""),
            "url": url,
            "startAt": start_at,
            "endAt": end_at,
            "status": "scheduled",
            "jobId": "",
            "error": "",
            "createdAt": now_ms,
            "finishedAt": 0,
        }
        ABEMA_RESERVES[rsv_id] = rsv
        _save_abema_reserves_unlocked()

    # すでに放送中または開始 20 秒以内なら即座に録画開始
    if now_ms >= start_at - 20000:
        _trigger_abema_reserve_recording(rsv_id)
        with ABEMA_RESERVES_LOCK:
            rsv = dict(ABEMA_RESERVES.get(rsv_id) or rsv)
    return rsv, None, 201


def delete_abema_reserve(rsv_id):
    job_to_stop = None
    with ABEMA_RESERVES_LOCK:
        rsv = ABEMA_RESERVES.get(rsv_id)
        if not rsv:
            return False, "reserve not found"
        st = rsv.get("status")
        jid = str(rsv.get("jobId") or "")
        if st == "recording" and jid:
            job_to_stop = jid
            rsv["status"] = "cancelled"
            rsv["finishedAt"] = int(time.time() * 1000)
        else:
            ABEMA_RESERVES.pop(rsv_id, None)
        _save_abema_reserves_unlocked()

    if job_to_stop:
        with JOBS_LOCK:
            j = JOBS.get(job_to_stop)
            if j and j.get("stopEvent") is not None and j.get("status") == "downloading":
                j["statusText"] = "停止・MP4 保存仕上げ中..."
                j["stopEvent"].set()
            elif j:
                j["status"] = "cancelled"
                j["statusText"] = "キャンセル済"
                if j.get("stopEvent") is not None:
                    j["stopEvent"].set()
    return True, ("stopping" if job_to_stop else "deleted")


def _abema_scheduler_loop():
    """ABEMA 予約録画の時刻監視 (5秒間隔) & 番組表キャッシュ定期更新 (30分間隔)"""
    last_tt_check = 0.0
    while True:
        try:
            now_s = time.time()
            now_ms = int(now_s * 1000)

            # 1) 予約時刻の監視と自動開始・期限切れ整理
            to_trigger = []
            dirty = False
            with ABEMA_RESERVES_LOCK:
                for rid in list(ABEMA_RESERVES.keys()):
                    r = ABEMA_RESERVES.get(rid)
                    if not r:
                        continue
                    st = r.get("status")
                    st_at = int(r.get("startAt") or 0)
                    ed_at = int(r.get("endAt") or 0)
                    if st == "scheduled":
                        if ed_at <= now_ms + 10000:
                            r["status"] = "missed"
                            r["error"] = "放送終了時刻を過ぎました"
                            r["finishedAt"] = now_ms
                            dirty = True
                        elif now_ms >= st_at - 15000:
                            to_trigger.append(rid)
                    elif st in ("done", "cancelled", "missed", "error"):
                        ref_ts = int(r.get("finishedAt") or ed_at or 0)
                        if ref_ts > 0 and (now_ms - ref_ts) > 48 * 3600 * 1000:
                            ABEMA_RESERVES.pop(rid, None)
                            dirty = True
                if dirty:
                    _save_abema_reserves_unlocked()

            for rid in to_trigger:
                _trigger_abema_reserve_recording(rid)

            # 2) 番組表キャッシュの定期自動更新 (30分おき)
            if now_s - last_tt_check >= 60.0:
                last_tt_check = now_s
                with ABEMA_TIMETABLE_LOCK:
                    cur = ABEMA_TIMETABLE_DATA
                    fetching = ABEMA_TIMETABLE_FETCHING
                if not fetching and (
                    cur is None or (now_ms - int(cur.get("updatedAt") or 0)) > ABEMA_TIMETABLE_TTL_SEC * 1000
                ):
                    threading.Thread(target=refresh_abema_timetable_cache, daemon=True).start()
        except Exception as e:
            print(f"[dtvplus-save] ABEMA scheduler err: {e}", flush=True)
        time.sleep(5.0)


# =========================================================================
# 重複ダウンロード防止 & 単発/一括ダウンロード投入ヘルパー
# =========================================================================
def _extract_episode_id_from_url(url, explicit_id=""):
    ep_id = str(explicit_id or "").strip()
    if ep_id:
        return ep_id
    u = str(url or "").strip()
    # TVer: /episodes/ep..., ABEMA VOD: /video/episode/54-125_s1_p1
    m = re.search(r"/episodes?/([A-Za-z0-9_-]+)", u)
    if m:
        return m.group(1)
    return ""


def _is_vod_unique_episode_id(ep_id):
    """TVer / ABEMA VOD のエピソード固有IDかを判定 (ライブチャンネルスラッグと区別)"""
    s = str(ep_id or "").strip()
    if not s:
        return False
    if re.match(r"^ep[a-z0-9]{6,}$", s, re.I):
        return True
    if re.match(r"^\d+-\d+_s\d+_p\d+", s, re.I):
        return True
    return False


def _get_saved_and_active_episode_ids():
    """現在保存済みの VOD episodeId 集合、進行中 episodeId 集合、および実在ファイル ID 一覧を返す"""
    items = scan_library(force=False)
    saved_ids = set()
    file_ids = set()
    for it in items:
        fid = str(it.get("id") or "").strip()
        if fid:
            file_ids.add(fid)
        eid = str(it.get("episodeId") or "").strip()
        if _is_vod_unique_episode_id(eid):
            saved_ids.add(eid)
    active_ids = set()
    with JOBS_LOCK:
        for j in JOBS.values():
            if j.get("status") in ("queued", "downloading") and not j.get("isLive"):
                eid = str(j.get("episodeId") or "").strip()
                if eid:
                    active_ids.add(eid)
    return saved_ids, active_ids, file_ids


def _find_duplicate_save(ep_id, url, is_live_req):
    """既存ライブラリ・進行中ジョブとの重複を検査する"""
    ep_low = str(ep_id or "").strip().lower()
    url_norm = str(url or "").strip().rstrip("/").lower()

    # 1. 現在待機中 / ダウンロード中ジョブとの重複 (ライブの二重録画も防止)
    with JOBS_LOCK:
        for j in JOBS.values():
            if j.get("status") not in ("queued", "downloading"):
                continue
            j_url = str(j.get("url") or "").strip().rstrip("/").lower()
            j_ep = str(j.get("episodeId") or "").strip().lower()
            if (url_norm and j_url == url_norm) or (not is_live_req and ep_low and j_ep == ep_low):
                return "already_queued", _serialize_job(j)

    # 2. VOD は保存済みライブラリ (D:\tver_hozon 等) に同一 episodeId があれば重複スキップ
    if not is_live_req and ep_low:
        items = scan_library(force=False)
        for it in items:
            it_ep = str(it.get("episodeId") or "").strip().lower()
            if it_ep and it_ep == ep_low:
                return "already_saved", {
                    "id": it.get("id"),
                    "title": it.get("title"),
                    "episodeId": it.get("episodeId"),
                }
    return None, None


def _enqueue_save_item(body):
    """単発 / 一括ダウンロード共通の重複検査＆ジョブ登録処理"""
    url = str(body.get("url") or "").strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        return None, "valid url required", 400

    is_live_req = bool(body.get("isLive")) or ("abema.tv/now-on-air/" in url.lower())
    ep_id = _extract_episode_id_from_url(url, body.get("episodeId") or "")
    title = str(body.get("title") or url)

    dup_reason, dup_ref = _find_duplicate_save(ep_id, url, is_live_req)
    if dup_reason:
        return {
            "ok": True,
            "skipped": True,
            "reason": dup_reason,
            "episodeId": ep_id,
            "title": title,
            "existing": dup_ref,
        }, None, 200

    job_id = f"job_{int(time.time() * 1000)}_{len(JOB_ORDER) + 1}"
    job = {
        "id": job_id,
        "url": url,
        "episodeId": ep_id,
        "title": title,
        "series": str(body.get("series") or ""),
        "genre": str(body.get("genre") or ""),
        "broadcaster": str(body.get("broadcaster") or ""),
        "provider": str(body.get("provider") or ("TVER" if "tver.jp" in url else ("ABEMA" if "abema" in url else "WEB"))),
        "thumbnail": _unwrap_proxy_url(body.get("thumbnail") or ""),
        "description": str(body.get("description") or ""),
        "durationSec": float(body.get("durationSec") or 0),
        "isLive": is_live_req,
        "startAt": int(body.get("startAt") or 0),
        "endAt": int(body.get("endAt") or 0),
        "slotId": str(body.get("slotId") or ""),
        "stopEvent": threading.Event(),
        "status": "queued",
        "progress": 0.0,
        "statusText": "待機中...",
        "error": "",
        "createdAt": int(time.time() * 1000),
        "startedAt": 0,
        "finishedAt": 0,
        "proc": None,
    }
    with JOBS_LOCK:
        JOBS[job_id] = job
        JOB_ORDER.append(job_id)
    if is_live_req:
        threading.Thread(target=_run_abema_live_save_job, args=(job_id,), daemon=True).start()
    else:
        JOB_QUEUE.put(job_id)
    return {"ok": True, "skipped": False, "job": _serialize_job(job)}, None, 202


def _run_save_job(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job or job["status"] == "cancelled":
            return
        url_check = str(job.get("url") or "").lower()
        is_abema_live = ("abema.tv/now-on-air/" in url_check) or (bool(job.get("isLive")) and ("abema" in url_check or job.get("provider") == "ABEMA"))
    if is_abema_live:
        return _run_abema_live_save_job(job_id)

    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job or job["status"] == "cancelled":
            return
        job["status"] = "downloading"
        job["statusText"] = "ストリーム解析中..."
        job["startedAt"] = int(time.time() * 1000)

    url = job["url"]
    known_dur = float(job.get("durationSec") or 0)
    if job.get("episodeId"):
        EPISODE_META_HINTS[job["episodeId"]] = {
            "title": job.get("title") or "",
            "series": job.get("series") or "",
            "genre": job.get("genre") or "",
            "broadcaster": job.get("broadcaster") or "",
            "provider": job.get("provider") or "",
            "thumbnail": job.get("thumbnail") or "",
            "description": job.get("description") or "",
            "url": url,
        }

    # ジョブ専用一時フォルダで作業し、成功・失敗・キャンセル問わず終了時に必ず丸ごと削除する
    job_tmp_dir = os.path.join(TEMP_WORK_DIR, job_id)
    os.makedirs(job_tmp_dir, exist_ok=True)
    is_abema_url = ("abema.tv" in url.lower()) or (job.get("provider") == "ABEMA")
    out_tmpl = "%(series&{} |)s%(title)s [%(id)s].%(ext)s" if is_abema_url else "%(title)s [%(id)s].%(ext)s"
    if YTDLP_BIN:
        cmd = [YTDLP_BIN]
    else:
        cmd = [_resolve_console_python(), "-u", "-m", "yt_dlp"]
    cmd.extend([
        "--progress",
        "--newline",
        "--no-color",
        "--no-playlist",
        "--hls-prefer-native",
        "-N", "4",
        "-P", f"home:{PRIMARY_SAVE_DIR}",
        "-P", f"temp:{job_tmp_dir}",
        "--merge-output-format", "mp4",
        "--embed-metadata",
        "--embed-thumbnail",
        "-o", out_tmpl,
        url,
    ])

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    proc = None
    last_err = ""
    detected_dur = known_dur

    def _process_output_line(raw_line):
        nonlocal last_err, detected_dur
        s = raw_line.strip()
        if not s:
            return
        # 1) yt-dlp 標準進捗: "[download]  42.3% of ..."
        if "[download] Destination:" in s:
            is_aud = ("audio" in s.lower()) or s.lower().endswith(".m4a")
            with JOBS_LOCK:
                job["statusText"] = "音声トラックを取得中..." if is_aud else "映像トラックを取得中..."
            return
        m_pct = re.search(r"(\d{1,3}(?:\.\d+)?)%", s)
        if m_pct:
            val = float(m_pct.group(1))
            with JOBS_LOCK:
                # 最終 MP4 結合が終わるまで 100% 完了表示にしない (最大 99%)
                job["progress"] = min(99.0, val)
                job["statusText"] = s[:120]
            return
        # 2) HLS フラグメント進捗: "(frag 120/450)"
        m_frag = re.search(r"frag\s+(\d+)\s*/\s*(\d+)", s, re.I)
        if m_frag:
            cur_f, tot_f = int(m_frag.group(1)), int(m_frag.group(2))
            if tot_f > 0:
                with JOBS_LOCK:
                    job["progress"] = min(99.9, round((cur_f / tot_f) * 100.0, 1))
                    job["statusText"] = f"ダウンロード中 (frag {cur_f}/{tot_f})"
            return
        # 3) ffmpeg フォールバック時の総尺・経過時刻・サイズ解析
        m_dur = re.search(r"Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)", s)
        if m_dur:
            d_sec = _parse_hms_sec(m_dur.group(1))
            if d_sec > 5:
                detected_dur = d_sec
            return
        m_time = re.search(r"time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)", s)
        if m_time:
            cur_sec = _parse_hms_sec(m_time.group(1))
            m_sz = re.search(r"size=\s*([0-9.]+[A-Za-z]+)", s)
            sz_str = (" / " + m_sz.group(1)) if m_sz else ""
            with JOBS_LOCK:
                if detected_dur > 5:
                    job["progress"] = min(99.9, round((cur_sec / detected_dur) * 100.0, 1))
                elif cur_sec > 0 and job["progress"] < 1.0:
                    job["progress"] = 1.0
                job["statusText"] = f"保存中 {m_time.group(1).split('.')[0]}{sz_str}"
            return
        if "[Merger]" in s or "[EmbedThumbnail]" in s or "[Metadata]" in s or "[Fixup" in s:
            with JOBS_LOCK:
                job["progress"] = max(job["progress"], 99.0)
                job["statusText"] = "MP4 結合・メタデータ仕上げ中..."
        elif "ERROR:" in s:
            last_err = s

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=0,
            env=env,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        with JOBS_LOCK:
            job["proc"] = proc

        # \r (ffmpeg進捗) と \n (yt-dlp進捗) の両方をリアルタイム処理する
        buf = bytearray()
        while True:
            ch = proc.stdout.read(1)
            if not ch:
                if buf:
                    _process_output_line(buf.decode("utf-8", errors="replace"))
                    buf.clear()
                break
            if ch in (b"\r", b"\n"):
                if buf:
                    _process_output_line(buf.decode("utf-8", errors="replace"))
                    buf.clear()
            else:
                buf.extend(ch)
                if len(buf) > 4096:
                    _process_output_line(buf.decode("utf-8", errors="replace"))
                    buf.clear()

        rc = proc.wait()
        if rc == 0:
            # VOD 保存完了ファイルにも冒頭 720p 混入によるヘッダ低下があれば無劣化で 1080p 補正する
            try:
                ep_tag = str(job.get("episodeId") or "").strip()
                if ep_tag:
                    cand_files = [
                        os.path.join(PRIMARY_SAVE_DIR, fn)
                        for fn in os.listdir(PRIMARY_SAVE_DIR)
                        if fn.lower().endswith(".mp4") and f"[{ep_tag}]" in fn
                    ]
                    if cand_files:
                        newest_mp4 = max(cand_files, key=lambda p: os.path.getmtime(p))
                        fixed_p = _fix_mp4_leading_resolution_if_needed(newest_mp4, job_tmp_dir)
                        if fixed_p != newest_mp4 and os.path.isfile(fixed_p):
                            os.replace(fixed_p, newest_mp4)
            except Exception:
                pass
        with JOBS_LOCK:
            job["proc"] = None
            if job["status"] == "cancelled":
                return
            if rc == 0:
                job["status"] = "done"
                job["progress"] = 100.0
                job["finishedAt"] = int(time.time() * 1000)
                job["statusText"] = "保存完了"
            else:
                job["status"] = "error"
                job["error"] = last_err or f"yt-dlp exited with code {rc}"
                job["finishedAt"] = int(time.time() * 1000)
        if rc == 0:
            scan_library(force=True)
    except Exception as e:
        with JOBS_LOCK:
            job["proc"] = None
            if job["status"] != "cancelled":
                job["status"] = "error"
                job["error"] = str(e)
                job["finishedAt"] = int(time.time() * 1000)
    finally:
        shutil.rmtree(job_tmp_dir, ignore_errors=True)


def _worker_loop():
    while True:
        job_id = JOB_QUEUE.get()
        try:
            _run_save_job(job_id)
        except Exception:
            pass
        finally:
            JOB_QUEUE.task_done()


def _serialize_job(j):
    return {
        "id": j["id"],
        "url": j["url"],
        "title": j["title"],
        "series": j["series"],
        "broadcaster": j["broadcaster"],
        "provider": j["provider"],
        "thumbnail": j["thumbnail"],
        "isLive": bool(j.get("isLive")),
        "endAt": int(j.get("endAt") or 0),
        "status": j["status"],
        "progress": j["progress"],
        "statusText": j["statusText"],
        "error": j["error"],
        "createdAt": j["createdAt"],
        "finishedAt": j["finishedAt"],
    }


def _public_item(item, origin):
    return {
        "id": item["id"],
        "fileName": item["fileName"],
        "episodeId": item["episodeId"],
        "provider": item["provider"],
        "genre": item.get("genre") or "その他",
        "series": item["series"],
        "title": item["title"],
        "broadcaster": item["broadcaster"],
        "description": item["description"],
        "durationSec": item["durationSec"],
        "width": item["width"],
        "height": item["height"],
        "sizeBytes": item["sizeBytes"],
        "sizeLabel": item["sizeLabel"],
        "mtimeMs": item["mtimeMs"],
        "thumbnailUrl": f"{origin}/api/thumb/{item['id']}",
        "videoUrl": f"{origin}/api/video/{item['id']}",
    }


class MediaSaveHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")

    def _origin(self):
        host = (self.headers.get("Host") or "").strip()
        return f"http://{host}" if host else f"http://127.0.0.1:{PORT}"

    def _check_access(self):
        cip = self.client_address[0] if self.client_address else ""
        if not _is_allowed_client(cip):
            self.send_response(403)
            self.send_header("Content-Length", "9")
            self.end_headers()
            self.wfile.write(b"Forbidden")
            return False
        return True

    def _send_json(self, obj, status=200):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _serve_video_range(self, abs_path):
        if not os.path.isfile(abs_path):
            return self._send_json({"error": "file not found"}, 404)
        total = os.path.getsize(abs_path)
        ctype, _ = mimetypes.guess_type(abs_path)
        if not ctype:
            ctype = "video/mp4"

        range_hdr = self.headers.get("Range")
        start = 0
        end = total - 1
        status = 200
        if range_hdr and range_hdr.startswith("bytes="):
            m = re.match(r"bytes=(\d*)-(\d*)", range_hdr)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                if m.group(2):
                    end = min(total - 1, int(m.group(2)))
                if start >= total or start > end:
                    self.send_response(416)
                    self._cors()
                    self.send_header("Content-Range", f"bytes */{total}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206

        length = end - start + 1
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.end_headers()

        try:
            with open(abs_path, "rb") as f:
                f.seek(start)
                rem = length
                while rem > 0:
                    chunk = f.read(min(262144, rem))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    rem -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_OPTIONS(self):
        if not self._check_access():
            return
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self._check_access():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        origin = self._origin()

        if path == "/api/ping":
            items = scan_library(force=False)
            try:
                usage = shutil.disk_usage(PRIMARY_SAVE_DIR)
                free_gb = round(usage.free / (1024 ** 3), 1)
            except Exception:
                free_gb = None
            with JOBS_LOCK:
                active_jobs = sum(1 for j in JOBS.values() if j["status"] in ("queued", "downloading"))
            with ABEMA_RESERVES_LOCK:
                abema_rsv_cnt = sum(1 for r in ABEMA_RESERVES.values() if r.get("status") in ("scheduled", "recording"))
            with ABEMA_TIMETABLE_LOCK:
                abema_tt_ts = int((ABEMA_TIMETABLE_DATA or {}).get("updatedAt") or 0)
            return self._send_json({
                "ok": True,
                "service": "dtvplus-media-save-server",
                "saveDir": PRIMARY_SAVE_DIR,
                "dirs": SAVE_DIRS,
                "itemCount": len(items),
                "activeJobs": active_jobs,
                "abemaReserveCount": abema_rsv_cnt,
                "abemaTimetableUpdatedAt": abema_tt_ts,
                "freeGb": free_gb,
            })

        if path == "/api/abema/timetable":
            force = (qs.get("force") or ["0"])[0] == "1"
            tt = get_abema_timetable_cached(force=force)
            rsvs, live_jobs = list_abema_reserves_public()
            resp = dict(tt or {})
            resp["reserves"] = rsvs
            resp["activeLiveJobs"] = live_jobs
            return self._send_json(resp)

        if path == "/api/abema/reserves":
            rsvs, live_jobs = list_abema_reserves_public()
            return self._send_json({
                "ok": True,
                "reserves": rsvs,
                "activeLiveJobs": live_jobs,
            })

        if path == "/api/saved_ids":
            saved_ids, active_ids, file_ids = _get_saved_and_active_episode_ids()
            return self._send_json({
                "ok": True,
                "storageMounted": os.path.isdir(PRIMARY_SAVE_DIR),
                "savedIds": sorted(saved_ids),
                "activeIds": sorted(active_ids),
                "fileIds": sorted(file_ids),
                "savedCount": len(saved_ids),
                "activeCount": len(active_ids),
                "fileCount": len(file_ids),
            })

        if path == "/api/items":
            force = (qs.get("rescan") or ["0"])[0] == "1"
            q_kw = (qs.get("q") or [""])[0].strip().lower()
            f_prov = (qs.get("provider") or [""])[0].strip().upper()
            f_genre = (qs.get("genre") or [""])[0].strip()
            f_series = (qs.get("series") or [""])[0].strip()
            f_bc = (qs.get("broadcaster") or [""])[0].strip()
            all_items = scan_library(force=force)

            # サイドバー用集計 (区分別・ジャンル別・TVer放送局別・番組名別)
            p_map = {}
            g_map = {}
            tver_b_map = {}
            b_map = {}
            s_map = {}
            for it in all_items:
                pv = (it.get("provider") or "LOCAL").upper()
                p_map[pv] = p_map.get(pv, 0) + 1
                gn = (it.get("genre") or "その他").strip()
                g_map[gn] = g_map.get(gn, 0) + 1
                bn = (it.get("broadcaster") or "その他").strip()
                b_map[bn] = b_map.get(bn, 0) + 1
                if pv == "TVER":
                    tver_b_map[bn] = tver_b_map.get(bn, 0) + 1
                sn = (it.get("series") or "").strip()
                if sn:
                    s_map[sn] = s_map.get(sn, 0) + 1

            provider_counts = [{"name": k, "count": v} for k, v in sorted(p_map.items(), key=lambda x: (-x[1], x[0]))]
            genre_counts = [{"name": k, "count": v} for k, v in sorted(g_map.items(), key=lambda x: (-x[1], x[0]))]
            tver_bc_counts = [{"name": k, "count": v} for k, v in sorted(tver_b_map.items(), key=lambda x: (-x[1], x[0]))]
            bc_counts = [{"name": k, "count": v} for k, v in sorted(b_map.items(), key=lambda x: (-x[1], x[0]))]
            series_counts = [{"name": k, "count": v} for k, v in sorted(s_map.items(), key=lambda x: (-x[1], x[0]))]

            items = all_items
            if f_prov:
                items = [it for it in items if (it.get("provider") or "LOCAL").upper() == f_prov]
            if f_genre:
                items = [it for it in items if (it.get("genre") or "その他").strip() == f_genre]
            if f_series:
                items = [it for it in items if (it.get("series") or "").strip() == f_series]
            if f_bc:
                items = [it for it in items if (it.get("broadcaster") or "その他").strip() == f_bc]
            if q_kw:
                items = [
                    it for it in items
                    if q_kw in it["title"].lower()
                    or q_kw in it["series"].lower()
                    or q_kw in it["broadcaster"].lower()
                    or q_kw in (it.get("genre") or "").lower()
                    or q_kw in it["description"].lower()
                ]
            return self._send_json({
                "saveDir": PRIMARY_SAVE_DIR,
                "total": len(items),
                "allTotal": len(all_items),
                "providerCounts": provider_counts,
                "genreCounts": genre_counts,
                "tverBroadcasterCounts": tver_bc_counts,
                "broadcasterCounts": bc_counts,
                "seriesCounts": series_counts,
                "items": [_public_item(it, origin) for it in items],
            })

        if path == "/api/jobs":
            now_ms = int(time.time() * 1000)
            with JOBS_LOCK:
                arr = []
                for jid in reversed(JOB_ORDER):
                    j = JOBS.get(jid)
                    if not j:
                        continue
                    # 完了から 10 分以上経ったエラー/キャンセル履歴は自動非表示
                    if j.get("status") in ("error", "cancelled") and j.get("finishedAt") and (now_ms - j["finishedAt"] > 600000):
                        continue
                    arr.append(_serialize_job(j))
            return self._send_json({"jobs": arr[:40]})

        if path.startswith("/api/thumb/"):
            fid = path[len("/api/thumb/"):].strip("/")
            scan_library(force=False)
            with ITEMS_LOCK:
                item = ITEMS_BY_ID.get(fid)
            if not item:
                return self._send_json({"error": "not found"}, 404)
            tp = ensure_thumbnail(item)
            if not tp or not os.path.isfile(tp):
                return self._send_json({"error": "thumb unavailable"}, 404)
            with open(tp, "rb") as f:
                raw = f.read()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return

        if path.startswith("/api/video/"):
            fid = path[len("/api/video/"):].strip("/")
            scan_library(force=False)
            with ITEMS_LOCK:
                item = ITEMS_BY_ID.get(fid)
            if not item:
                return self._send_json({"error": "not found"}, 404)
            return self._serve_video_range(item["absPath"])

        return self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        if not self._check_access():
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/cleanup":
            res = cleanup_storage(clear_finished_jobs=True)
            return self._send_json(res)
        if parsed.path == "/api/abema/reserves":
            cl = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(cl) if cl > 0 else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception:
                return self._send_json({"error": "invalid json"}, 400)
            rsv, err_msg, code = add_abema_reserve(body)
            if err_msg:
                return self._send_json({"ok": False, "error": err_msg}, code)
            return self._send_json({"ok": True, "reserve": rsv}, code)
        if parsed.path == "/api/save/batch":
            cl = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(cl) if cl > 0 else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception:
                return self._send_json({"error": "invalid json"}, 400)
            items = body.get("items")
            if not isinstance(items, list) or len(items) == 0:
                return self._send_json({"error": "items list required"}, 400)
            # サーバー負荷・容量圧迫防止のため 1 回の一括投入は最大 10 話までに制限
            batch_slice = items[:10]
            queued = 0
            skipped_saved = 0
            skipped_active = 0
            failed = 0
            results = []
            for entry in batch_slice:
                if not isinstance(entry, dict):
                    failed += 1
                    continue
                res_obj, err_msg, _ = _enqueue_save_item(entry)
                if err_msg:
                    failed += 1
                    results.append({"ok": False, "error": err_msg, "title": str(entry.get("title") or "")})
                    continue
                if res_obj.get("skipped"):
                    if res_obj.get("reason") == "already_saved":
                        skipped_saved += 1
                    else:
                        skipped_active += 1
                else:
                    queued += 1
                results.append(res_obj)
            return self._send_json({
                "ok": True,
                "queued": queued,
                "skippedSaved": skipped_saved,
                "skippedActive": skipped_active,
                "failed": failed,
                "total": len(batch_slice),
                "results": results,
            }, 202 if queued > 0 else 200)

        if parsed.path != "/api/save":
            return self._send_json({"error": "not found"}, 404)

        cl = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(cl) if cl > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            return self._send_json({"error": "invalid json"}, 400)

        res_obj, err_msg, code = _enqueue_save_item(body)
        if err_msg:
            return self._send_json({"ok": False, "error": err_msg}, code)
        return self._send_json(res_obj, code)

    def do_DELETE(self):
        if not self._check_access():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/abema/reserves/"):
            rid = urllib.parse.unquote(path[len("/api/abema/reserves/"):].strip("/"))
            ok, mode = delete_abema_reserve(rid)
            if not ok:
                return self._send_json({"error": mode}, 404)
            return self._send_json({"ok": True, "id": rid, "mode": mode})

        if path.startswith("/api/jobs/"):
            jid = path[len("/api/jobs/"):].strip("/")
            with JOBS_LOCK:
                job = JOBS.get(jid)
                if not job:
                    return self._send_json({"error": "job not found"}, 404)
                is_live_job = bool(job.get("isLive")) and job["status"] == "downloading"
                stop_ev = job.get("stopEvent")
                proc = job.get("proc")
                if is_live_job and stop_ev is not None:
                    # ライブ録画中は強制 kill せず正常停止シグナルを送り、ここまでの映像を MP4 確定保存する
                    job["statusText"] = "停止・MP4 保存仕上げ中..."
                    stop_ev.set()
                    return self._send_json({"ok": True, "stopping": jid})
                job["status"] = "cancelled"
                job["statusText"] = "キャンセル済"
                if stop_ev is not None:
                    stop_ev.set()
            if proc:
                try:
                    if os.name == "nt":
                        subprocess.run(
                            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                            capture_output=True,
                            timeout=5,
                            creationflags=0x08000000,
                        )
                    else:
                        proc.kill()
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
            return self._send_json({"ok": True, "cancelled": jid})

        if path.startswith("/api/items/"):
            fid = path[len("/api/items/"):].strip("/")
            with ITEMS_LOCK:
                item = ITEMS_BY_ID.get(fid)
            if not item:
                return self._send_json({"error": "item not found"}, 404)
            try:
                if os.path.isfile(item["absPath"]):
                    os.remove(item["absPath"])
                for p in (os.path.join(META_CACHE_DIR, f"{fid}.json"), os.path.join(THUMB_CACHE_DIR, f"{fid}.jpg")):
                    if os.path.isfile(p):
                        os.remove(p)
            except Exception as e:
                return self._send_json({"error": str(e)}, 500)
            scan_library(force=True)
            return self._send_json({"ok": True, "deleted": fid})

        return self._send_json({"error": "not found"}, 404)


def main():
    mimetypes.init()
    mimetypes.add_type("video/mp4", ".mp4")
    mimetypes.add_type("video/x-matroska", ".mkv")
    mimetypes.add_type("video/mp2t", ".ts")
    mimetypes.add_type("video/mp2t", ".m2ts")

    # yt-dlp モジュールを事前ウォームアップ (ABEMA ライブ鍵取得・番組表キャッシュ用)
    if yd is not None:
        threading.Thread(target=yd.warmup_ytdlp, daemon=True).start()

    # ABEMA 予約データ & 番組表ディスクキャッシュを即時ロードし、スケジューラを起動
    load_abema_reserves()
    _load_abema_timetable_from_disk()
    threading.Thread(target=_abema_scheduler_loop, daemon=True).start()

    # ダウンロードワーカーを2並列で起動
    for _ in range(2):
        threading.Thread(target=_worker_loop, daemon=True).start()

    # 初回起動時に古い一時残骸・孤立キャッシュを自動クリーンアップしてスキャン
    threading.Thread(target=lambda: cleanup_storage(clear_finished_jobs=False), daemon=True).start()

    try:
        srv = ThreadingHTTPServer(("0.0.0.0", PORT), MediaSaveHandler)
    except OSError:
        print(f"[dtvplus-save] Port {PORT} is already in use (already running).", flush=True)
        sys.exit(0)

    print(f"[dtvplus-save] Media Save Server listening on http://0.0.0.0:{PORT}/ (dir={PRIMARY_SAVE_DIR})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
