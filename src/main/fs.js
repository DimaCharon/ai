/* ============================================================
   fs.js — контролируемый доступ к файлам ПК + терминал
   ------------------------------------------------------------
   Файлы:
     • listDir / readFile / writeFile / pickDir / openPath
     • записью/удалением управляет ПОДТВЕРЖДЕНИЕ ПОЛЬЗОВАТЕЛЯ
       (модалка в интерфейсе, до вызова writeFile)
   Терминал:
     • run() запускает CMD или PowerShell в рабочем каталоге,
       стримит вывод событием 'term:out', завершение — 'term:done'
     • kill() останавливает процесс
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { dialog, shell } = require("electron");

const HOME = os.homedir();
const MAX_PREVIEW = 2 * 1024 * 1024; // 2 МБ для предпросмотра
const MAX_TERM_OUT = 512 * 1024;     // 512 КБ хвоста вывода

/* ============================================================
   ФАЙЛЫ
   ============================================================ */
function norm(p) {
  return path.resolve(p || HOME);
}

/** Содержимое каталога (сначала папки, по имени). */
async function listDir(win, p) {
  const dir = norm(p);
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const items = entries
      .filter((e) => !e.name.startsWith(".") || e.name === ".git")
      .map((e) => ({
        name: e.name,
        dir: e.isDirectory(),
        size: e.isFile() ? safeSize(dir, e.name) : 0,
      }));
    items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { ok: true, path: dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, items };
  } catch (e) {
    return { ok: false, path: dir, error: "Не удалось открыть: " + e.message };
  }
}

function safeSize(dir, name) {
  try { return fs.statSync(path.join(dir, name)).size; } catch { return 0; }
}

/** Чтение файла для предпросмотра (текст, до 2 МБ). */
async function readFile(p) {
  const f = norm(p);
  try {
    const st = await fs.promises.stat(f);
    if (st.isDirectory()) return { ok: false, error: "Это папка" };
    if (st.size > MAX_PREVIEW) return { ok: false, binary: true, error: "Файл больше 2 МБ — предпросмотр недоступен (открой в проводнике)" };
    const buf = await fs.promises.readFile(f);
    if (buf.includes(0)) return { ok: false, binary: true, error: "Бинарный файл — предпросмотр недоступен" };
    return { ok: true, content: buf.toString("utf8"), size: st.size, mtime: st.mtimeMs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Запись файла (вызывается только ПОСЛЕ подтверждения в UI). */
async function writeFile(p, content) {
  const f = norm(p);
  try {
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    await fs.promises.writeFile(f, content, "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Диалог выбора папки. */
async function pickDir(win) {
  const r = await dialog.showOpenDialog(win, {
    title: "Выбрать папку проекта",
    defaultPath: HOME,
    properties: ["openDirectory"],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  return { ok: true, path: r.filePaths[0] };
}

/** Открыть файл/папку в системном приложении (проводник). */
async function openPath(p) {
  const f = norm(p);
  const err = await shell.openPath(f);
  return err ? { ok: false, error: err } : { ok: true };
}

/** Показать в проводнике (режим «показать в папке»). */
function revealPath(p) {
  shell.showItemInFolder(norm(p));
}

/* ============================================================
   ТЕРМИНАЛ (CMD / PowerShell)
   ============================================================ */
const runs = new Map(); // runId -> { child, out }

/**
 * Запустить команду. ПОДТВЕРЖДЕНИЕ делает UI (модалка),
 * сюда приходит уже согласованная команда.
 * @param {object} win окно-получатель событий
 * @param {object} opts { command, shell: 'cmd'|'powershell', cwd }
 */
function run(win, { command, shell: shellName = "cmd", cwd }) {
  const sh = shellName === "powershell" ? "powershell" : "cmd";
  const bin = sh === "cmd" ? process.env.ComSpec || "cmd.exe" : "powershell.exe";
  const args = sh === "cmd"
    ? ["/d", "/s", "/c", command]
    : ["-NoProfile", "-NonInteractive", "-Command", command];

  let child;
  try {
    child = spawn(bin, args, {
      cwd: norm(cwd),
      windowsHide: true,
      env: { ...process.env, CI: "true" },
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const runId = crypto.randomUUID();
  const rec = { child, out: "" };
  runs.set(runId, rec);

  const push = (chunk) => {
    rec.out = (rec.out + chunk).slice(-MAX_TERM_OUT);
    safeSend(win, "term:out", { runId, text: chunk });
  };
  child.stdout.on("data", (d) => push(d.toString("utf8")));
  child.stderr.on("data", (d) => push(d.toString("utf8")));
  child.on("error", (e) => {
    runs.delete(runId);
    safeSend(win, "term:done", { runId, code: -1, error: e.message });
  });
  child.on("close", (code) => {
    runs.delete(runId);
    safeSend(win, "term:done", { runId, code });
  });

  return { ok: true, runId };
}

/** Остановить запущенную команду. */
function kill(runId) {
  const rec = runs.get(runId);
  if (rec) {
    try { rec.child.kill("SIGKILL"); } catch { /* уже завершена */ }
    runs.delete(runId);
  }
  return { ok: true };
}

function safeSend(win, channel, payload) {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  } catch { /* окно закрывается */ }
}

module.exports = { listDir, readFile, writeFile, pickDir, openPath, revealPath, run, kill, HOME };
