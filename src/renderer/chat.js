/* ============================================================
   chat.js — чат (рендерер)
   ------------------------------------------------------------
   • Токеновый стриминг ответа (карека мигает, текст на лету).
   • Статусная строка движка: «Ожидание ответа… Попытка 2/10…».
   • Обрыв потока на середине → main шлёт restart → чистим и
     собираем заново (пока не будет ПОЛНЫЙ ответ).
   • Ошибка → диагностическое окно с «Переподключиться».
   • ← → — навигация по истории сообщений текущего чата.
   ============================================================ */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);

  const messagesEl = $("#messages");
  const chatEl = $("#chat");
  const welcomeEl = $("#welcome");
  const statusEl = $("#stream-status");
  const inputEl = $("#chat-input");
  const sendBtn = $("#btn-send");
  const stopBtn = $("#btn-stop");

  const state = {
    activeChatId: null,
    providerId: null,
    modelId: null,
    modelName: null,
    busy: false,
    lastUserText: "",
    snapshots: [],
    hist: -1,
    currentBody: null, // msg-body, куда льётся стрим
    hasTokens: false,
  };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  /* ---------- DOM ---------- */
  function pushMsg(role, html, modelLabel) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    if (role === "user") {
      div.innerHTML = `<span class="who">You</span><div class="msg-body">${html}</div>`;
    } else {
      div.innerHTML =
        `<span class="who ai">✳ Charon<small>${esc(modelLabel || "")}</small></span>` +
        `<div class="msg-body"></div>`;
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div.querySelector(".msg-body");
  }

  function showStatus(html) {
    statusEl.innerHTML = `<i class="pulse-dot"></i><span>${html}</span>`;
    statusEl.classList.remove("hidden");
  }
  function hideStatus() { statusEl.classList.add("hidden"); }

  function setBusy(b) {
    state.busy = b;
    sendBtn.classList.toggle("hidden", b);
    stopBtn.classList.toggle("hidden", !b);
    inputEl.disabled = b;
  }

  function showChatView() {
    welcomeEl.classList.add("hidden");
    chatEl.classList.remove("hidden");
  }
  function showWelcome() {
    chatEl.classList.add("hidden");
    welcomeEl.classList.remove("hidden");
  }

  /* ---------- история (← →) ---------- */
  function commitSnapshot() {
    state.snapshots.push(messagesEl.innerHTML);
    state.hist = state.snapshots.length - 1;
  }
  function back() {
    if (state.busy || state.hist <= 0) return;
    state.hist--;
    messagesEl.innerHTML = state.snapshots[state.hist];
  }
  function fwd() {
    if (state.busy || state.hist >= state.snapshots.length - 1) return;
    state.hist++;
    messagesEl.innerHTML = state.snapshots[state.hist];
  }

  /* ---------- отправка: 1 нажатие = 1 ответ ---------- */
  async function send(raw) {
    const text = (raw != null ? raw : inputEl.value).trim();
    if (!text || state.busy || !state.providerId) return;
    inputEl.value = "";
    state.lastUserText = text;
    state.hist = -1;
    state.snapshots = [];

    showChatView();
    pushMsg("user", esc(text));
    setBusy(true);
    state.currentBody = null;
    state.hasTokens = false;

    cc.chat.send({
      chatId: state.activeChatId,
      providerId: state.providerId,
      modelId: state.modelId,
      text,
    });
    // результат придёт событиями: chat:status / chat:token / chat:done / chat:error
  }

  /* ---------- события от main ---------- */
  cc.chat.onStatus(({ chatId, text, restart }) => {
    if (chatId) state.activeChatId = chatId;
    if (restart && state.currentBody) {
      // ответ оборвался на середине — чистим и пересобираем
      state.currentBody.textContent = "";
      state.hasTokens = false;
    }
    if (text) showStatus(esc(text));
  });

  cc.chat.onToken(({ chatId, text }) => {
    if (chatId) state.activeChatId = chatId;
    hideStatus();
    if (!state.currentBody) state.currentBody = pushMsg("assistant", "", state.modelName);
    state.hasTokens = true;
    state.currentBody.textContent += text;
    // каретка
    let caret = state.currentBody.querySelector(".caret");
    if (!caret) {
      caret = document.createElement("span");
      caret.className = "caret";
      caret.textContent = "▍";
      state.currentBody.appendChild(caret);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  cc.chat.onDone(({ chatId, attempts, migratedFrom }) => {
    if (chatId) state.activeChatId = chatId;
    const caret = state.currentBody && state.currentBody.querySelector(".caret");
    if (caret) caret.remove();
    hideStatus();
    setBusy(false);
    commitSnapshot();
    if (migratedFrom) {
      CC.toast("Лимит чата достигнут — история перенесена в новый чат, старый удалён");
    }
    // задача завершена: оверлей маскота + чим (если включено в настройках)
    cc.mascot.taskDone();
  });

  cc.chat.onError(({ chatId, message, retryable }) => {
    if (chatId) state.activeChatId = chatId;
    hideStatus();
    setBusy(false);
    const body = pushMsg("assistant", "", state.modelName);
    body.innerHTML = `<span class="err-inline">Не удалось получить ответ.</span>`;
    CC.showError(message, !!retryable, () => send(state.lastUserText));
  });

  /* ---------- загрузка чата из истории ---------- */
  async function loadChat(chatId) {
    const chat = await cc.chat.get(chatId);
    if (!chat) return;
    state.activeChatId = chat.id;
    state.providerId = chat.provider;
    state.modelId = chat.model;
    state.modelName = chat.model;
    state.snapshots = [];
    state.hist = -1;
    messagesEl.innerHTML = "";
    for (const m of chat.messages) {
      if (m.role === "system") continue;
      pushMsg(m.role === "user" ? "user" : "assistant", esc(m.content), chat.model);
    }
    showChatView();
    CC.updateModelBadge(chat.provider, chat.model);
  }

  /** Начать новый чат (сброс activeChatId). */
  function newChat() {
    state.activeChatId = null;
    state.snapshots = [];
    state.hist = -1;
    showWelcome();
    messagesEl.innerHTML = "";
  }

  /* ---------- кнопки ---------- */
  sendBtn.addEventListener("click", () => send());
  stopBtn.addEventListener("click", () => {
    if (state.activeChatId) cc.chat.stop(state.activeChatId);
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) send();
  });
  $("#btn-back").addEventListener("click", back);
  $("#btn-fwd").addEventListener("click", fwd);

  window.CC = window.CC || {};
  Object.assign(window.CC, { Chat: { send, back, fwd, loadChat, newChat, state } });
})();
