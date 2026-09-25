/* ============================================================
   base.js — общий интерфейс провайдера
   ------------------------------------------------------------
   Чтобы добавить нового провайдера (бесплатную нейросеть),
   создайте файл в providers/, расширьте Provider и
   зарегистрируйте его в engine.js. UI подхватит его сам.
   ============================================================ */
"use strict";

/** Ошибка провайдера с кодом — main-процесс превратит её
 *  в понятное диагностическое окно на русском. */
class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.providerError = true;
  }
}

class Provider {
  /** @type {string} короткий id (openrouter | dahl | arena | …) */
  id = "base";
  /** @type {string} человекочитаемое имя для UI */
  name = "Базовый провайдер";
  /** @type {number} лимит сообщений на один чат */
  limit = 100;

  /** Проверка доступности (ключ/сессия). Бросает ProviderError
   *  с готовым русским текстом для окна диагностики. */
  async check() {
    throw new ProviderError("not_implemented", "Метод check() не реализован");
  }

  /** Список моделей: [{ id, name, free?, vision? }] */
  async listModels() {
    return [];
  }

  /** Модель умеет видеть изображения (скриншоты)? По умолчанию — нет. */
  supportsVision(modelId) {
    void modelId;
    return false;
  }

  /**
   * Стриминг ответа. Генератор yield-ит события:
   *   { type: 'token', text } — очередной кусок ответа.
   * После генератора считается, что ответ ПОЛНЫЙ.
   * Бросает Error при обрыве — движок сам повторит запрос.
   */
  // eslint-disable-next-line require-yield
  async *streamChat({ model, messages, signal }) {
    throw new ProviderError("not_implemented", "Метод streamChat() не реализован");
  }

  /** Создать «настоящий» чат у провайдера (у Arena — на сайте). */
  async createChat({ model }) {
    return { id: null }; // для API без «чатов» — локальный id достаточно
  }

  /** Удалить чат у провайдера (best-effort). */
  async deleteChat(chat) {
    /* noop */
  }
}

module.exports = { Provider, ProviderError };
