/* ============================================================
   charon.js — пиксельный маскот Charon (рендерер)
   ------------------------------------------------------------
   SPRITE скопирован 1:1 из изображения пользователя (13×8):
   '#' — тело (#D97757), 'e' — глаз (белый), '.' — пусто.
   Форма: «голова» 9×3 с глазами 1×2, руки по бокам (2 ряда),
   «ноги» — 4 лапки (столбцы 2, 4, 8, 10, ряд 7).

   Живое поведение (настройки: показ / анимация / размер):
   • startIdle()  — моргание;
   • lookAt(x,y)  — глаза «тянутся» к курсору (тело на месте),
                    рядом → машет правой рукой (не чаще 4 с);
   • wave(n)      — поднимает правую руку (кадры A/B);
   • setAnim(on)  — анимация вкл/выкл (выкл = статика);
   • setHidden(h)— сам маскот вкл/выкл.
   ============================================================ */
(() => {
  "use strict";

  /* --- Точный спрайт 13×8 (1:1 из изображения) --- */
  const SPRITE = [
    ".............",
    "..#########..",
    "..#e#####e#..",
    "..#e#####e#..",
    "#############",
    "#############",
    "..#########..",
    "..#.#...#.#..",
  ];
  const W = 13, H = 8, CW = 13; // канвас = размер спрайта
  const EYE_TOP = [[3, 2], [9, 2]]; // верх глаз (закрывается при мигании)
  const COLORS = { body: "#d97757", eye: "#ffffff" };

  function frame(mutate) {
    const g = SPRITE.map((r) => r.split(""));
    if (mutate) mutate(g);
    return g.map((r) => r.join(""));
  }

  const FRAMES = {
    idle: frame(),
    /* мигание: верхний ряд глаз закрывается */
    blink: frame((g) => EYE_TOP.forEach(([c, r]) => { g[r][c] = "#"; })),
    /* машет: правая рука (столбцы 11–12, ряды 4–5) поднимается вверх.
       А — руки на рядах 2–3, В — на рядах 1–2 (выше). */
    waveA: frame((g) => {
      for (let r = 4; r <= 5; r++) for (let c = 11; c <= 12; c++) g[r][c] = ".";
      for (let r = 2; r <= 3; r++) for (let c = 11; c <= 12; c++) g[r][c] = "#";
    }),
    waveB: frame((g) => {
      for (let r = 4; r <= 5; r++) for (let c = 11; c <= 12; c++) g[r][c] = ".";
      for (let r = 1; r <= 2; r++) for (let c = 11; c <= 12; c++) g[r][c] = "#";
    }),
  };

  /** Нарисовать кадр. ox/oy (−1/0/1) — куда смотрят глаза. */
  function renderFrame(canvas, name, ox = 0, oy = 0) {
    const ctx = canvas.getContext("2d");
    const px = Math.floor(canvas.width / CW);
    const py = Math.floor(canvas.height / H);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const grid = FRAMES[name] || FRAMES.idle;
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < CW; c++) {
        const ch = grid[r][c];
        if (ch === ".") continue;
        const isEye = ch === "e";
        ctx.fillStyle = isEye ? COLORS.eye : COLORS.body;
        if (isEye && (ox || oy) && name !== "blink") {
          ctx.fillRect(c * px, r * py, px, py);
          if (ox > 0) ctx.fillRect((c + 1) * px, r * py, px, py);
          if (ox < 0) ctx.fillRect((c - 1) * px, r * py, px, py);
          if (oy > 0) ctx.fillRect(c * px, (r + 1) * py, px, py);
          if (oy < 0) ctx.fillRect(c * px, (r - 1) * py, px, py);
        } else {
          ctx.fillRect(c * px, r * py, px, py);
        }
      }
    }
  }

  class CharonSprite {
    constructor(canvas, { blink = true, anim = true } = {}) {
      this.canvas = canvas;
      this.blinkEnabled = blink;
      this.anim = anim;
      this.tracking = true;
      this.timers = [];
      this.waving = false;
      this.eyeOX = 0; this.eyeOY = 0;
      this.lastWaveAt = 0;
      this._lastLookAt = 0;
      renderFrame(canvas, "idle");
    }

    _paint(name) {
      renderFrame(this.canvas, name, this.eyeOX, this.eyeOY);
    }

    startIdle() {
      this.stop();
      if (!this.blinkEnabled || !this.anim) return;
      const tick = () => {
        if (this.waving || !this.anim) return;
        this._paint("blink");
        this.timers.push(setTimeout(() => this._paint("idle"), 170));
        this.timers.push(setTimeout(tick, 2200 + Math.random() * 3500));
      };
      this.timers.push(setTimeout(tick, 1400 + Math.random() * 2200));
    }

    stop() {
      this.timers.forEach(clearTimeout);
      this.timers = [];
      if (!this.waving) this._paint("idle");
    }

    /** Машет правой рукой (поднимает вверх) cycles циклов. */
    wave(cycles = 3, onDone) {
      this.stop();
      this.waving = true;
      let i = 0;
      const step = () => {
        renderFrame(this.canvas, i % 2 ? "waveB" : "waveA", this.eyeOX, this.eyeOY);
        i++;
        if (i <= cycles * 2) {
          this.timers.push(setTimeout(step, 170));
        } else {
          this.waving = false;
          this._paint("idle");
          this.startIdle();
          if (onDone) onDone();
        }
      };
      step();
    }

    /** Глаза следят за точкой (координаты страницы). Рядом — машет. */
    lookAt(pageX, pageY) {
      if (!this.anim || !this.tracking) return;
      const now = Date.now();
      if (now - this._lastLookAt < 90) return;
      this._lastLookAt = now;

      const b = this.canvas.getBoundingClientRect();
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      const dx = pageX - cx, dy = pageY - cy;
      const ox = Math.abs(dx) > 60 ? Math.sign(dx) : 0;
      const oy = Math.abs(dy) > 40 ? Math.sign(dy) : 0;
      if (ox !== this.eyeOX || oy !== this.eyeOY) {
        this.eyeOX = ox; this.eyeOY = oy;
        if (!this.waving) this._paint("idle");
      }
      const near =
        pageX > b.left - 90 && pageX < b.right + 90 &&
        pageY > b.top - 60 && pageY < b.bottom + 60;
      if (near && !this.waving && now - this.lastWaveAt > 4000) {
        this.lastWaveAt = now;
        this.wave(2);
      }
    }

    setAnim(on) {
      this.anim = !!on;
      if (!this.anim) {
        this.eyeOX = 0; this.eyeOY = 0;
        this.stop();
      } else {
        this.startIdle();
      }
    }

    setHidden(h) {
      this.canvas.style.display = h ? "none" : "";
    }
  }

  window.CharonSprite = CharonSprite;
  window.renderCharonFrame = renderFrame;
})();
