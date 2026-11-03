/* ============================================================
   engine.js — движок «1 нажатие = 1 гарантированный ответ» +
   АГЕНТСКАЯ ПЕТЛЯ (инструменты ИИ)
   ------------------------------------------------------------
   Движок:
     • Экспоненциальный backoff + джиттер, до 10 попыток.
     • АУТО-МИГРАЦИЯ ЧАТА при лимите (создал → проверил →
       скопировал → удалил старый).
   Агentic-петля (v1.0.8):
     • Модель вставляет блоки-команды (```read:```, ```edit:```,
       ```browse:```, ```remember:```, ```list:```) → движок
       исполняет их и возвращает результат модели → повторяет,
       пока задача не выполнена (до 6 итераций / 5 минут).
     • Файлы: только в пределах прикреплённой папки (в Self-режиме
       — папки самого приложения).
     • Браузер: ТОЛЬКО инкогнито, окно закрывается после каждой
       страницы и после каждого промта.
     • Правки файлов — только с подтверждением в UI.
   ============================================================ */
"use strict";

const crypto = require("crypto");
const store = require("./store");
const { OpenRouter } = require("./providers/openrouter");
const { Dahl } = require("./providers/dahl");
const { Arena } = require("./providers/arena");
const { Xkiro } = require("./providers/xkiro");
const { ProviderError } = require("./providers/base");
const council = require("./council");
const agents = require("./agents");
const attachmentsSvc = require("./attachments");
const memory = require("./memory");
const plugins = require("./plugins");
const browserSvc = require("./browser");
const appself = require("./appself");

const MAX_ATTEMPTS = 10;
const ATTEMPT_TIMEOUT_MS = 90000; // таймаут одной попытки
const AGENT_MAX_ITER = 6;         // максимум итераций агentic-петли
const AGENT_BUDGET_MS = 5 * 60 * 1000; // 5 минут на инструменты в одном промте

/** Реестр провайдеров. Новый провайдер = require + одна строка. */
const providers = {
  openrouter: new OpenRouter(),
  dahl: new Dahl(),
  arena: new Arena(),
  xkiro: new Xkiro(),
};
Object.defineProperty(providers.arena, "limit", {
  get() { return providers.arena.realLimit; },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) =>
  Math.min(15000, 600 * 2 ** (attempt - 1)) + Math.random() * 500;

/* ---------- перевод ошибок в русские объяснения ---------- */
function friendly(err, providerName) {
  if (err && err.providerError) return err.message;
  const s = String((err && (err.message || err.name)) || err);
  if (/AbortError|timeout|aborted/i.test(s)) return providerName + " не отвечает (таймаут " + Math.round(ATTEMPT_TIMEOUT_MS / 1000) + " с) — переподключаюсь";
  if (/terminated|UND_ERR/i.test(s)) return "Связь с " + providerName + " рвётся («terminated»: соединение закрывает оператор/VPN/сервер) — попробуй сменить VPN или другой провайдер";
  if (/fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket|network/i.test(s)) return "Связь с " + providerName + " обрывается (сеть/сервер) — переподключаюсь";
  if (/401|403/.test(s)) return providerName + ": доступ запрещён (401/403) — проверь ключ или куку";
  if (/429/.test(s)) return providerName + ": превышен лимит запросов (429) — жду и повторяю";
  if (/404/.test(s)) return providerName + ": эндпоинт не найден (404) — возможно, сайт изменил API";
  if (/5\d\d/.test(s.slice(0, 10))) return providerName + ": серверная ошибка (5xx) — повторяю";
  return providerName + ": " + s.slice(0, 160);
}

/* ============================================================
   ДВИЖОК: 1 нажатие = 1 ответ
   ============================================================ */
async function runRequest(provider, opts) {
  const { model, messages, signal, onToken, onStatus } = opts;
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal && signal.aborted) return { ok: false, code: "aborted", aborted: true };

    onStatus({
      text: `Ожидание ответа… Попытка ${attempt}/${maxAttempts} (${provider.name} отвечает с задержкой, повторяем запрос)`,
      attempt,
    });

    let full = "";
    let emitted = false;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    const timeoutId = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);

    try {
      for await (const ev of provider.streamChat({ model, messages, signal: controller.signal, chatId: opts.chatId })) {
        if (ev.type === "token") {
          full += ev.text;
          emitted = true;
          onToken(ev.text);
        }
      }
      if (!full.trim()) throw new Error("Пустой ответ от модели");
      return { ok: true, text: full, attempts: attempt };
    } catch (err) {
      if (signal && signal.aborted) return { ok: false, code: "aborted", aborted: true };
      if (err && err.noRetry) {
        return { ok: false, code: err.code || "provider", message: err.message, retryable: false };
      }
      if (attempt === maxAttempts) {
        return {
          ok: false,
          code: "max_retries",
          message:
            "Не удалось получить ответ от " + provider.name + " после " + maxAttempts +
            " попыток. " + friendly(err, provider.name) +
            ". Проверь интернет и ключ/куку, затем нажми «Переподключиться».",
        };
      }
      if (emitted) {
        onStatus({ restart: true, text: friendly(err, providerName(provider)) + ". Собираю ответ заново (попытка " + (attempt + 1) + "/" + maxAttempts + ")…" });
      } else {
        const wait = Math.round(backoff(attempt) / 1000);
        onStatus({ text: friendly(err, provider.name) + " — повтор через " + wait + " с (попытка " + (attempt + 1) + "/" + maxAttempts + ")" });
      }
      await sleep(backoff(attempt));
    } finally {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
    }
  }
  return { ok: false, code: "max_retries", message: "Движок остановлен" };
}

