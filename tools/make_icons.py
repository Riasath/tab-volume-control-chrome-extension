#!/usr/bin/env python3
"""Render the extension icons (speaker + waves on a rounded blue tile).

No third-party deps: shapes are rasterised with 4x supersampling and written
out as PNGs by hand. Run from anywhere:  python3 tools/make_icons.py
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
SS = 4  # supersample factor

BG_TOP = (59, 130, 246)
BG_BOTTOM = (37, 99, 235)
FG = (255, 255, 255)


def rounded_rect(x, y, r):
    """Coverage test for a rounded unit square with corner radius r."""
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def speaker(x, y):
    # Body of the speaker.
    if 0.20 <= x <= 0.33 and 0.40 <= y <= 0.60:
        return True
    # Cone: widens linearly from the body out to x = 0.50.
    if 0.33 <= x <= 0.50:
        t = (x - 0.33) / (0.50 - 0.33)
        half = 0.10 + t * 0.16
        if abs(y - 0.5) <= half:
            return True
    return False


def wave(x, y, radius, thickness=0.05, spread=52.0):
    dx, dy = x - 0.50, y - 0.50
    d = math.hypot(dx, dy)
    if abs(d - radius) > thickness / 2:
        return False
    if dx <= 0:
        return False
    return abs(math.degrees(math.atan2(dy, dx))) <= spread


def render(size):
    px = bytearray()
    n = SS * SS
    for py in range(size):
        px.append(0)  # PNG filter byte: none
        for pxi in range(size):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    u = (pxi + (sx + 0.5) / SS) / size
                    v = (py + (sy + 0.5) / SS) / size
                    if not rounded_rect(u, v, 0.22):
                        continue
                    br = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * v
                    bg = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * v
                    bb = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * v
                    ink = speaker(u, v) or wave(u, v, 0.20) or (
                        size >= 32 and wave(u, v, 0.31, 0.055)
                    )
                    if ink:
                        br, bg, bb = FG
                    r += br
                    g += bg
                    b += bb
                    a += 255.0
            if a == 0:
                px += b"\0\0\0\0"
            else:
                cov = a / n
                px += bytes(
                    (
                        int(round(r / (a / 255.0))),
                        int(round(g / (a / 255.0))),
                        int(round(b / (a / 255.0))),
                        int(round(cov)),
                    )
                )
    return bytes(px)


def png(size, raw):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


os.makedirs(OUT, exist_ok=True)
for s in (16, 32, 48, 128):
    path = os.path.join(OUT, "icon%d.png" % s)
    with open(path, "wb") as f:
        f.write(png(s, render(s)))
    print("wrote", os.path.normpath(path))
