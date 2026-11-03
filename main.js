/* ============================================================
   main.js — главный процесс Charon Code
   ------------------------------------------------------------
   • Главное окно (frameless, кастомный титлбар с mac-кнопками)
   • ОВЕРЛЕЙ МАСКОТА: прозрачное always-on-top окно 150×150
     в правом нижнем углу (над треем). Вылезает, когда задача
     завершена в фоне: машет рукой + мягкий чим. Клик — возврат
     в приложение.
   • IPC: auth / settings / providers / chat / files / terminal
   ============================================================ */
"use strict";

const { app, BrowserWindow, ipcMain, screen, shell } = require("electron");
const path = require("path");
const crypto = require("crypto");

const store = require("./src/main/store");
const engine = require("./src/main/engine");
const fsSvc = require("./src/main/fs");
const screenSvc = require("./src/main/screen");
const connSvc = require("./src/main/connectors");
const bridgeSvc = require("./src/main/bridge");
const memory = require("./src/main/memory");
const plugins = require("./src/main/plugins");
const appself = require("./src/main/appself");

let win = null;      // главное окно
let overlay = null;  // оверлей маскота

/* ============================================================
   ОКНА
   ============================================================ */
function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    frame: false,                 // свой титлбар с mac-кнопками
    backgroundColor: "#0a0b0f",
    show: false,
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, "src", "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  // Закрыли главное окно → прячем оверлей и выходим полностью
  // (иначе скрытое окно-оверлей удержало бы процесс в фоне)
  win.on("closed", () => {
    win = null;
    hideOverlay();
    app.quit();
  });
}

