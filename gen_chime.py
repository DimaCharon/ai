#!/usr/bin/env python3
"""Генератор СПОКОЙНОГО ТИХОГО чима завершения задачи (assets/chime.wav).

Два мягких колокольных тона Do5 -> Mi5 (большая терция),
длинный attack, медленное экспоненциальное затухание,
минимум верхних гармоник (никакой «резкости»),
пиковая громкость 0.09 — тише, чем дыхание.
Запуск:  python3 gen_chime.py
"""
import math
import os
import struct
import wave

SR = 44100


def bell(freq: float, dur: float, amp: float):
    """Мягкий колокольный тон: медленный attack + exp-затухание."""
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        attack = min(1.0, t / 0.040)                 # 40 мс — без щелчка
        env = math.exp(-t / 1.15) * attack           # медленное гасание
        v = (
            0.85 * math.sin(2 * math.pi * freq * t)
            + 0.08 * math.sin(2 * math.pi * freq * 2 * t)
            + 0.015 * math.sin(2 * math.pi * freq * 3 * t)
        )
        out.append(v * env * amp)
    return out


def place(buf, start, sig):
    s = int(start * SR)
    for i, v in enumerate(sig):
        if s + i < len(buf):
            buf[s + i] += v


def main():
    total = 1.9
    buf = [0.0] * int(SR * total)
    place(buf, 0.00, bell(523.25, 1.25, 0.55))  # Do5
    place(buf, 0.35, bell(659.25, 1.50, 0.45))  # Mi5
    peak = max(abs(x) for x in buf) or 1.0
    scale = 0.09 / peak  # ТИХИЙ пик
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "assets", "chime.wav")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = b"".join(struct.pack("<h", int(x * scale * 32767)) for x in buf)
        w.writeframes(frames)
    print(f"OK: {path} ({os.path.getsize(path)} bytes, quiet={scale:.4f})")


if __name__ == "__main__":
    main()