function providerName(p) {
  return p.name || p.id || "провайдер";
}

/* ============================================================
   ПОДТВЕРЖДЕНИЯ (правка файлов из чата)
   ============================================================ */
const pendingConfirms = new Map(); // actionId -> resolve

/** UI ответил на подтверждение (chat:confirmReply). */
function confirmReply(actionId, ok) {
  const r = pendingConfirms.get(actionId);
  if (r) {
    pendingConfirms.delete(actionId);
    r(!!ok);
    return { ok: true };
  }
  return { ok: false, error: "Подтверждение не найдено (истекло)" };
}

function askConfirm(win, chatId, title, detail, preview) {
  const actionId = crypto.randomUUID();
  safeSend(win, "chat:confirm", { chatId, actionId, title, detail, preview: preview || "" });
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      pendingConfirms.delete(actionId);
      resolve(false); // 3 мин без ответа — не пишем
    }, 180000);
    pendingConfirms.set(actionId, (ok) => {
      clearTimeout(t);
      resolve(ok);
    });
  });
}

/* ============================================================
   КОНТЕКСТ: память + проект + файлы + плагины + инструменты
   ============================================================ */
function buildContextText({ mode, root, project }) {
  let ctx = "Ты — Charon Code, десктопный AI-агент, работающий на ПК пользователя. Отвечай на языке пользователя (по умолчанию русский). Пиши кратко и по делу.\n";
  const memG = memory.read("global");
  if (memG.trim()) ctx += "ГЛОБАЛЬНАЯ ПАМЯТЬ (у тебя всегда, во всех чатах):\n" + memG.trim().slice(0, 4000) + "\n";
  if (project) {
    ctx += "Текущий ПРОЕКТ: «" + project.name + "» (папка: " + project.dir + ")\n";
    const memP = memory.read(project.id);
    if (memP.trim()) ctx += "ПАМЯТЬ ПРОЕКТА «" + project.name + "»:\n" + memP.trim().slice(0, 4000) + "\n";
  }
  if (root) {
    const fc = agents.buildFolderContext(root);
    if (fc.tree) ctx += "ФАЙЛЫ В ПАПКЕ (" + root + "):\n" + fc.tree + "\n";
    if (fc.files) ctx += "СОДЕРЖИМОЕ ТЕКСТОВЫХ ФАЙЛОВ (уже у тебя в контексте — перечитывать через ```read:``` не обязательно):\n" + fc.files + "\n";
  }
  if (mode === "self") {
    ctx += "РЕЖИМ САМО-ПРИЛОЖЕНИЯ: ты дорабатываешь сам Charon Code (его файлы в контексте выше). После правок пользователь нажмёт «Перезапустить» — правки вступят в силу. Не ломай структуру: правь точечно.\n";
  }
  const pc = plugins.contextForPrompt();
  if (pc) ctx += "УСТАНОВЛЕННЫЕ ПЛАГИНЫ (их команды доступны пользователю как /имя):\n" + pc + "\n";
  ctx += agents.abilitiesPrompt(root, mode === "self");
  return ctx;
}

