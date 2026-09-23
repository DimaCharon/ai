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
    return (store.getSettings().keys.openrouter || "").trim();
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
    return (j.data || [])
      .filter((m) => m.id.endsWith(":free") || Number(m.pricing && m.pricing.prompt) === 0)
      .map((m) => ({ id: m.id, name: m.name || m.id, free: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async *streamChat({ model, messages, signal }) {
    const r = await fetch(this.base + "/chat/completions", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 220);
      if (r.status === 401) throw new ProviderError("no_key", "OpenRouter: ключ не принят (401). Проверь ключ в Настройках.");
      if (r.status === 429) throw new Error("429: превышен лимит запросов OpenRouter");
      throw new Error("OpenRouter: HTTP " + r.status + " — " + body);
    }
    yield* parseSSE(r, "OpenRouter");
  }
}

module.exports = { OpenRouter };
