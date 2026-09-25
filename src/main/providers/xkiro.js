/* ============================================================
   xkiro.js — XRouter (api.xkiro.com), OpenAI-совместимый API
   ------------------------------------------------------------
   • Ключ: XTROUTER_API_KEY (пользователь вводит в Настройках).
   • Список моделей: GET /v1/models — отдаётся даже БЕЗ ключа,
     фильтр access_tier === "free" (иначе цена 0). Список живой:
     при ошибке сети — запасной список из 37 free-моделей.
   • Чат: POST /v1/chat/completions, stream: true (SSE).
   • Анти-«terminated» как у dahl: Connection: close + фолбэк
     на stream:false, если поток рвётся до первого токена.
   ============================================================ */
"use strict";

const { Provider, ProviderError } = require("./base");
const store = require("../store");
const { parseSSE } = require("./sse");

/* Запасной список (access_tier: free, актуально на 23.09.2026).
   Живой список подтягивается с /v1/models, это только фолбэк.
   vision: true — модель видит изображения (скриншоты экрана). */
const FALLBACK_FREE = [
  { id: "deepseek/deepseek-v4.1-flash:free", name: "DeepSeek V4.1 Flash (Free)", vision: true },
  { id: "minimax/minimax-m2:free", name: "MiniMax M2 (Free)" },
  { id: "minimax/minimax-m2.1:free", name: "MiniMax M2.1 (Free)" },
  { id: "minimax/minimax-m2.1-highspeed:free", name: "MiniMax M2.1 Highspeed (Free)" },
  { id: "minimax/minimax-m2.5:free", name: "MiniMax M2.5 (Free)" },
  { id: "minimax/minimax-m2.5-highspeed:free", name: "MiniMax M2.5 Highspeed (Free)" },
  { id: "minimax/minimax-m2.7:free", name: "MiniMax M2.7 (Free)" },
  { id: "minimax/minimax-m2.7-highspeed:free", name: "MiniMax M2.7 Highspeed (Free)" },
  { id: "minimax/minimax-m3:free", name: "MiniMax M3 (Free)", vision: true },
  { id: "mistralai/codestral-2508", name: "Codestral" },
  { id: "mistralai/devstral-medium", name: "Devstral 2" },
  { id: "mistralai/ministral-14b", name: "Ministral 3 14B", vision: true },
  { id: "mistralai/ministral-3b", name: "Ministral 3 3B", vision: true },
  { id: "mistralai/ministral-8b", name: "Ministral 3 8B", vision: true },
  { id: "mistralai/mistral-large-2512", name: "Mistral Large 3", vision: true },
  { id: "mistralai/mistral-medium-3.5", name: "Mistral Medium 3.5", vision: true },
  { id: "mistralai/mistral-small-2603", name: "Mistral Small 4", vision: true },
  { id: "qwen/qwen-plus-2025-07-28:free", name: "Qwen Plus 0728 (Free)", vision: true },
  { id: "qwen/qwen3-coder-plus:free", name: "Qwen3 Coder Plus (Free)", vision: true },
  { id: "qwen/qwen3-max:free", name: "Qwen3 Max (Free)", vision: true },
  { id: "qwen/qwen3-omni-flash:free", name: "Qwen3 Omni Flash (Free)", vision: true },
  { id: "qwen/qwen3-vl-plus:free", name: "Qwen3 VL Plus (Free)", vision: true },
  { id: "qwen/qwen3.5-397b-a17b:free", name: "Qwen3.5 397B A17B (Free)", vision: true },
  { id: "qwen/qwen3.5-flash:free", name: "Qwen3.5 Flash (Free)", vision: true },
  { id: "qwen/qwen3.5-omni-flash:free", name: "Qwen3.5 Omni Flash (Free)", vision: true },
  { id: "qwen/qwen3.5-omni-plus:free", name: "Qwen3.5 Omni Plus (Free)", vision: true },
  { id: "qwen/qwen3.5-plus:free", name: "Qwen3.5 Plus (Free)", vision: true },
  { id: "qwen/qwen3.6-27b:free", name: "Qwen3.6 27B (Free)", vision: true },
  { id: "qwen/qwen3.6-35b-a3b:free", name: "Qwen3.6 35B A3B (Free)", vision: true },
  { id: "qwen/qwen3.6-max-preview:free", name: "Qwen3.6 Max Preview (Free)" },
  { id: "qwen/qwen3.6-plus:free", name: "Qwen3.6 Plus (Free)", vision: true },
  { id: "qwen/qwen3.7-flash:free", name: "Qwen3.7 Flash (Free)", vision: true },
  { id: "qwen/qwen3.7-max:free", name: "Qwen3.7 Max (Free)" },
  { id: "qwen/qwen3.7-plus:free", name: "Qwen3.7 Plus (Free)", vision: true },
  { id: "qwen/qwen3.8-max:free", name: "Qwen3.8 Max (Free)", vision: true },
  { id: "qwen/qwen3.8-omni-flash:free", name: "Qwen3.8 Omni Flash (Free)", vision: true },
  { id: "sensenova/sensenova-6.7-flash-lite", name: "SenseNova 6.7 Flash-Lite", vision: true },
  { id: "sensenova/sensenova-6.8-flash-lite", name: "SenseNova 6.8 Flash-Lite", vision: true },
];

