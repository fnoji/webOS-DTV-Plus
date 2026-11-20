/* -*- coding: utf-8 -*-
 * mmt2ts.c - ARIB STD-B32 / STD-B60 BS4K (MMT/TLV) -> MPEG-2 TS リアルタイムリマキサー
 *
 * - 標準入力 (stdin) から生 MMT/TLV ストリームを受信し、映像 (HEVC/H.265) と音声 (AAC) を
 *   完全無劣化で MPEG-2 TS (188バイトパケット: HEVC 0x24 + MPEG-2 AAC ADTS 0x0F / LATM 0x11)
 *   へリアルタイム変換して標準出力 (stdout) へ出力する。
 * - 外部ライブラリ依存ゼロ (標準 C99 + libc のみ) のため、LG webOS ARMv7 環境でも超低 CPU 負荷で動作する。
 *
 * 使い方:
 *   mmt2ts [--sid <service_id>]
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>

/* ============================================================================
 * 定数・ユーティリティ
 * ============================================================================ */
#define TS_PACKET_SIZE 188
#define TS_PID_PAT     0x0000
#define TS_PID_PMT     0x0100
#define TS_PID_VIDEO   0x0101
#define TS_PID_AUDIO0  0x0102
#define TS_PID_AUDIO1  0x0103

#define MAX_AUDIO_TRACKS 2
#define MAX_MPU_CACHE    64
#define MAX_AUS_PER_MPU  256
#define MAX_SIG_PIDS     16
#define MAX_AU_BUF       (4 * 1024 * 1024)
#define MAX_MFU_BUF      (2 * 1024 * 1024)
#define MAX_SIG_BUF      (256 * 1024)
#define IO_BUF_SIZE      (256 * 1024)

static inline uint16_t rd16(const uint8_t *p) {
    return (uint16_t)(((uint16_t)p[0] << 8) | p[1]);
}

static inline uint32_t rd32(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

static uint64_t ntp64_to_90khz(uint32_t ntp_sec, uint32_t ntp_frac) {
    uint64_t sec_ticks = (uint64_t)ntp_sec * 90000ULL;
    uint64_t frac_ticks = ((uint64_t)ntp_frac * 90000ULL) >> 32;
    return (sec_ticks + frac_ticks) & 0x1FFFFFFFFULL;
}

/* MPEG-2 PSI CRC-32 */
static uint32_t crc32_table[256];
static void init_crc32(void) {
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i << 24;
        for (int j = 0; j < 8; j++) {
            c = (c & 0x80000000U) ? ((c << 1) ^ 0x04C11DB7U) : (c << 1);
        }
        crc32_table[i] = c;
    }
}

static uint32_t calc_crc32(const uint8_t *data, size_t len) {
    uint32_t crc = 0xFFFFFFFFU;
    for (size_t i = 0; i < len; i++) {
        crc = (crc << 8) ^ crc32_table[((crc >> 24) ^ data[i]) & 0xFF];
    }
    return crc;
}

/* ============================================================================
 * 出力バッファ & MPEG-2 TS パケッタイザ
 * ============================================================================ */
static uint8_t out_buf[IO_BUF_SIZE];
static size_t  out_pos = 0;

static void ts_flush(void) {
    if (out_pos > 0) {
        if (fwrite(out_buf, 1, out_pos, stdout) != out_pos) {
            exit(0);
        }
        fflush(stdout);
        out_pos = 0;
    }
}

static void ts_emit_packet(const uint8_t pkt[TS_PACKET_SIZE]) {
    if (out_pos + TS_PACKET_SIZE > sizeof(out_buf)) {
        ts_flush();
    }
    memcpy(out_buf + out_pos, pkt, TS_PACKET_SIZE);
    out_pos += TS_PACKET_SIZE;
    if (out_pos >= 188 * 64) {
        ts_flush();
    }
}

static uint8_t cc_pat = 0;
static uint8_t cc_pmt = 0;
static uint8_t cc_vid = 0;
static uint8_t cc_aud[MAX_AUDIO_TRACKS] = {0, 0};

static int audio_track_count = 0;
static uint8_t audio_stream_type[MAX_AUDIO_TRACKS] = {0x0F, 0x0F}; /* 0x0F=ADTS, 0x11=LATM */

static void ts_write_psi(uint16_t pid, uint8_t *cc, const uint8_t *sec, size_t sec_len) {
    uint8_t pkt[TS_PACKET_SIZE];
    memset(pkt, 0xFF, sizeof(pkt));
    pkt[0] = 0x47;
    pkt[1] = 0x40 | (uint8_t)((pid >> 8) & 0x1F);
    pkt[2] = (uint8_t)(pid & 0xFF);
    pkt[3] = 0x10 | ((*cc)++ & 0x0F);
    pkt[4] = 0x00; /* pointer_field */
    if (sec_len > TS_PACKET_SIZE - 5) sec_len = TS_PACKET_SIZE - 5;
    memcpy(pkt + 5, sec, sec_len);
    ts_emit_packet(pkt);
}

static void ts_emit_pat_pmt(uint16_t program_number) {
    uint8_t sec[128];
    size_t p = 0;

    /* PAT */
    sec[p++] = 0x00; /* table_id */
    sec[p++] = 0xB0;
    sec[p++] = 0x00; /* placeholder section_length */
    sec[p++] = 0x00; sec[p++] = 0x01; /* transport_stream_id */
    sec[p++] = 0xC1; /* version=0, current=1 */
    sec[p++] = 0x00; /* section_number */
    sec[p++] = 0x00; /* last_section_number */
    sec[p++] = (uint8_t)(program_number >> 8);
    sec[p++] = (uint8_t)(program_number & 0xFF);
    sec[p++] = 0xE0 | (uint8_t)((TS_PID_PMT >> 8) & 0x1F);
    sec[p++] = (uint8_t)(TS_PID_PMT & 0xFF);
    uint16_t pat_len = (uint16_t)((p - 3) + 4);
    sec[1] = 0xB0 | (uint8_t)((pat_len >> 8) & 0x0F);
    sec[2] = (uint8_t)(pat_len & 0xFF);
    uint32_t crc = calc_crc32(sec, p);
    sec[p++] = (uint8_t)(crc >> 24);
    sec[p++] = (uint8_t)(crc >> 16);
    sec[p++] = (uint8_t)(crc >> 8);
    sec[p++] = (uint8_t)(crc & 0xFF);
    ts_write_psi(TS_PID_PAT, &cc_pat, sec, p);

    /* PMT */
    p = 0;
    sec[p++] = 0x02; /* table_id */
    sec[p++] = 0xB0;
    sec[p++] = 0x00;
    sec[p++] = (uint8_t)(program_number >> 8);
    sec[p++] = (uint8_t)(program_number & 0xFF);
    sec[p++] = 0xC1;
    sec[p++] = 0x00;
    sec[p++] = 0x00;
    sec[p++] = 0xE0 | (uint8_t)((TS_PID_VIDEO >> 8) & 0x1F); /* PCR_PID = video */
    sec[p++] = (uint8_t)(TS_PID_VIDEO & 0xFF);
    sec[p++] = 0xF0;
    sec[p++] = 0x00; /* program_info_length = 0 */

    /* Video ES: HEVC (0x24) */
    sec[p++] = 0x24;
    sec[p++] = 0xE0 | (uint8_t)((TS_PID_VIDEO >> 8) & 0x1F);
    sec[p++] = (uint8_t)(TS_PID_VIDEO & 0xFF);
    sec[p++] = 0xF0;
    sec[p++] = 0x00;

    /* Audio ES(s) */
    int n_aud = audio_track_count > 0 ? audio_track_count : 1;
    if (n_aud > MAX_AUDIO_TRACKS) n_aud = MAX_AUDIO_TRACKS;
    for (int i = 0; i < n_aud; i++) {
        uint16_t apid = (uint16_t)(TS_PID_AUDIO0 + i);
        sec[p++] = audio_stream_type[i];
        sec[p++] = 0xE0 | (uint8_t)((apid >> 8) & 0x1F);
        sec[p++] = (uint8_t)(apid & 0xFF);
        /* ISO 639 language descriptor (jpn) */
        sec[p++] = 0xF0;
        sec[p++] = 0x06;
        sec[p++] = 0x0A; /* descriptor_tag */
        sec[p++] = 0x04; /* descriptor_length */
        sec[p++] = 'j'; sec[p++] = 'p'; sec[p++] = 'n';
        sec[p++] = 0x00;
    }

    uint16_t pmt_len = (uint16_t)((p - 3) + 4);
    sec[1] = 0xB0 | (uint8_t)((pmt_len >> 8) & 0x0F);
    sec[2] = (uint8_t)(pmt_len & 0xFF);
    crc = calc_crc32(sec, p);
    sec[p++] = (uint8_t)(crc >> 24);
    sec[p++] = (uint8_t)(crc >> 16);
    sec[p++] = (uint8_t)(crc >> 8);
    sec[p++] = (uint8_t)(crc & 0xFF);
    ts_write_psi(TS_PID_PMT, &cc_pmt, sec, p);
}

