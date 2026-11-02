/* ============================================================
   plugins.js — плагины Charon Code (установка по ссылке)
   ------------------------------------------------------------
   Плагин = папка с plugin.json:
     {
       "name": "git-helper",          // slug (a-z, 0-9, -)
       "version": "1.0.0",
       "description": "Команды для git",
       "context": "…небольшой контекст, который ИИ видит…",
       "commands": [
         { "name": "commit", "description": "написать коммит",
           "prompt": "Напиши git-commit для: {args}" }
       ]
     }
   Установка: пользователь вставляет ссылку
   https://github.com/автор/плагин → скачиваем zip (codeload) →
   распаковываем (PowerShell) → находим plugin.json → копируем
   в %APPDATA%\Charon Code\plugins\<name>.
   В чате: /команда аргументы → шаблон prompt (подстановка
   {args}) отправляется модели.
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const store = require("./store");

const MAX_ZIP_BYTES = 50 * 1024 * 1024; // 50 МБ на плагин
const MAX_CONTEXT = 20000;

function pluginsDir() {
  const d = path.join(store.dataDir(), "plugins");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Проверка/нормализация манифеста. Бросает Error при невалидном. */
function validate(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("plugin.json не найден или повреждён");
  const name = String(manifest.name || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9_-]{1,48}$/.test(name)) {
    throw new Error("Некорректное имя плагина в plugin.json («name»: a-z, 0-9, дефис)");
  }
  const commands = Array.isArray(manifest.commands)
    ? manifest.commands
        .filter((c) => c && typeof c.prompt === "string" && typeof c.name === "string")
        .map((c) => ({
          name: String(c.name).trim().toLowerCase().replace(/\s+/g, "-"),
          description: String(c.description || "").slice(0, 200),
          prompt: c.prompt.slice(0, 20000),
        }))
        .filter((c) => /^[\wа-яА-ЯёЁ-]{1,32}$/.test(c.name))
    : [];
  return {
    name,
    version: String(manifest.version || "0.0.0").slice(0, 32),
    description: String(manifest.description || "").slice(0, 400),
    context: String(manifest.context || "").slice(0, MAX_CONTEXT),
    commands,
  };
}

/** Список установленных плагинов (+ состояние включённости). */
function list() {
  const enabled = store.getSettings().plugins || {};
  const dir = pluginsDir();
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, e.name, "plugin.json"), "utf8"));
      out.push({ ...validate(m), enabled: enabled[e.name] !== false });
    } catch {
      out.push({ name: e.name, version: "—", description: "(plugin.json повреждён)", commands: [], enabled: false, broken: true });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function isEnabled(name) {
  return (store.getSettings().plugins || {})[name] !== false;
}

function setEnabled(name, v) {
  const s = store.getSettings();
  store.saveSettings({ plugins: { ...(s.plugins || {}), [name]: !!v } });
  return { ok: true, enabled: !!v };
}

function remove(name) {
  try {
    fs.rmSync(path.join(pluginsDir(), String(name).replace(/[^a-zA-Z0-9_-]/g, "")), { recursive: true, force: true });
  } catch { /* уже нет */ }
  const s = store.getSettings();
  const plugins = { ...(s.plugins || {}) };
  delete plugins[name];
  store.saveSettings({ plugins });
  return { ok: true };
}

/** Найти plugin.json в корне распаковки или в подпапке на 1 уровень. */
function findManifestDir(root) {
  const direct = path.join(root, "plugin.json");
  if (fs.existsSync(direct)) return root;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name, "plugin.json");
    if (fs.existsSync(p)) return path.join(root, e.name);
  }
  return null;
}

function psExpand(zipPath, outDir) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command",
       `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`],
      { timeout: 120000, windowsHide: true },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

/**
 * Установить плагин по ссылке на GitHub-репозиторий.
 * @param {string} url https://github.com/автор/плагин
 */
async function install(url) {
  const m = String(url || "").trim().match(/^https?:\/\/(www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:[/.]|$)/i);
  if (!m) throw new Error("Нужна ссылка вида https://github.com/автор/плагин");
  const [, , user, repo] = m;

  const zipUrl = (branch) => `https://codeload.github.com/${user}/${repo}/zip/refs/heads/${branch}`;
  let buf = null;
  for (const branch of ["main", "master"]) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 60000);
      const r = await fetch(zipUrl(branch), { signal: c.signal });
      clearTimeout(t);
      if (r.ok) {
        buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > MAX_ZIP_BYTES) throw new Error("Архив больше 50 МБ — отказываюсь");
        break;
      }
    } catch (e) {
      if (branch === "master") throw new Error("Не удалось скачать репозиторий: " + String(e.message || e).slice(0, 120));
    }
  }
  if (!buf) throw new Error("Не нашёл ветку main/master в репозитории");

  const stamp = Date.now();
  const tmpZip = path.join(os.tmpdir(), "cc-plugin-" + stamp + ".zip");
  const outDir = path.join(os.tmpdir(), "cc-plugin-ex-" + stamp);
  fs.mkdirSync(outDir, { recursive: true });
  try {
    fs.writeFileSync(tmpZip, buf);
    await psExpand(tmpZip, outDir);
    const src = findManifestDir(outDir);
    if (!src) throw new Error("В репозитории нет plugin.json (в корне или в папке на 1 уровень)");
    const manifest = validate(JSON.parse(fs.readFileSync(path.join(src, "plugin.json"), "utf8")));

    const target = path.join(pluginsDir(), manifest.name);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(src, target, { recursive: true });
    store.saveSettings({ plugins: { ...(store.getSettings().plugins || {}), [manifest.name]: true } });
    return { ok: true, plugin: manifest };
  } finally {
    try { fs.rmSync(tmpZip, { force: true }); } catch { /* ок */ }
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ок */ }
  }
}

/** Текст для контекста промпта: включённые плагины (описание + контекст). */
function contextForPrompt() {
  const parts = [];
  for (const p of list()) {
    if (!p.enabled || p.broken) continue;
    let line = "• " + p.name;
    if (p.description) line += " — " + p.description;
    if (p.commands.length) line += "; команды: " + p.commands.map((c) => "/" + c.name).join(", ");
    if (p.context) line += "\n   Контекст плагина: " + p.context.slice(0, 1500);
    parts.push(line);
    if (parts.join("\n").length > 6000) break;
  }
  return parts.join("\n");
}

/** Разрешить /команду → prompt-шаблон с подстановкой {args}. */
function resolveCommand(cmdName, args = "") {
  const a = String(args || "").trim();
  for (const p of list()) {
    if (!p.enabled || p.broken) continue;
    const c = p.commands.find((x) => x.name === String(cmdName).toLowerCase());
    if (c) {
      const prompt = c.prompt.includes("{args}") ? c.prompt.replace(/\{args\}/g, a) : c.prompt + (a ? "\n\nВвод: " + a : "");
      return { ok: true, plugin: p.name, command: c.name, prompt };
    }
  }
  return { ok: false, error: "Команда /" + cmdName + " не найдена среди установленных плагинов" };
}

/** Все команды (для автодополнения в чате). */
function allCommands() {
  const out = [];
  for (const p of list()) {
    if (!p.enabled || p.broken) continue;
    for (const c of p.commands) out.push({ name: c.name, description: c.description, plugin: p.name });
  }
  return out;
}

module.exports = { list, install, remove, setEnabled, resolveCommand, allCommands, contextForPrompt, validate };
