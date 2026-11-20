#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pc_server.py - DTV Plus PC版 (Windows / Chrome ブラウザ / Tailscale 外出先視聴対応) 統合サーバー
- 共通コア app/backend/ytdlp_daemon.py をそのまま継承し、TVer/ABEMA/EPGStation/SIDEBAND_HUB を 100% 共用
- app/ を静的配信しつつ index.html へ pc/ アダプタのみ動的注入 (LGTV .ipk を一切汚さない)
- ローカル (127.0.0.1) および自宅LAN / Tailscale (100.64.0.0/10) からのアクセスを許可
- GR/BS/CS は SIDEBAND_HUB 抽出 + ffmpeg GPU HWエンコード (NVENC/QSV/AMF優先) で mpegts.js 配信
- BS4K は mmt2ts_pc.py で無劣化 HEVC TS 変換 (CPU ~2%)、リモート省帯域モード時は GPU で 720p/540p H.264 へ変換
"""
import io
import ipaddress
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

# pythonw.exe 実行時に sys.stdout / sys.stderr が None となり print() でクラッシュするのを防止
if sys.stdout is None:
    try:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    except Exception:
        pass
if sys.stderr is None:
    try:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")
    except Exception:
        pass

PC_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(PC_DIR)
APP_DIR = os.path.join(ROOT_DIR, "app")
BACKEND_DIR = os.path.join(APP_DIR, "backend")

if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)
if PC_DIR not in sys.path:
    sys.path.insert(0, PC_DIR)

import ytdlp_daemon as yd
from mmt2ts_pc import Mmt2TsRemuxer

FFMPEG_BIN = shutil.which("ffmpeg") or "ffmpeg"
HW_ENCODER = "libx264"
TAILSCALE_IP = ""

INJECT_HEAD_SNIPPET = (
    '\n  <link rel="stylesheet" href="/pc/pc_style.css">\n'
    '  <script src="/pc/vendor/mpegts.min.js"></script>\n'
    '  <script src="/pc/vendor/hls.min.js"></script>\n'
    '  <script src="/pc/pc_adapter.js"></script>\n'
)

# 接続許可ネットワーク (Loopback / 自宅LANプライベートIP / Tailscale CGNAT & IPv6)
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

# /pc/lan_proxy の中継先として許可する自宅LANプライベートネットワーク
ALLOWED_LAN_PROXY_NETS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
]


def _is_ip_in_nets(ip_str, nets):
    if not ip_str:
        return False
    try:
        clean = ip_str.split("%")[0]
        addr = ipaddress.ip_address(clean)
        if getattr(addr, "ipv4_mapped", None):
            addr = addr.ipv4_mapped
        return any(addr in net for net in nets)
    except Exception:
        return False


def _is_allowed_client(ip_str):
    return _is_ip_in_nets(ip_str, ALLOWED_CLIENT_NETS)


def _is_allowed_lan_target(target_url):
    try:
        p = urllib.parse.urlparse(target_url)
        if p.scheme not in ("http", "https") or not p.hostname:
            return False
        return _is_ip_in_nets(p.hostname, ALLOWED_LAN_PROXY_NETS)
    except Exception:
        return False


def detect_tailscale_ip():
    """Tailscale が稼働していれば IPv4 アドレス (100.x.y.z) を検出する"""
    global TAILSCALE_IP
    try:
        proc = subprocess.run(
            ["tailscale", "ip", "-4"],
            capture_output=True,
            text=True,
            timeout=4,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        if proc.returncode == 0:
            for line in proc.stdout.splitlines():
                s = line.strip()
                if s and _is_ip_in_nets(s, [ipaddress.ip_network("100.64.0.0/10")]):
                    TAILSCALE_IP = s
                    print(f"[dtvplus-pc] Tailscale URL: http://{TAILSCALE_IP}:{yd.PORT}/", flush=True)
                    return TAILSCALE_IP
    except Exception:
        pass
    return TAILSCALE_IP


def detect_hw_encoder():
    """利用可能な最速 H.264 ハードウェアエンコーダを自動検出する"""
    global HW_ENCODER
    for enc in ("h264_nvenc", "h264_qsv", "h264_amf"):
        try:
            proc = subprocess.run(
                [
                    FFMPEG_BIN, "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "color=c=black:s=640x360:d=0.1",
                    "-c:v", enc, "-f", "null", "-",
                ],
                capture_output=True,
                timeout=8,
                creationflags=0x08000000 if os.name == "nt" else 0,
            )
            if proc.returncode == 0:
                HW_ENCODER = enc
                print(f"[dtvplus-pc] Detected GPU encoder: {HW_ENCODER}", flush=True)
                return HW_ENCODER
        except Exception:
            continue
    HW_ENCODER = "libx264"
    print("[dtvplus-pc] Using software encoder: libx264", flush=True)
    return HW_ENCODER


def _build_ffmpeg_video_args(encoder, is_bs4k_downscale=False, quality="high"):
    """
    画質プリセット別 ffmpeg 映像エンコード引数を生成する。
    - high   : ローカル標準 (GR/BS/CS は 1080p 60p 8Mbps / BS4K 変換時は 1080p 8Mbps)
    - medium : 外出先 Wi-Fi / Tailscale 標準 (720p 30p 3Mbps)
    - mobile : モバイル回線・省データ (540p 30p 1.5Mbps)
    """
    q = quality if quality in ("high", "medium", "mobile") else "high"
    if q == "mobile":
        vf = "scale=960:540" if is_bs4k_downscale else "bwdif=mode=0:parity=-1:deint=0,scale=960:540"
        br, maxr, bufs, gop, cq = "1500k", "2200k", "4400k", "60", "27"
    elif q == "medium":
        vf = "scale=1280:720" if is_bs4k_downscale else "bwdif=mode=0:parity=-1:deint=0,scale=1280:720"
        br, maxr, bufs, gop, cq = "3000k", "4500k", "9000k", "60", "25"
    else:
        # 日本の放送波 (1080i) は bwdif=mode=1 (60p 高画質デインターレース) でちらつきを完全に防ぐ
        vf = "scale=1920:1080" if is_bs4k_downscale else "bwdif=mode=1:parity=-1:deint=0"
        br, maxr, bufs, gop, cq = "8M", "12M", "16M", "120", "22"

    if encoder == "h264_nvenc":
        return [
            "-vf", vf,
            "-c:v", "h264_nvenc",
            "-preset", "p2",
            "-rc", "vbr",
            "-cq", cq,
            "-b:v", br,
            "-maxrate", maxr,
            "-bufsize", bufs,
            "-g", gop,
            "-bf", "0",
            "-pix_fmt", "yuv420p",
        ]
    if encoder == "h264_qsv":
        return [
            "-vf", vf,
            "-c:v", "h264_qsv",
            "-preset", "veryfast",
            "-b:v", br,
            "-maxrate", maxr,
            "-g", gop,
            "-bf", "0",
            "-pix_fmt", "nv12",
        ]
    if encoder == "h264_amf":
        return [
            "-vf", vf,
            "-c:v", "h264_amf",
            "-quality", "speed",
            "-b:v", br,
            "-maxrate", maxr,
            "-g", gop,
            "-bf", "0",
            "-pix_fmt", "yuv420p",
        ]
    return [
        "-vf", vf,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", cq,
        "-maxrate", maxr,
        "-bufsize", bufs,
        "-g", gop,
        "-bf", "0",
        "-pix_fmt", "yuv420p",
    ]


def _detect_mmt_tlv_buf(buf):
    n = len(buf)
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
    valid_tlv = (0x01, 0x02, 0x03, 0xFE, 0xFF)
    limit = min(n - 12, 28672)
    for off in range(0, max(0, limit)):
        if buf[off] != 0x7F or buf[off + 1] not in valid_tlv:
            continue
        ln1 = (buf[off + 2] << 8) | buf[off + 3]
        p1 = off + 4 + ln1
        if p1 + 4 >= n or buf[p1] != 0x7F or buf[p1 + 1] not in valid_tlv:
            continue
        ln2 = (buf[p1 + 2] << 8) | buf[p1 + 3]
        p2 = p1 + 4 + ln2
        if p2 + 4 <= n and buf[p2] == 0x7F and buf[p2 + 1] in valid_tlv:
            return True
    return len(buf) > 0 and buf[0] == 0x7F and buf[0] != 0x47


def _safe_join(base_dir, rel_path):
    clean = os.path.normpath("/" + rel_path).lstrip("\\/")
    full = os.path.abspath(os.path.join(base_dir, clean))
    base_abs = os.path.abspath(base_dir)
    if full != base_abs and not full.startswith(base_abs + os.sep):
        return None
    return full


class PcDaemonHandler(yd.DaemonHandler):
    """LGTV 共通 DaemonHandler を継承し、PC 静的配信・GPU トランスコード・Tailscale 透過中継を追加する"""

    def _check_access(self):
        client_ip = (self.client_address[0] if self.client_address else "")
        if not _is_allowed_client(client_ip):
            self.send_response(403)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Forbidden: LAN or Tailscale access only")
            return False
        return True

    def _request_origin(self):
        host = (self.headers.get("Host") or "").strip()
        if not host:
            return f"http://127.0.0.1:{yd.PORT}"
        return f"http://{host}"

    def _rewrite_local_origin_str(self, text):
        origin = self._request_origin()
        local_prefix = f"http://127.0.0.1:{yd.PORT}"
        if origin != local_prefix and local_prefix in text:
            return text.replace(local_prefix, origin)
        return text

    def _send_json(self, obj, status=200):
        """親クラスが返す JSON 中の http://127.0.0.1:7019 を現在のアクセス元 Origin へ自動置換する"""
        body_str = json.dumps(obj, ensure_ascii=False)
        body_str = self._rewrite_local_origin_str(body_str)
        body = body_str.encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, full_path, inject_pc=False):
        if not full_path or not os.path.isfile(full_path):
            return self._send_json({"error": "not found"}, 404)
        with open(full_path, "rb") as f:
            raw = f.read()
        if inject_pc:
            txt = raw.decode("utf-8", errors="replace")
            if "</head>" in txt:
                ts = int(time.time())
                snippet = (
                    f'\n  <link rel="stylesheet" href="/pc/pc_style.css?v={ts}">\n'
                    f'  <script src="/pc/vendor/mpegts.min.js"></script>\n'
                    f'  <script src="/pc/vendor/hls.min.js"></script>\n'
                    f'  <script src="/pc/pc_adapter.js?v={ts}"></script>\n'
                )
                txt = txt.replace("</head>", snippet + "</head>", 1)
            raw = txt.encode("utf-8")
        ctype, _ = mimetypes.guess_type(full_path)
        if not ctype:
            ctype = "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _handle_pc_hls_proxy(self, target_url):
        """TVer VOD 等の外部 HLS を CORS 制限なしで再生できるよう中継する (Tailscale Origin 対応)"""
        if not target_url or not (target_url.startswith("http://") or target_url.startswith("https://")):
            return self._send_json({"error": "invalid url"}, 400)
        hdrs = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        }
        if "tver.jp" in target_url or "streaks.jp" in target_url:
            hdrs["Origin"] = "https://tver.jp"
            hdrs["Referer"] = "https://tver.jp/"
        elif "abema" in target_url:
            hdrs["Origin"] = "https://abema.tv"
            hdrs["Referer"] = "https://abema.tv/"

        origin = self._request_origin()
        req = urllib.request.Request(target_url, headers=hdrs)
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            ct = resp.headers.get("Content-Type") or "application/octet-stream"
            is_m3u8 = (".m3u8" in target_url.lower()) or ("mpegurl" in ct.lower()) or raw.lstrip().startswith(b"#EXTM3U")
            if is_m3u8:
                txt = raw.decode("utf-8", errors="replace")
                out_lines = []
                for line in txt.splitlines():
                    s = line.strip()
                    if not s:
                        continue
                    if s.startswith("#"):
                        if 'URI="' in s:
                            def _repl(m):
                                abs_u = urllib.parse.urljoin(target_url, m.group(1))
                                return 'URI="%s/pc/hls_proxy?url=%s"' % (
                                    origin, urllib.parse.quote(abs_u, safe="")
                                )
                            s = re.sub(r'URI="([^"]+)"', _repl, s)
                        out_lines.append(s)
                    else:
                        abs_u = urllib.parse.urljoin(target_url, s)
                        out_lines.append(
                            "%s/pc/hls_proxy?url=%s" % (origin, urllib.parse.quote(abs_u, safe=""))
                        )
                raw = ("\n".join(out_lines) + "\n").encode("utf-8")
                ct = "application/vnd.apple.mpegurl; charset=utf-8"

            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", ct)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    def _handle_abema_m3u8_remote(self):
        """親クラスの /api/abema/m3u8 出力中の 127.0.0.1:7019 を現在のアクセス元 Origin へ書き換えて返す"""
        orig_wfile = self.wfile
        buf = io.BytesIO()
        self.wfile = buf
        try:
            super().do_GET()
        finally:
            self.wfile = orig_wfile

        raw = buf.getvalue()
        sep = b"\r\n\r\n"
        idx = raw.find(sep)
        if idx == -1:
            self.wfile.write(raw)
            return
        head_bytes = raw[:idx]
        body_bytes = raw[idx + 4:]
        local_b = f"http://127.0.0.1:{yd.PORT}".encode("ascii")
        origin_b = self._request_origin().encode("ascii", errors="ignore")
        if origin_b != local_b and local_b in body_bytes:
            body_bytes = body_bytes.replace(local_b, origin_b)
            # Content-Length ヘッダーを再計算
            head_str = head_bytes.decode("iso-8859-1", errors="replace")
            head_str = re.sub(
                r"(?im)^Content-Length:\s*\d+\r?$",
                f"Content-Length: {len(body_bytes)}",
                head_str,
            )
            head_bytes = head_str.encode("iso-8859-1", errors="replace")
        self.wfile.write(head_bytes + sep + body_bytes)

    def _handle_lan_proxy(self, target_url, method="GET"):
        """
        自宅 LAN (Mirakurun / EPGStation 等) 向け透過プロキシ。
        Tailscale サブネットルーターなしでも外出先から番組表・ロゴ・録画サムネ・MP4再生(Rangeシーク)を利用可能にする。
        """
        if not _is_allowed_lan_target(target_url):
            return self._send_json({"error": "forbidden target (LAN private IP only)"}, 403)

        body = None
        cl_hdr = self.headers.get("Content-Length")
        if cl_hdr and method in ("POST", "PUT", "PATCH"):
            try:
                cl = int(cl_hdr)
                if cl > 0:
                    body = self.rfile.read(cl)
            except Exception:
                body = None

        fwd_hdrs = {
            "User-Agent": "DTVPlus-PC-Proxy/0.3",
        }
        for hk in ("Content-Type", "Accept", "Range", "If-None-Match", "If-Modified-Since"):
            hv = self.headers.get(hk)
            if hv:
                fwd_hdrs[hk] = hv

        req = urllib.request.Request(target_url, data=body, headers=fwd_hdrs, method=method)
        try:
            resp = urllib.request.urlopen(req, timeout=20)
            status = getattr(resp, "status", 200)
        except urllib.error.HTTPError as he:
            resp = he
            status = he.code
        except Exception as e:
            return self._send_json({"error": f"lan_proxy error: {e}"}, 502)

        try:
            self.send_response(status)
            self._cors()
            for hk in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Cache-Control", "ETag", "Last-Modified"):
                hv = resp.headers.get(hk)
                if hv:
                    self.send_header(hk, hv)
            self.end_headers()
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            try:
                resp.close()
            except Exception:
                pass

    def _pipe_pc_abema_live(self, source_m3u8_url, quality="high"):
        """
        PC Chrome (mpegts.js) 向けの ABEMA ライブ専用パイプライン:
        本編 (48kHz High 24/30fps) と TVCM (/tsad/: 44.1kHz Main 30fps) のフォーマット変化による
        ストリームエラー・音声ピッチ低下 (スロー化) を完全に根絶するため、
        連続 TS を GPU H.264 (30fps統一) + 48000Hz AAC 固定リサンプルで配信する。
        """
        if not yd.YDL_READY_EVENT.is_set() or yd.yt_dlp is None:
            yd.warmup_ytdlp()
        media_url, initial_txt = yd._select_abema_variant_url(source_m3u8_url)

        q = quality if quality in ("high", "medium", "mobile") else "high"
        if q == "mobile":
            vf = "scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p"
            br, maxr, bufs, cq, abr = "1500k", "2200k", "4400k", "27", "128k"
        elif q == "medium":
            vf = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p"
            br, maxr, bufs, cq, abr = "3000k", "4500k", "9000k", "25", "160k"
        else:
            # 4:3 本編 (640x480 等) <-> 16:9 TVCM (1920x1080) の往復でも SAR=1:1 / 1920x1080 単一 SPS を維持しフリーズを根絶
            vf = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p"
            br, maxr, bufs, cq, abr = "6M", "8M", "12M", "22", "192k"

        cmd = [
            FFMPEG_BIN, "-hide_banner", "-loglevel", "error",
            "-fflags", "+discardcorrupt",
            "-analyzeduration", "1500000",
            "-probesize", "2000000",
            "-f", "mpegts",
            "-i", "pipe:0",
            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-vf", vf,
            "-r", "30000/1001",
        ]
        if HW_ENCODER == "h264_nvenc":
            cmd.extend(["-c:v", "h264_nvenc", "-preset", "p2", "-rc", "vbr", "-cq", cq, "-b:v", br, "-maxrate", maxr, "-bufsize", bufs, "-g", "60", "-bf", "0", "-pix_fmt", "yuv420p"])
        elif HW_ENCODER == "h264_qsv":
            cmd.extend(["-c:v", "h264_qsv", "-preset", "veryfast", "-b:v", br, "-maxrate", maxr, "-g", "60", "-bf", "0", "-pix_fmt", "nv12"])
        elif HW_ENCODER == "h264_amf":
            cmd.extend(["-c:v", "h264_amf", "-quality", "speed", "-b:v", br, "-maxrate", maxr, "-g", "60", "-bf", "0", "-pix_fmt", "yuv420p"])
        else:
            cmd.extend(["-c:v", "libx264", "-preset", "veryfast", "-crf", cq, "-maxrate", maxr, "-bufsize", bufs, "-g", "60", "-bf", "0", "-pix_fmt", "yuv420p"])

        cmd.extend([
            "-c:a", "aac",
            "-ar", "48000",
            "-ac", "2",
            "-b:a", abr,
            "-f", "mpegts",
            "pipe:1",
        ])

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

        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        stop_ev = threading.Event()

        def feeder():
            fetcher = yd._AbemaKeepAliveFetcher()
            normalizer = yd.AbemaContinuousTSNormalizer(normalize_pcr=True)
            last_seq = -1
            first_round = True
            idle_errors = 0
            init_txt = initial_txt
            try:
                while not stop_ev.is_set() and proc.poll() is None:
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
                            if stop_ev.is_set() or proc.poll() is not None:
                                break
                            last_seq = sg["seq"]
                            raw = fetcher.get(sg["url"], timeout=10)
                            if sg["ticket"]:
                                key = yd.get_abema_videokey(sg["ticket"])
                                iv = sg["iv"] if sg["iv"] is not None else sg["seq"].to_bytes(16, "big")
                                raw = yd.decrypt_aes_128_cbc(raw, key, iv)
                            normalized = normalizer.process_segment(raw, is_discontinuity=sg["disc"], is_ad_segment=False)
                            if normalized:
                                proc.stdin.write(normalized)
                    except Exception:
                        idle_errors += 1
                        if idle_errors >= 10:
                            break
                        stop_ev.wait(0.9)
            except Exception:
                pass
            finally:
                fetcher.close_all()
                try:
                    proc.stdin.close()
                except Exception:
                    pass

        th = threading.Thread(target=feeder, daemon=True)
        th.start()
        try:
            while True:
                out_chunk = proc.stdout.read(65536)
                if not out_chunk:
                    break
                self.wfile.write(out_chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            stop_ev.set()
            try:
                proc.kill()
                proc.wait(timeout=2)
            except Exception:
                pass

    def _pipe_pc_stream(self, target_url, range_start_byte=0, explicit_sid=0, stream_mode="", bs4k_codec="hevc", quality="high"):
        """
        PC Chrome (mpegts.js) 向けの放送波・録画ストリーミング処理:
        - BS4K (MMT/TLV): Mmt2TsRemuxer で HEVC+AAC TS 化 (quality=high かつ codec=hevc なら映像無劣化、
          リモート省帯域モードや codec=h264 なら GPU H.264 変換)
        - GR/BS/CS (MPEG-2 TS): SIDEBAND_HUB へ分岐しつつ ffmpeg GPU エンコードで H.264+AAC MPEG-TS 出力
        """
        req_headers = {
            "User-Agent": "DTVPlus-PC/0.3",
            "X-Mirakurun-Priority": "2",
        }
        if range_start_byte > 0:
            req_headers["Range"] = f"bytes={range_start_byte}-"

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

        first_chunk = up.read(32768)
        if not first_chunk:
            try:
                up.close()
            except Exception:
                pass
            return self._send_json({"error": "empty upstream stream"}, 502)

        is_mmt_tlv = (stream_mode == "bs4k") or _detect_mmt_tlv_buf(first_chunk)
        q = quality if quality in ("high", "medium", "mobile") else "high"
        audio_br = "128k" if q == "mobile" else ("160k" if q == "medium" else "192k")

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

        read_fn = getattr(up, "read1", up.read)

        cmd = [
            FFMPEG_BIN, "-hide_banner", "-loglevel", "error",
            "-fflags", "+discardcorrupt",
            "-analyzeduration", "2000000",
            "-probesize", "3000000",
            "-f", "mpegts",
            "-i", "pipe:0",
            "-map", "0:v:0",
            "-map", "0:a:0?",
        ]
        # BS4K 高画質モードかつ HEVC 再生可能時のみ映像完全無劣化コピー。
        # リモート省帯域モード (medium/mobile) や h264 指定時は GPU で縮小 H.264 化。
        if is_mmt_tlv and bs4k_codec != "h264" and q == "high":
            cmd.extend(["-c:v", "copy"])
        else:
            cmd.extend(_build_ffmpeg_video_args(HW_ENCODER, is_bs4k_downscale=is_mmt_tlv, quality=q))
        cmd.extend([
            "-c:a", "aac",
            "-b:a", audio_br,
            "-ac", "2",
            "-ar", "48000",
            "-f", "mpegts",
            "pipe:1",
        ])

        sb_session = None if is_mmt_tlv else yd.SIDEBAND_HUB.begin_session(target_url, explicit_sid, range_start_byte)
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )

        def feeder():
            remuxer = Mmt2TsRemuxer(explicit_sid) if is_mmt_tlv else None
            try:
                if remuxer:
                    o0 = remuxer.feed(first_chunk)
                    if o0:
                        proc.stdin.write(o0)
                else:
                    try:
                        yd.SIDEBAND_HUB.feed(sb_session, first_chunk)
                    except Exception:
                        pass
                    proc.stdin.write(first_chunk)

                while True:
                    data = read_fn(65536)
                    if not data:
                        break
                    if remuxer:
                        out = remuxer.feed(data)
                        if out:
                            proc.stdin.write(out)
                    else:
                        try:
                            yd.SIDEBAND_HUB.feed(sb_session, data)
                        except Exception:
                            pass
                        proc.stdin.write(data)
                if remuxer:
                    tail = remuxer.flush()
                    if tail:
                        proc.stdin.write(tail)
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

        th = threading.Thread(target=feeder, daemon=True)
        th.start()
        try:
            while True:
                out_chunk = proc.stdout.read(65536)
                if not out_chunk:
                    break
                self.wfile.write(out_chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
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

    def _enforce_local_or_sync_acl(self, method, path):
        # PC 版サーバーは _check_access() で LAN / Tailscale 許可を管理する
        return self._check_access()

    @staticmethod
    def _rewrite_loopback_for_tv(url_str, pc_lan_ip):
        """PC 版で 127.0.0.1 / localhost になっている URL を TV から届く PC の LAN IP へ変換する"""
        s = str(url_str or "").strip()
        if not s or not pc_lan_ip:
            return s
        try:
            p = urllib.parse.urlparse(s)
            if p.scheme in ("http", "https") and p.hostname in ("127.0.0.1", "localhost"):
                netloc = f"{pc_lan_ip}:{p.port}" if p.port else pc_lan_ip
                return urllib.parse.urlunparse((p.scheme, netloc, p.path, p.params, p.query, p.fragment))
        except Exception:
            pass
        return s

    def _handle_sync_to_tv(self):
        try:
            cl = int(self.headers.get("Content-Length") or "0")
            if cl <= 0 or cl > 65536:
                return self._send_json({"ok": False, "error": "invalid payload"}, 400)
            raw = self.rfile.read(cl).decode("utf-8", errors="replace")
            body = json.loads(raw)
        except Exception as e:
            return self._send_json({"ok": False, "error": f"invalid json: {e}"}, 400)

        tv_ip = str(body.get("tvIp") or "").strip()
        # http://192.168.x.x:7019 形式で貼られた場合もホスト部だけ抽出
        if "://" in tv_ip:
            try:
                tv_ip = urllib.parse.urlparse(tv_ip).hostname or ""
            except Exception:
                tv_ip = ""
        tv_ip = tv_ip.split(":")[0].strip()
        if not tv_ip or not _is_ip_in_nets(tv_ip, ALLOWED_LAN_PROXY_NETS):
            return self._send_json({"ok": False, "error": "LAN 内の有効な TV IP アドレスを指定してください"}, 400)

        raw_settings = body.get("settings")
        if not isinstance(raw_settings, dict):
            return self._send_json({"ok": False, "error": "settings object required"}, 400)

        clean = yd.sanitize_synced_settings(raw_settings)
        pc_lan_ip = yd.get_local_lan_ip()
        if pc_lan_ip:
            for k in ("mirakurunUrl", "bs4kMirakurunUrl", "epgstationUrl", "mediaSaveServerUrl"):
                if k in clean and isinstance(clean[k], str):
                    clean[k] = self._rewrite_loopback_for_tv(clean[k], pc_lan_ip)
            if isinstance(clean.get("epgstationServers"), list):
                for srv in clean["epgstationServers"]:
                    if isinstance(srv, dict) and srv.get("url"):
                        srv["url"] = self._rewrite_loopback_for_tv(srv["url"], pc_lan_ip)

        target_url = f"http://{tv_ip}:{yd.PORT}/api/sync/settings"
        payload_bytes = json.dumps({"settings": clean}, ensure_ascii=False).encode("utf-8")
        try:
            req = urllib.request.Request(
                target_url,
                data=payload_bytes,
                method="POST",
                headers={"Content-Type": "application/json; charset=utf-8"},
            )
            with urllib.request.urlopen(req, timeout=6) as resp:
                resp_body = resp.read().decode("utf-8", errors="replace")
                resp_json = json.loads(resp_body) if resp_body else {"ok": True}
            resp_json["tvIp"] = tv_ip
            resp_json["ok"] = True
            return self._send_json(resp_json, 200)
        except urllib.error.HTTPError as e:
            err_txt = ""
            try:
                err_txt = e.read().decode("utf-8", errors="replace")[:200]
            except Exception:
                pass
            return self._send_json({"ok": False, "error": f"TV 応答エラー HTTP {e.code}: {err_txt}"}, 502)
        except Exception as e:
            return self._send_json({"ok": False, "error": f"TV ({tv_ip}) に接続できません。TV で DTV Plus が起動中か、同一 LAN 内か確認してください ({e})"}, 502)

    def do_OPTIONS(self):
        if not self._check_access():
            return
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range, X-Mirakurun-Priority")
        self.end_headers()

    def do_POST(self):
        if not self._check_access():
            return
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/pc/lan_proxy":
            return self._handle_lan_proxy((qs.get("target") or [""])[0], method="POST")
        if parsed.path == "/pc/sync_to_tv":
            return self._handle_sync_to_tv()
        return super().do_POST()

    def do_PUT(self):
        if not self._check_access():
            return
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/pc/lan_proxy":
            return self._handle_lan_proxy((qs.get("target") or [""])[0], method="PUT")
        return self._send_json({"error": "method not allowed"}, 405)

    def do_DELETE(self):
        if not self._check_access():
            return
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/pc/lan_proxy":
            return self._handle_lan_proxy((qs.get("target") or [""])[0], method="DELETE")
        return super().do_DELETE()

    def do_GET(self):
        if not self._check_access():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        try:
            if path == "/api/device/info":
                ver_str = yd.yt_dlp.version.__version__ if (yd.YDL_READY_EVENT.is_set() and yd.yt_dlp) else "loading..."
                return self._send_json({
                    "ok": True,
                    "app": "dtvplus-pc",
                    "platform": "pc",
                    "port": yd.PORT,
                    "lanIp": yd.get_local_lan_ip(),
                    "ytdlpVersion": ver_str,
                })

            if path == "/pc/discover_tv":
                return self._send_json(yd.discover_lan_servers("tv"))

            if path == "/api/ping":
                ver_str = yd.yt_dlp.version.__version__ if (yd.YDL_READY_EVENT.is_set() and yd.yt_dlp) else "loading..."
                return self._send_json({
                    "ok": True,
                    "ready": yd.YDL_READY_EVENT.is_set(),
                    "platform": "pc",
                    "hwEncoder": HW_ENCODER,
                    "tailscaleIp": TAILSCALE_IP or None,
                    "tailscaleUrl": f"http://{TAILSCALE_IP}:{yd.PORT}/" if TAILSCALE_IP else None,
                    "ytdlpVersion": ver_str,
                    "pythonVersion": sys.version.split()[0],
                    "ts": int(time.time() * 1000),
                })

            if path == "/" or path == "/index.html":
                return self._serve_static(os.path.join(APP_DIR, "index.html"), inject_pc=True)

            if path == "/pc/lan_proxy":
                return self._handle_lan_proxy((qs.get("target") or [""])[0], method="GET")

            if path.startswith("/pc/hls_proxy"):
                u = (qs.get("url") or [""])[0]
                return self._handle_pc_hls_proxy(u)

            if path == "/api/abema/m3u8":
                return self._handle_abema_m3u8_remote()

            if path.startswith("/pc/abema_live") and qs.get("url"):
                u = qs["url"][0]
                quality = (qs.get("quality") or ["high"])[0]
                return self._pipe_pc_abema_live(u, quality)

            if path.startswith("/pc/stream") and qs.get("target"):
                target = qs["target"][0]
                explicit_sid = int((qs.get("sid") or ["0"])[0] or 0)
                stream_mode = (qs.get("mode") or [""])[0]
                bs4k_codec = (qs.get("codec") or ["hevc"])[0]
                quality = (qs.get("quality") or ["high"])[0]
                return self._pipe_pc_stream(target, 0, explicit_sid, stream_mode, bs4k_codec, quality)

            if path.startswith("/pc/recorded") and qs.get("target"):
                target = qs["target"][0]
                offset_sec = float((qs.get("offsetSec") or ["0"])[0] or 0)
                dur_sec = float((qs.get("durationSec") or ["0"])[0] or 0)
                total_size = int((qs.get("size") or ["0"])[0] or 0)
                explicit_sid = int((qs.get("sid") or ["0"])[0] or 0)
                stream_mode = (qs.get("mode") or [""])[0]
                bs4k_codec = (qs.get("codec") or ["hevc"])[0]
                quality = (qs.get("quality") or ["high"])[0]
                start_byte = 0
                if offset_sec > 1.0 and dur_sec > 5.0 and total_size > 18800:
                    ratio = max(0.0, min(0.992, offset_sec / dur_sec))
                    start_byte = (int(ratio * total_size) // 188) * 188
                return self._pipe_pc_stream(target, start_byte, explicit_sid, stream_mode, bs4k_codec, quality)

            if path.startswith("/pc/"):
                rel = path[len("/pc/"):]
                return self._serve_static(_safe_join(PC_DIR, rel), inject_pc=False)

            # app/ 配下の静的ファイル (/css/, /js/, /icon*.png 等)
            if not path.startswith("/api/") and not path.startswith("/stream") and not path.startswith("/recorded"):
                cand = _safe_join(APP_DIR, path.lstrip("/"))
                if cand and os.path.isfile(cand):
                    return self._serve_static(cand, inject_pc=False)

        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return
        except Exception as e:
            try:
                return self._send_json({"error": str(e)}, 500)
            except Exception:
                return

        return super().do_GET()


def main():
    mimetypes.init()
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")

    threading.Thread(target=yd.warmup_ytdlp, daemon=True).start()
    threading.Thread(target=detect_hw_encoder, daemon=True).start()
    threading.Thread(target=detect_tailscale_ip, daemon=True).start()

    try:
        # 0.0.0.0 で待受 (LAN / Tailscale からの接続を _check_access で許可制制御)
        srv = ThreadingHTTPServer(("0.0.0.0", yd.PORT), PcDaemonHandler)
    except OSError:
        print(f"[dtvplus-pc] Port {yd.PORT} is already in use (already running).", flush=True)
        sys.exit(0)

    print(f"[dtvplus-pc] Server started on http://127.0.0.1:{yd.PORT}/ (LAN & Tailscale ready)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