/** Arena принимает ТОЛЬКО последнее пользовательское сообщение —
   весь контекст и хвост разговора вкладываем в него. */
function arenaMessage(ctxText, msgs, fileText) {
  const tail = msgs.slice(-8)
    .filter((m) => !Array.isArray(m.content))
    .map((m) => (m.role === "user" ? "Я: " : "Charon: ") + String(m.content).slice(0, 4000))
    .join("\n\n");
  const filesPart = fileText ? "\n\n[ПРИКРЕПЛЁННЫЕ ФАЙЛЫ (содержимое)]:\n" + fileText + "\n" : "";
  return (
    "[КОНТЕКСТ СИСТЕМЫ — это инструкции, память и файлы для работы, не текст пользователя]\n" +
    ctxText +
    filesPart +
    "\n\n[НАШ РАЗГОВОР (конец)]:\n" +
    (tail || "(начало разговора)") +
    "\n\nОтветь на последнее сообщение (от «Я») обычным текстом."
  );
}

/* ============================================================
   ЧАТЫ: отправка + авто-миграция + агentic-петля
   ============================================================ */
const stopControllers = new Map();
function stopChat(chatId) {
  const c = stopControllers.get(chatId);
  if (c) c.abort();
}

function buildSummary(msgs) {
  const fmt = (m) => (m.role === "user" ? "Я: " : "Charon: ") + String(m.content || "").slice(0, 300);
  const first = msgs.slice(0, 2).map(fmt);
  const last = msgs.slice(-6).map(fmt);
  return [...new Set([...first, ...last])].join("\n");
}

/**
 * Полный цикл отправки:
 *  проверка провайдера → чат → лимит? авто-миграция → запрос →
 *  АГЕНТИЧЕСКАЯ ПЕТЛЯ (блоки-команды) → сохранение.
 */