static void write_ts_timestamp(uint8_t *dst, uint8_t prefix4, uint64_t ts90k) {
    ts90k &= 0x1FFFFFFFFULL;
    dst[0] = (uint8_t)((prefix4 << 4) | (((ts90k >> 30) & 0x07) << 1) | 0x01);
    dst[1] = (uint8_t)((ts90k >> 22) & 0xFF);
    dst[2] = (uint8_t)((((ts90k >> 15) & 0x7F) << 1) | 0x01);
    dst[3] = (uint8_t)((ts90k >> 7) & 0xFF);
    dst[4] = (uint8_t)((((ts90k) & 0x7F) << 1) | 0x01);
}

static void ts_write_pes(uint16_t pid, uint8_t *cc, uint8_t stream_id,
                         const uint8_t *payload, size_t payload_len,
                         uint64_t pts90k, int has_dts, uint64_t dts90k,
                         int emit_pcr, uint64_t pcr90k, int is_random_access) {
    uint8_t pes_hdr[24];
    size_t hdr_len = 0;

    pes_hdr[0] = 0x00; pes_hdr[1] = 0x00; pes_hdr[2] = 0x01;
    pes_hdr[3] = stream_id;
    size_t opt_len = has_dts ? 10 : 5;
    size_t total_pes_len = 3 + opt_len + payload_len;
    if ((stream_id & 0xF0) == 0xE0 && total_pes_len > 65535) {
        pes_hdr[4] = 0x00; pes_hdr[5] = 0x00; /* video unbounded length allowed */
    } else if (total_pes_len <= 65535) {
        pes_hdr[4] = (uint8_t)(total_pes_len >> 8);
        pes_hdr[5] = (uint8_t)(total_pes_len & 0xFF);
    } else {
        pes_hdr[4] = 0x00; pes_hdr[5] = 0x00;
    }
    pes_hdr[6] = 0x80; /* marker bits '10' */
    pes_hdr[7] = has_dts ? 0xC0 : 0x80;
    pes_hdr[8] = (uint8_t)opt_len;
    if (has_dts) {
        write_ts_timestamp(pes_hdr + 9, 0x03, pts90k);
        write_ts_timestamp(pes_hdr + 14, 0x01, dts90k);
        hdr_len = 19;
    } else {
        write_ts_timestamp(pes_hdr + 9, 0x02, pts90k);
        hdr_len = 14;
    }

    size_t total_len = hdr_len + payload_len;
    size_t sent = 0;
    int first = 1;

    while (sent < total_len) {
        uint8_t pkt[TS_PACKET_SIZE];
        size_t rem = total_len - sent;
        int want_pcr = (first && emit_pcr);
        int want_rai = (first && is_random_access);

        pkt[0] = 0x47;
        pkt[1] = (first ? 0x40 : 0x00) | (uint8_t)((pid >> 8) & 0x1F);
        pkt[2] = (uint8_t)(pid & 0xFF);

        size_t af_min = 0;
        if (want_pcr) af_min = 8;       /* len(1) + flags(1) + pcr(6) */
        else if (want_rai) af_min = 2;  /* len(1) + flags(1) */

        size_t max_pay = TS_PACKET_SIZE - 4 - af_min;
        size_t af_len = af_min;
        size_t take = rem;
        if (take > max_pay) {
            take = max_pay;
        } else if (take < max_pay) {
            /* padding needed in adaptation field */
            size_t pad = max_pay - take;
            af_len = af_min + pad;
            if (af_len == 0) af_len = 1; /* shouldn't happen since pad>=1 */
        }

        if (af_len > 0) {
            pkt[3] = 0x30 | ((*cc)++ & 0x0F);
            pkt[4] = (uint8_t)(af_len - 1);
            if (af_len >= 2) {
                uint8_t flags = 0;
                if (want_rai) flags |= 0x40;
                if (want_pcr) flags |= 0x10;
                pkt[5] = flags;
                size_t af_pos = 6;
                if (want_pcr) {
                    uint64_t pbase = pcr90k & 0x1FFFFFFFFULL;
                    pkt[6] = (uint8_t)(pbase >> 25);
                    pkt[7] = (uint8_t)(pbase >> 17);
                    pkt[8] = (uint8_t)(pbase >> 9);
                    pkt[9] = (uint8_t)(pbase >> 1);
                    pkt[10] = (uint8_t)(((pbase & 1) << 7) | 0x7E);
                    pkt[11] = 0x00;
                    af_pos = 12;
                }
                if (af_pos < 4 + af_len) {
                    memset(pkt + af_pos, 0xFF, (4 + af_len) - af_pos);
                }
            }
        } else {
            pkt[3] = 0x10 | ((*cc)++ & 0x0F);
        }

        size_t dst_off = 4 + af_len;
        size_t copied = 0;
        while (copied < take) {
            size_t cur_pos = sent + copied;
            if (cur_pos < hdr_len) {
                size_t n = hdr_len - cur_pos;
                if (n > take - copied) n = take - copied;
                memcpy(pkt + dst_off + copied, pes_hdr + cur_pos, n);
                copied += n;
            } else {
                size_t pay_off = cur_pos - hdr_len;
                size_t n = take - copied;
                memcpy(pkt + dst_off + copied, payload + pay_off, n);
                copied += n;
            }
        }

        ts_emit_packet(pkt);
        sent += take;
        first = 0;
    }
}

