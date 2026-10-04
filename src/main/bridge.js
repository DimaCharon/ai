/* ============================================================
   bridge.js — «Arena Bridge»: локальный HTTP-сервер, к которому
   подключается браузерное расширение (папка extension/).
   Расширение подсовывает свежую сессию arena.ai → приложение
   сохраняет её в настройки и проверяет. Больше не нужно копировать
   куку вручную (токен Арены живёт ~1 час — расширение решает это
   в один клик).

   Безопасность:
     • сервер слушает ТОЛЬКО 127.0.0.1 (недоступен из сети);
     • принимает только две команды: ping и arena-cookie;
     • кука попадает только в локальные settings.json.

   Эндпоинты:
     GET  /ping          → { ok, app, version }
     POST /arena-cookie  → { cookie: "k=v; k2=v2" }
                          → { ok, saved, user?, warn? }
   CORS открыт (расширение приходит с origin chrome-extension://).
   ============================================================ */
"use strict";

const http = require("http");
const path = require("path");
const { app } = require("electron");
const store = require("./store");

const BRIDGE_PORT = 48107;

/** Папка расширения: рядом с exe (extraResources) или в проекте (dev). */
function extDir() {
  if (app.isPackaged) {
    return path.join(path.dirname(app.getPath("exe")), "extension");
  }
  return path.join(__dirname, "..", "..", "extension");
}

/**
 * Запустить сервер. @param {object} engine — движок (для проверки куки
 * через providers.arena.check()).
 */
function startBridgeServer(engine) {
  let server;
  try {
    server = http.createServer((req, res) => {
      const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };
      const send = (code, obj) => {
        try {
          res.writeHead(code, obj === undefined ? cors : { ...cors, "Content-Type": "application/json" });
          res.end(obj === undefined ? "" : JSON.stringify(obj));
        } catch { /* соединение уже рвано */ }
      };
      if (req.method === "OPTIONS") { send(204); return; }

      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 1024 * 1024) req.destroy(); // защита от огромных тел
      });
      req.on("end", () => {
        try {
          if (req.url === "/ping" && req.method === "GET") {
            return send(200, { ok: true, app: "charon-code", version: app.getVersion() });
          }
          if (req.url === "/arena-cookie" && req.method === "POST") {
            const j = JSON.parse(body || "{}");
            const cookie = String(j.cookie || "").trim();
            if (!cookie) return send(400, { ok: false, error: "Пустая кука — расширение ничего не передало." });
            const s = store.getSettings();
            store.saveSettings({ keys: { ...s.keys, arenaCookie: cookie } });
            // Живая проверка сессии (ответ придёт, как только Arena ответит)
            (async () => {
              let user = null, warn = null;
              try {
                const chk = await engine.providers.arena.check();
                user = (chk && chk.username) || null;
              } catch (err) {
                warn = String((err && err.message) || err).slice(0, 200);
              }
              send(200, { ok: true, saved: true, user, warn });
            })();
            return;
          }
          send(404, { ok: false, error: "Неизвестный эндпоинт" });
        } catch (e) {
          send(400, { ok: false, error: String(e.message || e).slice(0, 140) });
        }
      });
    });
    server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        console.warn("[bridge] порт " + BRIDGE_PORT + " занят другим экземпляром — пропускаю");
      } else {
        console.error("[bridge] ошибка сервера:", e.message);
      }
    });
    server.listen(BRIDGE_PORT, "127.0.0.1");
    console.log("[bridge] Arena Bridge слушает 127.0.0.1:" + BRIDGE_PORT);
  } catch (e) {
    console.error("[bridge] не удалось запустить сервер:", e.message);
  }
}

module.exports = { startBridgeServer, extDir, BRIDGE_PORT };