async function sendChat(win, payload, signal) {
  const {
    chatId: inChatId, providerId, modelId, text: rawText, screen: screenIn,
    mode = "chat", projectId = null, attachedDir = null, pluginCmd = null,
    files = null,
  } = payload;
  const provider = providers[providerId];
  if (!provider) throw new ProviderError("unknown", "Неизвестный провайдер: " + providerId);

  const screenData =
    screenIn && screenIn.dataUrl && provider.supportsVision(modelId) ? screenIn : null;

  let chatId = inChatId;
  const emit = {
    token: (t) => safeSend(win, "chat:token", { chatId, text: t }),
    status: (s) => safeSend(win, "chat:status", { chatId, ...s }),
    done: (d) => safeSend(win, "chat:done", { chatId, ...d }),
    error: (e) => safeSend(win, "chat:error", { chatId, ...e }),
  };

  /* Вложения (фото/видео/документы): решаем, что модель получит. */
  const attach = attachmentsSvc.prepare(files, {
    vision: provider.supportsVision(modelId),
  });
  for (const rej of attach.rejected) {
    emit.status({ text: attachmentsSvc.rejectedMessage(rej, modelId) });
  }

  try {
    /* 1. Доступность провайдера */
    try {
      await provider.check();
    } catch (err) {
      emit.error({
        code: err.code || "provider",
        message: err.message,
        retryable: ["no_key", "no_cookie", "session_expired", "network"].includes(err.code),
      });
      return null;
    }

    /* 2. Чат */
    let chat = inChatId ? store.getChat(inChatId) : null;
    if (!chat) {
      chat = store.newChat({ provider: providerId, model: modelId, title: rawText.slice(0, 48) });
      chatId = chat.id;
      chat.project = projectId || null;
      emit.status({ text: "Новый чат создан (" + provider.name + ")" });
      try {
        const remote = await provider.createChat({ model: modelId });
        if (remote && remote.id) chat.remoteId = remote.id;
      } catch { /* локальный режим */ }
      store.saveChat(chat);
    } else if (projectId != null) {
      chat.project = projectId || null;
    }

    /* Плагин-команда: /имя аргументы → prompt-шаблон */
    let text = rawText;
    let pluginMeta = null;
    if (pluginCmd && pluginCmd.name) {
      const rc = plugins.resolveCommand(pluginCmd.name, pluginCmd.args);
      if (!rc.ok) {
        emit.error({ code: "plugin", message: rc.error, retryable: false });
        return chat;
      }
      text = rc.prompt;
      pluginMeta = { plugin: rc.plugin, command: rc.command };
    }

    chat.messages.push({
      role: "user", content: rawText, at: Date.now(),
      screen: !!screenData, code: mode === "code", self: mode === "self",
      project: projectId || null, plugin: pluginMeta || undefined,
      files: attach.names.length ? attach.names : undefined,
    });
    if (screenIn && !screenData && !attach.imageParts.length) {
      emit.status({ text: "Модель " + modelId + " не видит изображения — шлю без скриншота. Выбери модель с меткой 👁 (XRouter/OpenRouter)." });
    }

    /* Проект и корень инструментов */
    const s = store.getSettings();
    const project = (s.projects || []).find((p) => p.id === projectId) || null;
    const isSelf = mode === "self";
    const appDir = isSelf ? appself.appDir() : null;
    const root = isSelf ? appDir : (attachedDir || null);
    if (isSelf && !appDir) {
      emit.error({ code: "self", message: "Self-режим: файлы приложения не найдены (ожидалась папка resources/app).", retryable: false });
      return chat;
    }
    if (isSelf && appDir && !appself.writable(appDir)) {
      emit.status({ text: "⚠ Self: каталог приложения доступен только для чтения. Чтобы правки сохранялись — установи Charon Code не в Program Files (свой каталог) или запусти от администратора." });
    }

    const ctxText = buildContextText({ mode, root, project });

    /* 3. Лимит чата → авто-миграция */
    if (chat.messages.length >= provider.limit) {
      emit.status({ text: `Лимит чата достигнут (${chat.messages.length}/${provider.limit}) — перенос: создаю новый чат…` });
      try {
        const next = await migrateChat(win, chat, provider, signal);
        chat = next;
        chatId = chat.id;
      } catch (err) {
        if (signal && signal.aborted) return null;
        emit.status({ text: "Перенос не удался (" + String(err.message || err).slice(0, 80) + ") — продолжаю в текущем чате" });
      }
    }

    /* 4. Сообщения для провайдера */
    const attachText = attach.textBlocks.map((t) => t.block).join("\n\n");
    const attachImages = attach.imageParts; // [{type:'image_url',...}]
    const buildProviderMessages = (msgs) => {
      if (providerId === "arena") {
        return [{ role: "user", content: arenaMessage(ctxText, msgs, attachText) }];
      }
      let lastUserIdx = -1;
      msgs.forEach((m, i) => { if (m.role === "user" && !m.system) lastUserIdx = i; });
      return [
        { role: "system", content: ctxText },
        ...msgs.map((m, i) => {
          if (i === lastUserIdx && m.role === "user") {
            const parts = [];
            if (screenData || attachImages.length) {
              parts.push({ type: "text", text: String(m.content) + (attachText ? "\n\n" + attachText : "") });
              for (const img of attachImages) parts.push(img);
              if (screenData) parts.push({ type: "image_url", image_url: { url: screenData.dataUrl } });
              return { role: "user", content: parts };
            }
            return { role: "user", content: String(m.content) + (attachText ? "\n\n" + attachText : "") };
          }
          return { role: m.role, content: String(m.content) };
        }),
      ];
    };

    stopControllers.set(chatId, signal);
    const startedAt = Date.now();

    try {
      let finalText = "";
      let councilMembers = null;
      let judgeModel = null;

      if (mode === "code") {
        /* ============ КОД-РЕЖИМ ============
           Совет САМЫХ ЛУЧШИХ доступных моделей (XRouter free +
           dahl/OpenRouter по ключам) → судья сводит в ОДИН вывод. */
        let prep = null;
        try { prep = await council.prepare(providers); } catch (err) {
          emit.error({ code: "council", message: "Код-режим: " + (err.message || err), retryable: true });
          return chat;
        }
        judgeModel = prep.judge;
        try {
          const out = await council.runCouncil(providers, {
            members: prep.members,
            judge: prep.judge,
            messages: buildProviderMessages(chat.messages),
            signal,
            onStatus: (st) => emit.status(st),
            onToken: (t) => emit.token(t),
            onCouncil: (members) => safeSend(win, "chat:council", { chatId, members }),
          });
          finalText = out.finalText;
          councilMembers = out.members;
        } catch (err) {
          if (signal && signal.aborted) { emit.status({ text: "Остановлено пользователем" }); return chat; }
          emit.error({ code: "council", message: String(err.message || err).slice(0, 300), retryable: true });
          return chat;
        }
      } else {
        const res = await runRequest(provider, {
          model: modelId,
          messages: buildProviderMessages(chat.messages),
          signal,
          chatId: chat.remoteId || undefined,
          onToken: (t) => emit.token(t),
          onStatus: (st) => emit.status(st),
        });
        if (!res.ok) {
          if (res.aborted) { emit.status({ text: "Остановлено пользователем" }); return chat; }
          emit.error({ code: res.code, message: res.message, retryable: true });
          return chat;
        }
        finalText = res.text;
      }

      /* ============ АГЕНТИЧЕСКАЯ ПЕТЛЯ ============
         Блоки-команды в ответе → исполняем → результат модели →
         повторяем (до 6 итераций / 5 минут / стоп пользователя). */
      const memoryTarget = projectId || "global";
      let editsMade = false;
      for (let iter = 0; iter < AGENT_MAX_ITER; iter++) {
        if (signal && signal.aborted) break;
        if (Date.now() - startedAt > AGENT_BUDGET_MS) {
          emit.status({ text: "Лимит времени на инструменты (5 минут) — останавливаюсь, даю итог" });
          break;
        }
        const blocks = agents.parseBlocks(finalText);
        if (!blocks.length) break;

        // Чистим видимый текст (блоки пользователю не показываем)
        safeSend(win, "chat:cleanup", { chatId, text: agents.stripBlocks(finalText) });

        const results = [];
        for (const b of blocks) {
          if (signal && signal.aborted) break;
          safeSend(win, "chat:action", { chatId, card: agents.cardFor(b, "running") });
          let r;
          try {
            r = await agents.execute(b, {
              root,
              memoryTarget,
              isSelf,
              confirm: (title, detail, extra) =>
                askConfirm(win, chatId, title, detail, extra && extra.preview),
            });
          } catch (e) {
            r = { ok: false, error: String(e.message || e).slice(0, 160) };
          }
          if (b.kind === "edit" && r.ok) editsMade = true;
          safeSend(win, "chat:action", {
            chatId,
            card: { ...agents.cardFor(b, r.ok ? "ok" : "fail"), detail: String(r.error || r.text || "").slice(0, 400) },
          });
          results.push({ block: b, r });
        }
        if (signal && signal.aborted) break;
        if (!results.length) break;

        // Результат — новое системное сообщение для модели
        const sysText = agents.formatResults(results);
        chat.messages.push({ role: "user", content: sysText, at: Date.now(), system: true });
        store.saveChat(chat);
        safeSend(win, "chat:iter", { chatId });
        emit.status({ text: "Продолжаю работу с учётом результатов инструментов…" });

        // Следующий ход модели
        let res2;
        if (mode === "code" && judgeModel) {
          // в код-режиме продолжает СУДЬЯ (сильная модель)
          res2 = await runRequest(providers[judgeModel.providerId], {
            model: judgeModel.id,
            messages: buildProviderMessages(chat.messages),
            signal,
            onToken: (t) => emit.token(t),
            onStatus: (st) => emit.status(st),
          });
        } else {
          res2 = await runRequest(provider, {
            model: modelId,
            messages: buildProviderMessages(chat.messages),
            signal,
            chatId: chat.remoteId || undefined,
            onToken: (t) => emit.token(t),
            onStatus: (st) => emit.status(st),
          });
        }
        if (!res2.ok) {
          if (res2.aborted) break;
          emit.status({ text: "Инструменты выполнены, но повторный запрос не удался: " + String(res2.message || "").slice(0, 120) });
          break;
        }
        finalText = res2.text;
      }

      /* Финал */
      const displayText = agents.stripBlocks(finalText).trim() || finalText.trim();
      chat.messages.push({
        role: "assistant", content: displayText, at: Date.now(),
        council: councilMembers || undefined,
      });
      store.saveChat(chat);
      emit.done({
        text: displayText,
        attempts: 1,
        migratedFrom: null,
        chatId, providerId, modelId,
        codeMode: mode === "code",
        council: councilMembers || undefined,
        editsMade,
        isSelf,
      });
      return chat;
    } finally {
      // ВСЕ инкогнито-окна закрываются после каждого промта
      browserSvc.closeAll();
      stopControllers.delete(chatId);
    }
  } catch (err) {
    browserSvc.closeAll();
    stopControllers.delete(chatId);
    emit.error({ code: "engine", message: String(err.message || err).slice(0, 300), retryable: true });
    return chat;
  }
}