/* ============================================================================
 * LATM (AudioMuxElement) -> ADTS 無劣化変換ビットリーダ
 * ============================================================================ */
typedef struct {
    const uint8_t *data;
    size_t len;
    size_t bitpos;
} BitReader;

static uint32_t br_read(BitReader *br, int nbits) {
    uint32_t val = 0;
    for (int i = 0; i < nbits; i++) {
        size_t byte_i = br->bitpos >> 3;
        if (byte_i >= br->len) return 0;
        int bit_i = 7 - (int)(br->bitpos & 7);
        val = (val << 1) | ((br->data[byte_i] >> bit_i) & 1U);
        br->bitpos++;
    }
    return val;
}

typedef struct {
    int valid;
    int audio_object_type;
    int sr_index;
    int chan_config;
    int frame_len_type;
} LatmConfig;

static uint32_t latm_get_value(BitReader *br) {
    uint32_t bytes_for_value = br_read(br, 2);
    uint32_t val = 0;
    for (uint32_t i = 0; i <= bytes_for_value; i++) {
        val = (val << 8) | br_read(br, 8);
    }
    return val;
}

static int parse_audio_specific_config(BitReader *br, LatmConfig *cfg) {
    uint32_t aot = br_read(br, 5);
    if (aot == 31) aot = 32 + br_read(br, 6);
    uint32_t sri = br_read(br, 4);
    if (sri == 15) br_read(br, 24);
    uint32_t ch = br_read(br, 4);
    if (aot == 5 || aot == 29) { /* SBR / PS */
        uint32_t ext_sri = br_read(br, 4);
        if (ext_sri == 15) br_read(br, 24);
        aot = br_read(br, 5);
        if (aot == 31) aot = 32 + br_read(br, 6);
        if (aot == 22) br_read(br, 4);
    }
    /* GASpecificConfig (for AAC-LC = 2, Main = 1, SSR = 3, LTP = 4) */
    if (aot == 1 || aot == 2 || aot == 3 || aot == 4 || aot == 6 || aot == 7 || aot == 17 || aot == 19 || aot == 20 || aot == 21 || aot == 22 || aot == 23) {
        uint32_t frame_len_flag = br_read(br, 1);
        (void)frame_len_flag;
        uint32_t dep_core = br_read(br, 1);
        if (dep_core) br_read(br, 14);
        uint32_t ext_flag = br_read(br, 1);
        if (ch == 0) {
            /* program_config_element present -> fallback to LATM */
            return -1;
        }
        if (aot == 6 || aot == 20) br_read(br, 3);
        if (ext_flag) {
            if (aot == 22) { br_read(br, 5); br_read(br, 11); }
            if (aot == 17 || aot == 19 || aot == 20 || aot == 23) br_read(br, 3);
            br_read(br, 1);
        }
    } else {
        return -1;
    }

    if (sri >= 13 || ch == 0 || ch > 7) return -1;
    cfg->valid = 1;
    cfg->audio_object_type = (int)aot;
    cfg->sr_index = (int)sri;
    cfg->chan_config = (int)ch;
    return 0;
}

/*
 * LATM AudioMuxElement を 7バイト ADTS ヘッダ付き AAC フレームへ変換する。
 * 成功時は出力バイト数を返す。22.2ch 等で ADTS 非対応の場合は -1 を返す。
 */
static int latm_to_adts(const uint8_t *latm, size_t latm_len, LatmConfig *cfg,
                        uint8_t *out_adts, size_t out_cap) {
    BitReader br = { latm, latm_len, 0 };
    uint32_t use_same = br_read(&br, 1);
    if (!use_same) {
        uint32_t ver = br_read(&br, 1);
        uint32_t ver_a = (ver == 1) ? br_read(&br, 1) : 0;
        if (ver_a != 0) return -1;
        if (ver == 1) latm_get_value(&br); /* taraBufferFullness */
        uint32_t all_same = br_read(&br, 1);
        if (!all_same) return -1;
        uint32_t num_sub = br_read(&br, 6);
        uint32_t num_prog = br_read(&br, 4);
        uint32_t num_lay = br_read(&br, 3);
        if (num_sub != 0 || num_prog != 0 || num_lay != 0) return -1;

        if (ver == 0) {
            if (parse_audio_specific_config(&br, cfg) != 0) return -1;
        } else {
            uint32_t asc_len = latm_get_value(&br);
            size_t start_bit = br.bitpos;
            if (parse_audio_specific_config(&br, cfg) != 0) return -1;
            if (br.bitpos < start_bit + asc_len) {
                br.bitpos = start_bit + asc_len;
            }
        }
        cfg->frame_len_type = (int)br_read(&br, 3);
        if (cfg->frame_len_type == 0) {
            br_read(&br, 8); /* latmBufferFullness */
        } else {
            return -1;
        }
        uint32_t other_data = br_read(&br, 1);
        if (other_data) {
            if (ver == 1) {
                latm_get_value(&br);
            } else {
                while (1) {
                    uint32_t esc = br_read(&br, 1);
                    br_read(&br, 8);
                    if (!esc) break;
                }
            }
        }
        uint32_t crc_check = br_read(&br, 1);
        if (crc_check) br_read(&br, 8);
    }

    if (!cfg->valid) return -1;

    /* PayloadLengthInfo (frameLengthType == 0) */
    uint32_t mux_len = 0;
    while (1) {
        uint32_t tmp = br_read(&br, 8);
        mux_len += tmp;
        if (tmp != 255) break;
    }

    if (mux_len == 0 || mux_len + 7 > out_cap || (br.bitpos + (size_t)mux_len * 8) > latm_len * 8) {
        return -1;
    }

    uint32_t frame_len = mux_len + 7;
    int profile = (cfg->audio_object_type > 0) ? (cfg->audio_object_type - 1) : 1;
    if (profile > 3) profile = 1; /* AAC-LC */

    /* 7-byte ADTS header (MPEG-2, no CRC) */
    out_adts[0] = 0xFF;
    out_adts[1] = 0xF1; /* sync + MPEG-4(0)/MPEG-2(1)? 0xF1 = MPEG-4, layer 00, protection_absent=1 */
    out_adts[2] = (uint8_t)(((profile & 3) << 6) | ((cfg->sr_index & 0x0F) << 2) | ((cfg->chan_config >> 2) & 1));
    out_adts[3] = (uint8_t)(((cfg->chan_config & 3) << 6) | ((frame_len >> 11) & 3));
    out_adts[4] = (uint8_t)((frame_len >> 3) & 0xFF);
    out_adts[5] = (uint8_t)(((frame_len & 7) << 5) | 0x1F);
    out_adts[6] = 0xFC;

    for (uint32_t i = 0; i < mux_len; i++) {
        out_adts[7 + i] = (uint8_t)br_read(&br, 8);
    }
    return (int)frame_len;
}

/* ============================================================================
 * MPU タイムスタンプ管理 (0x0001 + 0x8026)
 * ============================================================================ */