function createOverlay() {
  const wa = screen.getPrimaryDisplay().workArea; // рабочая область (без трей-панели)
  overlay = new BrowserWindow({
    width: 150,
    height: 150,
    x: wa.x + wa.width - 150,  // правый нижний угол
    y: wa.y + wa.height - 150,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,           // не отнимает фокус, но клики принимает
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlay.setAlwaysOnTop(true, "screen-saver"); // поверх ВСЕХ окон
  if (overlay.setVisibleOnAllWorkspaces) {
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  overlay.loadFile(path.join(__dirname, "src", "renderer", "overlay.html"));
  overlay.on("ready-to-show", () => overlay.hide()); // стартует скрытым
  overlay.on("closed", () => { overlay = null; });
}

/** Показать маскота: вылезает из угла, машет, ждёт клика. */
function showOverlay(tip) {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.showInactive(); // показать, НЕ отнимая фокус у приложения
  overlay.webContents.send("overlay:show", tip || "Задача выполнена — кликни, чтобы вернуться", mascotScale());
  // чим играет в главном окне (после жеста пользователя — автоплей разрешён)
  safeSend(win, "mascot:wave");
}

/* ---------- размер маскота (настройка) ---------- */
let mascotScaleVal = 1;
function mascotScale() {
  return Math.min(2, Math.max(0.6, Number(mascotScaleVal) || 1));
}
function applyMascotScale(s) {
  mascotScaleVal = mascotScale();
  if (overlay && !overlay.isDestroyed()) {
    const size = Math.round(150 * mascotScaleVal);
    const wa = screen.getPrimaryDisplay().workArea;
    overlay.setSize(size, size);
    overlay.setPosition(wa.x + wa.width - size, wa.y + wa.height - size);
    overlay.webContents.send("overlay:scale", mascotScaleVal);
  }
  return mascotScaleVal;
}

function hideOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.webContents.send("overlay:hide");
  overlay.hide();
}

function safeSend(w, channel, payload) {
  try {
    if (w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) {
      w.webContents.send(channel, payload);
    }
  } catch { /* окно закрывается */ }
}

/* ============================================================
   IPC
   ============================================================ */
function registerIpc() {
  /* ---------- окно ---------- */
  ipcMain.handle("win:close", () => { if (win) win.close(); });
  ipcMain.handle("win:minimize", () => { if (win) win.minimize(); });
  ipcMain.handle("win:toggleMax", () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });

  /* ---------- аккаунты (локальные) ---------- */
  ipcMain.handle("auth:status", () => store.auth.status());
  ipcMain.handle("auth:register", (_e, u, p) => store.auth.register(u, p));
  ipcMain.handle("auth:login", (_e, u, p) => store.auth.login(u, p));
  ipcMain.handle("auth:logout", () => { store.auth.logout(); return { ok: true }; });

  /* ---------- настройки ---------- */
  ipcMain.handle("settings:get", () => store.getSettings());
  ipcMain.handle("settings:save", (_e, patch) => store.saveSettings(patch));

  /* ---------- статистика (вкладка Overview — из реальных данных) ---------- */
  ipcMain.handle("stats:get", () => store.stats());

  /* ---------- провайдеры и модели ---------- */
  ipcMain.handle("providers:listModels", async (_e, providerId) => {
    const p = engine.providers[providerId];
    if (!p) return { ok: false, error: "Неизвестный провайдер" };
    try {
      if (providerId !== "arena") await p.check(); // без ключа список не берём
      const models = await p.listModels();
      return { ok: true, provider: providerId, models };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  /** «Обновить сессию Arena»: проверить куку + подтянуть агентов. */
  ipcMain.handle("providers:refreshArena", async () => {
    const p = engine.providers.arena;
    try {
      const chk = await p.check();
      const agents = await p.listAgents();
      return { ok: true, agents, user: chk.username || null };
    } catch (err) {
      return { ok: false, code: err.code || "error", error: err.message || String(err) };
    }
  });

  /* ---------- чат (движок «1 нажатие = 1 ответ») ---------- */
  ipcMain.handle("chat:list", () => store.listChats());
  ipcMain.handle("chat:get", (_e, id) => store.getChat(id));
  ipcMain.handle("chat:delete", (_e, id) => store.deleteChat(id));
  ipcMain.handle("chat:stop", (_e, chatId) => { engine.stopChat(chatId); return { ok: true }; });
  ipcMain.handle("chat:confirmReply", (_e, actionId, ok) => engine.confirmReply(actionId, ok));

  /* ---------- проекты (папка + своя память) ---------- */
  ipcMain.handle("projects:list", () => store.getSettings().projects || []);
  ipcMain.handle("projects:new", async (e, opts) => {
    const w = BrowserWindow.fromWebContents(e.sender) || win;
    const r = await fsSvc.pickDir(w);
    if (!r || !r.ok || !r.path) return { ok: false, error: (r && r.error) || "Выбор папки отменён" };
    const s = store.getSettings();
    const name = String((opts && opts.name) || "").trim() || r.path.split(path.sep).filter(Boolean).pop() || "Проект";
    const project = { id: crypto.randomUUID().slice(0, 8), name, dir: r.path, createdAt: Date.now() };
    store.saveSettings({ projects: [...(s.projects || []), project] });
    return { ok: true, project };
  });
  ipcMain.handle("projects:remove", (_e, id) => {
    const s = store.getSettings();
    store.saveSettings({ projects: (s.projects || []).filter((p) => p.id !== id) });
    return { ok: true };
  });

  /* ---------- память ИИ (глобальная + проекта) ---------- */
  ipcMain.handle("memory:get", (_e, target) => ({ target: target || "global", text: memory.read(target || "global") }));
  ipcMain.handle("memory:save", (_e, target, text) => memory.save(target || "global", text));

  /* ---------- плагины (установка по ссылке GitHub) ---------- */
  ipcMain.handle("plugins:list", () => plugins.list());
  ipcMain.handle("plugins:install", (_e, url) => plugins.install(url));
  ipcMain.handle("plugins:remove", (_e, name) => plugins.remove(name));
  ipcMain.handle("plugins:setEnabled", (_e, name, v) => plugins.setEnabled(name, v));
  ipcMain.handle("plugins:commands", () => plugins.allCommands());

  /* ---------- Self-режим: файлы самого приложения + рестарт ---------- */
  ipcMain.handle("app:info", () => ({
    dir: appself.appDir(),
    writable: appself.writable(),
    version: app.getVersion(),
  }));
  ipcMain.handle("app:relaunch", () => {
    try {
      app.relaunch();
      app.quit();
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
    return { ok: true };
  });
  ipcMain.handle("chat:send", async (e, payload) => {
    // Один AbortController на запрос: «Стоп» в UI прервёт его.
    // Движок сам регистрирует контроллер по chatId (engine.stopChat).
    const w = BrowserWindow.fromWebContents(e.sender) || win;
    const controller = new AbortController();
    return engine.sendChat(w, payload, controller.signal);
  });

  /* ---------- файлы ---------- */
  ipcMain.handle("files:list", (e, p) => fsSvc.listDir(BrowserWindow.fromWebContents(e.sender), p));
  ipcMain.handle("files:read", (_e, p) => fsSvc.readFile(p));
  ipcMain.handle("files:write", (_e, p, content) => fsSvc.writeFile(p, content));
  ipcMain.handle("files:pick", (e) => fsSvc.pickDir(BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle("files:open", (_e, p) => fsSvc.openPath(p));
  ipcMain.handle("files:reveal", (_e, p) => { fsSvc.revealPath(p); return { ok: true }; });
  ipcMain.handle("files:saveTemp", (_e, name, data) => fsSvc.saveTemp(name, data));

  /* ---------- терминал ---------- */
  ipcMain.handle("terminal:run", (e, opts) => {
    const w = BrowserWindow.fromWebContents(e.sender) || win;
    return fsSvc.run(w, opts);
  });
  ipcMain.handle("terminal:kill", (_e, runId) => fsSvc.kill(runId));

  /* ---------- коннекторы (GitHub / GitLab / Google Drive / …) ---------- */
  ipcMain.handle("connectors:list", () => connSvc.list());
  ipcMain.handle("connectors:check", (_e, id) => connSvc.check(id));
  ipcMain.handle("connectors:saveToken", (_e, id, token) => connSvc.saveToken(id, token));
  ipcMain.handle("connectors:action", (_e, id, name, params) => connSvc.action(id, name, params || []));

  /* ---------- экран (микроскриншоты для «видения» ИИ) ---------- */
  ipcMain.handle("screen:list", () => screenSvc.listScreens());
  ipcMain.handle("screen:capture", (_e, opts) => screenSvc.captureScreen(opts || {}));

  /* ---------- маскот ---------- */
  /**
   * Задача завершилась: показать оверлей.
   *   mascotShow       — маскот вообще (мини + оверлей);
   *   showMascotOnDone — оверлей именно при завершении задачи;
   *   chimeOnDone      — тихий чим (решила рендерер-сторона).
   */
  ipcMain.on("mascot:taskDone", () => {
    const s = store.getSettings();
    if (s.mascotShow === false) return;
    if (!s.showMascotOnDone) return;
    // Пользователь СМОТРИТ на приложение — не отвлекаем оверлеем и чимом.
    // Оверлей нужен, когда внимание ELSEWHERE (другое окно).
    if (win && !win.isDestroyed() && win.isFocused()) return;
    showOverlay("Задача выполнена — кликни, чтобы вернуться");
  });
  ipcMain.handle("mascot:hide", () => { hideOverlay(); return { ok: true }; });
  ipcMain.handle("mascot:setScale", (_e, s) => { return { ok: true, scale: applyMascotScale(s) }; });

  /* ---- Arena Bridge: браузерное расширение подтягивает куку arena.ai ---- */
  ipcMain.handle("bridge:info", () => ({
    ok: true,
    port: bridgeSvc.BRIDGE_PORT,
    dir: bridgeSvc.extDir(),
  }));
  ipcMain.handle("bridge:reveal", () => {
    try {
      shell.showItemInFolder(bridgeSvc.extDir());
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
}

/* ============================================================
   ЗАПУСК / ЗАВЕРШЕНИЕ
   ============================================================ */
app.whenReady().then(() => {
  store.dataDir(); // создать структуру данных
  registerIpc();
  bridgeSvc.startBridgeServer(engine); // Arena Bridge (для браузера)
  createWindow();
  createOverlay();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit(); // без трей-иконки: закрыл окно — приложение вышло
});

/* Клик по маскоту (из overlay.html) — скрыть оверлей и вернуть фокус приложению */
ipcMain.on("overlay:click", () => {
  hideOverlay();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
