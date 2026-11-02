/* ============================================================
   council.js — КОД-РЕЖИМ: «совет» САМЫХ ЛУЧШИХ моделей
   ------------------------------------------------------------
   Одна задача → несколько сильнейших моделей думают параллельно
   → судья (лучшая из доступных) сводит их ответы в ОДИН вывод.

   Состав (собирается из того, что реально доступно на этом ПК):
     • XRouter free — топ code-моделей (Qwen3 Coder, DeepSeek V4.1,
       MiniMax M3, Qwen3.8 Max…);
     • dahl.global — если есть ключ: MiniMax M2.7, DeepSeek V4 Flash;
     • OpenRouter — если есть ключ: 2 сильнейших :free из живого списка.
   Судья: MiniMax M2.7 (dahl), если ключ есть, иначе Qwen3.8 Max (free).
   ============================================================ */
"use strict";

const { ProviderError } = require("./providers/base");
const store = require("./store");

/** Приоритетные free-модели XRouter (code-ориентированные + сильные). */
const XKIRO_PRIORITY = [
  "qwen/qwen3-coder-plus:free",
  "deepseek/deepseek-v4.1-flash:free",
  "minimax/minimax-m3:free",
  "qwen/qwen3.8-max:free",
  "qwen/qwen3-max:free",
  "mistralai/mistral-large-2512",
];
/** Модели dahl (по ключу пользователя) — платные, сильные. */
const DAHL_MODELS = [
  "MiniMaxAI/MiniMax-M2.7",
  "deepseek-ai/DeepSeek-V4-Flash-0731",
];
/** Сильные :free OpenRouter — берём первых найденных в живом списке. */
const OR_PRIORITY = [
  "deepseek/deepseek-chat-v3.1:free",
  "deepseek/deepseek-r1:free",
  "qwen/qwen3-coder:free",
  "minimax/minimax-m2:free",
  "meta-llama/llama-4-maverick:free",
  "google/gemini-2.5-flash:free",
  "mistralai/mistral-large-2512:free",
  "anthropic/claude-sonnet-4.5:free",
];
const MAX_MEMBERS = 8; // совет не больше 8 моделей

/**
 * Собрать состав совета из доступных провайдеров/ключей.
 * @param {object} providers реестр {openrouter, dahl, arena, xkiro}
 * @returns {Promise<{members:Array<{providerId,id,name}>, judge:{providerId,id,name}}>}
 */
async function prepare(providers) {
  const s = store.getSettings();
  const members = [];
  const add = (providerId, id, name) => {
    if (!members.some((m) => m.providerId === providerId && m.id === id)) {
      members.push({ providerId, id, name });
    }
  };

  // 1) XRouter free (топ-приоритет по живому списку)
  try {
    const live = await providers.xkiro.listModels();
    const ids = new Set(live.map((m) => m.id));
    const picked = XKIRO_PRIORITY.filter((id) => ids.has(id));
    if (picked.length) {
      for (const id of picked) add("xkiro", id, id.split("/").pop().replace(":free", ""));
    } else if (live.length) {
      for (const m of live.slice(0, 4)) add("xkiro", m.id, m.name);
    }
  } catch { /* оффлайн — добавим по приоритету вслепую */
    for (const id of XKIRO_PRIORITY.slice(0, 4)) add("xkiro", id, id.split("/").pop().replace(":free", ""));
  }

  // 2) dahl (если ключ)
  if (String(s.keys.dahl || "").trim()) {
    for (const id of DAHL_MODELS) add("dahl", id, id.split("/").pop() + " · dahl");
  }

  // 3) OpenRouter free (если ключ) — 2 сильнейших из живого списка
  if (String(s.keys.openrouter || "").trim()) {
    try {
      const live = await providers.openrouter.listModels();
      const ids = new Set(live.map((m) => m.id));
      let got = 0;
      for (const id of OR_PRIORITY) {
        if (got >= 2) break;
        if (ids.has(id)) { add("openrouter", id, id.split("/").pop().replace(":free", "")); got++; }
      }
    } catch { /* сеть — пропускаем */ }
  }

  if (!members.length) {
    throw new ProviderError("council", "Не удалось собрать совет: нет доступных моделей (нужен хотя бы ключ XRouter).");
  }

  // Судья: лучший из доступных
  let judge;
  if (String(s.keys.dahl || "").trim()) {
    judge = { providerId: "dahl", id: DAHL_MODELS[0], name: DAHL_MODELS[0].split("/").pop() };
  } else {
    judge = { providerId: "xkiro", id: "qwen/qwen3.8-max:free", name: "Qwen3.8 Max" };
  }

  return { members: members.slice(0, MAX_MEMBERS), judge };
}

