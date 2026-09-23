/* ============================================================
   charon.js — пиксельный маскот Charon (рендерер)
   ------------------------------------------------------------
   SPRITE извлечён 1:1 из фото пользователя (24×15):
   '#' — тело, 'e' — глаз, '.' — пусто. Ничего не придумано.
   Канвас 26×15: два лишних столбца справа — для «руки»,
   которая поднимается в кадрах машания.

   Живое поведение (всё включается выключается настройками):
   • startIdle()   — моргание (idle-цикл);
   • lookAt(x,y)   — ГЛАЗА следят за мышкой: зрачок «растёт»
                     в сторону курсора (тело стоит на месте);
                     если курсор рядом — машет рукой (не чаще
                     раза в 4 с);
   • wave(n)       — машет правой рукой;
   • setAnim(on)   — анимация вкл/выкл (выкл = статичный кадр);
   • setHidden(h) — сам маскот вкл/выкл.
   ============================================================ */
(() => {
  "use strict";

  /* --- Точный спрайт 24×15 (из фото) --- */
  const SPRITE = [
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
  ];
  const W = 24, H = 15, CW = 26; // CW — ширина канваса (24 + 2 под руку)
  const EYE_TOP = [[6, 3], [6, 4], [16, 3], [17, 3]]; // верх глаз (закрывается при мигании)
  const COLORS = { body: "#935c4f", eye: "#281412" };

  /* --- Сборка кадров --- */
  function pad(row) { return row + ".."; }
  function frame(mutate) {
    const g = SPRITE.map((r) => r.split(""));
    if (mutate) mutate(g);
    return g.map((r) => r.join("") + "..");
  }

  const FRAMES = {
    idle: frame(),
    /* мигание: верхние ряды глаз закрываются */
    blink: frame((g) => EYE_TOP.forEach(([c, r]) => { g[r][c] = "#"; })),
    /* машет: правая часть «руки» (столбцы 21–23) поднимается.
       А — рука на строках 0–2 (высоко), В — на 2–4 (чуть ниже). */
    waveA: frame((g) => {
      for (let r = 6; r <= 8; r++) for (let c = 21; c <= 23; c++) g[r][c] = ".";
      for (let r = 0; r <= 2; r++) for (let c = 21; c <= 23; c++) g[r][c] = "#";
    }),
    waveB: frame((g) => {
      for (let r = 6; r <= 8; r++) for (let c = 21; c <= 23; c++) g[r][c] = ".";
      for (let r = 2; r <= 4; r++) for (let c = 21; c <= 23; c++) g[r][c] = "#";
    }),
  };

  /**
   * Нарисовать кадр. ox/oy (−1/0/1) — куда «смотрят» глаза:
   * зрачок тянется на одну клетку в сторону курсора
   * (тело при этом не двигается — «стоит на месте»).
   */
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
          // зрачок: базовая клетка + вытянутая в сторону курсора
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

  /** Живой маскот: idle (моргает) + follow за мышкой + wave(). */
  class CharonSprite {
    constructor(canvas, { blink = true, anim = true } = {}) {
      this.canvas = canvas;
      this.blinkEnabled = blink;
      this.anim = anim;          // анимация вкл/выкл
      this.tracking = true;      // следит ли за мышкой
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
        this.timers.push(setTimeout(() => this._paint("idle"), 160));
        this.timers.push(setTimeout(tick, 2200 + Math.random() * 3500));
      };
      this.timers.push(setTimeout(tick, 1400 + Math.random() * 2200));
    }

    stop() {
      this.timers.forEach(clearTimeout);
      this.timers = [];
      if (!this.waving) this._paint("idle");
    }

    /** Машет правой рукой cycles циклов, затем возвращается в idle. */
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

    /**
     * Глаза следят за точкой (координаты страницы).
     * Тело стоит на месте. Если курсор оказался рядом —
     * коротко машет (не чаще раза в 4 с).
     */
    lookAt(pageX, pageY) {
      if (!this.anim || !this.tracking) return;
      const now = Date.now();
      if (now - this._lastLookAt < 90) return; // троттлинг
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
      // курсор рядом с маскотом → помахал (рукой «привет»)
      const near =
        pageX > b.left - 90 && pageX < b.right + 90 &&
        pageY > b.top - 60 && pageY < b.bottom + 60;
      if (near && !this.waving && now - this.lastWaveAt > 4000) {
        this.lastWaveAt = now;
        this.wave(2);
      }
    }

    /** Анимация вкл/выкл. Выкл = статичный кадр, глаза по центру. */
    setAnim(on) {
      this.anim = !!on;
      if (!this.anim) {
        this.eyeOX = 0; this.eyeOY = 0;
        this.stop();
      } else {
        this.startIdle();
      }
    }

    /** Сам маскот вкл/выкл (мини-канвас). */
    setHidden(h) {
      this.canvas.style.display = h ? "none" : "";
    }
  }

  window.CharonSprite = CharonSprite;
  window.renderCharonFrame = renderFrame;
})();
