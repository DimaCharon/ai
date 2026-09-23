/* ============================================================
   arena.js — Arena AI (lmarena.ai) через сессионную куку
   ------------------------------------------------------------
   HOW IT WORKS
   1. Пользователь копирует сессионную куку из браузера
      (F12 → Network → любой запрос к lmarena.ai → заголовок
      Cookie) и вставляет в Настройки → «Обновить сессию».
   2. Приложение ходит на веб-эндпоинты АРЕНЫ от имени этой
      сессии: смотрит список AI-агентов и ПРЕДЛАГАЕТ их в
      селекторе моделей, создаёт РЕАЛЬНЫЕ чаты на сайте,
      шлёт туда сообщения, ведёт счётчик лимита.
   3. Когда чат наполнен до лимита — движок САМ создаёт новый
      чат, копирует туда историю, проверяет, что новый чат
      отвечает, и только потом удаляет старый (см. engine.js).

   ⚠️ КОНФИГУРАЦИЯ ЭНДПОИНТОВ
   Arena не имеет публичного API — ниже пути её ВЕБ-эндпоинтов.
   Если сайт изменит API, диагностическое окно укажет, какой
   именно шаг сломался, и достаточно поправить константу
   ARENA_CFG.endpoints (один блок).
   ============================================================ */
"use strict";

const { Provider, ProviderError } = require("./base");
const { parseSSE } = require("./sse");
const store = require("../store");

const ARENA_CFG = {
  baseUrl: "https://lmarena.ai",
  endpoints: {
    home: "/",               // GET    — проверка сессии (редирект на логин = сессия истекла)
    agents: "/api/agents",   // GET    — список AI-агентов/моделей Арены
    chatNew: "/api/chat",    // POST   { model } → { chatId } — создать реальный чат
    chatSend: "/api/chat/stream", // POST { chatId, model, history, message } → SSE-ответ
    chatDel: "/api/chat",    // DELETE { chatId } — удалить старый чат
  },
  // Если эндпоинт агентов недоступен — предлагаем этот список
  // (реальные названия моделей Арены).
  fallbackAgents: [
    "Claude Opus 5", "Claude Sonnet 5", "GPT-5",
    "Gemini 3 Pro", "DeepSeek V4", "Grok 4",
  ],
  timeoutMs: 25000,
};

class Arena extends Provider {
  id = "arena";
  name = "Arena AI";
  limit = 30; // переопределяется из настроек

  get realLimit() {
    return Math.max(4, Number(store.getSettings().arenaLimit) || 30);
  }

  get cookie() {
    return (store.getSettings().keys.arenaCookie || "").trim();
  }

  headers() {
    return {
      Cookie: this.cookie,
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    };
  }

  /* ---------- кэш агентов (10 минут) ---------- */
  _agentCache = null; // { at, agents }

  /**
   * Проверка сессии. Бросает ProviderError с русским текстом:
   *  - no_cookie        — кука не введена
   *  - session_expired  — кука истекла/недействительна
   *  - network          — сеть недоступна
   */
  async check() {
    if (!this.cookie) {
      throw new ProviderError(
        "no_cookie",
        "Нет сессии Arena AI. Откройте lmarena.ai в браузере, войдите, затем F12 → Network → любой запрос → скопируйте заголовок Cookie и вставьте его в Настройки (⚙) → «Обновить сессию»."
      );
    }
    let r;
    try {
      r = await fetch(ARENA_CFG.baseUrl + ARENA_CFG.endpoints.home, {
        headers: { Cookie: this.cookie }, // без Content-Type — простой GET
        redirect: "manual",
        signal: AbortSignal.timeout(ARENA_CFG.timeoutMs),
      });
    } catch (e) {
      throw new ProviderError("network", "Arena AI недоступна: " + String(e.message || e).slice(0, 120) + ". Проверь интернет и попробуй ещё раз.");
    }
    const loc = r.headers.get("location") || "";
    if ([401, 403].includes(r.status) || (r.status >= 300 && r.status < 400 && /login|signin|auth/i.test(loc))) {
      throw new ProviderError(
        "session_expired",
        "Истекла сессия Arena AI: кука недействительна или закончилась. Открой lmarena.ai в браузере, войди заново и нажми «Обновить сессию» в Настройках."
      );
    }
    if (r.status >= 500) throw new Error("Arena AI: сервер отвечает ошибкой " + r.status);
    return { ok: true, status: r.status };
  }

