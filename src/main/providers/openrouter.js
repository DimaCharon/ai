/* ============================================================
   openrouter.js — OpenRouter (только БЕСПЛАТНЫЕ модели)
   ------------------------------------------------------------
   • Живой список моделей: GET /api/v1/models, фильтр «:free»
     (или цена = 0). Список обновляется кнопкой «Обновить».
   • Чат: POST /api/v1/chat/completions, stream: true (SSE).
   ============================================================ */
"use strict";

const { Provider, ProviderError } = require("./base");
const { parseSSE } = require("./sse");
const store = require("../store");

class OpenRouter extends Provider {
  id = "openrouter";
  name = "OpenRouter · free";
  base = "https://openrouter.ai/api/v1";
  limit = 100;

  get key() {
    // если пользователь вставил ключ с префиксом «Bearer …» — срезаем
    let k = (store.getSettings().keys.openrouter || "").trim();
    k = k.replace(/^bearer\s+/i, "").trim();
    return k;
  }

  headers() {
    return {
      Authorization: "Bearer " + this.key,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://charon-code.local",
      "X-Title": "Charon Code",
    };
  }

  async check() {
    if (!this.key) {
      throw new ProviderError(
        "no_key",
        "Нет ключа OpenRouter. Откройте Настройки (⚙) и вставьте бесплатный ключ с openrouter.ai/keys — он нужен даже для бесплатных моделей."
      );
    }
  }

  /** Живой список только бесплатных моделей. */
  async listModels() {
    const r = await fetch(this.base + "/models", { headers: this.headers(), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("OpenRouter: HTTP " + r.status);
    const j = await r.json();
    const arr = (j.data || [])
      .filter((m) => m.id.endsWith(":free") || Number(m.pricing && m.pricing.prompt) === 0)
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        free: true,
        vision: !!(m.architecture && (m.architecture.input_modalities || []).includes("image")),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this._vision = new Map(arr.map((m) => [m.id, m.vision]));
    return arr;
  }

  /** Модель видит изображения (скриншоты экрана)? */
  supportsVision(modelId) {
    return this._vision ? this._vision.get(modelId) === true : false;
  }

  async *streamChat({ model, messages, signal }) {
    const r = await fetch(this.base + "/chat/completions", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
    if (!r.ok) {
      const body = (await r.text().catch(() => "")).slice(0, 300);
      if (r.status === 401) throw new ProviderError("no_key", "OpenRouter: ключ не принят (401). Проверь ключ в Настройках.");
      if (r.status === 429) throw new Error("429: превышен лимит запросов OpenRouter");
      if (r.status === 404 && /unavailable for free|not found/i.test(body)) {
        const e = new ProviderError("model_gone",
          "Эта модель убрана из бесплатной линейки OpenRouter (у них часто ротация free-списка). " +
          "Открой «Модели» → группа «OpenRouter · только free» → выбери любую из списка.");
        e.noRetry = true;
        throw e;
      }
      throw new Error("OpenRouter: HTTP " + r.status + " — " + body);
    }
    yield* parseSSE(r, "OpenRouter");
  }
}

module.exports = { OpenRouter };
