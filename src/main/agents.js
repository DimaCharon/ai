/* ============================================================
   agents.js — инструменты ИИ (провайдер-независимый протокол)
   ------------------------------------------------------------
   Модель вставляет в ответ БЛОКИ-КОМАНДЫ, движок исполняет их
   и возвращает результат модели (петля до 6 итераций):

     ```read: путь/к/файлу        — прочитать файл
     ```list:                     — актуальное дерево папки
     ```edit: путь/к/файлу        — ПОЛНАЯ перезапись файла
     <содержимое>                 (требует подтверждения в UI)
     ```browse: URL               — инкогнито-браузер (закрыт
                                    сам после каждой страницы)
     ```remember: текст           — записать в память

   Безопасность:
     • read/list/edit — ТОЛЬКО внутри корневой папки
       (прикреплённая папка или папка приложения в Self-режиме);
       обход через «..», абсолютные пути — отклоняются.
     • remember — только локальные файлы памяти.
     • browse — только http/https, окно закрывается обязательно.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const browser = require("./browser");
const memory = require("./memory");

const MAX_READ_BYTES = 200 * 1024;   // 200 КБ на read
const MAX_READ_INJECT = 40 * 1024;   // сколько отдаём модели
const MAX_WRITE_BYTES = 1024 * 1024; // 1 МБ на edit
const MAX_TREE_LINES = 160;

const TEXT_EXT = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".html", ".htm", ".css",
  ".json", ".md", ".txt", ".c", ".h", ".cpp", ".hpp", ".cs", ".go", ".rs", ".java",
  ".kt", ".sh", ".bat", ".ps1", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".xml",
  ".sql", ".vue", ".svelte", ".php", ".rb", ".lua", ".env", ".gitignore",
]);

/** Протокол возможностей (вставляется в системный контекст). */
function abilitiesPrompt(root, isSelf) {
  let what;
  if (isSelf) {
    what = "ФАЙЛАМИ САМОГО ПРИЛОЖЕНИЯ Charon Code (папка: " + root + "). После правок пользователь перезапустит приложение — изменения вступят.";
  } else if (root) {
    what = "ФАЙЛАМИ ПРИКРЕПЛЁННОЙ ПАПКИ «" + path.basename(root) + "» (путь: " + root + ").";
  } else {
    what = "Файловые команды сейчас недоступны (нет прикреплённой папки — выбери чип-папку или проект); browse и remember работают.";
    return (
      "\n\nИНСТРУМЕНТЫ (исполняются системой автоматически, результат вернётся тебе следующим сообщением):\n" +
      "```browse: URL``` — открыть страницу в ИНКОГНИТО-браузере: получишь её видимый текст, окно закроется само\n" +
      "```remember: текст``` — сохранить в память (будет у тебя в будущих чатах)\n" +
      "Действуй. Прикреплённой папки нет — файлными командами (read/list/edit) пользоваться нельзя."
    );
  }
  return (
    "\n\nИНСТРУМЕНТЫ (исполняются системой автоматически, результат вернётся тебе следующим сообщением — " +
    "пиши блок-команду вместо описания действия, плюс краткое пояснение обычным текстом):\n" +
    "```read: относительный/путь``` — прочитать файл\n" +
    "```list:``` — актуальный список файлов папки\n" +
    "```edit: относительный/путь``` (в блоке — ПОЛНОЕ новое содержимое файла) — перезаписать файл (пользователь подтвердит)\n" +
    "```browse: URL``` — открыть страницу в ИНКОГНИТО-браузере: получишь её видимый текст, окно закроется само\n" +
    "```remember: текст``` — сохранить в память (будет у тебя в будущих чатах)\n" +
    "Действуй " + what + " Файлы вне этой папки НЕ трогай. Один блок-команда = одно действие."
  );
}

/**
 * Разобрать блоки-команды в тексте ответа.
 * @returns {Array<{kind, arg, content}>}
 */
