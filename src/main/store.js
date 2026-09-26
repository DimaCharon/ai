/* ============================================================
   store.js — локальная «база» Charon Code
   ------------------------------------------------------------
   ВСЁ хранится ТОЛЬКО на этом ПК:
     %APPDATA%\Charon Code\
       users.json        — аккаунты (имя + scrypt-хеш пароля, без «облака»)
       session.json      — текущий вошедший аккаунт
       settings.json     — ключи API, кука Arena, настройки
       chats/<id>.json   — чаты и переписка
       chats/archive/    — удалённые (перенесённые) чаты
   Никаких сетевых запросов на хранение данных не выполняется.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");

/* ---------- каталог данных ---------- */
function dataDir() {
  const d = app.getPath("userData"); // C:\Users\<you>\AppData\Roaming\Charon Code
  for (const sub of ["", "chats", "chats/archive"]) {
    fs.mkdirSync(path.join(d, sub), { recursive: true });
  }
  return d;
}
const P = (name) => path.join(dataDir(), name);

/* ---------- атомарное чтение/запись JSON ---------- */
function readJSON(file, def) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return def;
  }
}
function writeJSON(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file); // атомарная замена — файл не «поедет»
}

/* ============================================================
   АККАУНТЫ (регистрация/вход) — только локально
   ============================================================ */
const USERS_FILE = () => P("users.json");
const SESSION_FILE = () => P("session.json");

function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString("hex");
}

const auth = {
  /** Статус: кто сейчас вошёл (для автовхода). */
  status() {
    return readJSON(SESSION_FILE(), null); // { username, at } | null
  },

  /** Регистрация: 3–24 символа, пароль от 4. Создаётся ТОЛЬКО локально. */
  register(username, password) {
    const u = String(username || "").trim();
    if (!/^[\wа-яА-ЯёЁ\-]{3,24}$/.test(u)) {
      throw new Error("Имя пользователя: 3–24 символа — латиница, кириллица, цифры, «_» или «-».");
    }
    if (String(password || "").length < 4) {
      throw new Error("Пароль: минимум 4 символа.");
    }
    const users = readJSON(USERS_FILE(), {});
    const key = u.toLowerCase();
    if (users[key]) throw new Error("Такой аккаунт уже существует — войдите.");
    const salt = crypto.randomBytes(16).toString("hex");
    users[key] = { username: u, salt, hash: hashPassword(password, salt), createdAt: Date.now() };
    writeJSON(USERS_FILE(), users);
    writeJSON(SESSION_FILE(), { username: u, at: Date.now() });
    return { username: u };
  },

  /** Вход: сверяем scrypt-хеш (constant-time). */
  login(username, password) {
    const key = String(username || "").trim().toLowerCase();
    const users = readJSON(USERS_FILE(), {});
    const rec = users[key];
    if (!rec) throw new Error("Аккаунт не найден. Зарегистрируйтесь.");
    const got = hashPassword(String(password || ""), rec.salt);
    const a = Buffer.from(got, "hex");
    const b = Buffer.from(rec.hash, "hex");
    if (!crypto.timingSafeEqual(a, b)) throw new Error("Неверный пароль.");
    writeJSON(SESSION_FILE(), { username: rec.username, at: Date.now() });
    return { username: rec.username };
  },

  logout() {
    try { fs.unlinkSync(SESSION_FILE()); } catch { /* файла уже нет */ }
  },
};

/* ============================================================
   НАСТРОЙКИ
   ============================================================ */
const SETTINGS_FILE = () => P("settings.json");

const DEFAULT_SETTINGS = {
  keys: {
    openrouter: "",    // ключ OpenRouter (бесплатные модели)
    dahl: "",          // ключ inference.dahl.global
    arenaCookie: "",   // сессионная кука Arena AI (arena.ai)
    xkiro: "",         // XTROUTER_API_KEY (api.xkiro.com)
  },
  model: {
    provider: "openrouter", // openrouter | dahl | arena | xkiro
    id: "qwen/qwen3.8-27b:free", // актуальная free-модель (список живой в UI)
  },
  arenaLimit: 30,        // лимит сообщений на чат в Arena (Agent Mode ≈ 5!)
  mascotShow: true,      // маскот: показывать (мини в строке + оверлей)
  mascotAnim: true,      // анимация маскота: моргание, машет, следит за мышкой
  mascotScale: 1,        // размер маскота: 0.8 / 1 / 1.4
  showMascotOnDone: true, // оверлей при завершении задачи (только когда не в фокусе)
  chimeOnDone: true,     // тихий чим при завершении задачи
};

