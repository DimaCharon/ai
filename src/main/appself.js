/* ============================================================
   appself.js — «Само-приложение»: где лежат файлы Charon Code
   ------------------------------------------------------------
   Режим 🛠 Self: ИИ читает и правит файлы самого приложения,
   после чего пользователь жмёт «Перезапустить» — и правки
   вступают в силу.
   • dev (npm start)   — корень проекта;
   • установленный app — <install>\resources\app (сборка с
     asar: false — файлы обычные, на диске, а не в архиве).
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

/** Каталог с файлами приложения (или null). */
function appDir() {
  if (!app.isPackaged) {
    // dev: src/main → корень проекта
    return path.join(__dirname, "..", "..");
  }
  const d = path.join(process.resourcesPath, "app");
  if (fs.existsSync(d)) return d;
  return null;
}

/** Можно ли писать прямо в каталог приложения. */
function writable(d = appDir()) {
  if (!d) return false;
  try {
    fs.accessSync(d, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Дерево файлов приложения для контекста ИИ. */
function tree(root) {
  const out = [];
  let count = 0;
  const MAX = 160;
  const SKIP = new Set(["node_modules", ".git", "out", "dist", ".cache", "__pycache__", "coverage"]);
  (function walk(dir, prefix, depth) {
    if (depth > 4 || count >= MAX) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= MAX) {
        out.push(prefix + "… (ещё файлы)");
        return;
      }
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push(prefix + "📁 " + e.name + "/");
        walk(p, prefix + "  ", depth + 1);
        count++;
      } else {
        let size = "";
        try {
          size = " (" + fs.statSync(p).size + " B)";
        } catch { /* ignore */ }
        out.push(prefix + "📄 " + e.name + size);
        count++;
      }
    }
  })(root, "", 0);
  return out.join("\n");
}

module.exports = { appDir, writable, tree };
