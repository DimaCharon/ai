/* ============================================================
   screen.js — захват экрана (микроскриншоты) для «видения» ИИ
   ------------------------------------------------------------
   Electron desktopCapturer — встроено, без доп. зависимостей.
   Микроскриншот = JPEG с ограничением по наибольшей стороне
   (1280px, качество ~70) → 150–400 КБ, уходит в сообщение как
   image_url (base64 data-URI) — формат понимают OpenAI-
   совместимые API (xkiro, OpenRouter, dahl).

   Честная оговорка: чат-API не смотрят «видео в реальном
   времени». Формат: свежий кадр на каждое сообщение — модель
   видит экран в момент отправки. Live-режим в UI делает
   это автоматически.
   ============================================================ */
"use strict";

const { desktopCapturer } = require("electron");

/** Список экранов (для выбора; по умолчанию — первый/основной). */
async function listScreens() {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 2, height: 2 },
  });
  return sources.map((s, i) => ({
    id: i,
    name: s.name || ("Экран " + (i + 1)),
    width: s.size.width,
    height: s.size.height,
  }));
}

/**
 * Микроскриншот.
 * @param {object} opts { index=0, maxW=1280, quality=70, previewW=320 }
 * @returns {Promise<{ok:true, dataUrl, previewUrl?, width, height, screen}
 *                   |{ok:false, error}>}
 */
async function captureScreen({ index = 0, maxW = 1280, quality = 70, previewW = 320 } = {}) {
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: maxW, height: maxW },
    });
  } catch (e) {
    return { ok: false, error: "Не удалось получить список экранов: " + String(e.message || e).slice(0, 120) };
  }
  if (!sources.length) return { ok: false, error: "Экран не найден" };
  const src = sources[Math.min(index, sources.length - 1)] || sources[0];

  let img;
  try {
    img = await src.getThumbnail();
  } catch (e) {
    return { ok: false, error: "Сбой захвата: " + String(e.message || e).slice(0, 120) };
  }
  if (!img || img.isEmpty()) return { ok: false, error: "Пустой кадр — не удалось снять экран" };

  const dataUrl = "data:image/jpeg;base64," + img.toJPEG(quality).toString("base64");
  let previewUrl = null;
  try {
    const small = img.resize({ width: previewW });
    previewUrl = "data:image/jpeg;base64," + small.toJPEG(55).toString("base64");
  } catch { /* превью не критично */ }

  return {
    ok: true,
    dataUrl,
    previewUrl,
    width: img.getWidth(),
    height: img.getHeight(),
    screen: src.name,
  };
}

module.exports = { listScreens, captureScreen };
