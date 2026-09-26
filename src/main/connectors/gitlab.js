/* ============================================================
   gitlab.js — коннектор GitLab (REST API v4, Personal Access Token)
   ------------------------------------------------------------
   Те же возможности, что у GitHub: check, список проектов,
   дерево файлов, чтение файла, скачивание архива в папку.
   Токен: settings.keys.gitlab
   (gitlab.com → Preferences → Access Tokens, scope: read_api)
   ============================================================ */
"use strict";

const path = require("path");
const os = require("os");
const zlib = require("zlib");
const store = require("../store");
const { extractTarToDir } = require("./tar");

const BASE = "https://gitlab.com/api/v4";
const MAX_FILE = 300000;

class GitlabConnector {
  id = "gitlab";
  name = "GitLab";
  icon = "🦊";
  desc = "Проекты и файлы кода на GitLab";

  get token() {
    let t = (store.getSettings().keys.gitlab || "").trim();
    t = t.replace(/^bearer\s+/i, "").trim();
    return t;
  }
  setToken(t) {
    const s = store.getSettings();
    store.saveSettings({ keys: { ...s.keys, gitlab: (t || "").trim() } });
  }

  headers() {
    return { "Authorization": "Bearer " + this.token, "User-Agent": "Charon Code" };
  }

  async _get(url, { timeout = 30000, raw = false } = {}) {
    if (!this.token) return { ok: false, error: "Нет токена GitLab." };
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    try {
      const r = await fetch(BASE + url, { headers: this.headers(), signal: c.signal });
      const body = await r.text();
      if (r.status === 401 || r.status === 403) {
        return { ok: false, error: "GitLab: токен не принят (HTTP " + r.status + "). Проверь Access Token (scope: read_api)." };
      }
      if (!r.ok) return { ok: false, error: "GitLab: HTTP " + r.status + " — " + body.slice(0, 160) };
      if (raw) return { ok: true, body };
      try { return { ok: true, data: JSON.parse(body) }; }
      catch { return { ok: true, body }; }
    } catch (e) {
      return { ok: false, error: "Не удалось подключиться к GitLab: " + String(e.message || e).slice(0, 140) };
    } finally {
      clearTimeout(t);
    }
  }

  async check() {
    const r = await this._get("/user");
    if (!r.ok) return r;
    return { ok: true, info: r.data.username, name: r.data.name || r.data.username };
  }

  async listProjects() {
    const r = await this._get("/projects?membership=true&per_page=100&order_by=last_activity_at");
    if (!r.ok) return r;
    return {
      ok: true,
      data: (r.data || []).map((x) => ({
        full_name: x.path_with_namespace,
        name: x.name,
        id: x.id,
        default_branch: x.default_branch,
      })),
    };
  }

  async listDir(project, pathStr = "", branch) {
    // project = числовой id или "owner/repo" (с энкодингом)
    const p = String(project).includes("/") ? encodeURIComponent(project) : String(project);
    const url = "/projects/" + p + "/repository/tree?per_page=100" +
      (pathStr ? "&path=" + encodeURIComponent(pathStr) : "") +
      (branch ? "&ref=" + encodeURIComponent(branch) : "");
    const r = await this._get(url);
    if (!r.ok) return r;
    return { ok: true, data: (r.data || []).map((x) => ({ name: x.name, path: x.path, type: x.type, size: x.size || 0 })) };
  }

  async readFile(project, pathStr) {
    const p = String(project).includes("/") ? encodeURIComponent(project) : String(project);
    const r = await this._get("/projects/" + p + "/repository/files/" + encodeURIComponent(pathStr) + "/raw", { raw: true });
    if (!r.ok) return r;
    const text = r.body || "";
    return { ok: true, data: { path: pathStr, size: text.length, text: text.slice(0, MAX_FILE), truncated: text.length > MAX_FILE } };
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

  async downloadRepo(project, branch, destBase = os.homedir()) {
    const p = String(project).includes("/") ? encodeURIComponent(project) : String(project);
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 180000);
    let buf;
    let repoName;
    try {
      const r = await fetch(BASE + "/projects/" + p + "/repository/archive.tar.gz" + (branch ? "?sha=" + encodeURIComponent(branch) : ""), {
        headers: this.headers(),
        signal: c.signal,
      });
      if (!r.ok) return { ok: false, error: "GitLab: не удалось скачать проект (HTTP " + r.status + ")" };
      repoName = (r.headers.get("content-disposition") || "").match(/filename="?([^";]+)"/);
      buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 500 * 1024 * 1024) return { ok: false, error: "Проект больше 500 МБ — скачай через git." };
    } catch (e) {
      return { ok: false, error: "Не удалось скачать проект: " + String(e.message || e).slice(0, 140) };
    } finally {
      clearTimeout(t);
    }
    if (!repoName) {
      const info = await this._get("/projects/" + p);
      repoName = info.ok && info.data ? info.data.name : "gitlab-project";
    } else {
      repoName = repoName[1].replace(/\.tar\.gz$/, "").split("-").slice(0, 1).join("-");
    }
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

module.exports = GitlabConnector;