typedef struct {
    int valid;
    uint32_t mpu_seq;
    uint64_t pts90k;          /* MPU 先頭プレゼンテーション時刻 (90kHz) */
    int has_ext;
    uint32_t timescale;
    uint16_t default_pts_off;
    uint16_t decoding_time_off;
    uint16_t num_au;
    uint16_t dts_pts_off[MAX_AUS_PER_MPU];
    uint16_t au_dur[MAX_AUS_PER_MPU];
} MpuTimeEntry;

typedef struct {
    uint16_t mmt_pid;
    uint32_t timescale;
    uint16_t default_pts_off;
    MpuTimeEntry entries[MAX_MPU_CACHE];
    int has_last_pts;
    uint64_t last_pts90k;
    uint64_t last_dts90k;
} AssetTiming;

static MpuTimeEntry *timing_find_or_alloc(AssetTiming *at, uint32_t mpu_seq, int alloc) {
    int slot = (int)(mpu_seq % MAX_MPU_CACHE);
    if (at->entries[slot].valid && at->entries[slot].mpu_seq == mpu_seq) {
        return &at->entries[slot];
    }
    if (!alloc) return NULL;
    memset(&at->entries[slot], 0, sizeof(MpuTimeEntry));
    at->entries[slot].valid = 1;
    at->entries[slot].mpu_seq = mpu_seq;
    return &at->entries[slot];
}

static void parse_asset_descriptors(AssetTiming *at, const uint8_t *desc, size_t len) {
    size_t p = 0;
    while (p + 3 <= len) {
        uint16_t dtag = rd16(desc + p);
        uint8_t dlen = desc[p + 2];
        p += 3;
        if (p + dlen > len) break;
        const uint8_t *b = desc + p;
        p += dlen;

        if (dtag == 0x0001) {
            /* MPU Timestamp Descriptor: repeated 12-byte entries */
            size_t q = 0;
            while (q + 12 <= dlen) {
                uint32_t seq = rd32(b + q);
                uint32_t nsec = rd32(b + q + 4);
                uint32_t nfrac = rd32(b + q + 8);
                MpuTimeEntry *e = timing_find_or_alloc(at, seq, 1);
                e->pts90k = ntp64_to_90khz(nsec, nfrac);
                q += 12;
            }
        } else if (dtag == 0x8026 && dlen >= 1) {
            /* MPU Extended Timestamp Descriptor (ARIB STD-B60) */
            size_t q = 0;
            uint8_t flags = b[q++];
            int pts_off_type = (flags >> 1) & 3;
            int ts_flag = flags & 1;
            uint32_t ts_val = at->timescale ? at->timescale : 180000;
            uint16_t def_off = at->default_pts_off;
            if (ts_flag && q + 4 <= dlen) {
                ts_val = rd32(b + q);
                q += 4;
                if (ts_val > 0) at->timescale = ts_val;
            }
            if (pts_off_type == 1 && q + 2 <= dlen) {
                def_off = rd16(b + q);
                q += 2;
                at->default_pts_off = def_off;
            }
            while (q + 8 <= dlen) {
                uint32_t seq = rd32(b + q); q += 4;
                q += 1; /* leap_ind + reserved */
                uint16_t dto = rd16(b + q); q += 2;
                uint8_t num_au = b[q++];
                MpuTimeEntry *e = timing_find_or_alloc(at, seq, 1);
                e->has_ext = 1;
                e->timescale = ts_val;
                e->default_pts_off = def_off;
                e->decoding_time_off = dto;
                e->num_au = num_au;
                for (int i = 0; i < num_au; i++) {
                    if (q + 2 > dlen) break;
                    uint16_t dpo = rd16(b + q); q += 2;
                    uint16_t dur = def_off;
                    if (pts_off_type == 2) {
                        if (q + 2 > dlen) break;
                        dur = rd16(b + q); q += 2;
                    }
                    if (i < MAX_AUS_PER_MPU) {
                        e->dts_pts_off[i] = dpo;
                        e->au_dur[i] = dur;
                    }
                }
            }
        }
    }
}

static int compute_sample_timestamps(AssetTiming *at, uint32_t mpu_seq, uint32_t sample_num,
                                     uint64_t default_step_90k,
                                     uint64_t *out_pts, uint64_t *out_dts, int *out_has_dts) {
    /* sample_num は 1-based。MPT (0x0001) の実 NTP 時刻が一度も解決できていない場合は 0 を返す */
    uint32_t idx = (sample_num > 0) ? (sample_num - 1) : 0;
    MpuTimeEntry *e = timing_find_or_alloc(at, mpu_seq, 0);
    if (e && e->pts90k != 0) {
        uint32_t ts = (e->has_ext && e->timescale > 0) ? e->timescale : (at->timescale ? at->timescale : 180000);
        if (e->has_ext && idx < e->num_au && idx < MAX_AUS_PER_MPU) {
            uint64_t acc = 0;
            for (uint32_t i = 0; i < idx; i++) {
                acc += e->au_dur[i] ? e->au_dur[i] : e->default_pts_off;
            }
            /* DTS(idx) = MPU_PTS - decoding_time_off + acc */
            int64_t rel_dts = (int64_t)acc - (int64_t)e->decoding_time_off;
            int64_t dts_delta_90k = (rel_dts * 90000LL) / (int64_t)ts;
            int64_t pts_off_90k = ((int64_t)e->dts_pts_off[idx] * 90000LL) / (int64_t)ts;
            uint64_t dts = (uint64_t)((int64_t)e->pts90k + dts_delta_90k) & 0x1FFFFFFFFULL;
            uint64_t pts = (dts + (uint64_t)pts_off_90k) & 0x1FFFFFFFFULL;
            *out_dts = dts;
            *out_pts = pts;
            *out_has_dts = (e->dts_pts_off[idx] != 0 || e->decoding_time_off != 0);
            at->has_last_pts = 1;
            at->last_pts90k = pts;
            at->last_dts90k = dts;
            return 1;
        }
        /* Extended 情報未着時のフォールバック補間 */
        uint64_t step = (at->default_pts_off && at->timescale)
            ? (((uint64_t)at->default_pts_off * 90000ULL) / at->timescale)
            : default_step_90k;
        uint64_t pts = (e->pts90k + (uint64_t)idx * step) & 0x1FFFFFFFFULL;
        *out_pts = pts;
        *out_dts = pts;
        *out_has_dts = 0;
        at->has_last_pts = 1;
        at->last_pts90k = pts;
        at->last_dts90k = pts;
        return 1;
    }

    if (at->has_last_pts) {
        at->last_dts90k = (at->last_dts90k + default_step_90k) & 0x1FFFFFFFFULL;
        at->last_pts90k = (at->last_pts90k + default_step_90k) & 0x1FFFFFFFFULL;
        *out_pts = at->last_pts90k;
        *out_dts = at->last_dts90k;
        *out_has_dts = 0;
        return 1;
    }
    return 0;
}

/* ============================================================================
 * サービス / Asset 状態
 * ============================================================================ */
static uint16_t target_service_id = 0;
static uint16_t active_service_id = 0;
static uint16_t pa_pid = 0;
static uint16_t video_mmt_pid = 0;
static uint16_t audio_mmt_pid[MAX_AUDIO_TRACKS] = {0, 0};

