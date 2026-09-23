/* ============================================================
   arena.js — Arena AI (arena.ai) через сессионную куку браузера
   ------------------------------------------------------------
   HOW IT WORKS
   1. LMArena переехала: lmarena.ai теперь 301 → arena.ai.
      Реальный сайт пользователя: https://arena.ai/agent.
   2. Пользователь копирует сессионную куку из браузера:
      arena.ai → F12 → Network → любой запрос → Request Headers
      → строка «cookie:» → скопировать ВСЁ значение целиком
      (важно: через Network, а не document.cookie — там нет
      HttpOnly-кук, включая __cf_clearance Cloudflare).
      Вставляет в Настройки (⚙) → «Сохранить» → «Обновить сессию».
   3. Приложение ходит на веб-эндпоинты АРЕНЫ от имени этой сессии:
      • GET  /api/me — проверка сессии (200 = активна, 401 = истекла);
      • POST /nextjs-api/stream/create-chat — создать/продолжить
        чат (ответ — SSE-стрим токенов).
   4. Когда чат наполнен до лимита — движок САМ создаёт новый
      чат, копирует туда историю, проверяет, что новый отвечает,
      и только потом удаляет старый (см. engine.js).

   ⚠️ ОГРАНИЧЕНИЯ (честно)
   • Публичного API нет — это веб-эндпоинты фронтенда, сайт может
     их поменять. Конфиг — в одном блоке ARENA_CFG.
   • Сайт добавляет reCAPTCHA v2 на отправку сообщений. Сервер
     проверяет АВТОРИЗАЦИЮ первой; если после валидной куки
     придёт требование CAPTCHA — приложение честно скажет, что
     без браузера это не обойти, и предложит другой провайдер.
   ============================================================ */
"use strict";

