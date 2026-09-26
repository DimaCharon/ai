/* ============================================================
   tar.js — минимальный распаковщик .tar (для .tar.gz через zlib)
   ------------------------------------------------------------
   Без внешних зависимостей: разбирает стандартный ustar-формат,
   который генерируют GitHub (tarball) и GitLab (archive).
   Симлинки/хардлинки не раскладывается (защита от выхода за папку).
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Распаковать tar-архив.
 * @param {Buffer} tarBuf содержимое .tar (уже без gzip)
 * @param {string} dest   каталог назначения
 * @param {object} opts   { stripFirst: убрать верхнюю папку архива }
 * @returns {number} количество распакованных файлов
 */
function extractTarToDir(tarBuf, dest, opts = {}) {
  const destAbs = path.resolve(dest);
  let count = 0;
  let off = 0;

  while (off + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // конец архива

    let name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const sizeOct = header.toString("utf8", 124, 136).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeOct, 8) || 0;
    const type = header[156];
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
    let full = prefix ? prefix + "/" + name : name;

    // GitHub/GitLab оборачивают всё в одну корневую папку — убираем её
    if (opts.stripFirst && full.includes("/")) {
      full = full.split("/").slice(1).join("/");
    }

    const dataStart = off + 512;
    const blockEnd = dataStart + Math.ceil(size / 512) * 512;

    if (full && full !== "./" && !full.startsWith("..")) {
      const target = path.resolve(destAbs, full);
      const safe = target === destAbs || target.startsWith(destAbs + path.sep);
      if (safe) {
        if (type === 0x30 /* '0' файл */ || type === 0) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, tarBuf.subarray(dataStart, dataStart + size));
          count++;
        } else if (type === 0x35 /* '5' каталог */) {
          fs.mkdirSync(target, { recursive: true });
        }
        // '1' symlink / '2' hardlink — намеренно пропускаем
      }
    }
    off = blockEnd;
  }
  return count;
}

module.exports = { extractTarToDir };