static AssetTiming video_timing;
static AssetTiming audio_timing[MAX_AUDIO_TRACKS];
static LatmConfig  audio_latm_cfg[MAX_AUDIO_TRACKS];

/* 映像パラメータセット (VPS/SPS/PPS) キャッシュ & AU アセンブラ */
static uint8_t vps_buf[512]; static size_t vps_len = 0;
static uint8_t sps_buf[512]; static size_t sps_len = 0;
static uint8_t pps_buf[512]; static size_t pps_len = 0;

static uint8_t *au_buf = NULL;
static size_t   au_len = 0;
static uint32_t au_mpu_seq = 0;
static uint32_t au_sample_num = 0;
static uint32_t vid_last_mpu_seq = 0;
static uint32_t vid_mpu_au_counter = 0;
static uint32_t aud_last_mpu_seq[MAX_AUDIO_TRACKS] = {0, 0};
static uint32_t aud_mpu_au_counter[MAX_AUDIO_TRACKS] = {0, 0};
static int      au_has_active = 0;
static int      au_is_keyframe = 0;
static int      au_has_vps = 0;
static int      au_has_sps = 0;
static int      au_has_pps = 0;
static int      au_has_aud = 0;
static int      video_started = 0;
static uint64_t last_pat_pmt_dts = 0;
static uint64_t video_base_dts = 0;

/* 断片化 MFU 再構成バッファ */
typedef struct {
    uint8_t *buf;
    size_t len;
    int active;
    uint32_t mpu_seq;
    uint32_t sample_num;
} MfuAssembler;

static MfuAssembler video_mfu_asm;
static MfuAssembler audio_mfu_asm[MAX_AUDIO_TRACKS];

static void au_append_nal(const uint8_t *nal, size_t nlen) {
    if (nlen == 0 || au_len + 4 + nlen > MAX_AU_BUF) return;
    au_buf[au_len++] = 0x00;
    au_buf[au_len++] = 0x00;
    au_buf[au_len++] = 0x00;
    au_buf[au_len++] = 0x01;
    memcpy(au_buf + au_len, nal, nlen);
    au_len += nlen;
}

static void flush_video_au(void) {
    if (!au_has_active || au_len == 0) {
        au_len = 0;
        au_has_active = 0;
        return;
    }

    uint64_t pts = 0, dts = 0;
    int has_dts = 0;
    if (!compute_sample_timestamps(&video_timing, au_mpu_seq, au_sample_num, 1502ULL, &pts, &dts, &has_dts)) {
        au_len = 0;
        au_has_active = 0;
        return;
    }

    /* 最初の映像出力は必ず VPS+SPS+PPS とキーフレーム (BLA/IDR/CRA) から開始する */
    if (!video_started) {
        if (!au_is_keyframe || vps_len == 0 || sps_len == 0 || pps_len == 0) {
            au_len = 0;
            au_has_active = 0;
            return;
        }
        video_started = 1;
        ts_emit_pat_pmt(active_service_id ? active_service_id : 101);
    }

    /* 200ms (18000 ticks) ごと、およびキーフレーム直前に PAT/PMT を再送 */
    uint64_t dts_diff = (dts - last_pat_pmt_dts) & 0x1FFFFFFFFULL;
    if (au_is_keyframe || last_pat_pmt_dts == 0 || dts_diff >= 18000ULL) {
        ts_emit_pat_pmt(active_service_id ? active_service_id : 101);
        last_pat_pmt_dts = dts;
    }
    video_base_dts = dts;

    /* キーフレーム時に VPS/SPS/PPS が AU に未同梱なら先頭に補完する */
    if (au_is_keyframe && (!au_has_vps || !au_has_sps || !au_has_pps) && vps_len && sps_len && pps_len) {
        static uint8_t prefix_buf[2048];
        size_t plen = 0;
        if (!au_has_aud) {
            /* HEVC AUD (Access Unit Delimiter) */
            prefix_buf[plen++] = 0x00; prefix_buf[plen++] = 0x00; prefix_buf[plen++] = 0x00; prefix_buf[plen++] = 0x01;
            prefix_buf[plen++] = 0x46; prefix_buf[plen++] = 0x01; prefix_buf[plen++] = 0x50;
        }
        if (!au_has_vps && plen + 4 + vps_len <= sizeof(prefix_buf)) {
            prefix_buf[plen++] = 0x00; prefix_buf[plen++] = 0x00; prefix_buf[plen++] = 0x00; prefix_buf[plen++] = 0x01;
            memcpy(prefix_buf + plen, vps_buf, vps_len); plen += vps_len;
        }
        if (!au_has_sps && plen + 4 + sps_len <= sizeof(prefix_buf)) {
            prefix_buf[plen++] = 0x00; prefix_buf[plen++] = 0x00; prefix_buf[plen++] = 0x00; prefix_buf[plen++] = 0x01;
            memcpy(prefix_buf + plen, sps_buf, sps_len); plen += sps_len;
        }
        if (!au_has_pps && plen + 4 + pps_len <= sizeof(prefix_buf)) {
            prefix_buf[plen++] = 0x00; prefix_buf[plen++] = 0x00; prefix_buf[plen++] = 0x00; prefix_buf[plen++] = 0x01;
            memcpy(prefix_buf + plen, pps_buf, pps_len); plen += pps_len;
        }
        if (au_len + plen <= MAX_AU_BUF) {
            memmove(au_buf + plen, au_buf, au_len);
            memcpy(au_buf, prefix_buf, plen);
            au_len += plen;
        }
    }

    /* PCR はデコード時刻より 700ms (63000 ticks) 手前に設定し、600KB超の巨大キーフレームや
     * 映像より最大 400ms 先行する音声 PTS に対してもアンダーラン・再同期フリーズを防ぐ */
    uint64_t pcr90k = (dts - 63000ULL) & 0x1FFFFFFFFULL;
    ts_write_pes(TS_PID_VIDEO, &cc_vid, 0xE0, au_buf, au_len,
                 pts, has_dts, dts, 1, pcr90k, au_is_keyframe);

    au_len = 0;
    au_has_active = 0;
    au_is_keyframe = 0;
    au_has_vps = au_has_sps = au_has_pps = au_has_aud = 0;
}

static void begin_new_video_au(uint32_t mpu_seq, uint32_t sample_num) {
    if (mpu_seq != vid_last_mpu_seq) {
        vid_last_mpu_seq = mpu_seq;
        vid_mpu_au_counter = 1;
    } else {
        vid_mpu_au_counter++;
    }
    au_has_active = 1;
    au_mpu_seq = mpu_seq;
    /* ARIB STD-B60 BS4K では timed MFU の sample_number が 0 埋めされるため、MPU 内 AU カウンタを使う */
    au_sample_num = (sample_num > 0) ? sample_num : vid_mpu_au_counter;
    au_len = 0;
    au_is_keyframe = 0;
    au_has_vps = au_has_sps = au_has_pps = au_has_aud = 0;
}

