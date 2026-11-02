/* ============================================================
   browser.js — ИНКОГНИТО-браузер ИИ
   ------------------------------------------------------------
   Правила (жёсткие, по требованию пользователя):
     • ТОЛЬКО инкогнито: отдельный непersist-partition
       "cc-incognito" — НИ ОДНА твоя кука, пароль, история
       туда не попадают; после закрытия — стерто всё.
     • Все окна, открытые ИИ, ЗАКРЫВАЮТСЯ САМОСТОЯТЕЛЬНО
       после каждого промта (closeAll() в finally движка).
     • Режим показа — тумблер в настройках: видимое окно /
       тихо в фоне.
   ============================================================ */
"use strict";

const { BrowserWindow } = require("electron");
const store = require("./store");

/** Окна, открытые ИИ (чтобы закрыть все после промта). */
const openWindows = new Set();

/** Открыть страницу и вернуть её видимый текст (+ скриншот).
 * @param {string} url
 * @param {object} opts { capture: bool }
 * @returns {Promise<{ok, title, text, dataUrl?, error?}>}
 */
async function browse(url, { capture = false } = {}) {
  let u;
  try {
    u = new URL(String(url));
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("протокол");
  } catch {
    return { ok: false, error: "Некорректный URL (нужен http/https)" };
  }

  const s = store.getSettings();
  const visible = s.browserVisible !== false; // по умолчанию — видимое окно

  const w = new BrowserWindow({
    width: 1000,
    height: 720,
    show: visible,
    frame: true,
    title: "Charon · Инкогнито",
    // Непersist-partition: чистый профиль на время жизни окна.
    // Всё, что «всплывёт» здесь, исчезает при закрытии — инкогнито.
    webPreferences: {
      partition: "cc-incognito",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  openWindows.add(w);
  w.on("closed", () => openWindows.delete(w));

  const TITLE = "Charon · Инкогнито (не используй, не закрывай — закроется сама)";
  w.setTitle(TITLE);

  const timer = setTimeout(() => safeClose(w), 90000); // 90 с — максимум на страницу
  try {
    await w.loadURL(u.toString(), { timeout: 45000 });
    // Даём странице дорисоваться (JS/SPA)
    await new Promise((r) => setTimeout(r, 2600));

    let title = "", text = "";
    try {
      const res = await w.webContents.executeJavaScript(
        "(() => { const t = document.title || ''; " +
        "const el = document.body; " +
        "const x = el ? el.innerText || el.textContent || '' : ''; " +
        "return JSON.stringify({ t, x: x.slice(0, 24000) }); })()"
      );
      const j = JSON.parse(res || "{}");
      title = j.t || "";
      text = (j.x || "").replace(/\n{3,}/g, "\n\n").trim();
    } catch { /* страница могла уйти — ок */ }

    let dataUrl = null;
    if (capture) {
      try {
        const img = await w.webContents.capturePage();
        if (img && !img.isEmpty()) dataUrl = img.toDataURL("image/png");
      } catch { /* без скриншота */ }
    }

    return { ok: true, title, url: u.toString(), text: text.slice(0, 20000), dataUrl };
  } catch (e) {
    return { ok: false, error: "Не удалось открыть страницу: " + String(e.message || e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
    safeClose(w); // ОКНО ЗАКРЫВАЕТСЯ ПОСЛЕ КАЖДОЙ СТРАНИЦЫ
  }
}

function safeClose(w) {
  try {
    if (!w.isDestroyed()) w.close();
  } catch { /* уже закрыто */ }
}

/** Закрыть ВСЕ инкогнито-окна (вызывается в конце каждого промта). */
function closeAll() {
  for (const w of [...openWindows]) safeClose(w);
  openWindows.clear();
}

module.exports = { browse, closeAll };