function getSettings() {
  const s = readJSON(SETTINGS_FILE(), {});
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    keys: { ...DEFAULT_SETTINGS.keys, ...(s.keys || {}) },
    model: { ...DEFAULT_SETTINGS.model, ...(s.model || {}) },
  };
}
function saveSettings(patch) {
  const merged = { ...getSettings(), ...patch };
  writeJSON(SETTINGS_FILE(), merged);
  return merged;
}

/* ============================================================
   ЧАТЫ
   ============================================================ */
const chatFile = (id) => P("chats/" + id + ".json");

function newChat({ provider, model, title, remoteId = null }) {
  const now = Date.now();
  const chat = {
    id: crypto.randomUUID(),
    provider,
    model,
    remoteId, // id «настоящего» чата у провайдера (у Arena — на самом сайте)
    title: title || "Новый чат",
    createdAt: now,
    updatedAt: now,
    messages: [], // [{role, content, at}]
  };
  writeJSON(chatFile(chat.id), chat);
  return chat;
}

function getChat(id) {
  return readJSON(chatFile(id), null);
}

function saveChat(chat) {
  chat.updatedAt = Date.now();
  writeJSON(chatFile(chat.id), chat);
}

/** Список чатов (без переписки) — для панели «История». */
function listChats() {
  const dir = P("chats");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJSON(path.join(dir, f), null))
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ messages, ...meta }) => ({ ...meta, count: (messages || []).length }));
}

/** Старый чат после переноса — в архив (фактически «удаляется»). */
function archiveChat(chat) {
  try {
    fs.renameSync(chatFile(chat.id), P("chats/archive/" + chat.id + ".json"));
  } catch { /* уже не существует */ }
}

/** Удаление чата пользователем — в архив (можно вернуть: chats/archive). */
function deleteChat(id) {
  const chat = getChat(id);
  if (!chat) return { ok: false, error: "Чат не найден" };
  archiveChat(chat);
  return { ok: true };
}

/* ============================================================
   СТАТИСТИКА (вкладка Overview) — считается из реальных данных
   ============================================================ */
function stats() {
  const dir = P("chats");
  const chats = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJSON(path.join(dir, f), null))
    .filter(Boolean);

  const perDay = {};   // "YYYY-MM-DD" -> { count, byBucket: [7] }
  let messages = 0;
  let tokens = 0;
  const modelUse = {};
  const daySet = new Set();

  for (const c of chats) {
    for (const m of c.messages || []) {
      messages++;
      tokens += Math.ceil((m.content || "").length / 4); // грубая оценка
      modelUse[c.model] = (modelUse[c.model] || 0) + 1;
      const d = new Date(m.at || c.updatedAt);
      const key = d.toISOString().slice(0, 10);
      daySet.add(key);
      perDay[key] = perDay[key] || { count: 0, byBucket: Array(7).fill(0) };
      perDay[key].count++;
      // 7 «часовых» полос: 24 часа / 7
      const bucket = Math.min(6, Math.floor((d.getHours() + d.getMinutes() / 60) / (24 / 7)));
      perDay[key].byBucket[bucket]++;
    }
  }

  // heatmap: последние 24 дня (столбцы) × 7 полос (строки)
  const heat = [];
  const today = new Date();
  for (let i = 23; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const cell = perDay[key];
    heat.push(cell ? cell.byBucket : Array(7).fill(0));
  }

  let favorite = "—";
  let best = 0;
  for (const [m, n] of Object.entries(modelUse)) if (n > best) { best = n; favorite = m; }

  return {
    sessions: chats.length,
    messages,
    tokens: formatTokens(tokens),
    days: daySet.size,
    favorite,
    heat, // 24 × 7
  };
}

function formatTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

module.exports = { auth, getSettings, saveSettings, newChat, getChat, saveChat, listChats, archiveChat, deleteChat, stats, dataDir };