static void handle_hevc_mfu(uint32_t mpu_seq, uint32_t sample_num, const uint8_t *mfu, size_t len) {
    if (au_has_active && (au_mpu_seq != mpu_seq || (sample_num > 0 && au_sample_num != sample_num))) {
        flush_video_au();
    }

    size_t p = 0;
    while (p + 4 <= len) {
        uint32_t nlen = rd32(mfu + p);
        p += 4;
        if (nlen == 0 || p + nlen > len) break;
        const uint8_t *nal = mfu + p;
        p += nlen;

        uint8_t nal_type = (nal[0] >> 1) & 0x3F;
        /* AUD (NAL type 35) は新フレーム (Access Unit) の先頭境界 */
        if (nal_type == 35) {
            if (au_has_active && au_len > 0) {
                flush_video_au();
            }
            if (!au_has_active) {
                begin_new_video_au(mpu_seq, sample_num);
            }
            au_has_aud = 1;
            au_append_nal(nal, nlen);
            continue;
        }
        if (!au_has_active) {
            begin_new_video_au(mpu_seq, sample_num);
        }
        if (nal_type == 32) {
            au_has_vps = 1;
            if (nlen <= sizeof(vps_buf)) { memcpy(vps_buf, nal, nlen); vps_len = nlen; }
        } else if (nal_type == 33) {
            au_has_sps = 1;
            if (nlen <= sizeof(sps_buf)) { memcpy(sps_buf, nal, nlen); sps_len = nlen; }
        } else if (nal_type == 34) {
            au_has_pps = 1;
            if (nlen <= sizeof(pps_buf)) { memcpy(pps_buf, nal, nlen); pps_len = nlen; }
        } else if (nal_type >= 16 && nal_type <= 21) {
            /* BLA / IDR / CRA キーフレーム */
            au_is_keyframe = 1;
        }
        au_append_nal(nal, nlen);
    }
}

static void handle_audio_mfu(int track_idx, uint32_t mpu_seq, uint32_t sample_num,
                             const uint8_t *mfu, size_t len) {
    if (len == 0 || track_idx < 0 || track_idx >= MAX_AUDIO_TRACKS) return;

    if (mpu_seq != aud_last_mpu_seq[track_idx]) {
        aud_last_mpu_seq[track_idx] = mpu_seq;
        aud_mpu_au_counter[track_idx] = 1;
    } else {
        aud_mpu_au_counter[track_idx]++;
    }
    uint32_t eff_sample = (sample_num > 0) ? sample_num : aud_mpu_au_counter[track_idx];

    if (!video_started) return;

    uint64_t pts = 0, dts = 0;
    int has_dts = 0;
    if (!compute_sample_timestamps(&audio_timing[track_idx], mpu_seq, eff_sample, 1920ULL, &pts, &dts, &has_dts)) {
        return; /* MPT の NTP 時刻と紐付く前の音声 MPU は破棄し A/V ズレを防ぐ */
    }

    /* PCR (video_base_dts - 63000) より過去の音声フレームを破棄し、A/V クロック再同期フリーズを防ぐ */
    if (video_base_dts != 0) {
        int64_t diff = (int64_t)((pts - video_base_dts) & 0x1FFFFFFFFULL);
        if (diff > (1LL << 32)) diff -= (1LL << 33);
        if (diff < -60000LL) return;
    }

    static uint8_t adts_out[16384];
    int adts_len = latm_to_adts(mfu, len, &audio_latm_cfg[track_idx], adts_out, sizeof(adts_out));
    if (adts_len > 0) {
        if (audio_stream_type[track_idx] != 0x0F) {
            audio_stream_type[track_idx] = 0x0F;
            ts_emit_pat_pmt(active_service_id ? active_service_id : 101);
        }
        ts_write_pes((uint16_t)(TS_PID_AUDIO0 + track_idx), &cc_aud[track_idx],
                     (uint8_t)(0xC0 + track_idx), adts_out, (size_t)adts_len,
                     pts, 0, 0, 0, 0, 1);
    } else if (len + 3 <= sizeof(adts_out)) {
        /* 22.2ch 等で ADTS 非対応の場合は LOAS/LATM (0x11) にフォールバック */
        if (audio_stream_type[track_idx] != 0x11) {
            audio_stream_type[track_idx] = 0x11;
            ts_emit_pat_pmt(active_service_id ? active_service_id : 101);
        }
        adts_out[0] = 0x56;
        adts_out[1] = (uint8_t)(0xE0 | ((len >> 8) & 0x1F));
        adts_out[2] = (uint8_t)(len & 0xFF);
        memcpy(adts_out + 3, mfu, len);
        ts_write_pes((uint16_t)(TS_PID_AUDIO0 + track_idx), &cc_aud[track_idx],
                     (uint8_t)(0xC0 + track_idx), adts_out, len + 3,
                     pts, 0, 0, 0, 0, 1);
    }
}

/* ============================================================================
 * Signaling (PLT / MPT) パーサ
 * ============================================================================ */
typedef struct {
    uint16_t pid;
    uint8_t *buf;
    size_t len;
    int active;
} SigAssembler;

static SigAssembler sig_asms[MAX_SIG_PIDS];

static SigAssembler *get_sig_asm(uint16_t pid) {
    for (int i = 0; i < MAX_SIG_PIDS; i++) {
        if (sig_asms[i].pid == pid && sig_asms[i].buf) return &sig_asms[i];
    }
    for (int i = 0; i < MAX_SIG_PIDS; i++) {
        if (!sig_asms[i].buf) {
            sig_asms[i].pid = pid;
            sig_asms[i].buf = (uint8_t *)malloc(MAX_SIG_BUF);
            sig_asms[i].len = 0;
            sig_asms[i].active = 0;
            return &sig_asms[i];
        }
    }
    return NULL;
}

static void parse_plt_table(const uint8_t *tb, size_t tlen) {
    if (tlen < 1) return;
    size_t q = 0;
    uint8_t num_pkg = tb[q++];
    uint16_t first_sid = 0, first_pa = 0;
    for (int i = 0; i < num_pkg && q < tlen; i++) {
        uint8_t pid_len = tb[q++];
        if (q + pid_len > tlen) break;
        uint16_t sid = (pid_len >= 2) ? rd16(tb + q + pid_len - 2) : 0;
        q += pid_len;
        if (q >= tlen) break;
        uint8_t loc_type = tb[q++];
        uint16_t loc_pid = 0;
        if (loc_type == 0x00 && q + 2 <= tlen) {
            loc_pid = rd16(tb + q); q += 2;
        } else if (loc_type == 0x01 && q + 10 <= tlen) {
            q += 10;
        } else if (loc_type == 0x02 && q + 34 <= tlen) {
            q += 34;
        } else {
            break;
        }
        if (loc_pid != 0) {
            if (first_pa == 0) { first_sid = sid; first_pa = loc_pid; }
            if (target_service_id != 0 && sid == target_service_id) {
                active_service_id = sid;
                pa_pid = loc_pid;
                return;
            }
        }
    }
    if (pa_pid == 0 && first_pa != 0) {
        active_service_id = first_sid;
        pa_pid = first_pa;
    }
}