class Xkiro extends Provider {
  id = "xkiro";
  name = "XRouter · xkiro";
  base = "https://api.xkiro.com/v1";
  limit = 100;

  get key() {
    return (store.getSettings().keys.xkiro || "").trim();
  }

  headers(withKey = true) {
    const h = { "Content-Type": "application/json", Connection: "close" };
    if (withKey && this.key) h.Authorization = "Bearer " + this.key;
    return h;
  }

  async check() {
    if (!this.key) {
      throw new ProviderError(
        "no_key",
        "Нет ключа XRouter. Получи XTROUTER_API_KEY на xkiro.com и вставь его в Настройки (⚙) → «Сохранить»."
      );
    }
    // Живая проверка ключа: /v1/models принимает Authorization; 401/403 = плохой ключ
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 12000);
      const r = await fetch(this.base + "/models", { headers: this.headers(), signal: c.signal });
      clearTimeout(t);
      if (r.status === 401 || r.status === 403) {
        throw new ProviderError("no_key", "XRouter: ключ не принят (HTTP " + r.status + "). Проверь XTROUTER_API_KEY в Настройках.");
      }
    } catch (e) {
      if (e && e.providerError) throw e;
      throw new ProviderError(
        "network",
        "XRouter (api.xkiro.com) недоступен из твоей сети: " + String(e.message || e).slice(0, 120) +
        ". Проверь интернет/VPN и попробуй ещё раз."
      );
    }
  }

  /** Живой список только бесплатных моделей (эндпоинт открыт даже без ключа). */
  async listModels() {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 20000);
      const r = await fetch(this.base + "/models", { headers: this.headers(false), signal: c.signal });
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        const arr = (j.data || [])
          .filter((m) => m.access_tier === "free" ||
            (m.pricing && Number(m.pricing.input) === 0 && Number(m.pricing.output) === 0))
          .map((m) => ({
            id: m.id,
            name: m.display_name || m.id,
            free: true,
            vision: !!(m.capabilities && m.capabilities.vision),
          }));
        if (arr.length) {
          this._vision = new Map(arr.map((m) => [m.id, m.vision]));
          return arr.sort((a, b) => a.name.localeCompare(b.name));
        }
      }
    } catch { /* сеть/формат — используем запасной список */ }
    this._vision = new Map(FALLBACK_FREE.map((m) => [m.id, !!m.vision]));
    return FALLBACK_FREE;
  }

  /** Модель видит изображения (скриншоты экрана)? */
  supportsVision(modelId) {
    return this._vision ? this._vision.get(modelId) === true : false;
  }

  async handleHttpError(r, label = "XRouter") {
    const body = (await r.text().catch(() => "")).slice(0, 220);
    if (r.status === 401) throw new ProviderError("no_key", label + ": ключ не принят (401). Проверь XTROUTER_API_KEY в Настройках.");
    if (r.status === 404) throw new Error(label + ": модель не найдена (404) — выбери другую из списка");
    if (r.status === 429) throw new Error("429: превышен лимит запросов XRouter");
    throw new Error(label + ": HTTP " + r.status + " — " + body);
  }

  async *streamChat({ model, messages, signal }) {
    /* --- 1) основной запрос: SSE-стрим --- */
    let gotToken = false;
    try {
      const r = await fetch(this.base + "/chat/completions", {
        method: "POST",
        headers: this.headers(),
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
      if (gotToken) throw err;
      if (signal && signal.aborted) throw err;

      /* --- 2) FALLBACK: поток оборвался до первого токена →
             повторяем с stream:false (один JSON, живуче при обрывах) --- */
      const r2 = await fetch(this.base + "/chat/completions", {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ model, messages, stream: false }),
        signal,
      });
      if (!r2.ok) await this.handleHttpError(r2);
      const j = await r2.json();
      const text = (j.choices && j.choices[0] && j.choices[0].message?.content) || "";
      if (!text) throw err;
      yield { type: "token", text };
      return;
    }
  }
}

module.exports = { Xkiro };
