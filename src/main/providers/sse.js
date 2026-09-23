/* ============================================================
   sse.js — общий разбор SSE-потоков нейросетей
   ------------------------------------------------------------
   Формат: строки «data: {...}», завершение «data: [DONE]».
   Если провайдер ответил обычным JSON (не SSE) — отдаём
   текст одним токеном.
   ============================================================ */
"use strict";

/**
 * @param {Response} response fetch-ответ с потоком
 * @param {string} providerName для сообщений об ошибках
 * @yields {{type:'token', text:string}}
 */
async function* parseSSE(response, providerName = "провайдер") {
  const ct = (response.headers.get("content-type") || "");
  if (ct.includes("application/json")) {
    // Ответ не потоковый — разбираем JSON целиком
    const j = await response.json();
    const text =
      (j.choices && j.choices[0] && (j.choices[0].message?.content || j.choices[0].text)) ||
      (j.data && j.data.content) ||
      "";
    if (!text) throw new Error(providerName + ": пустой ответ");
    yield { type: "token", text };
    return;
  }

  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let gotToken = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const data = line.startsWith("data:") ? line.slice(5).trim() : line;
      if (data === "[DONE]" || data === "done") return;
      if (!data.startsWith("{")) continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Error(providerName + ": " + (j.error.message || "ошибка"));
      const delta =
        (j.choices && j.choices[0] && (j.choices[0].delta?.content ?? j.choices[0].text)) ||
        (j.data && (j.data.content ?? j.data.delta)) ||
        "";
      if (delta) { gotToken = true; yield { type: "token", text: String(delta) }; }
    }
  }
  if (!gotToken) throw new Error("Пустой поток от " + providerName);
}

module.exports = { parseSSE };