static void parse_mpt_table(const uint8_t *tb, size_t tlen) {
    if (tlen < 5) return;
    size_t q = 0;
    q++; /* mode */
    uint8_t pkg_id_len = tb[q++];
    if (q + pkg_id_len + 2 > tlen) return;
    if (pkg_id_len >= 2) {
        uint16_t sid = rd16(tb + q + pkg_id_len - 2);
        if (active_service_id == 0) active_service_id = sid;
    }
    q += pkg_id_len;
    uint16_t mpt_desc_len = rd16(tb + q); q += 2;
    if (q + mpt_desc_len + 1 > tlen) return;
    q += mpt_desc_len;

    uint8_t num_assets = tb[q++];
    int found_aud = 0;
    for (int ai = 0; ai < num_assets && q < tlen; ai++) {
        if (q + 6 > tlen) break;
        q += 1; /* id_type */
        q += 4; /* scheme */
        uint8_t aid_len = tb[q++];
        if (q + aid_len + 6 > tlen) break;
        q += aid_len;
        const uint8_t *atype = tb + q; q += 4;
        q += 1; /* clock_relation */
        uint8_t loc_cnt = tb[q++];
        uint16_t asset_pid = 0;
        for (int li = 0; li < loc_cnt && q < tlen; li++) {
            uint8_t ltype = tb[q++];
            if (ltype == 0x00 && q + 2 <= tlen) {
                asset_pid = rd16(tb + q); q += 2;
            } else if (ltype == 0x01 && q + 10 <= tlen) {
                q += 10;
            } else if (ltype == 0x02 && q + 34 <= tlen) {
                q += 34;
            } else {
                return;
            }
        }
        if (q + 2 > tlen) break;
        uint16_t ad_len = rd16(tb + q); q += 2;
        if (q + ad_len > tlen) break;
        const uint8_t *adesc = tb + q;
        q += ad_len;

        if ((memcmp(atype, "hev1", 4) == 0 || memcmp(atype, "hvc1", 4) == 0) && asset_pid != 0) {
            if (video_mmt_pid == 0 || video_mmt_pid == asset_pid) {
                video_mmt_pid = asset_pid;
                video_timing.mmt_pid = asset_pid;
                parse_asset_descriptors(&video_timing, adesc, ad_len);
            }
        } else if (memcmp(atype, "mp4a", 4) == 0 && asset_pid != 0) {
            int slot = -1;
            for (int k = 0; k < audio_track_count; k++) {
                if (audio_mmt_pid[k] == asset_pid) { slot = k; break; }
            }
            if (slot == -1 && audio_track_count < MAX_AUDIO_TRACKS) {
                slot = audio_track_count++;
                audio_mmt_pid[slot] = asset_pid;
                audio_timing[slot].mmt_pid = asset_pid;
            }
            if (slot >= 0) {
                parse_asset_descriptors(&audio_timing[slot], adesc, ad_len);
                found_aud++;
            }
        }
    }
    (void)found_aud;
}

static void parse_pa_message(uint16_t pid, const uint8_t *msg, size_t len) {
    /*
     * ARIB STD-B60 PA message:
     *   msg_id(2B) = 0x0000, version(1B), length(4B), num_ext(1B), ext_entries(num_ext * 4B), tables...
     *   Note: 場合により signaling payload 先頭に message_id が直置されるためオフセットを確認してパースする。
     */
    if (len < 10) return;
    uint16_t msg_id = rd16(msg);
    if (msg_id != 0x0000) return;
    uint32_t mlen = rd32(msg + 3);
    size_t p = 7;
    if (p >= len) return;
    uint8_t num_ext = msg[p++];
    p += (size_t)num_ext * 4;
    size_t end = (7 + mlen <= len) ? (7 + mlen) : len;

    while (p + 4 <= end) {
        uint8_t tid = msg[p];
        uint16_t tlen = rd16(msg + p + 2);
        p += 4;
        if (p + tlen > end) break;
        if (tid == 0x80 && pid == 0x0000) {
            parse_plt_table(msg + p, tlen);
        } else if (tid == 0x20 && (pa_pid == 0 || pid == pa_pid)) {
            parse_mpt_table(msg + p, tlen);
        }
        p += tlen;
    }
}

static void handle_signaling_packet(uint16_t pid, const uint8_t *s, size_t slen) {
    if (slen < 3) return;
    if (pid != 0x0000 && pid != pa_pid && pa_pid != 0) return;

    uint8_t hdr0 = s[0];
    int fi = (hdr0 >> 6) & 3;
    int agg = hdr0 & 1;
    int hflag = (hdr0 >> 1) & 1;
    const uint8_t *body = s + 2;
    size_t blen = slen - 2;

    if (fi == 0) {
        if (agg == 0) {
            parse_pa_message(pid, body, blen);
        } else {
            size_t p = 0;
            size_t lsz = hflag ? 2 : 4;
            while (p + lsz <= blen) {
                uint32_t ul = hflag ? rd16(body + p) : rd32(body + p);
                p += lsz;
                if (p + ul > blen) break;
                parse_pa_message(pid, body + p, ul);
                p += ul;
            }
        }
        return;
    }

    SigAssembler *sa = get_sig_asm(pid);
    if (!sa || !sa->buf) return;
    if (fi == 1) {
        sa->len = 0;
        sa->active = 1;
        if (blen <= MAX_SIG_BUF) {
            memcpy(sa->buf, body, blen);
            sa->len = blen;
        }
    } else if (fi == 2 && sa->active) {
        if (sa->len + blen <= MAX_SIG_BUF) {
            memcpy(sa->buf + sa->len, body, blen);
            sa->len += blen;
        } else {
            sa->active = 0;
        }
    } else if (fi == 3 && sa->active) {
        if (sa->len + blen <= MAX_SIG_BUF) {
            memcpy(sa->buf + sa->len, body, blen);
            sa->len += blen;
            parse_pa_message(pid, sa->buf, sa->len);
        }
        sa->active = 0;
        sa->len = 0;
    }
}

/* ============================================================================
 * MMTP パケット処理
 * ============================================================================ */