  /**
   * Список AI-агентов Арены — приложение показывает их в
   * селекторе моделей (группа «Arena AI · агенты»).
   */
  async listAgents() {
    if (this._agentCache && Date.now() - this._agentCache.at < 10 * 60 * 1000) {
      return this._agentCache.agents;
    }
    let agents = null;
    // 1) пробуем API-эндпоинт
    try {
      const r = await fetch(ARENA_CFG.baseUrl + ARENA_CFG.endpoints.agents, {
        headers: this.headers(),
        signal: AbortSignal.timeout(ARENA_CFG.timeoutMs),
      });
      if (r.ok) {
        const j = await r.json();
        const arr = Array.isArray(j) ? j : j.agents || j.data || j.models || [];
        if (arr.length) {
          agents = arr.map((a, i) =>
            typeof a === "string"
              ? { id: slugify(a), name: a }
              : { id: a.id || a.modelId || slugify(a.name) + i, name: a.name || a.model || a.title || "agent-" + i }
          );
        }
      }
    } catch { /* переходим к следующему источнику */ }
    // 2) пробуем найти модели в HTML главной (JSON-конфиг фронтенда)
    if (!agents) {
      try {
        const r = await fetch(ARENA_CFG.baseUrl + ARENA_CFG.endpoints.home, {
          headers: { Cookie: this.cookie },
          signal: AbortSignal.timeout(ARENA_CFG.timeoutMs),
        });
        const html = await r.text();
        const names = new Set();
        for (const m of ARENA_CFG.fallbackAgents) {
          if (html.toLowerCase().includes(m.toLowerCase())) names.add(m);
        }
        if (names.size) agents = [...names].map((n) => ({ id: slugify(n), name: n }));
      } catch { /* не критично */ }
    }
    // 3) запасной список
    if (!agents) agents = ARENA_CFG.fallbackAgents.map((n) => ({ id: slugify(n), name: n }));

    this._agentCache = { at: Date.now(), agents };
    return agents;
  }

  /** Модели Арены = её AI-агенты (и их предлагает приложение). */
  async listModels() {
    return this.listAgents();
  }

  /** Создать РЕАЛЬНЫЙ чат на сайте Арены. */
  async createChat({ model }) {
    const r = await fetch(ARENA_CFG.baseUrl + ARENA_CFG.endpoints.chatNew, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(ARENA_CFG.timeoutMs),
    });
    if (!r.ok) {
      // Не фатально: продолжаем в «локальном» режиме (чат живёт у нас)
      return { id: null, note: "HTTP " + r.status };
    }
    try {
      const j = await r.json();
      const id = j.chatId || j.id || (j.data && (j.data.chatId || j.data.id)) || null;
      return { id };
    } catch {
      return { id: null };
    }
  }

  /** Отправить сообщение в реальный чат Арины (стрим ответа). */
  async *streamChat({ model, messages, signal, chatId }) {
    const last = [...messages].reverse().find((m) => m.role === "user");
    const history = messages
      .filter((m) => m.role !== "system")
      .slice(-24)
      .map((m) => ({ role: m.role, content: m.content }));
    const r = await fetch(ARENA_CFG.baseUrl + ARENA_CFG.endpoints.chatSend, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ chatId: chatId || null, model, message: last ? last.content : "", history }),
      signal,
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 220);
      if (r.status === 401 || r.status === 403) {
        throw new ProviderError("session_expired", "Arena AI: сессия прервана во время запроса (HTTP " + r.status + "). Нажми «Переподключиться» или обнови куку в Настройках.");
      }
      if (r.status === 429) throw new Error("429: Arena AI — превышен лимит запросов");
      throw new Error("Arena AI: HTTP " + r.status + " — " + body);
    }
    yield* parseSSE(r, "Arena AI");
  }

  /** Удалить старый чат на сайте (best-effort — после переноса). */
  async deleteChat(chat) {
    if (!chat || !chat.remoteId) return;
    try {
      await fetch(ARENA_CFG.baseUrl + ARENA_CFG.endpoints.chatDel, {
        method: "DELETE",
        headers: this.headers(),
        body: JSON.stringify({ chatId: chat.remoteId }),
        signal: AbortSignal.timeout(15000),
      });
    } catch { /* старый чат удалится у нас локально в любом случае */ }
  }
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

module.exports = { Arena, ARENA_CFG };
