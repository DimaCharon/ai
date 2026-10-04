/* Charon Code — Arena Bridge (popup)
   Логика целиком здесь; service worker не нужен.
   • ping:   GET  http://127.0.0.1:48107/ping        → работает ли приложение
   • кука:   chrome.cookies getAll domain=arena.ai   → полная строка "k=v; k2=v2"
   • push:   POST http://127.0.0.1:48107/arena-cookie → приложение сохраняет
   и проверяет сессию. */
"use strict";

const APP_URL = "http://127.0.0.1:48107";
const $ = (s) => document.querySelector(s);

async function pingApp() {
  try {
    const r = await fetch(APP_URL + "/ping", { method: "GET" });
    const j = await r.json();
    return j && j.ok ? j : null;
  } catch {
    return null;
  }
}

async function readArenaCookies() {
  try {
    const cs = await chrome.cookies.getAll({ domain: "arena.ai" });
    if (!cs || !cs.length) return null;
    // Авторизационные куки Арены первыми (на всякий случай), остальные — после.
    const auth = cs.filter((c) => c.name.startsWith("arena-auth"));
    const rest = cs.filter((c) => !c.name.startsWith("arena-auth"));
    return [...auth, ...rest].map((c) => c.name + "=" + c.value).join("; ");
  } catch {
    return null;
  }
}

function setSt(id, state, text) {
  const el = $("#" + id);
  el.className = "st " + state;
  el.textContent = (state === "ok" ? "✓ " : state === "bad" ? "✗ " : "● ") + text;
}

async function refresh() {
  const app = await pingApp();
  setSt("st-app", app ? "ok" : "bad", app ? "работает" : "не запущено");
  const ck = await readArenaCookies();
  setSt("st-cook", ck ? "ok" : "bad", ck ? "найдена" : "не найдена");
  return { app, ck };
}

$("#btn-push").addEventListener("click", async () => {
  const btn = $("#btn-push");
  const res = $("#result");
  btn.disabled = true;
  res.className = "result";
  res.textContent = "Проверяю…";
  const { app, ck } = await refresh();
  if (!app) {
    res.className = "result bad";
    res.textContent = "✗ Charon Code не запущен. Открой приложение и нажми ещё раз.";
    btn.disabled = false;
    return;
  }
  if (!ck) {
    res.className = "result bad";
    res.textContent = "✗ В браузере нет сессии arena.ai. Войди на arena.ai в этом браузере и нажми ещё раз.";
    btn.disabled = false;
    return;
  }
  res.textContent = "Отправляю в приложение…";
  try {
    const r = await fetch(APP_URL + "/arena-cookie", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: ck }),
    });
    const j = await r.json();
    if (!j.ok) {
      res.className = "result bad";
      res.textContent = "✗ " + (j.error || "Приложение отклонило куку.");
    } else {
      res.className = "result ok";
      res.textContent =
        "✓ Сессия обновлена" + (j.user ? " (пользователь " + j.user + ")" : "") +
        (j.warn ? "\n⚠ " + j.warn : "") +
        "\nВ Charon Code нажми «Обновить сессию Arena».";
    }
  } catch (e) {
    res.className = "result bad";
    res.textContent = "✗ Не удалось связаться с приложением: " + String(e.message || e).slice(0, 100);
  }
  btn.disabled = false;
});

refresh();
