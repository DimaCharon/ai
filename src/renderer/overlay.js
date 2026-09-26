/* ============================================================
   overlay.js — логика окна-оверлея маскота
   ------------------------------------------------------------
   main-процесс показывает это окно, когда задача завершена.
   Маскот вылезает из угла, машет правой рукой, затем замеряет
   в idle (покачивание + моргание) до клика. Клик → возврат
   в приложение (main фокусирует главное окно).
   ============================================================ */
(() => {
  "use strict";
  const slot = document.getElementById("slot");
  const tip = document.getElementById("tip");
  const sprite = new window.CharonSprite(document.getElementById("c"), { blink: true });

  function applyScale(s) {
    const v = Math.min(2, Math.max(0.6, Number(s) || 1));
    document.body.style.setProperty("--ms", v);
  }
  window.cc.overlay.onScale(applyScale);

  window.cc.overlay.onShow((tipText, scale) => {
    if (scale) applyScale(scale);
    tip.textContent = tipText || "Задача выполнена — кликни, чтобы вернуться";
    tip.classList.add("show");
    // перезапуск pop-анимации
    slot.classList.remove("pop", "bob");
    void slot.offsetWidth;
    slot.classList.add("pop");
    // после доезда — махать правой рукой, затем idle-цикл
    setTimeout(() => {
      sprite.wave(3, () => sprite.startIdle());
      slot.classList.add("bob");
    }, 640);
  });

  window.cc.overlay.onHide(() => {
    tip.classList.remove("show");
    slot.classList.remove("pop", "bob");
    sprite.stop();
  });

  // Клик по маскоту → вернуть фокус в приложение
  slot.addEventListener("click", () => window.cc.overlay.click());
})();
