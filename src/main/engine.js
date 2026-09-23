/* ============================================================
   engine.js — движок запросов «1 нажатие = 1 гарантированный ответ»
   ------------------------------------------------------------
   • Экспоненциальный backoff + джиттер, до 10 попыток.
   • Если нейросеть тормозит, рвёт соединение или отвечает с
     задержкой — запрос НЕ сбрасывается: мы переподключаемся
     и добираем полный ответ. UI показывает:
     «Ожидание ответа… Попытка 2/10 (Arena AI отвечает с
      задержкой, повторяем запрос)».
   • АУТО-МИГРАЦИЯ ЧАТА: когда чат наполнен до лимита,
     движок САМ:
       1) создаёт новый чат (у Arena — реальный, на сайте);
       2) проверяет, что новый чат отвечает (тестовый запрос);
       3) копирует туда историю;
       4) убедившись, что новый работает — удаляет старый.
   ============================================================ */
"use strict";

const crypto = require("crypto");
const store = require("./store");
const { OpenRouter } = require("./providers/openrouter");
const { Dahl } = require("./providers/dahl");
const { Arena } = require("./providers/arena");
const { ProviderError } = require("./providers/base");

const MAX_ATTEMPTS = 10;
const ATTEMPT_TIMEOUT_MS = 90000; // таймаут одной попытки

/** Реестр провайдеров. Новый провайдер = require + одна строка. */
const providers = {
  openrouter: new OpenRouter(),
  dahl: new Dahl(),
  arena: new Arena(),
};
// у Arena лимит читается из настроек на лету
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
/**
 * @param {object} provider провайдер
 * @param {object} opts { model, messages, signal, maxAttempts,
 *                        onToken(text), onStatus({text, attempt, restart}) }
 * @returns {Promise<{ok:true, text, attempts}|{ok:false, code, message, aborted?}>}
 */
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
    // общая отмена (кнопка «Стоп») + таймаут одной попытки
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
        // ответ уже начал печататься, но оборвался — чистим и собираем заново
        onStatus({ restart: true, text: friendly(err, provider.name) + ". Собираю ответ заново (попытка " + (attempt + 1) + "/" + maxAttempts + ")…" });
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

/* ============================================================
   ЧАТЫ: отправка + авто-миграция
   ============================================================ */
/** Контроллеры отмены: chatId -> AbortController */
const stopControllers = new Map();
function stopChat(chatId) {
  const c = stopControllers.get(chatId);
  if (c) c.abort();
}

/** Краткая история для контекста нового чата. */
function buildSummary(msgs) {
  const fmt = (m) => (m.role === "user" ? "Я: " : "Charon: ") + String(m.content || "").slice(0, 300);
  const first = msgs.slice(0, 2).map(fmt);
  const last = msgs.slice(-6).map(fmt);
  return [...new Set([...first, ...last])].join("\n");
}

/**
 * Полный цикл отправки:
 *  проверка провайдера → чат (новый/существующий) → лимит?
 *  → авто-миграция → запрос движком → сохранение.
 */
async function sendChat(win, payload, signal) {
  const { chatId: inChatId, providerId, modelId, text } = payload;
  const provider = providers[providerId];
  if (!provider) throw new ProviderError("unknown", "Неизвестный провайдер: " + providerId);

  let chatId = inChatId;
  const emit = {
    token: (t) => safeSend(win, "chat:token", { chatId, text: t }),
    status: (s) => safeSend(win, "chat:status", { chatId, ...s }),
    done: (d) => safeSend(win, "chat:done", { chatId, ...d }),
    error: (e) => safeSend(win, "chat:error", { chatId, ...e }),
  };

  /* 1. Доступность провайдера (ключ/сессия) */
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

  /* 2. Чат: существующий или новый */
  let chat = inChatId ? store.getChat(inChatId) : null;
  let createdRemote = false;
  if (!chat) {
    chat = store.newChat({ provider: providerId, model: modelId, title: text.slice(0, 48) });
    chatId = chat.id;
    emit.status({ text: "Новый чат создан (" + provider.name + ")" });
    // У Arena создаём РЕАЛЬНЫЙ чат на сайте
    try {
      const remote = await provider.createChat({ model: modelId });
      if (remote && remote.id) { chat.remoteId = remote.id; createdRemote = true; }
    } catch { /* локальный режим — не фатально */ }
    store.saveChat(chat);
  }
  chat.messages.push({ role: "user", content: text, at: Date.now() });

  /* 3. Лимит чата → авто-миграция (копирую → проверяю → удаляю старый) */
  let migratedFrom = null;
  if (chat.messages.length >= provider.limit) {
    emit.status({ text: `Лимит чата достигнут (${chat.messages.length}/${provider.limit} сообщений) — начинаю перенос: создаю новый чат…` });
    try {
      const next = await migrateChat(win, chat, provider, signal);
      migratedFrom = chat.id;
      chat = next;
      chatId = chat.id;
    } catch (err) {
      if (signal && signal.aborted) return null;
      emit.status({ text: "Перенос не удался (" + String(err.message || err).slice(0, 80) + ") — продолжаю в текущем чате" });
    }
  }

  /* 4. Запрос движком */
  stopControllers.set(chatId, signal);
  const res = await runRequest(provider, {
    model: modelId,
    messages: chat.messages,
    signal,
    chatId: chat.remoteId || undefined,
    onToken: (t) => emit.token(t),
    onStatus: (s) => emit.status(s),
  });
  stopControllers.delete(chatId);

  if (!res.ok) {
    if (res.aborted) { emit.status({ text: "Остановлено пользователем" }); return chat; }
    emit.error({ code: res.code, message: res.message, retryable: true });
    return chat;
  }

  chat.messages.push({ role: "assistant", content: res.text, at: Date.now() });
  store.saveChat(chat);
  emit.done({ text: res.text, attempts: res.attempts, migratedFrom, chatId, providerId, modelId });
  return chat;
}

/**
 * Авто-миграция чата (когда лимит наполнен):
 *   1) новый чат (у Arena — реальный на сайте);
 *   2) проверочный запрос — убеждаемся, что новый чат отвечает;
 *   3) копирование истории;
 *   4) удаление старого (у провайдера + локальный архив).
 */
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
    // новый чат не подтверждён — старый НЕ трогаем
    store.archiveChat(next); // убираем «висячего»
    throw new Error("новый чат не отвечает: " + (probe.message || "ошибка"));
  }

  st("Перенос 3/4: копирую историю в новый чат…");
  next.messages.push(...chat.messages);

  st("Перенос 4/4: новый чат работает — удаляю старый…");
  try { await provider.deleteChat(chat); } catch { /* best-effort */ }
  store.archiveChat(chat); // локально «удаляем» (в архив)
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

module.exports = { sendChat, stopChat, providers, MAX_ATTEMPTS };
