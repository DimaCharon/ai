/* ============================================================
   dahl.js — кастомные модели inference.dahl.global
   ------------------------------------------------------------
   Endpoint: https://inference.dahl.global/v1/chat/completions
   Авторизация: Bearer <ключ> (ключ вводится пользователем).
   Список моделей фиксирован (из ТЗ):
     • deepseek-ai/DeepSeek-V4-Flash-0731
     • MiniMaxAI/MiniMax-M2.7
     • zai-org/GLM-5.3-Flash
   ============================================================ */
"use strict";

const { Provider, ProviderError } = require("./base");
const store = require("../store");
const { parseSSE } = require("./sse");

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
    return (store.getSettings().keys.dahl || "").trim();
  }

  headers() {
    return {
      Authorization: "Bearer " + this.key,
      "Content-Type": "application/json",
    };
  }

  async check() {
    if (!this.key) {
      throw new ProviderError(
        "no_key",
        "Нет ключа dahl.global. Откройте Настройки (⚙) и вставьте API-ключ для inference.dahl.global."
      );
    }
  }

  async listModels() {
    return Dahl.MODELS;
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
      if (r.status === 401) throw new ProviderError("no_key", "dahl.global: ключ не принят (401). Проверь ключ в Настройках.");
      if (r.status === 429) throw new Error("429: превышен лимит запросов dahl.global");
      throw new Error("dahl.global: HTTP " + r.status + " — " + body);
    }
    yield* parseSSE(r, "dahl.global");
  }
}

module.exports = { Dahl };
