/* ============================================================
   connectors/index.js — реестр коннекторов + единый IPC-слой
   ------------------------------------------------------------
   Коннектор — это способ достать внешние данные (код из
   репозиториев, файлы из облака) в Charon Code. Новый коннектор
   = новый файл-класс + одна строка в реестре.

   Единый контракт для UI:
     check()       → { ok, info?, error? }
     listRepos()   → { ok, data: [{ full_name, name, default_branch? }] }
     listDir(x, path, branch) → { ok, data: [{ name, path, type, size }] }
     readFile(x, path)        → { ok, data: { path, text, truncated } }
     downloadRepo(x, branch, destBase) → { ok, dir, files }

   (у Google Drive сейчас только check() — см. его README внутри)
   ============================================================ */
"use strict";

const Github = require("./github");
const Gitlab = require("./gitlab");
const GoogleDrive = require("./googledrive");

const connectors = {
  github: new Github(),
  gitlab: new Gitlab(),
  googledrive: new GoogleDrive(),
};

/** Краткое описание для UI: [{ id, name, icon, desc, token, setup }] */
function list() {
  return Object.values(connectors).map((c) => ({
    id: c.id,
    name: c.name,
    icon: c.icon,
    desc: c.desc,
    token: !!(c.token && c.token.length),
    setup: !!c.setupNeeded,
  }));
}

function get(id) {
  return connectors[id] || null;
}

/** Проверка подключения коннектора. */
async function check(id) {
  const c = get(id);
  if (!c) return { ok: false, error: "Неизвестный коннектор: " + id };
  try { return await c.check(); }
  catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200) }; }
}

/** Сохранить токен и сразу проверить. */
async function saveToken(id, token) {
  const c = get(id);
  if (!c) return { ok: false, error: "Неизвестный коннектор: " + id };
  if (typeof c.setToken !== "function") {
    return { ok: false, error: "У коннектора " + c.name + " нет токена (нужна OAuth-настройка)." };
  }
  c.setToken(token);
  return check(id);
}

/** Вызвать действие: listRepos | listDir | readFile | downloadRepo */
async function action(id, name, params = []) {
  const c = get(id);
  if (!c) return { ok: false, error: "Неизвестный коннектор: " + id };
  const fn = c[name];
  if (typeof fn !== "function") return { ok: false, error: "Действие «" + name + "» у " + c.name + " недоступно" };
  try {
    return await fn.apply(c, params);
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

module.exports = { connectors, list, get, check, saveToken, action };