function parseBlocks(text) {
  const out = [];
  // ВАЖНО: в arg бектики запрещены ([^\n`]), иначе жадный захват
  // глотает закрывающий ``` однострочных блоков (read/browse/list).
  const re = /```(read|list|edit|browse|remember)\s*[:：]\s*([^\n`]*)(?:\n([\s\S]*?))?```/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    out.push({
      kind: m[1],
      arg: (m[2] || "").trim(),
      content: m[3] != null ? m[3] : "",
      index: m.index,
      full: m[0],
    });
  }
  return out;
}

/** Убрать блоки из текста (чтобы пользователю было чисто). */
function stripBlocks(text) {
  return String(text || "")
    .replace(/```(read|list|edit|browse|remember)\s*[:：][\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Безопасный путь: rel от root. Никогда не уводит за пределы root.
 * @returns {string|null}
 */
function safePath(root, rel) {
  try {
    const r = String(rel || "").trim().replace(/^\/+/, "");
    if (!r || r.startsWith("/") || /^[a-zA-Z]:/.test(r)) return null; // абсолютные — нет
    const resolved = path.resolve(root, r);
    const rootAbs = path.resolve(root);
    if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) return null;
    return resolved;
  } catch {
    return null;
  }
}

/** Дерево папки (для list: и авто-контекста). */
function walkTree(root, maxLines = MAX_TREE_LINES) {
  const out = [];
  let count = 0;
  const SKIP = new Set(["node_modules", ".git", ".cache", "__pycache__", "coverage", ".venv", "dist", "out"]);
  (function walk(dir, prefix, depth) {
    if (depth > 5 || out.length >= maxLines) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxLines) {
        out.push(prefix + "… (ещё файлы)");
        return;
      }
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push(prefix + "📁 " + e.name + "/");
        walk(p, prefix + "  ", depth + 1);
      } else {
        let size = "";
        try {
          size = " (" + fs.statSync(p).size + " B)";
        } catch { /* ok */ }
        out.push(prefix + "📄 " + e.name + size);
      }
    }
  })(root, "", 0);
  return out.join("\n");
}

/**
 * Авто-контекст прикреплённой папки: дерево + содержимое текстовых
 * файлов (до 30 КБ суммарно, по 8 КБ на файл).
 * @returns {{tree:string, files:string}}
 */
function buildFolderContext(root) {
  const tree = walkTree(root);
  const parts = [];
  let total = 0;
  const MAX_TOTAL = 30 * 1024;
  const MAX_ONE = 8 * 1024;
  let files = 0;
  (function walk(dir, depth) {
    if (depth > 4 || files >= 25 || total >= MAX_TOTAL) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      if (total >= MAX_TOTAL || files >= 25) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!["node_modules", ".git", ".cache", "__pycache__", "dist", "out"].includes(e.name)) walk(p, depth + 1);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      try {
        const st = fs.statSync(p);
        if (st.size > 120 * 1024) continue;
        const raw = fs.readFileSync(p, "utf8");
        if (raw.slice(0, 8000).includes("\u0000")) continue; // бинарный
        const rel = path.relative(root, p).replace(/\\/g, "/");
        let content = raw;
        let cut = false;
        if (Buffer.byteLength(content) > MAX_ONE) {
          content = content.slice(0, MAX_ONE);
          cut = true;
        }
        const block = "### Файл: " + rel + (cut ? " (обрезано)" : "") + "\n" + content;
        if (total + block.length > MAX_TOTAL) continue;
        parts.push(block);
        total += block.length;
        files++;
      } catch { /* нет прав — пропускаем */ }
    }
  })(root, 0);
  return { tree, files: parts.join("\n\n---\n\n") };
}

function isTextFile(p) {
  const ext = path.extname(p).toLowerCase();
  return TEXT_EXT.has(ext) || !ext;
}

/** Карточка действия для UI. */
function cardFor(block, state, detail) {
  const icons = { read: "📄", list: "🗂", edit: "✏️", browse: "🌐", remember: "🧠" };
  const verbs = { read: "Читаю", list: "Список файлов", edit: "Правлю", browse: "Открываю (инкогнито)", remember: "Запоминаю" };
  return {
    kind: block.kind,
    icon: icons[block.kind] || "•",
    title: verbs[block.kind] || block.kind,
    detail: detail != null ? detail : block.arg || "",
    state, // "running" | "ok" | "fail"
  };
}

