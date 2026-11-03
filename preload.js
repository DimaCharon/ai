/* ============================================================
   preload.js — безопасный мост renderer ↔ main (contextBridge)
   ------------------------------------------------------------
   Renderer видит ТОЛЬКО объект window.cc. Прямого доступа к
   Node у интерфейса нет.
   ============================================================ */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/** Подписка на события main-процесса; возвращает функцию отписки. */
function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("cc", {
  /* ---------- окно ---------- */
  win: {
    close: () => ipcRenderer.invoke("win:close"),
    minimize: () => ipcRenderer.invoke("win:minimize"),
    toggleMax: () => ipcRenderer.invoke("win:toggleMax"),
  },

  /* ---------- локальные аккаунты ---------- */
  auth: {
    status: () => ipcRenderer.invoke("auth:status"),
    register: (u, p) => ipcRenderer.invoke("auth:register", u, p),
    login: (u, p) => ipcRenderer.invoke("auth:login", u, p),
    logout: () => ipcRenderer.invoke("auth:logout"),
  },

  /* ---------- настройки ---------- */
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (patch) => ipcRenderer.invoke("settings:save", patch),
  },

  /* ---------- статистика ---------- */
  stats: {
    get: () => ipcRenderer.invoke("stats:get"),
  },

  /* ---------- провайдеры / модели ---------- */
  providers: {
    listModels: (providerId) => ipcRenderer.invoke("providers:listModels", providerId),
    refreshArena: () => ipcRenderer.invoke("providers:refreshArena"),
  },

  /* ---------- чат ---------- */
  chat: {
    list: () => ipcRenderer.invoke("chat:list"),
    get: (id) => ipcRenderer.invoke("chat:get", id),
    delete: (id) => ipcRenderer.invoke("chat:delete", id),
    send: (payload) => ipcRenderer.invoke("chat:send", payload),
    stop: (chatId) => ipcRenderer.invoke("chat:stop", chatId),
    confirmReply: (actionId, ok) => ipcRenderer.invoke("chat:confirmReply", actionId, ok),
    onToken: (cb) => on("chat:token", cb),
    onStatus: (cb) => on("chat:status", cb),
    onDone: (cb) => on("chat:done", cb),
    onError: (cb) => on("chat:error", cb),
    onCouncil: (cb) => on("chat:council", cb),
    onAction: (cb) => on("chat:action", cb),
    onIter: (cb) => on("chat:iter", cb),
    onCleanup: (cb) => on("chat:cleanup", cb),
    onConfirm: (cb) => on("chat:confirm", cb),
  },

  /* ---------- проекты (папка + своя память) ---------- */
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    create: (name) => ipcRenderer.invoke("projects:new", { name }),
    remove: (id) => ipcRenderer.invoke("projects:remove", id),
  },

  /* ---------- память ИИ ---------- */
  memory: {
    get: (target) => ipcRenderer.invoke("memory:get", target),
    save: (target, text) => ipcRenderer.invoke("memory:save", target, text),
  },

  /* ---------- плагины ---------- */
  plugins: {
    list: () => ipcRenderer.invoke("plugins:list"),
    install: (url) => ipcRenderer.invoke("plugins:install", url),
    remove: (name) => ipcRenderer.invoke("plugins:remove", name),
    setEnabled: (name, v) => ipcRenderer.invoke("plugins:setEnabled", name, v),
    commands: () => ipcRenderer.invoke("plugins:commands"),
  },

  /* ---------- Self-режим (файлы приложения + перезапуск) ---------- */
  app: {
    info: () => ipcRenderer.invoke("app:info"),
    relaunch: () => ipcRenderer.invoke("app:relaunch"),
  },

  /* ---------- коннекторы (GitHub / GitLab / Google Drive / …) ---------- */
  connectors: {
    list: () => ipcRenderer.invoke("connectors:list"),
    check: (id) => ipcRenderer.invoke("connectors:check", id),
    saveToken: (id, token) => ipcRenderer.invoke("connectors:saveToken", id, token),
    action: (id, name, params) => ipcRenderer.invoke("connectors:action", id, name, params || []),
  },

  /* ---------- файлы ---------- */
  files: {
    list: (p) => ipcRenderer.invoke("files:list", p),
    read: (p) => ipcRenderer.invoke("files:read", p),
    write: (p, content) => ipcRenderer.invoke("files:write", p, content),
    pick: () => ipcRenderer.invoke("files:pick"),
    open: (p) => ipcRenderer.invoke("files:open", p),
    reveal: (p) => ipcRenderer.invoke("files:reveal", p),
    saveTemp: (name, data) => ipcRenderer.invoke("files:saveTemp", name, data),
  },

  /* ---------- терминал ---------- */
  terminal: {
    run: (opts) => ipcRenderer.invoke("terminal:run", opts),
    kill: (runId) => ipcRenderer.invoke("terminal:kill", runId),
    onOut: (cb) => on("term:out", cb),
    onDone: (cb) => on("term:done", cb),
  },

  /* ---------- экран: микроскриншоты для «видения» ИИ ---------- */
  screen: {
    list: () => ipcRenderer.invoke("screen:list"),
    capture: (opts) => ipcRenderer.invoke("screen:capture", opts),
  },

  /* ---------- маскот ---------- */
  mascot: {
    /** main → renderer: оверлей показан, сыграй чим */
    onWave: (cb) => on("mascot:wave", cb),
    taskDone: () => ipcRenderer.send("mascot:taskDone"),
    hide: () => ipcRenderer.invoke("mascot:hide"),
    setScale: (s) => ipcRenderer.invoke("mascot:setScale", s),
  },

  /* ---------- Arena Bridge (браузерное расширение) ---------- */
  bridge: {
    /** порт локального сервера + папка расширения */
    info: () => ipcRenderer.invoke("bridge:info"),
    /** показать папку extension в Проводнике */
    reveal: () => ipcRenderer.invoke("bridge:reveal"),
  },

  /* ---------- overlay.html: показать/скрыть/клик/масштаб ---------- */
  overlay: {
    onShow: (cb) => on("overlay:show", cb),
    onHide: (cb) => on("overlay:hide", cb),
    onScale: (cb) => on("overlay:scale", cb),
    click: () => ipcRenderer.send("overlay:click"),
  },
});
