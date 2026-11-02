/* ============================================================
   memory.js — память ИИ (только на этом ПК)
   ------------------------------------------------------------
   • Глобальная — 1 на ВСЕ чаты:  %APPDATA%\Charon Code\memory\global.md
   • Проекта — отдельно на проект: memory\projects\<id>.md
   ИИ видит её в каждом чате (движок подмешивает в контекст)
   и пишет в неё сам через команду ```remember: …```.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const store = require("./store");

const MAX_BYTES = 100 * 1024; // 100 КБ на файл памяти

function memDir() {
  const d = path.join(store.dataDir(), "memory");
  fs.mkdirSync(path.join(d, "projects"), { recursive: true });
  return d;
}

/** Целевой файл: "global" | id проекта. */
function fileFor(target) {
  if (target === "global" || !target) return path.join(memDir(), "global.md");
  const safe = String(target).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) return path.join(memDir(), "global.md");
  return path.join(memDir(), "projects", safe + ".md");
}

/** Прочитать память ("" если пустая). */
function read(target) {
  try {
    return fs.readFileSync(fileFor(target), "utf8");
  } catch {
    return "";
  }
}

const readGlobal = () => read("global");

/** Дописать строку в память (с датой). */
function append(target, text) {
  const line = String(text || "").trim().slice(0, 1500);
  if (!line) return { ok: false, error: "Пустая запись" };
  const stamp = new Date().toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const cur = read(target);
  const entry = (cur && !cur.endsWith("\n") ? "\n" : "") + "- [" + stamp + "] " + line + "\n";
  let next = cur + entry;
  if (Buffer.byteLength(next) > MAX_BYTES) next = next.slice(-MAX_BYTES); // держим хвост
  fs.writeFileSync(fileFor(target), next, "utf8");
  return { ok: true, size: Buffer.byteLength(next) };
}

/** Полная перезапись (кнопка «Сохранить память» в UI). */
function save(target, fullText) {
  let t = String(fullText || "");
  if (Buffer.byteLength(t) > MAX_BYTES) t = t.slice(0, MAX_BYTES);
  fs.writeFileSync(fileFor(target), t, "utf8");
  return { ok: true, size: Buffer.byteLength(t) };
}

module.exports = { read, readGlobal, append, save, fileFor };
