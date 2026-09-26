/* ============================================================
   council.js — CODE-РЕЖИМ: «совет» сильных моделей
   ------------------------------------------------------------
   Одна задача → несколько самых мощных БЕСПЛАТНЫХ моделей
   думают параллельно → судья (самая сильная) сводит их ответы
   в ОДИН итоговый вывод.

   Как работает:
     1. Для каждой модели совета делаем ОДИН запрос (stream:false,
        собираем полный текст) — параллельно, Promise.allSettled.
     2. Судья получает: исходную задачу + все ответы моделей и
        выдаёт единый финальный ответ (стримится в чат).
     3. Возвращаем { finalText, members:[{id,name,text,ok}] }.

   Модели совета — free-модели xkiro (там самые сильные бесплатные).
   Состав выбирается динамически из живого списка: берём тех, кто
   есть из списка приоритета, иначе — первые N доступных free.
   ============================================================ */
"use strict";

const { ProviderError } = require("./providers/base");

/** Приоритетный состав совета (code-ориентированные + сильные). */
const COUNCIL_PRIORITY = [
  "qwen/qwen3-coder-plus:free",
  "deepseek/deepseek-v4.1-flash:free",
  "minimax/minimax-m3:free",
  "qwen/qwen3.8-max:free",
  "qwen/qwen3-max:free",
  "mistralai/mistral-large-2512",
];
const DEFAULT_SIZE = 4;      // сколько моделей в совете
const JUDGE_ID = "qwen/qwen3.8-max:free"; // судья (сильная, есть в free)

/**
 * Выбрать состав совета по живому free-списку xkiro.
 * @param {Array<{id:string}>} freeModels живой список
 * @returns {string[]} id моделей совета (N штук)
 */
function pickCouncil(freeModels, size = DEFAULT_SIZE) {
  const ids = new Set(freeModels.map((m) => m.id));
  const chosen = COUNCIL_PRIORITY.filter((id) => ids.has(id));
  if (chosen.length >= Math.min(size, ids.size)) return chosen.slice(0, size);
  // добираем из живого списка, чего не хватает
  for (const m of freeModels) {
    if (chosen.length >= size) break;
    if (!chosen.includes(m.id)) chosen.push(m.id);
  }
  return chosen.slice(0, Math.max(2, size));
}

/**
 * Одиночный запрос модели → полный текст (без стрима в чат).
 * Использует streamChat провайдера, но просто собираем токены.
 */
async function askOne(provider, model, messages, signal) {
  let full = "";
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), 120000); // 2 мин на одну модель
  try {
    for await (const ev of provider.streamChat({ model, messages, signal: controller.signal })) {
      if (ev.type === "token") full += ev.text;
    }
    if (!full.trim()) throw new Error("Пустой ответ");
    return { text: full, ok: true };
  } catch (e) {
    return { text: "", ok: false, error: String(e.message || e).slice(0, 160) };
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * CODE-РЕЖИМ: совет моделей → 1 вывод.
 * @param {object} provider xkiro-провайдер (должен быть с ключом)
 * @param {object} opts { messages, signal, onStatus, onToken, onCouncil }
 * @returns {Promise<{finalText:string, members:Array}>}
 */
async function runCouncil(provider, { messages, signal, onStatus, onToken, onCouncil }) {
  const emitStatus = (text) => onStatus && onStatus({ text });

  if (!provider.key) {
    throw new ProviderError("no_key",
      "Code-режиму нужен ключ XRouter (xkiro.com). Вставь XTROUTER_API_KEY в Настройки (⚙) → «Сохранить».");
  }

  // Живой состав совета
  let freeModels = [];
  try { freeModels = await provider.listModels(); } catch { /* оффлайн — пустой */ }
  const council = pickCouncil(freeModels);
  if (council.length < 2) {
    throw new ProviderError("council",
      "Не удалось собрать совет: доступно мало бесплатных моделей xkiro (нужно ≥2). Проверь ключ XRouter.");
  }

  const names = council.map((id) => id.split("/").pop().replace(":free", ""));
  emitStatus(`Code-режим: думаю вместе ${council.length} моделей (${names.join(", ")})…`);

  // 1) совет думает параллельно
  const results = await Promise.allSettled(
    council.map((id, i) =>
      askOne(provider, id, messages, signal).then((r) => ({ id, name: names[i], ...r }))
    )
  );
  const members = results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { id: council[i], name: names[i], ok: false, text: "", error: "сбой" }
  );
  const okCount = members.filter((m) => m.ok).length;
  if (okCount === 0) {
    throw new Error("Code-режим: ни одна модель совета не ответила. " +
      members.map((m) => m.error).filter(Boolean).slice(0, 2).join(" | "));
  }
  emitStatus(`Code-режим: собрано ответов ${okCount}/${council.length} — свожу в один вывод…`);
  onCouncil && onCouncil(members);

  // 2) судья сводит в единый ответ
  const answers = members.filter((m) => m.ok)
    .map((m, i) => `--- Ответ ${i + 1} (модель: ${m.id}) ---\n${m.text.slice(0, 6000)}`)
    .join("\n\n");
  const judgeMessages = [
    { role: "system", content:
      "Ты — главный рецензент совета из нескольких ИИ-моделей. Тебе дают исходную задачу и " +
      "несколько ответов разных моделей. Твоя задача: внимательно сравнить их, выбрать " +
      "самое правильное и полное решение, объединить лучшие части и отдать ОДИН " +
      "финальный ответ. Если модели разошлись — реши сам, опираясь на корректность. " +
      "Ответь ТОЛЬКО финальным решением, без «модель 1 сказала…». На языке пользователя." },
    { role: "user", content:
      `Исходная задача:\n\n${lastUserText(messages)}\n\n` +
      `Вот ответы моделей совета:\n\n${answers}\n\n` +
      `Дай единый итоговый ответ.` },
  ];

  // судья — стримится в чат (onToken)
  let finalText = "";
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    for await (const ev of provider.streamChat({ model: JUDGE_ID, messages: judgeMessages, signal: controller.signal })) {
      if (ev.type === "token") { finalText += ev.text; onToken && onToken(ev.text); }
    }
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  if (!finalText.trim()) {
    // судья молчит — отдаём лучший из ответов совета как финал
    const best = members.filter((m) => m.ok).sort((a, b) => b.text.length - a.text.length)[0];
    finalText = best ? best.text : "Code-режим не собрал результат.";
  }

  return { finalText, members };
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (Array.isArray(m.content)) {
      // сообщение со скриншотом: content = [{type:'text'}, {type:'image_url'}]
      const parts = m.content.filter((p) => p && p.type === "text").map((p) => p.text).join("\n");
      if (parts) return parts;
    } else if (m.content) {
      return String(m.content);
    }
  }
  return "";
}

module.exports = { runCouncil, pickCouncil, COUNCIL_PRIORITY, DEFAULT_SIZE, JUDGE_ID };
