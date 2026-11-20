#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mmt2ts_pc.py - PC版 DTV Plus 用 ARIB STD-B32 / STD-B60 BS4K (MMT/TLV) -> MPEG-2 TS 無劣化リマキサー
- app/backend/mmt2ts.c と同一仕様の Pure Python 高速実装 (Cコンパイラ不要で Windows 動作)
- HEVC/H.265 (0x24) + AAC-ADTS (0x0F) / LATM (0x11) を無劣化のまま標準 MPEG-2 TS へ変換する
"""
import struct
import sys

TS_PID_PAT = 0x0000
TS_PID_PMT = 0x0100
TS_PID_VIDEO = 0x0101
TS_PID_AUDIO0 = 0x0102

MAX_MPU_CACHE = 64
VIDEO_STYPES_H265 = (b"hev1", b"hvc1")


def _make_crc32_table():
    tbl = []
    for i in range(256):
        c = i << 24
        for _ in range(8):
            c = (((c << 1) ^ 0x04C11DB7) & 0xFFFFFFFF) if (c & 0x80000000) else ((c << 1) & 0xFFFFFFFF)
        tbl.append(c)
    return tbl


_CRC32_TBL = _make_crc32_table()


def _calc_crc32(data):
    crc = 0xFFFFFFFF
    tbl = _CRC32_TBL
    for b in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ tbl[((crc >> 24) ^ b) & 0xFF]
    return crc


def _ntp64_to_90khz(nsec, nfrac):
    return ((nsec * 90000) + ((nfrac * 90000) >> 32)) & 0x1FFFFFFFF


def _encode_ts_timestamp(prefix4, ts90k):
    ts90k &= 0x1FFFFFFFF
    return bytes((
        (prefix4 << 4) | (((ts90k >> 30) & 0x07) << 1) | 0x01,
        (ts90k >> 22) & 0xFF,
        (((ts90k >> 15) & 0x7F) << 1) | 0x01,
        (ts90k >> 7) & 0xFF,
        ((ts90k & 0x7F) << 1) | 0x01,
    ))


class _BitReader:
    __slots__ = ("data", "len", "bitpos")

    def __init__(self, data):
        self.data = data
        self.len = len(data)
        self.bitpos = 0

    def read(self, nbits):
        val = 0
        data = self.data
        dlen = self.len
        bp = self.bitpos
        for _ in range(nbits):
            bi = bp >> 3
            if bi >= dlen:
                self.bitpos = bp
                return val
            val = (val << 1) | ((data[bi] >> (7 - (bp & 7))) & 1)
            bp += 1
        self.bitpos = bp
        return val


def _latm_get_value(br):
    n = br.read(2)
    val = 0
    for _ in range(n + 1):
        val = (val << 8) | br.read(8)
    return val


def _parse_asc(br, cfg):
    aot = br.read(5)
    if aot == 31:
        aot = 32 + br.read(6)
    sri = br.read(4)
    if sri == 15:
        br.read(24)
    ch = br.read(4)
    if aot in (5, 29):
        ext_sri = br.read(4)
        if ext_sri == 15:
            br.read(24)
        aot = br.read(5)
        if aot == 31:
            aot = 32 + br.read(6)
        if aot == 22:
            br.read(4)
    if aot in (1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23):
        br.read(1)  # frame_len_flag
        if br.read(1):
            br.read(14)
        ext_flag = br.read(1)
        if ch == 0:
            return False
        if aot in (6, 20):
            br.read(3)
        if ext_flag:
            if aot == 22:
                br.read(5)
                br.read(11)
            if aot in (17, 19, 20, 23):
                br.read(3)
            br.read(1)
    else:
        return False
    if sri >= 13 or ch == 0 or ch > 7:
        return False
    cfg["valid"] = True
    cfg["aot"] = aot
    cfg["sri"] = sri
    cfg["ch"] = ch
    return True


def _latm_to_adts(latm, cfg):
    br = _BitReader(latm)
    if not br.read(1):  # useSameStreamMux
        ver = br.read(1)
        ver_a = br.read(1) if ver == 1 else 0
        if ver_a != 0:
            return None
        if ver == 1:
            _latm_get_value(br)
        if not br.read(1):  # allStreamsSameTimeFraming
            return None
        if br.read(6) != 0 or br.read(4) != 0 or br.read(3) != 0:
            return None
        if ver == 0:
            if not _parse_asc(br, cfg):
                return None
        else:
            asc_len = _latm_get_value(br)
            st_bit = br.bitpos
            if not _parse_asc(br, cfg):
                return None
            if br.bitpos < st_bit + asc_len:
                br.bitpos = st_bit + asc_len
        if br.read(3) != 0:
            return None
        br.read(8)  # latmBufferFullness
        if br.read(1):  # otherDataPresent
            if ver == 1:
                _latm_get_value(br)
            else:
                while True:
                    esc = br.read(1)
                    br.read(8)
                    if not esc:
                        break
        if br.read(1):  # crcCheckPresent
            br.read(8)
    if not cfg.get("valid"):
        return None
    mux_len = 0
    while True:
        tmp = br.read(8)
        mux_len += tmp
        if tmp != 255:
            break
    if mux_len == 0 or br.bitpos + mux_len * 8 > len(latm) * 8:
        return None
    frame_len = mux_len + 7
    profile = (cfg["aot"] - 1) if cfg["aot"] > 0 else 1
    if profile > 3:
        profile = 1
    sri = cfg["sri"]
    ch = cfg["ch"]
    hdr = bytes((
        0xFF,
        0xF1,
        ((profile & 3) << 6) | ((sri & 0x0F) << 2) | ((ch >> 2) & 1),
        ((ch & 3) << 6) | ((frame_len >> 11) & 3),
        (frame_len >> 3) & 0xFF,
        ((frame_len & 7) << 5) | 0x1F,
        0xFC,
    ))
    # バイト境界に揃っていれば高速スライス、非整列ならシフト抽出
    bp = br.bitpos
    if (bp & 7) == 0:
        off = bp >> 3
        return hdr + bytes(latm[off : off + mux_len])
    shift = bp & 7
    inv = 8 - shift
    off = bp >> 3
    payload = bytearray(mux_len)
    for i in range(mux_len):
        b0 = latm[off + i]
        b1 = latm[off + i + 1] if (off + i + 1) < len(latm) else 0
        payload[i] = ((b0 << shift) & 0xFF) | (b1 >> inv)
    return hdr + bytes(payload)


class _AssetTiming:
    __slots__ = ("mmt_pid", "timescale", "default_pts_off", "entries", "has_last_pts", "last_pts90k", "last_dts90k")

    def __init__(self):
        self.mmt_pid = 0
        self.timescale = 0
        self.default_pts_off = 0
        self.entries = {}
        self.has_last_pts = False
        self.last_pts90k = 0
        self.last_dts90k = 0

    def get_entry(self, seq, alloc=False):
        e = self.entries.get(seq)
        if e is not None:
            return e
        if not alloc:
            return None
        if len(self.entries) >= MAX_MPU_CACHE:
            # 古いエントリを半分整理
            oldest = sorted(self.entries.keys())[: MAX_MPU_CACHE // 2]
            for k in oldest:
                self.entries.pop(k, None)
        e = {
            "pts90k": 0,
            "has_ext": False,
            "timescale": self.timescale or 180000,
            "default_pts_off": self.default_pts_off,
            "decoding_time_off": 0,
            "dts_pts_off": [],
            "au_dur": [],
        }
        self.entries[seq] = e
        return e

    def parse_descriptors(self, desc):
        p = 0
        d_total = len(desc)
        while p + 3 <= d_total:
            dtag = (desc[p] << 8) | desc[p + 1]
            dlen = desc[p + 2]
            p += 3
            if p + dlen > d_total:
                break
            b = desc[p : p + dlen]
            p += dlen

            if dtag == 0x0001:
                q = 0
                while q + 12 <= dlen:
                    seq, nsec, nfrac = struct.unpack_from(">III", b, q)
                    e = self.get_entry(seq, True)
                    e["pts90k"] = _ntp64_to_90khz(nsec, nfrac)
                    q += 12
            elif dtag == 0x8026 and dlen >= 1:
                q = 0
                flags = b[q]
                q += 1
                pts_off_type = (flags >> 1) & 3
                ts_flag = flags & 1
                ts_val = self.timescale or 180000
                def_off = self.default_pts_off
                if ts_flag and q + 4 <= dlen:
                    ts_val = struct.unpack_from(">I", b, q)[0]
                    q += 4
                    if ts_val > 0:
                        self.timescale = ts_val
                if pts_off_type == 1 and q + 2 <= dlen:
                    def_off = (b[q] << 8) | b[q + 1]
                    q += 2
                    self.default_pts_off = def_off
                while q + 8 <= dlen:
                    seq = struct.unpack_from(">I", b, q)[0]
                    q += 5  # seq(4) + leap/res(1)
                    dto = (b[q] << 8) | b[q + 1]
                    q += 2
                    num_au = b[q]
                    q += 1
                    e = self.get_entry(seq, True)
                    e["has_ext"] = True
                    e["timescale"] = ts_val
                    e["default_pts_off"] = def_off
                    e["decoding_time_off"] = dto
                    dpos = []
                    durs = []
                    for _ in range(num_au):
                        if q + 2 > dlen:
                            break
                        dpo = (b[q] << 8) | b[q + 1]
                        q += 2
                        dur = def_off
                        if pts_off_type == 2:
                            if q + 2 > dlen:
                                break
                            dur = (b[q] << 8) | b[q + 1]
                            q += 2
                        dpos.append(dpo)
                        durs.append(dur)
                    e["dts_pts_off"] = dpos
                    e["au_dur"] = durs

    def compute(self, mpu_seq, sample_num, default_step_90k):
        idx = (sample_num - 1) if sample_num > 0 else 0
        e = self.get_entry(mpu_seq, False)
        if e is not None and e["pts90k"] != 0:
            ts = (e["timescale"] if (e["has_ext"] and e["timescale"] > 0) else (self.timescale or 180000))
            if e["has_ext"] and idx < len(e["dts_pts_off"]):
                durs = e["au_dur"]
                def_o = e["default_pts_off"]
                acc = 0
                for i in range(idx):
                    acc += durs[i] if durs[i] else def_o
                rel_dts = acc - e["decoding_time_off"]
                dts_delta_90k = int((rel_dts * 90000) / ts)
                pts_off_90k = int((e["dts_pts_off"][idx] * 90000) / ts)
                dts = (e["pts90k"] + dts_delta_90k) & 0x1FFFFFFFF
                pts = (dts + pts_off_90k) & 0x1FFFFFFFF
                has_dts = (e["dts_pts_off"][idx] != 0 or e["decoding_time_off"] != 0)
                self.has_last_pts = True
                self.last_pts90k = pts
                self.last_dts90k = dts
                return True, pts, dts, has_dts
            step = int((self.default_pts_off * 90000) / self.timescale) if (self.default_pts_off and self.timescale) else default_step_90k
            pts = (e["pts90k"] + idx * step) & 0x1FFFFFFFF
            self.has_last_pts = True
            self.last_pts90k = pts
            self.last_dts90k = pts
            return True, pts, pts, False

        if self.has_last_pts:
            self.last_dts90k = (self.last_dts90k + default_step_90k) & 0x1FFFFFFFF
            self.last_pts90k = (self.last_pts90k + default_step_90k) & 0x1FFFFFFFF
            return True, self.last_pts90k, self.last_dts90k, False
        return False, 0, 0, False


class Mmt2TsRemuxer:
    """ストリーム単位の ARIB MMT/TLV -> MPEG-2 TS リマキサー"""

    def __init__(self, target_service_id=0):
        self.target_service_id = int(target_service_id or 0)
        self.active_service_id = 0
        self.pa_pid = 0
        self.video_mmt_pid = 0
        self.audio_mmt_pids = []
        self.audio_stream_types = [0x0F, 0x0F]

        self.video_timing = _AssetTiming()
        self.audio_timings = [_AssetTiming(), _AssetTiming()]
        self.audio_latm_cfgs = [{}, {}]

        self.cc = {TS_PID_PAT: 0, TS_PID_PMT: 0, TS_PID_VIDEO: 0, TS_PID_AUDIO0: 0, TS_PID_AUDIO0 + 1: 0}

        self.vps = b""
        self.sps = b""
        self.pps = b""

        self.au_buf = bytearray()
        self.au_has_active = False
        self.au_mpu_seq = 0
        self.au_sample_num = 0
        self.au_is_keyframe = False
        self.au_has_vps = False
        self.au_has_sps = False
        self.au_has_pps = False
        self.au_has_aud = False

        self.vid_last_mpu_seq = -1
        self.vid_mpu_au_counter = 0
        self.aud_last_mpu_seq = [-1, -1]
        self.aud_mpu_au_counter = [0, 0]

        self.video_started = False
        self.last_pat_pmt_dts = 0
        self.video_base_dts = 0

        self.vid_mfu = {"active": False, "seq": 0, "snum": 0, "buf": bytearray()}
        self.aud_mfus = [
            {"active": False, "seq": 0, "snum": 0, "buf": bytearray()},
            {"active": False, "seq": 0, "snum": 0, "buf": bytearray()},
        ]
        self.sig_asms = {}

        self.in_buf = bytearray()
        self.out_buf = bytearray()

    def _emit_psi(self, pid, sec):
        cc = self.cc[pid]
        self.cc[pid] = (cc + 1) & 0x0F
        hdr = bytes((0x47, 0x40 | ((pid >> 8) & 0x1F), pid & 0xFF, 0x10 | cc, 0x00))
        sec = sec[:183]
        self.out_buf.extend(hdr)
        self.out_buf.extend(sec)
        pad = 183 - len(sec)
        if pad > 0:
            self.out_buf.extend(b"\xff" * pad)

    def _emit_pat_pmt(self):
        pnum = self.active_service_id or 101
        pat_body = bytes((
            0x00, 0xB0, 0x0D, 0x00, 0x01, 0xC1, 0x00, 0x00,
            (pnum >> 8) & 0xFF, pnum & 0xFF,
            0xE0 | ((TS_PID_PMT >> 8) & 0x1F), TS_PID_PMT & 0xFF,
        ))
        self._emit_psi(TS_PID_PAT, pat_body + struct.pack(">I", _calc_crc32(pat_body)))

        sec = bytearray((
            0x02, 0xB0, 0x00,
            (pnum >> 8) & 0xFF, pnum & 0xFF,
            0xC1, 0x00, 0x00,
            0xE0 | ((TS_PID_VIDEO >> 8) & 0x1F), TS_PID_VIDEO & 0xFF,
            0xF0, 0x00,
            0x24, 0xE0 | ((TS_PID_VIDEO >> 8) & 0x1F), TS_PID_VIDEO & 0xFF, 0xF0, 0x00,
        ))
        n_aud = max(1, min(2, len(self.audio_mmt_pids)))
        for i in range(n_aud):
            apid = TS_PID_AUDIO0 + i
            sec.extend((
                self.audio_stream_types[i],
                0xE0 | ((apid >> 8) & 0x1F), apid & 0xFF,
                0xF0, 0x06, 0x0A, 0x04, ord("j"), ord("p"), ord("n"), 0x00,
            ))
        pmt_len = (len(sec) - 3) + 4
        sec[1] = 0xB0 | ((pmt_len >> 8) & 0x0F)
        sec[2] = pmt_len & 0xFF
        sec.extend(struct.pack(">I", _calc_crc32(sec)))
        self._emit_psi(TS_PID_PMT, bytes(sec))

    def _write_pes(self, pid, stream_id, payload, pts90k, has_dts, dts90k, emit_pcr, pcr90k, is_rai):
        opt_len = 10 if has_dts else 5
        total_pes_len = 3 + opt_len + len(payload)
        pes_len_field = total_pes_len if total_pes_len <= 65535 else 0
        pes_hdr = bytearray((
            0x00, 0x00, 0x01, stream_id,
            (pes_len_field >> 8) & 0xFF, pes_len_field & 0xFF,
            0x80, 0xC0 if has_dts else 0x80, opt_len,
        ))
        if has_dts:
            pes_hdr.extend(_encode_ts_timestamp(0x03, pts90k))
            pes_hdr.extend(_encode_ts_timestamp(0x01, dts90k))
        else:
            pes_hdr.extend(_encode_ts_timestamp(0x02, pts90k))

        data = bytes(pes_hdr) + bytes(payload)
        total = len(data)
        sent = 0
        first = True
        pid_hi = (pid >> 8) & 0x1F
        pid_lo = pid & 0xFF
        cc = self.cc[pid]
        out = self.out_buf

        while sent < total:
            rem = total - sent
            want_pcr = first and emit_pcr
            want_rai = first and is_rai
            af_min = 8 if want_pcr else (2 if want_rai else 0)
            max_pay = 184 - af_min
            if rem >= max_pay:
                take = max_pay
                af_len = af_min
            else:
                take = rem
                af_len = af_min + (max_pay - take)

            b1 = (0x40 if first else 0x00) | pid_hi
            if af_len > 0:
                out.extend((0x47, b1, pid_lo, 0x30 | cc, af_len - 1))
                if af_len >= 2:
                    flags = (0x40 if want_rai else 0) | (0x10 if want_pcr else 0)
                    out.append(flags)
                    written_af = 2
                    if want_pcr:
                        pb = pcr90k & 0x1FFFFFFFF
                        out.extend((
                            (pb >> 25) & 0xFF,
                            (pb >> 17) & 0xFF,
                            (pb >> 9) & 0xFF,
                            (pb >> 1) & 0xFF,
                            ((pb & 1) << 7) | 0x7E,
                            0x00,
                        ))
                        written_af = 8
                    if written_af < af_len:
                        out.extend(b"\xff" * (af_len - written_af))
            else:
                out.extend((0x47, b1, pid_lo, 0x10 | cc))
            out.extend(data[sent : sent + take])
            cc = (cc + 1) & 0x0F
            sent += take
            first = False

        self.cc[pid] = cc

    def _flush_video_au(self):
        if not self.au_has_active or not self.au_buf:
            self.au_buf.clear()
            self.au_has_active = False
            return

        ok, pts, dts, has_dts = self.video_timing.compute(self.au_mpu_seq, self.au_sample_num, 1502)
        if not ok:
            self.au_buf.clear()
            self.au_has_active = False
            return

        if not self.video_started:
            if not self.au_is_keyframe or not self.vps or not self.sps or not self.pps:
                self.au_buf.clear()
                self.au_has_active = False
                return
            self.video_started = True
            self._emit_pat_pmt()

        dts_diff = (dts - self.last_pat_pmt_dts) & 0x1FFFFFFFF
        if self.au_is_keyframe or self.last_pat_pmt_dts == 0 or dts_diff >= 18000:
            self._emit_pat_pmt()
            self.last_pat_pmt_dts = dts
        self.video_base_dts = dts

        payload = self.au_buf
        if self.au_is_keyframe and (not self.au_has_vps or not self.au_has_sps or not self.au_has_pps) and self.vps and self.sps and self.pps:
            prefix = bytearray()
            if not self.au_has_aud:
                prefix.extend(b"\x00\x00\x00\x01\x46\x01\x50")
            if not self.au_has_vps:
                prefix.extend(b"\x00\x00\x00\x01")
                prefix.extend(self.vps)
            if not self.au_has_sps:
                prefix.extend(b"\x00\x00\x00\x01")
                prefix.extend(self.sps)
            if not self.au_has_pps:
                prefix.extend(b"\x00\x00\x00\x01")
                prefix.extend(self.pps)
            prefix.extend(payload)
            payload = prefix

        pcr90k = (dts - 63000) & 0x1FFFFFFFF
        self._write_pes(TS_PID_VIDEO, 0xE0, payload, pts, has_dts, dts, True, pcr90k, self.au_is_keyframe)

        self.au_buf.clear()
        self.au_has_active = False
        self.au_is_keyframe = False
        self.au_has_vps = self.au_has_sps = self.au_has_pps = self.au_has_aud = False

    def _begin_new_video_au(self, mpu_seq, sample_num):
        if mpu_seq != self.vid_last_mpu_seq:
            self.vid_last_mpu_seq = mpu_seq
            self.vid_mpu_au_counter = 1
        else:
            self.vid_mpu_au_counter += 1
        self.au_has_active = True
        self.au_mpu_seq = mpu_seq
        self.au_sample_num = sample_num if sample_num > 0 else self.vid_mpu_au_counter
        self.au_buf.clear()
        self.au_is_keyframe = False
        self.au_has_vps = self.au_has_sps = self.au_has_pps = self.au_has_aud = False

    def _handle_hevc_mfu(self, mpu_seq, sample_num, mfu):
        if self.au_has_active and (self.au_mpu_seq != mpu_seq or (sample_num > 0 and self.au_sample_num != sample_num)):
            self._flush_video_au()
        p = 0
        mlen = len(mfu)
        while p + 4 <= mlen:
            nlen = (mfu[p] << 24) | (mfu[p + 1] << 16) | (mfu[p + 2] << 8) | mfu[p + 3]
            p += 4
            if nlen == 0 or p + nlen > mlen:
                break
            nal = mfu[p : p + nlen]
            p += nlen
            nal_type = (nal[0] >> 1) & 0x3F
            if nal_type == 35:
                if self.au_has_active and self.au_buf:
                    self._flush_video_au()
                if not self.au_has_active:
                    self._begin_new_video_au(mpu_seq, sample_num)
                self.au_has_aud = True
                self.au_buf.extend(b"\x00\x00\x00\x01")
                self.au_buf.extend(nal)
                continue
            if not self.au_has_active:
                self._begin_new_video_au(mpu_seq, sample_num)
            if nal_type == 32:
                self.au_has_vps = True
                self.vps = bytes(nal)
            elif nal_type == 33:
                self.au_has_sps = True
                self.sps = bytes(nal)
            elif nal_type == 34:
                self.au_has_pps = True
                self.pps = bytes(nal)
            elif 16 <= nal_type <= 21:
                self.au_is_keyframe = True
            self.au_buf.extend(b"\x00\x00\x00\x01")
            self.au_buf.extend(nal)

    def _handle_audio_mfu(self, tidx, mpu_seq, sample_num, mfu):
        if not mfu or tidx < 0 or tidx >= 2:
            return
        if mpu_seq != self.aud_last_mpu_seq[tidx]:
            self.aud_last_mpu_seq[tidx] = mpu_seq
            self.aud_mpu_au_counter[tidx] = 1
        else:
            self.aud_mpu_au_counter[tidx] += 1
        eff_sample = sample_num if sample_num > 0 else self.aud_mpu_au_counter[tidx]
        if not self.video_started:
            return
        ok, pts, _, _ = self.audio_timings[tidx].compute(mpu_seq, eff_sample, 1920)
        if not ok:
            return
        if self.video_base_dts != 0:
            diff = (pts - self.video_base_dts) & 0x1FFFFFFFF
            if diff > (1 << 32):
                diff -= (1 << 33)
            if diff < -60000:
                return
        adts = _latm_to_adts(mfu, self.audio_latm_cfgs[tidx])
        if adts:
            if self.audio_stream_types[tidx] != 0x0F:
                self.audio_stream_types[tidx] = 0x0F
                self._emit_pat_pmt()
            self._write_pes(TS_PID_AUDIO0 + tidx, 0xC0 + tidx, adts, pts, False, 0, False, 0, True)
        else:
            if self.audio_stream_types[tidx] != 0x11:
                self.audio_stream_types[tidx] = 0x11
                self._emit_pat_pmt()
            ml = len(mfu)
            loas = bytes((0x56, 0xE0 | ((ml >> 8) & 0x1F), ml & 0xFF)) + bytes(mfu)
            self._write_pes(TS_PID_AUDIO0 + tidx, 0xC0 + tidx, loas, pts, False, 0, False, 0, True)

    def _parse_plt(self, tb):
        if not tb:
            return
        q = 0
        tlen = len(tb)
        num_pkg = tb[q]
        q += 1
        first_sid = 0
        first_pa = 0
        for _ in range(num_pkg):
            if q >= tlen:
                break
            pid_len = tb[q]
            q += 1
            if q + pid_len > tlen:
                break
            sid = ((tb[q + pid_len - 2] << 8) | tb[q + pid_len - 1]) if pid_len >= 2 else 0
            q += pid_len
            if q >= tlen:
                break
            ltype = tb[q]
            q += 1
            lpid = 0
            if ltype == 0x00 and q + 2 <= tlen:
                lpid = (tb[q] << 8) | tb[q + 1]
                q += 2
            elif ltype == 0x01 and q + 10 <= tlen:
                q += 10
            elif ltype == 0x02 and q + 34 <= tlen:
                q += 34
            else:
                break
            if lpid != 0:
                if first_pa == 0:
                    first_sid = sid
                    first_pa = lpid
                if self.target_service_id != 0 and sid == self.target_service_id:
                    self.active_service_id = sid
                    self.pa_pid = lpid
                    return
        if self.pa_pid == 0 and first_pa != 0:
            self.active_service_id = first_sid
            self.pa_pid = first_pa

    def _parse_mpt(self, tb):
        tlen = len(tb)
        if tlen < 5:
            return
        q = 1
        pkg_id_len = tb[q]
        q += 1
        if q + pkg_id_len + 2 > tlen:
            return
        if pkg_id_len >= 2 and self.active_service_id == 0:
            self.active_service_id = (tb[q + pkg_id_len - 2] << 8) | tb[q + pkg_id_len - 1]
        q += pkg_id_len
        mpt_desc_len = (tb[q] << 8) | tb[q + 1]
        q += 2
        if q + mpt_desc_len + 1 > tlen:
            return
        q += mpt_desc_len
        num_assets = tb[q]
        q += 1
        for _ in range(num_assets):
            if q + 6 > tlen:
                break
            q += 5
            aid_len = tb[q]
            q += 1
            if q + aid_len + 6 > tlen:
                break
            q += aid_len
            atype = bytes(tb[q : q + 4])
            q += 5
            loc_cnt = tb[q]
            q += 1
            asset_pid = 0
            for _ in range(loc_cnt):
                if q >= tlen:
                    return
                ltype = tb[q]
                q += 1
                if ltype == 0x00 and q + 2 <= tlen:
                    asset_pid = (tb[q] << 8) | tb[q + 1]
                    q += 2
                elif ltype == 0x01 and q + 10 <= tlen:
                    q += 10
                elif ltype == 0x02 and q + 34 <= tlen:
                    q += 34
                else:
                    return
            if q + 2 > tlen:
                break
            ad_len = (tb[q] << 8) | tb[q + 1]
            q += 2
            if q + ad_len > tlen:
                break
            adesc = tb[q : q + ad_len]
            q += ad_len
            if atype in VIDEO_STYPES_H265 and asset_pid != 0:
                if self.video_mmt_pid == 0 or self.video_mmt_pid == asset_pid:
                    self.video_mmt_pid = asset_pid
                    self.video_timing.mmt_pid = asset_pid
                    self.video_timing.parse_descriptors(adesc)
            elif atype == b"mp4a" and asset_pid != 0:
                if asset_pid in self.audio_mmt_pids:
                    slot = self.audio_mmt_pids.index(asset_pid)
                elif len(self.audio_mmt_pids) < 2:
                    slot = len(self.audio_mmt_pids)
                    self.audio_mmt_pids.append(asset_pid)
                    self.audio_timings[slot].mmt_pid = asset_pid
                else:
                    slot = -1
                if slot >= 0:
                    self.audio_timings[slot].parse_descriptors(adesc)

    def _parse_pa(self, pid, msg):
        ml = len(msg)
        if ml < 10:
            return
        if ((msg[0] << 8) | msg[1]) != 0x0000:
            return
        mlen = struct.unpack_from(">I", msg, 3)[0]
        p = 7
        if p >= ml:
            return
        num_ext = msg[p]
        p += 1 + num_ext * 4
        end = min(7 + mlen, ml)
        while p + 4 <= end:
            tid = msg[p]
            tlen = (msg[p + 2] << 8) | msg[p + 3]
            p += 4
            if p + tlen > end:
                break
            if tid == 0x80 and pid == 0x0000:
                self._parse_plt(msg[p : p + tlen])
            elif tid == 0x20 and (self.pa_pid == 0 or pid == self.pa_pid):
                self._parse_mpt(msg[p : p + tlen])
            p += tlen

    def _handle_signaling(self, pid, s):
        if len(s) < 3:
            return
        if pid != 0x0000 and self.pa_pid != 0 and pid != self.pa_pid:
            return
        hdr0 = s[0]
        fi = (hdr0 >> 6) & 3
        agg = hdr0 & 1
        hflag = (hdr0 >> 1) & 1
        body = s[2:]
        if fi == 0:
            if agg == 0:
                self._parse_pa(pid, body)
            else:
                p = 0
                lsz = 2 if hflag else 4
                blen = len(body)
                while p + lsz <= blen:
                    ul = ((body[p] << 8) | body[p + 1]) if hflag else struct.unpack_from(">I", body, p)[0]
                    p += lsz
                    if p + ul > blen:
                        break
                    self._parse_pa(pid, body[p : p + ul])
                    p += ul
            return
        sa = self.sig_asms.get(pid)
        if sa is None:
            sa = {"active": False, "buf": bytearray()}
            self.sig_asms[pid] = sa
        if fi == 1:
            sa["buf"] = bytearray(body)
            sa["active"] = True
        elif fi == 2 and sa["active"]:
            if len(sa["buf"]) + len(body) <= 262144:
                sa["buf"].extend(body)
            else:
                sa["active"] = False
        elif fi == 3 and sa["active"]:
            if len(sa["buf"]) + len(body) <= 262144:
                sa["buf"].extend(body)
                self._parse_pa(pid, sa["buf"])
            sa["active"] = False
            sa["buf"].clear()

    def _handle_mpu(self, pid, p):
        if len(p) < 8:
            return
        is_vid = (self.video_mmt_pid != 0 and pid == self.video_mmt_pid)
        aud_idx = -1
        if not is_vid:
            if pid in self.audio_mmt_pids:
                aud_idx = self.audio_mmt_pids.index(pid)
            else:
                return
        ft_byte = p[2]
        if ((ft_byte >> 4) & 0x0F) != 2 or ((ft_byte >> 3) & 1) != 1:
            return
        fi = (ft_byte >> 1) & 3
        agg = ft_byte & 1
        mpu_seq = (p[4] << 24) | (p[5] << 16) | (p[6] << 8) | p[7]
        body = p[8:]
        blen = len(body)

        if agg == 1:
            ap = 0
            while ap + 2 <= blen:
                ulen = (body[ap] << 8) | body[ap + 1]
                ap += 2
                if ap + ulen > blen:
                    break
                if ulen > 14:
                    snum = (body[ap + 4] << 24) | (body[ap + 5] << 16) | (body[ap + 6] << 8) | body[ap + 7]
                    mfu = body[ap + 14 : ap + ulen]
                    if is_vid:
                        self._handle_hevc_mfu(mpu_seq, snum, mfu)
                    else:
                        self._handle_audio_mfu(aud_idx, mpu_seq, snum, mfu)
                ap += ulen
            return

        if blen < 14:
            return
        snum = (body[4] << 24) | (body[5] << 16) | (body[6] << 8) | body[7]
        mfu = body[14:]
        ma = self.vid_mfu if is_vid else self.aud_mfus[aud_idx]
        if fi == 0:
            if is_vid:
                self._handle_hevc_mfu(mpu_seq, snum, mfu)
            else:
                self._handle_audio_mfu(aud_idx, mpu_seq, snum, mfu)
        elif fi == 1:
            ma["buf"] = bytearray(mfu)
            ma["active"] = True
            ma["seq"] = mpu_seq
            ma["snum"] = snum
        elif fi == 2 and ma["active"]:
            if ma["seq"] == mpu_seq and ma["snum"] == snum and len(ma["buf"]) + len(mfu) <= 2097152:
                ma["buf"].extend(mfu)
            else:
                ma["active"] = False
        elif fi == 3 and ma["active"]:
            if ma["seq"] == mpu_seq and ma["snum"] == snum and len(ma["buf"]) + len(mfu) <= 2097152:
                ma["buf"].extend(mfu)
                if is_vid:
                    self._handle_hevc_mfu(ma["seq"], ma["snum"], ma["buf"])
                else:
                    self._handle_audio_mfu(aud_idx, ma["seq"], ma["snum"], ma["buf"])
            ma["active"] = False
            ma["buf"].clear()

    def _handle_mmtp(self, m):
        mlen = len(m)
        if mlen < 12:
            return
        b0 = m[0]
        b1 = m[1]
        pid = (m[2] << 8) | m[3]
        ptype = b1 & 0x3F
        off = 12
        if b0 & 0x20:
            off += 4
        if b0 & 0x02:
            if off + 4 > mlen:
                return
            ext_len = (m[off + 2] << 8) | m[off + 3]
            off += 4 + ext_len
        if off >= mlen:
            return
        if ptype == 0x02:
            self._handle_signaling(pid, m[off:])
        elif ptype == 0x00:
            self._handle_mpu(pid, m[off:])

    def feed(self, chunk):
        """生 MMT/TLV バイト列を入力し、変換済み MPEG-2 TS バイト列を返す"""
        if chunk:
            self.in_buf.extend(chunk)
        buf = self.in_buf
        mv = memoryview(buf)
        n = len(buf)
        pos = 0

        while pos + 4 <= n:
            if buf[pos] != 0x7F:
                nxt = buf.find(0x7F, pos + 1)
                if nxt < 0:
                    pos = n
                    break
                pos = nxt
                continue
            tlv_type = buf[pos + 1]
            tlv_len = (buf[pos + 2] << 8) | buf[pos + 3]
            pkt_total = 4 + tlv_len
            if pkt_total > 65540:
                pos += 1
                continue
            if pos + pkt_total > n:
                break
            pay = mv[pos + 4 : pos + pkt_total]
            if tlv_type == 0x03 and tlv_len >= 4:
                ht = pay[2]
                if ht == 0x61:
                    off = 3
                elif ht == 0x60:
                    off = 45
                elif ht == 0x20:
                    off = 25
                elif ht == 0x21:
                    off = 21
                else:
                    off = tlv_len
                if off < tlv_len:
                    self._handle_mmtp(pay[off:])
            elif tlv_type == 0x02 and tlv_len > 48:
                if (pay[0] >> 4) == 6 and pay[6] == 17:
                    self._handle_mmtp(pay[48:])
            pay.release()
            pos += pkt_total

        mv.release()
        if pos > 0:
            del self.in_buf[:pos]

        if not self.out_buf:
            return b""
        out = bytes(self.out_buf)
        self.out_buf.clear()
        return out

    def flush(self):
        self._flush_video_au()
        if not self.out_buf:
            return b""
        out = bytes(self.out_buf)
        self.out_buf.clear()
        return out