/* ============================================================
   АВТО-МИГРАЦИЯ ЧАТА (лимит наполнен)
   ============================================================ */
async function migrateChat(win, chat, provider, signal) {
  const st = (text) => safeSend(win, "chat:status", { chatId: chat.id, text });

  st("Перенос 1/4: создаю новый чат" + (provider.id === "arena" ? " на сайте Арены" : "") + "…");
  let remoteId = null;
  try {
    const remote = await provider.createChat({ model: chat.model });
    remoteId = (remote && remote.id) || null;
  } catch { /* локальный режим */ }

  const next = store.newChat({
    provider: chat.provider,
    model: chat.model,
    title: chat.title,
    remoteId,
  });
  next.project = chat.project || null;
  next.messages.push({
    role: "system",
    content: "Это продолжение предыдущего разговора. Ниже — краткая история для контекста:\n" + buildSummary(chat.messages),
    at: Date.now(),
  });

  st("Перенос 2/4: проверяю, что новый чат работает (тестовый запрос)…");
  const probe = await runRequest(provider, {
    model: chat.model,
    messages: [...next.messages, { role: "user", content: "Подтверди одним словом, что готов продолжить наш разговор." }],
    signal,
    chatId: next.remoteId || undefined,
    maxAttempts: 3,
    onToken: () => {},
    onStatus: () => {},
  });
  if (!probe.ok) {
    store.archiveChat(next);
    throw new Error("новый чат не отвечает: " + (probe.message || "ошибка"));
  }

  st("Перенос 3/4: копирую историю в новый чат…");
  next.messages.push(...chat.messages);

  st("Перенос 4/4: новый чат работает — удаляю старый…");
  try { await provider.deleteChat(chat); } catch { /* best-effort */ }
  store.archiveChat(chat);
  store.saveChat(next);
  return next;
}

function safeSend(win, channel, payload) {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  } catch { /* окно закрывается — не критично */ }
}

module.exports = { sendChat, stopChat, confirmReply, providers, MAX_ATTEMPTS, AGENT_MAX_ITER };