static void handle_mpu_packet(uint16_t pid, const uint8_t *p, size_t plen) {
    if (plen < 8) return;
    int is_vid = (video_mmt_pid != 0 && pid == video_mmt_pid);
    int aud_idx = -1;
    if (!is_vid) {
        for (int i = 0; i < audio_track_count; i++) {
            if (audio_mmt_pid[i] == pid) { aud_idx = i; break; }
        }
    }
    if (!is_vid && aud_idx < 0) return;

    uint16_t mpu_len = rd16(p);
    (void)mpu_len;
    uint8_t ft_byte = p[2];
    int ft = (ft_byte >> 4) & 0x0F;
    int timed = (ft_byte >> 3) & 1;
    int fi = (ft_byte >> 1) & 3;
    int agg = ft_byte & 1;
    uint32_t mpu_seq = rd32(p + 4);

    if (ft != 2 || timed != 1) return; /* Timed MFU のみ処理 */
    const uint8_t *body = p + 8;
    size_t blen = plen - 8;

    if (agg == 1) {
        size_t ap = 0;
        while (ap + 2 <= blen) {
            uint16_t ulen = rd16(body + ap);
            ap += 2;
            if (ap + ulen > blen) break;
            if (ulen > 14) {
                uint32_t snum = rd32(body + ap + 4);
                if (is_vid) {
                    handle_hevc_mfu(mpu_seq, snum, body + ap + 14, (size_t)(ulen - 14));
                } else {
                    handle_audio_mfu(aud_idx, mpu_seq, snum, body + ap + 14, (size_t)(ulen - 14));
                }
            }
            ap += ulen;
        }
        return;
    }

    if (blen < 14) return;
    uint32_t snum = rd32(body + 4);
    const uint8_t *mfu = body + 14;
    size_t mlen = blen - 14;
    MfuAssembler *ma = is_vid ? &video_mfu_asm : &audio_mfu_asm[aud_idx];

    if (fi == 0) {
        if (is_vid) handle_hevc_mfu(mpu_seq, snum, mfu, mlen);
        else handle_audio_mfu(aud_idx, mpu_seq, snum, mfu, mlen);
    } else if (fi == 1) {
        ma->len = 0;
        ma->active = 1;
        ma->mpu_seq = mpu_seq;
        ma->sample_num = snum;
        if (mlen <= MAX_MFU_BUF) {
            memcpy(ma->buf, mfu, mlen);
            ma->len = mlen;
        } else {
            ma->active = 0;
        }
    } else if (fi == 2 && ma->active) {
        if (ma->mpu_seq == mpu_seq && ma->sample_num == snum && ma->len + mlen <= MAX_MFU_BUF) {
            memcpy(ma->buf + ma->len, mfu, mlen);
            ma->len += mlen;
        } else {
            ma->active = 0;
        }
    } else if (fi == 3 && ma->active) {
        if (ma->mpu_seq == mpu_seq && ma->sample_num == snum && ma->len + mlen <= MAX_MFU_BUF) {
            memcpy(ma->buf + ma->len, mfu, mlen);
            ma->len += mlen;
            if (is_vid) handle_hevc_mfu(ma->mpu_seq, ma->sample_num, ma->buf, ma->len);
            else handle_audio_mfu(aud_idx, ma->mpu_seq, ma->sample_num, ma->buf, ma->len);
        }
        ma->active = 0;
        ma->len = 0;
    }
}

static void handle_mmtp_packet(const uint8_t *m, size_t mlen) {
    if (mlen < 12) return;
    uint8_t b0 = m[0];
    uint8_t b1 = m[1];
    uint16_t pid = rd16(m + 2);
    int ptype = b1 & 0x3F;

    size_t off = 12;
    if (b0 & 0x20) off += 4; /* C bit: packet_counter */
    if (b0 & 0x02) {         /* X bit: extension_header (type 2B + len 2B + body) */
        if (off + 4 > mlen) return;
        uint16_t ext_len = rd16(m + off + 2);
        off += 4 + ext_len;
    }
    if (off >= mlen) return;

    if (ptype == 0x02) {
        handle_signaling_packet(pid, m + off, mlen - off);
    } else if (ptype == 0x00) {
        handle_mpu_packet(pid, m + off, mlen - off);
    }
}

/* ============================================================================
 * TLV ストリーム読込ループ (リードポインタ方式で毎パケット memmove を完全排除)
 * ============================================================================ */
static uint8_t in_buf[IO_BUF_SIZE * 2];
static size_t  in_pos = 0;
static size_t  in_len = 0;

static int fill_input(size_t need) {
    while ((in_len - in_pos) < need) {
        if (in_pos > 0) {
            size_t rem = in_len - in_pos;
            if (rem > 0) {
                memmove(in_buf, in_buf + in_pos, rem);
            }
            in_pos = 0;
            in_len = rem;
        }
        size_t space = sizeof(in_buf) - in_len;
        if (space == 0) return -1;
        /* fread() は 512KB 全量揃うまでブロックしてバースト遅延を増幅するため、
         * POSIX read() でパイプに到着した分を即座に処理してリアルタイム性を保つ */
        ssize_t n;
        do {
            n = read(STDIN_FILENO, in_buf + in_len, space);
        } while (n < 0 && errno == EINTR);
        if (n <= 0) return 0;
        in_len += (size_t)n;
    }
    return 1;
}

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
    init_crc32();

    for (int i = 1; i + 1 < argc; i++) {
        if (strcmp(argv[i], "--sid") == 0) {
            target_service_id = (uint16_t)atoi(argv[i + 1]);
            i++;
        }
    }

    au_buf = (uint8_t *)malloc(MAX_AU_BUF);
    video_mfu_asm.buf = (uint8_t *)malloc(MAX_MFU_BUF);
    for (int i = 0; i < MAX_AUDIO_TRACKS; i++) {
        audio_mfu_asm[i].buf = (uint8_t *)malloc(MAX_MFU_BUF);
    }
    if (!au_buf || !video_mfu_asm.buf) {
        fprintf(stderr, "mmt2ts: out of memory\n");
        return 1;
    }

    while (1) {
        if (fill_input(4) <= 0) break;

        /* 0x7F TLV 同期バイト探索 */
        if (in_buf[in_pos] != 0x7F) {
            size_t avail = in_len - in_pos;
            uint8_t *sync = (uint8_t *)memchr(in_buf + in_pos + 1, 0x7F, avail - 1);
            if (!sync) {
                in_pos = 0;
                in_len = 0;
                continue;
            }
            in_pos = (size_t)(sync - in_buf);
            continue;
        }

        uint8_t tlv_type = in_buf[in_pos + 1];
        uint16_t tlv_len = rd16(in_buf + in_pos + 2);
        size_t pkt_total = 4 + (size_t)tlv_len;
        if (pkt_total > sizeof(in_buf)) {
            /* 異常パケット長は1バイト進めて再同期 */
            in_pos++;
            continue;
        }
        if (fill_input(pkt_total) <= 0) break;

        const uint8_t *pay = in_buf + in_pos + 4;
        if (tlv_type == 0x03 && tlv_len >= 4) {
            /* ARIB STD-B32 Table 7-3 圧縮 IP パケット:
             *   0x60: Partial IPv6 (38B) + Partial UDP (4B) = 42B
             *   0x61: IPv6/UDP 完全圧縮 = 0B
             *   0x20: Partial IPv4 (18B) + Partial UDP (4B) = 22B
             *   0x21: Partial IPv4 (18B) = 18B
             */
            uint8_t htype = pay[2];
            size_t off = 3;
            if (htype == 0x60) off += 42;
            else if (htype == 0x61) off += 0;
            else if (htype == 0x20) off += 22;
            else if (htype == 0x21) off += 18;
            else off = tlv_len;

            if (off < tlv_len) {
                handle_mmtp_packet(pay + off, tlv_len - off);
            }
        } else if (tlv_type == 0x02 && tlv_len > 48) {
            /* 非圧縮 IPv6 + UDP (40 + 8 = 48 bytes) */
            if ((pay[0] >> 4) == 6 && pay[6] == 17) {
                handle_mmtp_packet(pay + 48, tlv_len - 48);
            }
        }

        in_pos += pkt_total;
    }

    flush_video_au();
    ts_flush();
    return 0;
}