const crypto = require("crypto");
const { Provider, ProviderError } = require("./base");
const { parseSSE } = require("./sse");
const store = require("../store");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const ARENA_CFG = {
  baseUrl: "https://arena.ai", // lmarena.ai → 301 сюда
  endpoints: {
    me: "/api/me",                          // GET  — проверка сессии
    send: "/nextjs-api/stream/create-chat", // POST — создать/продолжить чат (SSE)
    // догадки для списка агентов (если сайт отдаёт — подхватим):
    agentsGuesses: ["/api/agents", "/api/models", "/api/v2/models"],
  },
  // Если список агентов недоступен — предлагаем известные фронт-модели.
  fallbackAgents: [
    "GPT-5", "Claude Sonnet 5", "Claude Opus 5",
    "Gemini 3 Pro", "Grok 4", "DeepSeek V4",
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
      Accept: "application/json, text/event-stream",
      "User-Agent": UA,
    };
  }

  /* ---------- кэш агентов (10 минут) ---------- */
  _agentCache = null; // { at, agents }

  /**
   * Проверка сессии: GET /api/me.
   *  200 + user → активна (возвращаем имя пользователя);
   *  401        → кука недействительна/истекла;
   *  403        → кука неполная (нет __cf_clearance и т.п.).
   */
  async check() {
    if (!this.cookie) {
      throw new ProviderError(
        "no_cookie",
        "Нет сессии Arena AI. Открой arena.ai в браузере (войди), затем F12 → Network → " +
        "перезагрузи → любой запрос к arena.ai → Request Headers → скопируй ВСЁ значение " +
        "строки «cookie:» и вставь в Настройки (⚙) → нажми «Сохранить» → «Обновить сессию»."
      );
    }
    let r;
    try {
      r = await fetch(ARENA_CFG.baseUrl + ARENA_CFG.endpoints.me, {
        headers: { Cookie: this.cookie, Accept: "application/json", "User-Agent": UA },
        redirect: "manual",
        signal: AbortSignal.timeout(ARENA_CFG.timeoutMs),
      });
    } catch (e) {
      throw new ProviderError(
        "network",
        "Arena AI (arena.ai) недоступна из твоей сети: " + String(e.message || e).slice(0, 120) +
        ". Проверь интернет/VPN и попробуй ещё раз."
      );
    }
    if (r.status === 401) {
      throw new ProviderError(
        "session_expired",
        "Сессия Arena AI недействительна (HTTP 401). Открой arena.ai в браузере, убедись, " +
        "что ты вошёл, затем заново скопируй куку (F12 → Network → Request Headers → cookie) " +
        "и нажми «Сохранить» → «Обновить сессию»."
      );
    }
    if (r.status === 403) {
      throw new ProviderError(
        "session_expired",
        "Arena вернула 403: кука, скорее всего, неполная (не хватает куки Cloudflare " +
        "__cf_clearance). Копируй куку только через F12 → Network (не из document.cookie — " +
        "там её нет), затем «Сохранить» → «Обновить сессию»."
      );
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location") || "";
      throw new ProviderError(
        "session_expired",
        "Arena уводит сессию на другую страницу (" + (loc || "редирект") + ") — кука истекла. " +
        "Войди заново в браузере и скопируй куку ещё раз."
      );
    }
    if (r.status >= 500) throw new Error("Arena AI: сервер отвечает ошибкой " + r.status);

    // 200 — достаём имя пользователя для статуса
    let username = null;
    try {
      const j = await r.json();
      username = (j.user && (j.user.username || j.user.name || j.user.email)) || null;
    } catch { /* не критично */ }
    return { ok: true, status: r.status, username };
  }

  /**
   * Список AI-агентов/моделей Арены для селектора.
   * 1) пробуем вероятные API-эндпоинты (если отдадут — используем);
   * 2) иначе — известный список фронт-моделей (Arena сама роутит).
   */
  async listAgents() {
    if (this._agentCache && Date.now() - this._agentCache.at < 10 * 60 * 1000) {
      return this._agentCache.agents;
    }
    let agents = null;
    for (const p of ARENA_CFG.endpoints.agentsGuesses) {
      try {
        const r = await fetch(ARENA_CFG.baseUrl + p, {
          headers: this.headers(),
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) continue;
        const ct = r.headers.get("content-type") || "";
        if (!ct.includes("json")) continue;
        const j = await r.json();
        const arr = Array.isArray(j) ? j : j.agents || j.models || j.data || [];
        if (arr.length) {
          agents = arr.map((a, i) =>
            typeof a === "string"
              ? { id: slugify(a), name: a }
              : { id: a.id || a.modelId || a.slug || slugify(a.name || a.model || "") + "-" + i,
                  name: a.name || a.model || a.title || "agent-" + i }
          );
          break;
        }
      } catch { /* пробуем следующий */ }
    }
    if (!agents) agents = ARENA_CFG.fallbackAgents.map((n) => ({ id: slugify(n), name: n }));

    this._agentCache = { at: Date.now(), agents };
    return agents;
  }

  /** Модели Арены = её AI-агенты (их и предлагаем в селекторе). */
  async listModels() {
    return this.listAgents();
  }

  /**
   * «Реальный чат» Арены создаётся первым сообщением (эндпоинт
   * create-chat). Локальный id чата для нас — store; серверный id
   * не нужен для отправки, поэтому createChat — best-effort no-op.
   */
  async createChat({ model }) {
    return { id: null };
  }

  /** Отправить сообщение в чат Арены (SSE-стрим ответа). */
  async *streamChat({ model, messages, signal, chatId }) {
    const last = [...messages].reverse().find((m) => m.role === "user");
    if (!last) throw new Error("Нет пользовательского сообщения для отправки");

    const body = {
      source: "agentic_chat_submit",
      message: {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ text: String(last.content) }],
        metadata: { manifestNodeId: null },
      },
    };
    if (chatId) body.chatId = chatId;   // если сервер примет — продолжим именно этот чат
    if (model) body.model = model;      // если сервер примет — маршрутизирует по модели

    let r;
    try {
      r = await fetch(ARENA_CFG.baseUrl + ARENA_CFG.endpoints.send, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      throw new Error("Arena AI: соединение обрывается (сеть/VPN) — переподключаюсь");
    }

    if (!r.ok) {
      const t = (await r.text().catch(() => "")).slice(0, 300);
      if (r.status === 401) {
        throw new ProviderError(
          "session_expired",
          "Arena AI: сессия прервана во время запроса (401). Скопируй куку заново в " +
          "Настройках → «Обновить сессию», затем «Переподключиться»."
        );
      }
      if (/captcha|recaptcha/i.test(t)) {
        throw new ProviderError(
          "captcha",
          "Arena требует reCAPTCHA на отправку сообщений — без браузера это не обойти " +
          "(защита сайта от ботов). Варианты: 1) войди заново в браузере и скопируй куку " +
          "ещё раз; 2) используй dahl.global или OpenRouter для этого запроса."
        );
      }
      if (r.status === 403) {
        throw new ProviderError(
          "session_expired",
          "Arena AI: HTTP 403 (доступ запрещён). Кука, возможно, неполная — скопируй её " +
          "заново через F12 → Network. Подробности: " + t
        );
      }
      if (r.status === 429) throw new Error("429: Arena AI — превышен лимит запросов");
      throw new Error("Arena AI: HTTP " + r.status + " — " + t);
    }

    yield* parseSSE(r, "Arena AI");
  }

  /** Удалить старый чат на сайте (best-effort — после переноса). */
  async deleteChat(chat) {
    // Публичного DELETE-эндпоинта нет — локальный архив (engine.js) и есть удаление.
    void chat;
  }
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

module.exports = { Arena, ARENA_CFG };
