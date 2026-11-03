/* ============================================================
   attachments.js — вложения к сообщению (фото/видео/документы)
   ------------------------------------------------------------
   Пользователь прикрепляет ЛЮБЫЕ файлы (📎 / drag&drop / Ctrl+V).
   Движок решает, что делать с каждым, по типу:

   • текст-подобные (.txt .js .json .md .css …) → содержимое
     вкладывается в промт как текст (модель «читает» документ);
   • изображения — ТОЛЬКО если модель видит (provider.supportsVision):
     шлём base64 data-URL; иначе → сообщение
     «Модель X не поддерживает формат .png»;
   • видео/аудио/бинарные документы (.pdf .docx .mp4 …) →
     «Модель X не поддерживает формат .mp4» (ни один из наших
     провайдеров их не принимает).

   Файлы не покидают ПК иначе, как в запрос к выбранной модели.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"]);
const VIDEO_EXT = new Set([".mp4", ".mkv", ".avi", ".mov", ".webm", ".wmv", ".flv", ".m4v", ".ts"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".ogg", ".oga", ".opus", ".flac", ".m4a", ".aac", ".wma"]);
const DOC_EXT = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
  ".zip", ".rar", ".7z", ".tar", ".gz", ".exe", ".msi", ".apk", ".iso",
  ".db", ".sqlite", ".bin", ".dat",
]);
const TEXT_EXT = new Set([
  ".txt", ".md", ".json", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".css",
  ".html", ".htm", ".csv", ".tsv", ".log", ".xml", ".yml", ".yaml", ".toml", ".ini",
  ".cfg", ".conf", ".env", ".gitignore", ".py", ".c", ".h", ".cpp", ".hpp", ".cs",
  ".go", ".rs", ".java", ".kt", ".php", ".rb", ".lua", ".sh", ".bat", ".ps1",
  ".sql", ".vue", ".svelte", ".svg", ".diff", ".patch",
]);

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;    // 8 МБ на изображение
const MAX_IMAGES_TOTAL = 20 * 1024 * 1024;  // 20 МБ на все изображения
const MAX_TEXT_FILE = 200 * 1024;           // 200 КБ на текстовый файл
const MAX_TEXT_TOTAL = 600 * 1024;          // 600 КБ на все текстовые вложения
const MAX_FILES = 10;

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".svg": "image/svg+xml",
};

/** Классификация по расширению. */
function classify(nameOrPath) {
  const ext = path.extname(String(nameOrPath || "")).toLowerCase();
  if (IMAGE_EXT.has(ext)) return { kind: "image", ext };
  if (VIDEO_EXT.has(ext)) return { kind: "video", ext };
  if (AUDIO_EXT.has(ext)) return { kind: "audio", ext };
  if (DOC_EXT.has(ext)) return { kind: "doc", ext };
  if (TEXT_EXT.has(ext) || !ext) return { kind: "text", ext: ext || "(без расширения)" };
  return { kind: "other", ext };
}

/**
 * Подготовить вложения к отправке.
 * @param {string[]} filePaths
 * @param {{vision: boolean, providerName?: string, modelId?: string}} cap
 * @returns {{
 *   imageParts: Array<{type:'image_url', image_url:{url:string}}>,
 *   textBlocks: Array<{name:string, block:string}>,
 *   rejected: Array<{name:string, ext:string, reason:string}>,
 *   names: Array<string>,
 * }}
 */
function prepare(filePaths, cap) {
  const out = { imageParts: [], textBlocks: [], rejected: [], names: [] };
  const files = (Array.isArray(filePaths) ? filePaths : []).slice(0, MAX_FILES);
  let imgTotal = 0;
  let textTotal = 0;

  for (const fp of files) {
    const name = path.basename(String(fp));
    out.names.push(name);
    const { kind, ext } = classify(fp);
    let st = null;
    try { st = fs.statSync(fp); } catch { /* файл пропал — ниже отклоним */ }

    if (!st || !st.isFile()) {
      out.rejected.push({ name, ext, reason: "файл не найден" });
      continue;
    }

    if (kind === "image") {
      if (!cap.vision) {
        out.rejected.push({ name, ext, reason: "модель не видит изображения" });
        continue;
      }
      if (st.size > MAX_IMAGE_BYTES) {
        out.rejected.push({ name, ext, reason: "слишком большое (лимит 8 МБ)" });
        continue;
      }
      if (imgTotal + st.size > MAX_IMAGES_TOTAL) {
        out.rejected.push({ name, ext, reason: "превышен лимит на все изображения (20 МБ)" });
        continue;
      }
      try {
        const b64 = fs.readFileSync(fp).toString("base64");
        out.imageParts.push({
          type: "image_url",
          image_url: { url: "data:" + (MIME[ext] || "image/png") + ";base64," + b64 },
        });
        imgTotal += st.size;
      } catch {
        out.rejected.push({ name, ext, reason: "не удалось прочитать файл" });
      }
      continue;
    }

    if (kind === "text") {
      if (textTotal >= MAX_TEXT_TOTAL) {
        out.rejected.push({ name, ext, reason: "превышен лимит на все текстовые файлы (600 КБ)" });
        continue;
      }
      try {
        const raw = fs.readFileSync(fp, "utf8");
        if (raw.slice(0, 4000).includes("\u0000")) {
          out.rejected.push({ name, ext, reason: "бинарное содержимое, текст не извлечь" });
          continue;
        }
        let content = raw;
        let cut = false;
        if (Buffer.byteLength(content) > MAX_TEXT_FILE) {
          content = content.slice(0, MAX_TEXT_FILE);
          cut = true;
        }
        const block = "### Прикреплённый файл: " + name + (cut ? " (обрезано до 200 КБ)" : "") + "\n```\n" + content + "\n```";
        if (textTotal + Buffer.byteLength(block) > MAX_TEXT_TOTAL) {
          out.rejected.push({ name, ext, reason: "превышен лимит на все текстовые файлы (600 КБ)" });
          continue;
        }
        out.textBlocks.push({ name, block });
        textTotal += Buffer.byteLength(block);
      } catch {
        out.rejected.push({ name, ext, reason: "не удалось прочитать файл" });
      }
      continue;
    }

    // video / audio / doc / other — ни один наш провайдер не принимает
    out.rejected.push({ name, ext, reason: "не поддерживается выбранной моделью" });
  }

  return out;
}

/** Русская строка для UI: «Модель X не поддерживает формат .mp4». */
function rejectedMessage(rej, modelId) {
  const fmt = (rej.ext || "").startsWith(".") ? rej.ext : "." + (rej.ext || "файл");
  return "⚠️ Модель " + modelId + " не поддерживает формат " + fmt +
    " — файл «" + rej.name + "» не отправляю." +
    (rej.reason === "модель не видит изображения"
      ? " Выбери модель с меткой 👁 (OpenRouter/XRouter) — она видит фото."
      : rej.reason === "не поддерживается выбранной моделью"
        ? " Подскажи, что важно из файла, текстом."
        : " (" + rej.reason + ")");
}

module.exports = { classify, prepare, rejectedMessage, MAX_FILES, MAX_IMAGE_BYTES };
