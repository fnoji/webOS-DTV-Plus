# -*- coding: utf-8 -*-
"""
LG webOS 純正テーマカラー (#CF0652 Carmine Magenta & チャコールグレー #181A20) 基調の
アプリアイコン (80x80, 130x130) およびスプラッシュ画像を生成するスクリプト。
"""
import os
import struct
import zlib


def write_png(path, width, height, pixel_fn):
    raw_rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            r, g, b, a = pixel_fn(x, y, width, height)
            row.extend((r, g, b, a))
        raw_rows.append(bytes(row))
    raw_data = b"".join(raw_rows)

    def chunk(tag, data):
        return (
            struct.pack("!I", len(data))
            + tag
            + data
            + struct.pack("!I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack("!IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw_data, 6))
        + chunk(b"IEND", b"")
    )
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)


def make_icon_pixel(accent_rgb):
    ar, ag, ab = accent_rgb

    def fn(x, y, w, h):
        nx = (x + 0.5) / w
        ny = (y + 0.5) / h
        # LG純正風 チャコールスレート背景 (#242730 -> #121418)
        br = int(36 - 18 * ny)
        bg = int(39 - 19 * ny)
        bb = int(48 - 24 * ny)

        # 上下左右アクセントライン
        margin = 0.075
        if nx < margin or nx > 1 - margin or ny < margin or ny > 1 - margin:
            return (ar, ag, ab, 255)

        # DTV モニター枠
        if 0.18 <= nx <= 0.82 and 0.22 <= ny <= 0.72:
            border = 0.055
            if (
                nx < 0.18 + border
                or nx > 0.82 - border
                or ny < 0.22 + border
                or ny > 0.72 - border
            ):
                return (245, 247, 250, 255)
            # LG マゼンタ再生シンボル
            tx = (nx - 0.41) / 0.22
            ty = abs(ny - 0.47) / 0.14
            if 0.0 <= tx <= 1.0 and ty <= (1.0 - tx):
                return (ar, ag, ab, 255)

        # スタンドバー
        if 0.34 <= nx <= 0.66 and 0.78 <= ny <= 0.83:
            return (ar, ag, ab, 255)

        return (br, bg, bb, 255)

    return fn


def make_splash_pixel(x, y, w, h):
    ny = y / float(h)
    return (int(24 - 10 * ny), int(26 - 11 * ny), int(32 - 14 * ny), 255)


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    # LG 純正フォーカスカラー #CF0652 (207, 6, 82)
    lg_magenta = make_icon_pixel((207, 6, 82))
    write_png(os.path.join(root, "app", "icon80.png"), 80, 80, lg_magenta)
    write_png(os.path.join(root, "app", "icon130.png"), 130, 130, lg_magenta)
    write_png(os.path.join(root, "app", "splash.png"), 320, 180, make_splash_pixel)

    ov_fn = make_icon_pixel((0, 180, 216))
    write_png(os.path.join(root, "overlay-app", "icon80.png"), 80, 80, ov_fn)
    write_png(os.path.join(root, "overlay-app", "icon130.png"), 130, 130, ov_fn)
    print("Generated LG-themed icons successfully.")
