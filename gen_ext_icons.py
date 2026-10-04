#!/usr/bin/env python3
"""Иконки для браузерного расширения (extension/icon16|48|128.png).
Спрайт — тот же, что в gen_icon.py."""
from PIL import Image, ImageDraw

SPRITE = [
    "...##################...",
    "...##################...",
    "...##################...",
    "...###e#########ee###...",
    "...###e#########ee###...",
    "...###e##############...",
    "########################",
    "########################",
    "########################",
    "########################",
    "########################",
    "########################",
    "...##################...",
    "...##################...",
    "...##################...",
    "....##.##......#..#.....",
    "....##.##......#..#.....",
    ".....#.##......#..#.....",
]
W, H = 24, 15
BODY = (147, 92, 79)
EYE = (40, 20, 18)
BG = (20, 22, 28)


def make(S, path):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rad = max(2, round(S * 0.22))
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=rad, fill=BG + (255,))
    scale = max(1, S // W - (1 if S % W < W // 2 else 0))
    scale = max(1, (S - 4) // W)
    ox, oy = (S - W * scale) // 2, (S - H * scale) // 2
    for gy, row in enumerate(SPRITE):
        for gx, ch in enumerate(row):
            if ch == ".":
                continue
            fill = (EYE if ch == "e" else BODY) + (255,)
            x0, y0 = ox + gx * scale, oy + gy * scale
            d.rectangle([x0, y0, x0 + scale - 1, y0 + scale - 1], fill=fill)
    img.save(path)
    print("OK:", path, S, "scale", scale)


if __name__ == "__main__":
    for size in (16, 48, 128):
        make(size, "extension/icon%d.png" % size)
