"""
生成扩展图标：圆角方块 + 白色对勾。

不依赖任何三方库（Pillow / cairosvg 都没有），只用 zlib + struct 手写 PNG，
配合超采样做抗锯齿。输出 16 / 48 / 128 三个尺寸。

用法：python make-icons.py
"""

import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")

# 背景渐变（上 → 下）
BG_TOP = (31, 122, 224)
BG_BOT = (10, 86, 184)
INK = (255, 255, 255)

# 对勾折线（归一化坐标），半径也是归一化的
CHECK = [(0.26, 0.53), (0.43, 0.70), (0.76, 0.29)]
CHECK_R = 0.077

SIZES = (16, 48, 128)
SS = 8          # 每像素每轴的超采样数
CORNER_R = 0.22  # 圆角半径（归一化）


def dist_to_seg(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    l2 = vx * vx + vy * vy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / l2))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def inside_round_rect(x, y, w, h, r):
    """x/y 为像素坐标，w/h 为边长，r 为圆角半径"""
    if x < 0 or y < 0 or x > w or y > h:
        return False
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    # 距离最近的「圆角圆心」不超过 r 即在内部
    if (x < r or x > w - r) and (y < r or y > h - r):
        return math.hypot(x - cx, y - cy) <= r
    return True


def inside_check(x, y, s):
    """x/y 归一化坐标，s 为尺寸（用于把线宽换算回归一化）"""
    pts = [(px * s, py * s) for px, py in CHECK]
    rad = CHECK_R * s
    # 先看两端点与折点的小圆（等于给折线加了圆头 + 圆滑拐角）
    for px, py in pts:
        if math.hypot(x - px, y - py) <= rad:
            return True
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        if dist_to_seg(x, y, ax, ay, bx, by) <= rad:
            return True
    return False


def render(size):
    """返回 size*size 的 RGBA 像素列表（straight alpha）"""
    px_out = []
    inv = 1.0 / SS
    for py in range(size):
        for px in range(size):
            acc_r = acc_g = acc_b = acc_a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) * inv
                    y = py + (sy + 0.5) * inv
                    if not inside_round_rect(x, y, size, size, CORNER_R * size):
                        continue
                    if inside_check(x, y, size):
                        acc_r += INK[0]; acc_g += INK[1]; acc_b += INK[2]
                        acc_a += 1.0
                    else:
                        # 竖直渐变
                        t = y / size
                        acc_r += BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t
                        acc_g += BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t
                        acc_b += BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t
                        acc_a += 1.0
            n = float(SS * SS)
            a = acc_a / n
            if a <= 0:
                px_out.append((0, 0, 0, 0))
            else:
                # 累加的是 premultiplied，PNG 要 straight alpha
                px_out.append((
                    int(round(acc_r / n / a)),
                    int(round(acc_g / n / a)),
                    int(round(acc_b / n / a)),
                    int(round(a * 255)),
                ))
    return px_out


def write_png(path, size, pixels):
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: none
        for x in range(size):
            r, g, b, a = pixels[y * size + x]
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    blob = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(blob)
    return len(blob)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        px = render(size)
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        n = write_png(path, size, px)
        print("icon%d.png  %d bytes" % (size, n))


if __name__ == "__main__":
    main()