/** Одиночный запрос модели → полный текст (без стрима в чат). */
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
 * КОД-РЕЖИМ: совет лучших моделей → 1 вывод.
 * @param {object} providers реестр провайдеров
 * @param {object} opts { members, judge, messages, signal, onStatus, onToken, onCouncil }
 */
async function runCouncil(providers, { members: inMembers, judge: inJudge, messages, signal, onStatus, onToken, onCouncil }) {
  const emitStatus = (text) => onStatus && onStatus({ text });

  let members = inMembers;
  let judge = inJudge;
  if (!members || !members.length || !judge) {
    const p = await prepare(providers);
    members = p.members;
    judge = p.judge;
  }

  const names = members.map((m) => m.name);
  emitStatus(`Код-режим: думаю вместе ${members.length} лучших моделей (${names.join(", ")})…`);

  // 1) совет думает параллельно
  const results = await Promise.allSettled(
    members.map((m) =>
      askOne(providers[m.providerId], m.id, messages, signal).then((r) => ({
        id: m.id,
        provider: m.providerId,
        name: m.name,
        ...r,
      }))
    )
  );
  const memberList = results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { id: members[i].id, provider: members[i].providerId, name: members[i].name, ok: false, text: "", error: "сбой" }
  );
  const okCount = memberList.filter((m) => m.ok).length;
  if (okCount === 0) {
    throw new Error("Код-режим: ни одна модель совета не ответила. " +
      memberList.map((m) => m.error).filter(Boolean).slice(0, 2).join(" | "));
  }
  emitStatus(`Код-режим: собрано ответов ${okCount}/${members.length} — свожу в один вывод (судья: ${judge.name})…`);
  onCouncil && onCouncil(memberList);

  // 2) судья сводит в единый ответ
  const answers = memberList.filter((m) => m.ok)
    .map((m, i) => `--- Ответ ${i + 1} (модель: ${m.id}, ${m.provider}) ---\n${m.text.slice(0, 6000)}`)
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

  // судья — стримится в чат
  let finalText = "";
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    for await (const ev of providers[judge.providerId].streamChat({ model: judge.id, messages: judgeMessages, signal: controller.signal })) {
      if (ev.type === "token") { finalText += ev.text; onToken && onToken(ev.text); }
    }
  } catch (e) {
    if (signal && signal.aborted) throw e;
    if (!finalText.trim()) throw e;
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  if (!finalText.trim()) {
    // судья молчит — отдаём лучший из ответов совета как финал
    const best = memberList.filter((m) => m.ok).sort((a, b) => b.text.length - a.text.length)[0];
    finalText = best ? best.text : "Код-режим не собрал результат.";
  }

  return { finalText, members: memberList, judge };
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (Array.isArray(m.content)) {
      const parts = m.content.filter((p) => p && p.type === "text").map((p) => p.text).join("\n");
      if (parts) return parts;
    } else if (m.content) {
      return String(m.content);
    }
  }
  return "";
}

module.exports = { runCouncil, prepare, XKIRO_PRIORITY, DAHL_MODELS, OR_PRIORITY, MAX_MEMBERS };
