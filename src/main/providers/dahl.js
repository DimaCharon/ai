/* ============================================================
   dahl.js — кастомные модели inference.dahl.global
   ------------------------------------------------------------
   Endpoint: https://inference.dahl.global/v1/chat/completions
   Авторизация: Bearer <ключ> (ключ вводится пользователем).
   Список моделей фиксирован (из ТЗ):
     • deepseek-ai/DeepSeek-V4-Flash-0731
     • MiniMaxAI/MiniMax-M2.7
     • zai-org/GLM-5.3-Flash

   Анти-«terminated» (соединение рвётся из РФ/оператором/VPN):
     • Connection: close — всегда свежее TLS-соединение
       (не трогаем пул, где могут жить «протухшие» сокеты);
     • check() — живая диагностика GET /v1/models:
       401 → «ключ не принят» сразу, без 10 пустых попыток;
       сеть не отвечает → понятное сообщение про VPN;
     • FALLBACK: если SSE-поток оборвался ДО первого токена —
       повторяем тот же запрос с stream:false (единый JSON-ответ
       переживает обрывы надёжнее длинного стрима).
   ============================================================ */
"use strict";

const { Provider, ProviderError } = require("./base");
const store = require("../store");
const { parseSSE } = require("./sse");

const NET_HINT =
  "Соединение с dahl.global рвётся («terminated»): обычно это оператор, " +
  "VPN или прокси. Попробуй включить/сменить VPN, или другой провайдер, " +
  "или нажми «Переподключиться».";

class Dahl extends Provider {
  id = "dahl";
  name = "dahl.global";
  base = "https://inference.dahl.global/v1";
  limit = 100;

  static MODELS = [
    { id: "deepseek-ai/DeepSeek-V4-Flash-0731", name: "DeepSeek-V4-Flash-0731" },
    { id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax-M2.7" },
    { id: "zai-org/GLM-5.3-Flash", name: "GLM-5.3-Flash" },
  ];

  get key() {
    // если пользователь вставил ключ с префиксом «Bearer …» — срезаем
    let k = (store.getSettings().keys.dahl || "").trim();
    k = k.replace(/^bearer\s+/i, "").trim();
    return k;
  }

  headers() {
    return {
      Authorization: "Bearer " + this.key,
      "Content-Type": "application/json",
      // свежее соединение на каждый запрос — исключаем «протухшие» сокет-пулы
      Connection: "close",
    };
  }

  /** Быстрый HTTP-статус с таймаутом. */
  async httpStatus(path, timeoutMs) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      const r = await fetch(this.base + path, { headers: this.headers(), signal: c.signal });
      return r.status;
    } finally {
      clearTimeout(t);
    }
  }

  async check() {
    if (!this.key) {
      throw new ProviderError(
        "no_key",
        "Нет ключа dahl.global. Откройте Настройки (⚙) и вставьте API-ключ для inference.dahl.global."
      );
    }
    // Живая диагностика: сервер доступен из этой сети? Ключ валиден?
    try {
      const st = await this.httpStatus("/models", 12000);
      if (st === 401 || st === 403) {
        throw new ProviderError(
          "no_key",
          "dahl.global: ключ не принят (HTTP " + st + "). Проверь ключ в Настройках."
        );
      }
    } catch (e) {
      if (e && e.providerError) throw e;
      throw new ProviderError("network", NET_HINT);
    }
  }

  /** Живой список моделей (GET /v1/models). Dahl периодически
   *  убирает/добавляет модели — показываем актуальный список;
   *  если сеть не отвечает — запасной список из ТЗ. */
  async listModels() {
    if (this.key) {
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 10000);
        const r = await fetch(this.base + "/models", { headers: this.headers(), signal: c.signal });
        clearTimeout(t);
        if (r.ok) {
          const j = await r.json();
          const arr = (j.data || [])
            .map((m) => ({ id: m.id, name: m.id }))
            .sort((a, b) => a.name.localeCompare(b.name));
          if (arr.length) return arr;
        }
      } catch { /* оффлайн — запасной список */ }
    }
    return Dahl.MODELS;
  }

  /** Разбор ответа (HTTP-статусы одинаковы для stream и non-stream). */
  async handleHttpError(r) {
    const body = (await r.text().catch(() => "")).slice(0, 300);
    if (r.status === 401) throw new ProviderError("no_key", "dahl.global: ключ не принят (401). Проверь ключ в Настройках.");
    if (r.status === 429) throw new Error("429: превышен лимит запросов dahl.global");
    // Модель на техобслуживании — повторять бессмысленно, говорим честно
    if (/maintenance|model_maintenance/i.test(body) || /maintenance/i.test(body)) {
      const e = new ProviderError("maintenance",
        "Модель сейчас на техобслуживании у dahl.global (сервер: до 24 часов). " +
        "Выбери другую модель: DeepSeek-V4-Flash-0731 или MiniMax-M2.7. " +
        "Детали от сервера: " + body.slice(0, 160));
      e.noRetry = true;
      throw e;
    }
    throw new Error("dahl.global: HTTP " + r.status + " — " + body);
  }

  async *streamChat({ model, messages, signal }) {
    const h = this.headers();

    /* --- 1) основной запрос: SSE-стрим --- */
    let gotToken = false;
    try {
      const r = await fetch(this.base + "/chat/completions", {
        method: "POST",
        headers: h,
        body: JSON.stringify({ model, messages, stream: true }),
        signal,
      });
      if (!r.ok) await this.handleHttpError(r);
      for await (const ev of parseSSE(r, this.name)) {
        gotToken = true;
        yield ev;
      }
      return;
    } catch (err) {
      if (gotToken) throw err; // ответ уже начал печататься — движок соберёт заново
      if (signal && signal.aborted) throw err; // таймаут/«Стоп» — не ковыряемся

      /* --- 2) FALLBACK: поток оборвался до первого токена →
             повторяем с stream:false (один JSON, без длинного стрима) --- */
      const r2 = await fetch(this.base + "/chat/completions", {
        method: "POST",
        headers: h,
        body: JSON.stringify({ model, messages, stream: false }),
        signal,
      });
      if (!r2.ok) await this.handleHttpError(r2);
      const j = await r2.json();
      const text =
        (j.choices && j.choices[0] && j.choices[0].message?.content) || "";
      if (!text) throw err; // нет текста — отдаём исходную ошибку, она точнее
      yield { type: "token", text };
      return;
    }
  }
}

module.exports = { Dahl };