/** Сформировать «[Система] …» сообщение с результатами для модели. */
function formatResults(results) {
  const lines = ["[Система] Исполнены твои команды-блоки. Результаты:"];
  results.forEach((r, i) => {
    const b = r.block;
    const head = "--- " + b.kind + (b.arg ? ": " + b.arg : "") + " ---";
    if (!r.r.ok) {
      lines.push(head, "ОШИБКА: " + (r.r.error || "неизвестно"));
    } else {
      lines.push(head, String(r.r.text != null ? r.r.text : (r.r.message || "выполнено")));
    }
  });
  lines.push("");
  lines.push("Продолжи работу с учётом результатов (если задача выполнена — дай итог пользователю обычным текстом, без блоков).");
  return lines.join("\n");
}

/**
 * Исполнить один блок.
 * @param {object} block {kind, arg, content}
 * @param {object} ctx { root, memoryTarget, browserVisible,
 *   confirm:(title,detail)=>Promise<boolean> }
 * @returns {Promise<{ok, text?, error?}>}
 */
async function execute(block, ctx) {
  const { root, memoryTarget = "global" } = ctx;
  switch (block.kind) {
    case "list": {
      if (!root) return { ok: false, error: "Нет прикреплённой папки (выбери чип-папку или проект)" };
      return { ok: true, text: walkTree(root) };
    }
    case "read": {
      if (!root) return { ok: false, error: "Нет прикреплённой папки" };
      const p = safePath(root, block.arg);
      if (!p) return { ok: false, error: "Путь вне прикреплённой папки: " + block.arg };
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return { ok: false, error: "Файл не найден: " + block.arg };
      const st = fs.statSync(p);
      if (st.size > MAX_READ_BYTES) return { ok: false, error: "Файл больше 200 КБ — открой его в панели Файлы" };
      const raw = fs.readFileSync(p, "utf8");
      if (raw.slice(0, 8000).includes("\u0000")) return { ok: false, error: "Бинарный файл — текст не отдаю" };
      let out = raw;
      if (out.length > MAX_READ_INJECT) out = out.slice(0, MAX_READ_INJECT) + "\n…(обрезано: " + st.size + " B)";
      return { ok: true, text: out };
    }
    case "edit": {
      if (!root) return { ok: false, error: "Нет прикреплённой папки" };
      const p = safePath(root, block.arg);
      if (!p) return { ok: false, error: "Путь вне прикреплённой папки: " + block.arg };
      const content = block.content.replace(/\n$/, "");
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) return { ok: false, error: "Слишком большой файл (лимит 1 МБ)" };
      const rel = path.relative(root, p).replace(/\\/g, "/");
      const existed = fs.existsSync(p);
      if (ctx.confirm) {
        const ok = await ctx.confirm(
          "Правка файла: " + rel,
          "ИИ хочет " + (existed ? "перезаписать файл «" + rel + "» (" : "создать файл «" + rel + "» (") +
            Buffer.byteLength(content) + " B). Подтвердить запись?",
          { preview: content.slice(0, 2000) }
        );
        if (!ok) return { ok: false, error: "Пользователь отменил запись" };
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, "utf8");
      return { ok: true, text: "Файл " + (existed ? "перезаписан" : "создан") + ": " + rel + " (" + Buffer.byteLength(content) + " B)" };
    }
    case "browse": {
      const res = await browser.browse(block.arg, { capture: false });
      if (!res.ok) return { ok: false, error: res.error };
      const t = res.text || "(пустая страница)";
      return { ok: true, text: "Страница: " + res.url + (res.title ? " («" + res.title + "»)" : "") + "\nОКНО ЗАКРЫТО. Видимый текст:\n" + t.slice(0, 18000) };
    }
    case "remember": {
      const text = (block.arg + (block.content ? "\n" + block.content : "")).trim();
      if (!text) return { ok: false, error: "Пустая запись в память" };
      const r = memory.append(memoryTarget, text);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, text: "Записано в память (" + (memoryTarget === "global" ? "глобальную" : "проекта") + "): " + text.slice(0, 200) };
    }
    default:
      return { ok: false, error: "Неизвестная команда: " + block.kind };
  }
}

module.exports = {
  abilitiesPrompt,
  parseBlocks,
  stripBlocks,
  safePath,
  walkTree,
  buildFolderContext,
  cardFor,
  formatResults,
  execute,
  isTextFile,
  MAX_READ_INJECT,
};
