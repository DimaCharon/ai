/* ============================================================
   charon.js — пиксельный маскот Charon (рендерер)
   ------------------------------------------------------------
   SPRITE извлечён 1:1 из фото пользователя (24×15):
   '#' — тело, 'e' — глаз, '.' — пусто. Ничего не придумано.
   Канвас 26×15: два лишних столбца справа — для «руки»,
   которая поднимается в кадрах машания.
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

  /** Нарисовать кадр на canvas (размер канваса кратен 26×15). */
  function renderFrame(canvas, name) {
    const ctx = canvas.getContext("2d");
    const px = Math.floor(canvas.width / CW);
    const py = Math.floor(canvas.height / H);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const grid = FRAMES[name] || FRAMES.idle;
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < CW; c++) {
        const ch = grid[r][c];
        if (ch === ".") continue;
        ctx.fillStyle = ch === "e" ? COLORS.eye : COLORS.body;
        ctx.fillRect(c * px, r * py, px, py);
      }
    }
  }

  /** Живой маскот: idle (бывает моргает) + wave() — машет рукой. */
  class CharonSprite {
    constructor(canvas, { blink = true } = {}) {
      this.canvas = canvas;
      this.blinkEnabled = blink;
      this.timers = [];
      this.waving = false;
      renderFrame(canvas, "idle");
    }

    startIdle() {
      this.stop();
      if (!this.blinkEnabled) return;
      const tick = () => {
        if (this.waving) return;
        renderFrame(this.canvas, "blink");
        this.timers.push(setTimeout(() => renderFrame(this.canvas, "idle"), 160));
        this.timers.push(setTimeout(tick, 2200 + Math.random() * 3500));
      };
      this.timers.push(setTimeout(tick, 1400 + Math.random() * 2200));
    }

    stop() {
      this.timers.forEach(clearTimeout);
      this.timers = [];
      if (!this.waving) renderFrame(this.canvas, "idle");
    }

    /** Машет правой рукой cycles циклов, затем возвращается в idle. */
    wave(cycles = 3, onDone) {
      this.stop();
      this.waving = true;
      let i = 0;
      const step = () => {
        renderFrame(this.canvas, i % 2 ? "waveB" : "waveA");
        i++;
        if (i <= cycles * 2) {
          this.timers.push(setTimeout(step, 170));
        } else {
          this.waving = false;
          renderFrame(this.canvas, "idle");
          this.startIdle();
          if (onDone) onDone();
        }
      };
      step();
    }
  }

  window.CharonSprite = CharonSprite;
  window.renderCharonFrame = renderFrame;
})();
