/* ============================================================
   selfcheck.js — самопроверка приложения после правок ИИ (Self)
   ------------------------------------------------------------
   Проблема v1.0.8: ИИ в Self-режиме перезаписал main.js файлом,
   где не было `const { ipcMain } = require("electron")` →
   после перезапуска приложение падало с
   «ReferenceError: ipcMain is not defined».

   Теперь ПОСЛЕ КАЖДОЙ правки в Self-режиме:
     1. синтаксис всех .js (парсинг без исполнения);
     2. в main.js: каждый используемый идентификатор из 'electron'
        действительно импортирован (именно тот класс ошибок);
     3. main.js содержит app.whenReady/createWindow и не обрезан;
     4. все package.json — валидный JSON;
     5. критичные файлы на месте (main.js, preload.js,
        package.json, src/renderer/index.html).
   Если проверка не прошла — правка ОТКАТЫВАЕТСЯ, файлы остаются
   как были, ИИ получает ошибку и может исправить.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

/** Идентификаторы, которые main.js ДОЛЖЕН импортировать из 'electron',
    если использует их «голыми» (не как свойство объекта). */
const ELECTRON_IDS = [
  "app", "BrowserWindow", "ipcMain", "screen", "shell", "dialog", "session",
  "Menu", "Notification", "globalShortcut", "contextBridge", "net",
  "systemPreferences", "powerMonitor", "protocol", "crashReporter",
];

const MIN_MAIN_BYTES = 500; // пустой/почти пустой main.js — точно не то
// (защита от ОРЕЗКИ при перезаписи живёт в agents.js: сравнение с
//  размером файла ДО правки — точнее, чем абсолютный порог)

/** Синтаксический разбор .js БЕЗ исполнения. */
function checkSyntax(p, content) {
  try {
    // new Function — парсит тело как функцию: ловит SyntaxError.
    // `require`/`module` внутри не исполняются.
    // eslint-disable-next-line no-new-func
    new Function(content);
    return null;
  } catch (e) {
    return "синтаксическая ошибка: " + String(e.message || e).slice(0, 200);
  }
}

/** Идентификаторы, объявленные через require('electron'). */
function declaredElectronIds(content) {
  const declared = new Set();
  const re = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*["']electron["']\s*\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    m[1].split(",").forEach((s) => {
      const id = s.trim().split(/\s+as\s+/)[0].trim();
      if (id) declared.add(id);
    });
  }
  // форма: const electron = require('electron'); electron.ipcMain…
  if (/(?:const|let|var)\s+electron\s*=\s*require\(\s*["']electron["']\s*\)/.test(content)) {
    ELECTRON_IDS.forEach((id) => declared.add("electron." + id));
  }
  return declared;
}

/** Используется ли «голый» идентификатор (не x.y, не в строке/комментарии)? */
function usedBare(content, id) {
  // (?<![.\w]) — не свойство и не продолжение другого слова
  const re = new RegExp("(?<![.\\w])(?:" + id + ")\\b", "g");
  let m;
  while ((m = re.exec(content)) !== null) {
    // пропуск совпадений внутри строк: смотрим баланс кавычек до позиции
    const before = content.slice(0, m.index);
    const dQ = (before.match(/"/g) || []).length;
    const sQ = (before.match(/'/g) || []).length;
    const bq = (before.match(/`/g) || []).length;
    if (dQ % 2 === 0 && sQ % 2 === 0 && bq % 2 === 0) return true;
    // в комментарии // — тоже не код
  }
  return false;
}

/** Проверка main.js: импорты из 'electron' + каркас. */
function checkMain(content) {
  const problems = [];
  if (Buffer.byteLength(content) < MIN_MAIN_BYTES) {
    problems.push("main.js подозрительно малый (" + Buffer.byteLength(content) +
      " B) — похоже, файл обрезан при перезаписи");
  }
  if (!/whenReady|app\.ready/.test(content)) {
    problems.push("main.js: нет app.whenReady — приложение не запустится");
  }
  if (!/createWindow|new BrowserWindow/.test(content)) {
    problems.push("main.js: нет создания окна (createWindow/BrowserWindow)");
  }
  const declared = declaredElectronIds(content);
  const usesBareElectron = /require\(\s*["']electron["']\s*\)/.test(content);
  if (!usesBareElectron) {
    if (ELECTRON_IDS.some((id) => usedBare(content, id))) {
      problems.push("main.js: нет require('electron'), но идентификаторы electron-объектов используются");
    }
    return problems;
  }
  for (const id of ELECTRON_IDS) {
    if (declared.has(id) || declared.has("electron." + id)) continue;
    if (usedBare(content, id)) {
      problems.push("main.js: «" + id + "» используется, но не импортирован из require(\"electron\") — будет ReferenceError");
    }
  }
  return problems;
}

/** Проверка одного файла. @returns {string[]} список проблем */
function checkFile(p, content) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    const prob = checkSyntax(p, content);
    if (prob) return [prob];
    const probs = [];
    if (path.basename(p) === "main.js") probs.push(...checkMain(content));
    return probs;
  }
  if (ext === ".json") {
    try {
      JSON.parse(content);
      return [];
    } catch (e) {
      return ["JSON: " + String(e.message || e).slice(0, 160)];
    }
  }
  return [];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "out", "dist", ".cache", "__pycache__", "coverage", ".venv"]);
const REQUIRED = ["main.js", "preload.js", "package.json", path.join("src", "renderer", "index.html")];

/**
 * Полная проверка каталога приложения.
 * @param {string} root
 * @returns {{ok: boolean, problems: Array<{file: string, problem: string}>, files: number}}
 */
function validateApp(root) {
  const problems = [];
  if (!root || !fs.existsSync(root)) {
    return { ok: false, problems: [{ file: root || "?", problem: "каталог приложения не найден" }], files: 0 };
  }
  let files = 0;

  // 1. критичные файлы на месте
  for (const rel of REQUIRED) {
    if (!fs.existsSync(path.join(root, rel))) {
      problems.push({ file: rel, problem: "критичный файл отсутствует" });
    }
  }

  // 2. рекурсивный обход .js/.json
  (function walk(dir, depth) {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      if (ext !== ".js" && ext !== ".mjs" && ext !== ".cjs" && ext !== ".json") continue;
      if (e.name.endsWith(".min.js")) continue;
      let content = null;
      try {
        if (fs.statSync(p).size > 1024 * 1024) continue; // >1 МБ — не парсим
        content = fs.readFileSync(p, "utf8");
        files++;
      } catch {
        continue;
      }
      for (const prob of checkFile(p, content)) {
        problems.push({ file: path.relative(root, p).replace(/\\/g, "/"), problem: prob });
      }
    }
  })(root, 0);

  return { ok: problems.length === 0, problems, files };
}

module.exports = { validateApp, checkFile, checkMain, checkSyntax, declaredElectronIds, usedBare };
