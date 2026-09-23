#!/usr/bin/env python3
"""Генератор иконки приложения (assets/icon.png, 256×256).

Спрайт Charon извлечён 1:1 из фото пользователя (см. SPRITE ниже).
Запуск:  python3 gen_icon.py
"""
from PIL import Image, ImageDraw

# Точная пиксельная сетка маскота 24×15 (из фото):
# '#' — тело, 'e' — глаз, '.' — пусто
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
RAD = 56


def main():
    S = 256
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=RAD, fill=BG + (255,))
    scale = 9  # 24*9 = 216, 15*9 = 135
    ox, oy = (S - W * scale) // 2, (S - H * scale) // 2
    for gy, row in enumerate(SPRITE):
        for gx, ch in enumerate(row):
            if ch == ".":
                continue
            fill = (EYE if ch == "e" else BODY) + (255,)
            x0, y0 = ox + gx * scale, oy + gy * scale
            d.rectangle([x0, y0, x0 + scale - 1, y0 + scale - 1], fill=fill)
    img.save("assets/icon.png")
    print("OK: assets/icon.png")


if __name__ == "__main__":
    main()
