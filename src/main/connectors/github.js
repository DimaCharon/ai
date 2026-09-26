/* ============================================================
   github.js — коннектор GitHub (REST API, Personal Access Token)
   ------------------------------------------------------------
   Возможности:
     • check()        — проверка токена (GET /user)
     • listRepos()    — репозитории пользователя
     • listDir()      — содержимое каталога репозитория
     • readFile()     — текст файла (до 300 КБ)
     • downloadRepo() — весь репозиторий (tarball) → папку проекта

   Токен хранится локально: settings.keys.github
   (github.com → Settings → Developer settings →
   Personal access tokens → classic, scope: repo)
   ============================================================ */
"use strict";

const path = require("path");
const os = require("os");
const zlib = require("zlib");
const store = require("../store");
const { extractTarToDir } = require("./tar");

const BASE = "https://api.github.com";
const MAX_FILE = 300000; // 300 КБ текста файла

class GithubConnector {
  id = "github";
  name = "GitHub";
  icon = "🐙";
  desc = "Репозитории и файлы кода: просмотр, чтение, загрузка в проект";

  get token() {
    let t = (store.getSettings().keys.github || "").trim();
    t = t.replace(/^bearer\s+/i, "").trim();
    return t;
  }
  setToken(t) {
    const s = store.getSettings();
    store.saveSettings({ keys: { ...s.keys, github: (t || "").trim() } });
  }

  headers() {
    return {
      Authorization: "Bearer " + this.token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Charon Code",
    };
  }

  async _get(url, { timeout = 30000 } = {}) {
    if (!this.token) return { ok: false, error: "Нет токена GitHub." };
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    try {
      const r = await fetch(BASE + url, { headers: this.headers(), signal: c.signal });
      const body = await r.text();
      if (r.status === 401 || r.status === 403) {
        if (/rate limit/i.test(body)) {
          return { ok: false, error: "GitHub: лимит запросов исчерпан — подожди минуту и попробуй снова." };
        }
        return { ok: false, error: "GitHub: токен не принят (HTTP " + r.status + "). Проверь PAT (scope: repo)." };
      }
      if (!r.ok) return { ok: false, error: "GitHub: HTTP " + r.status + " — " + body.slice(0, 160) };
      try { return { ok: true, data: JSON.parse(body) }; }
      catch { return { ok: true, body }; }
    } catch (e) {
      return { ok: false, error: "Не удалось подключиться к GitHub: " + String(e.message || e).slice(0, 140) };
    } finally {
      clearTimeout(t);
    }
  }

  /** Проверка токена. → { ok, info: login } */
  async check() {
    const r = await this._get("/user");
    if (!r.ok) return r;
    return { ok: true, info: r.data.login, name: r.data.name || r.data.login };
  }

  /** Репозитории пользователя (последние обновлённые). */
  async listRepos() {
    const r = await this._get("/user/repos?per_page=100&sort=updated");
    if (!r.ok) return r;
    return {
      ok: true,
      data: (r.data || []).map((x) => ({
        full_name: x.full_name,
        name: x.name,
        private: x.private,
        updated_at: x.updated_at,
        default_branch: x.default_branch,
      })),
    };
  }

  /** Содержимое каталога: [{ name, path, type: 'file'|'dir', size }] */
  async listDir(repo, path = "", branch) {
    const p = "/repos/" + repo + "/contents" +
      (path ? "/" + path.split("/").map(encodeURIComponent).join("/") : "");
    const r = await this._get(p + (branch ? "?ref=" + encodeURIComponent(branch) : ""));
    if (!r.ok) return r;
    const arr = Array.isArray(r.data) ? r.data : [r.data];
    return { ok: true, data: arr.map((x) => ({ name: x.name, path: x.path, type: x.type, size: x.size || 0 })) };
  }

  /** Текст файла. → { ok, data: { path, size, text, truncated } } */
  async readFile(repo, path) {
    const r = await this._get("/repos/" + repo + "/contents/" + path.split("/").map(encodeURIComponent).join("/"));
    if (!r.ok) return r;
    if (!r.data || !r.data.content) return { ok: false, error: "Не удалось прочитать файл" };
    const text = Buffer.from(r.data.content.replace(/\n/g, ""), "base64").toString("utf8");
    return {
      ok: true,
      data: { path: r.data.path, size: r.data.size, text: text.slice(0, MAX_FILE), truncated: r.data.size > MAX_FILE },
    };
  }

  /** Сохранить один файл в папку (без перезаписи: «имя (1).ext»). */
  async saveFile(fileName, content, destBase = os.homedir()) {
    const fs = require("fs");
    const name = fileName.split("/").pop().replace(/[\\/:*?"<>|]/g, "_") || "file.txt";
    let dest = path.join(destBase, name);
    if (fs.existsSync(dest)) {
      const base = path.basename(name, path.extname(name));
      const ext = path.extname(name);
      let i = 1;
      while (fs.existsSync(path.join(destBase, base + " (" + i + ")" + ext))) i++;
      dest = path.join(destBase, base + " (" + i + ")" + ext);
    }
    await fs.promises.mkdir(destBase, { recursive: true });
    await fs.promises.writeFile(dest, content, "utf8");
    return { ok: true, dir: dest };
  }

  /**
   * Скачать весь репозиторий (tarball) в папку.
   * → { ok, dir, files, size }
   */
  async downloadRepo(repo, branch, destBase = os.homedir()) {
    if (!this.token) return { ok: false, error: "Нет токена GitHub." };
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 180000);
    let buf;
    try {
      const r = await fetch(BASE + "/repos/" + repo + "/tarball/" + (branch || "HEAD"), {
        headers: this.headers(),
        signal: c.signal,
      });
      if (!r.ok) return { ok: false, error: "GitHub: не удалось скачать репозиторий (HTTP " + r.status + ")" };
      buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 500 * 1024 * 1024) return { ok: false, error: "Репозиторий больше 500 МБ — скачай через git." };
    } catch (e) {
      return { ok: false, error: "Не удалось скачать репозиторий: " + String(e.message || e).slice(0, 140) };
    } finally {
      clearTimeout(t);
    }

    const repoName = repo.split("/").pop();
    const dest = path.join(destBase, repoName);
    try {
      const tar = zlib.gunzipSync(buf);
      const count = extractTarToDir(tar, dest, { stripFirst: true });
      return { ok: true, dir: dest, files: count, size: buf.length };
    } catch (e) {
      return { ok: false, error: "Не удалось распаковать архив: " + String(e.message || e).slice(0, 140) };
    }
  }
}

module.exports = GithubConnector;
