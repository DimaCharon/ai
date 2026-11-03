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
    screenMode: null, // null | "once" (следующее сообщ.) | "live" (каждое)
    mode: "chat",     // "chat" | "code" | "self" — режим ИИ
    projectId: null,  // выбранный проект (своя память + папка)
    project: null,    // {id, name, dir}
    label: null,      // подпись для текущих assistant-сообщений
    council: null,    // ответы совета (приходят событием chat:council)
    selfEdits: false, // в Self-режиме были правки → показать «Перезапустить»
    attachments: [],  // прикреплённые файлы: {name, path, size, kind}
  };

  const screenBtn = $("#btn-screen");
  const screenLiveBtn = $("#btn-screen-live");

  /* ---------- ВЛОЖЕНИЯ: фото, видео, документы ЛЮБОГО формата ----------
     📎 кнопка / перетащить файл в окно / Ctrl+V.
     Что модель получит — решает main (attachments.js):
       • текст-подобные → содержимое в промт;
       • фото → только модели с 👁, иначе «модель не поддерживает формат»;
       • видео/аудио/pdf/docx → «модель не поддерживает формат». */
  const attachRow = $("#attach-row");
  const fileInput = $("#file-input");
  const btnAttach = $("#btn-attach");
  const ATTACH_ICONS = { image: "🖼", video: "🎬", audio: "🎵", text: "📄", doc: "📦", other: "📎" };

  function classifyKind(name) {
    const ext = (String(name || "").split(".").pop() || "").toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"].includes(ext)) return "image";
    if (["mp4", "mkv", "avi", "mov", "webm", "wmv", "flv", "m4v"].includes(ext)) return "video";
    if (["mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac", "wma"].includes(ext)) return "audio";
    if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "zip", "rar", "7z", "exe", "msi", "iso", "db"].includes(ext)) return "doc";
    return "text";
  }
  function fmtSize(b) {
    if (b >= 1048576) return (b / 1048576).toFixed(1) + " МБ";
    if (b >= 1024) return Math.round(b / 1024) + " КБ";
    return (b || 0) + " Б";
  }
  async function addFiles(fileList) {
    const arr = Array.from(fileList || []);
    for (const f of arr) {
      if (!f || !f.name) continue;
      if (state.attachments.length >= 10) {
        CC.toast("Не больше 10 файлов в одном сообщении", "err");
        break;
      }
      if (state.attachments.some((a) => a.name === f.name && a.size === f.size)) continue;
      let p = f.path || "";
      if (!p) {
        // файл без пути (картинка из буфера) → сохраним во временную папку
        try {
          const buf = await f.arrayBuffer();
          const r = await cc.files.saveTemp(f.name, buf);
          if (!r || !r.ok) { CC.toast("Файл: " + ((r && r.error) || "не удалось сохранить"), "err"); continue; }
          p = r.path;
        } catch (e) {
          CC.toast("Файл: " + String(e.message || e).slice(0, 90), "err");
          continue;
        }
      }
      state.attachments.push({ name: f.name, path: p, size: f.size || 0, kind: classifyKind(f.name) });
    }
    renderAttach();
  }
  function renderAttach() {
    if (!attachRow) return;
    attachRow.innerHTML = "";
    if (!state.attachments.length) { attachRow.classList.add("hidden"); return; }
    attachRow.classList.remove("hidden");
    state.attachments.forEach((a, i) => {
      const chip = document.createElement("span");
      chip.className = "attach-chip glass";
      chip.title = a.path;
      const lab = document.createElement("span");
      lab.textContent = (ATTACH_ICONS[a.kind] || "📎") + " " + a.name + (a.size ? " (" + fmtSize(a.size) + ")" : "");
      const x = document.createElement("b");
      x.className = "attach-x";
      x.title = "Убрать файл";
      x.textContent = "✕";
      x.addEventListener("click", (ev) => {
        ev.stopPropagation();
        state.attachments.splice(i, 1);
        renderAttach();
      });
      chip.appendChild(lab);
      chip.appendChild(x);
      attachRow.appendChild(chip);
    });
  }
  if (btnAttach && fileInput) btnAttach.addEventListener("click", () => fileInput.click());
  if (fileInput) fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });
  /* drag&drop в окно */
  ["dragenter", "dragover"].forEach((ev) =>
    document.addEventListener(ev, (e) => {
      e.preventDefault();
      chatEl && chatEl.classList.add("drop-hot");
    })
  );
  document.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (e.relatedTarget) return;
    chatEl && chatEl.classList.remove("drop-hot");
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    chatEl && chatEl.classList.remove("drop-hot");
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  /* Ctrl+V — файлы из буфера (скриншот, картинка) */
  inputEl && inputEl.addEventListener("paste", (e) => {
    const fl = e.clipboardData && e.clipboardData.files;
    if (fl && fl.length) { e.preventDefault(); addFiles(fl); }
  });

  /* ---------- «видение» экрана: микроскриншоты ---------- */
  function currentModelVision() {
    const lists = (window.CC && window.CC.models) || {};
    for (const k of Object.keys(lists)) {
      const m = (lists[k] || []).find((x) => x.id === state.modelId);
      if (m) return !!m.vision;
    }
    return false;
  }
  function showScreenPreview(url, caption) {
    const box = $("#screen-preview");
    const img = $("#screen-preview-img");
    if (!box || !img) return;
    if (url) img.src = url;
    $("#screen-preview-cap").textContent = caption || "";
    box.classList.remove("hidden");
  }
  function hideScreenPreview() {
    const box = $("#screen-preview");
    box && box.classList.add("hidden");
  }
  function updateScreenBtns() {
    screenBtn && screenBtn.classList.toggle("active", state.screenMode === "once");
    screenLiveBtn && screenLiveBtn.classList.toggle("active", state.screenMode === "live");
  }
  async function capturePreview() {
    try {
      const sc = await cc.screen.capture({});
      if (sc.ok) {
        showScreenPreview(sc.previewUrl, (sc.screen || "Экран") + " · " + sc.width + "×" + sc.height);
        if (state.screenMode === "once") CC.toast("📷 Скриншот приложится к следующему сообщению");
        if (state.screenMode === "live") CC.toast("👁 Live: к каждому сообщению будет прикладываться свежий микроскриншот");
      } else {
        CC.toast("Экран: " + sc.error);
      }
    } catch (e) {
      CC.toast("Экран: " + String(e.message || e).slice(0, 90));
    }
  }
  /** Вкл/выкл режим «видения» (вызывается и кнопками, и при смене модели). */
  function setScreenMode(mode) {
    state.screenMode = mode;
    updateScreenBtns();
    if (mode) capturePreview();
    else hideScreenPreview();
  }
  if (screenBtn) screenBtn.addEventListener("click", () => {
    if (state.screenMode === "once") { setScreenMode(null); return; }
    if (!currentModelVision()) {
      CC.toast("Эта модель не видит изображения — выбери модель с меткой 👁 (XRouter: Mistral Large 3, Qwen3 VL Plus, MiniMax M3…)");
      return;
    }
    setScreenMode("once");
  });
  if (screenLiveBtn) screenLiveBtn.addEventListener("click", () => {
    if (state.screenMode === "live") { setScreenMode(null); return; }
    if (!currentModelVision()) {
      CC.toast("Эта модель не видит изображения — выбери модель с меткой 👁 (XRouter: Mistral Large 3, Qwen3 VL Plus, MiniMax M3…)");
      return;
    }
    setScreenMode("live");
  });

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

  /* ---------- история (← →) — кнопка снята с титлбара,
     снапшоты всё ещё ведутся для возможного возврата ---------- */
  function commitSnapshot() {
    state.snapshots.push(messagesEl.innerHTML);
    state.hist = state.snapshots.length - 1;
  }

  /* ---------- отправка: 1 нажатие = 1 ответ ---------- */
  async function send(raw) {
    const hasFiles = state.attachments.length > 0;
    const text = ((raw != null ? raw : inputEl.value).trim()) || (hasFiles ? "(прикреплённый файл)" : "");
    if (!text || state.busy || !state.providerId) return;
    inputEl.value = "";
    autoSize();
    hideSlash();
    state.lastUserText = text;
    state.hist = -1;
    state.snapshots = [];
    state.selfEdits = false;

    /* Плагин-команда: /имя аргументы */
    let pluginCmd = null;
    if (text.startsWith("/")) {
      const sp = text.indexOf(" ");
      const name = (sp >= 0 ? text.slice(1, sp) : text.slice(1)).toLowerCase();
      const args = sp >= 0 ? text.slice(sp + 1).trim() : "";
      const found = (state.pluginCmds || []).find((c) => c.name === name);
      if (!found) {
        CC.toast("Команда /" + name + " не найдена. Вкладка «Плагины» — установить.", "err");
        return;
      }
      pluginCmd = { name: found.name, args };
    }

    /* Папка для инструментов ИИ: проект (если выбран) иначе активный чип */
    const chipEl = document.querySelector("#chips .chip.active");
    const chipPath = (chipEl && chipEl.dataset.path) || "";
    const attachedDir = state.project ? state.project.dir : chipPath || null;

    const tags =
      (state.screenMode ? '<span class="msg-screen-tag">📷 экран</span>' : "") +
      (state.mode === "code" ? '<span class="msg-code-tag">🧠 Код</span>' : "") +
      (state.mode === "self" ? '<span class="msg-code-tag">🛠 Self</span>' : "") +
      (pluginCmd ? '<span class="msg-plugin-tag">🧩 /' + esc(pluginCmd.name) + "</span>" : "") +
      (state.project ? '<span class="msg-proj-tag">📁 ' + esc(state.project.name) + "</span>" : "") +
      state.attachments.map((a) => '<span class="msg-file-tag">' + (ATTACH_ICONS[a.kind] || "📎") + " " + esc(a.name) + "</span>").join("");

    showChatView();
    pushMsg("user", esc(text) + tags);
    setBusy(true);
    state.currentBody = null;
    state.hasTokens = false;
    state.council = null;
    state.label =
      state.mode === "code" ? "Код · совет лучших моделей" :
      state.mode === "self" ? "Self · файлы приложения" :
      state.modelName;

    /* «Видение»: свежий микроскриншот на момент отправки (реалтайм
       в пределах формата чат-API — модель видит экран в эту секунду). */
    let screen = null;
    if (state.screenMode) {
      try {
        const sc = await cc.screen.capture({});
        if (sc.ok) {
          screen = { dataUrl: sc.dataUrl, width: sc.width, height: sc.height };
          showScreenPreview(sc.previewUrl, (sc.screen || "Экран") + " · " + sc.width + "×" + sc.height);
        } else {
          CC.toast("Экран: " + sc.error + " — шлю без скриншота");
        }
      } catch (e) {
        CC.toast("Экран: " + String(e.message || e).slice(0, 90) + " — шлю без скриншота");
      }
      if (state.screenMode === "once") setScreenMode(null);
    }

    cc.chat.send({
      chatId: state.activeChatId,
      providerId: state.providerId,
      modelId: state.modelId,
      text,
      screen,
      mode: state.mode,
      projectId: state.projectId,
      attachedDir,
      pluginCmd,
      files: state.attachments.map((a) => a.path),
    });
    state.attachments = [];
    renderAttach();
    // результат придёт событиями: chat:status / chat:token / chat:council /
    // chat:action / chat:iter / chat:cleanup / chat:confirm / chat:done / chat:error
  }

  /* ----------  Slash-автодополнение команд плагинов ---------- */
  const slashEl = document.createElement("div");
  slashEl.className = "slash-pop hidden";
  const metaRow = document.querySelector(".meta-row");
  if (metaRow) metaRow.parentElement.insertBefore(slashEl, metaRow);

  async function refreshPluginCmds() {
    try {
      state.pluginCmds = (await cc.plugins.commands()) || [];
    } catch {
      state.pluginCmds = [];
    }
    return state.pluginCmds;
  }
  function renderSlash(filter) {
    const cmds = (state.pluginCmds || []).filter(
      (c) => !filter || c.name.startsWith(filter)
    );
    if (!cmds.length) {
      hideSlash();
      return;
    }
    slashEl.innerHTML = cmds
      .slice(0, 8)
      .map(
        (c) =>
          `<button class="slash-item" data-name="${esc(c.name)}"><b>/${esc(c.name)}</b> <span>${esc(c.description || c.plugin)}</span></button>`
      )
      .join("");
    [...slashEl.querySelectorAll(".slash-item")].forEach((b) =>
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        inputEl.value = "/" + b.dataset.name + " ";
        inputEl.dispatchEvent(new Event("input"));
        inputEl.focus();
        hideSlash();
      })
    );
    slashEl.classList.remove("hidden");
  }
  function hideSlash() {
    slashEl.classList.add("hidden");
  }
  inputEl.addEventListener("input", () => {
    const v = inputEl.value;
    if (v.startsWith("/") && !v.includes("\n") && v.length < 40) {
      refreshPluginCmds().then(() => renderSlash(v.slice(1).trim().split(/\s/)[0].toLowerCase()));
    } else hideSlash();
  });
  inputEl.addEventListener("blur", () => setTimeout(hideSlash, 150));

  /* ---------- РЕЖИМЫ ИИ: 💬 Чат / 🧠 Код / 🛠 Self ---------- */
  const modeBtns = {
    chat: $("#mode-chat"),
    code: $("#mode-code"),
    self: $("#mode-self"),
  };
  function setMode(m) {
    state.mode = m;
    for (const k of Object.keys(modeBtns)) {
      if (modeBtns[k]) modeBtns[k].classList.toggle("active", k === m);
    }
    if (m === "code") CC.toast("🧠 Код: совет самых ЛУЧШИХ доступных моделей (free + твои ключи) → один вывод", 3600);
    if (m === "self") CC.toast("🛠 Self: ИИ работает с файлами самого Charon Code. После правок — «Перезапустить».", 4200);
  }
  if (modeBtns.chat) modeBtns.chat.addEventListener("click", () => setMode("chat"));
  if (modeBtns.code) modeBtns.code.addEventListener("click", () => setMode("code"));
  if (modeBtns.self) modeBtns.self.addEventListener("click", () => setMode("self"));

  /* ---------- ПРОЕКТЫ (папка + своя память) ---------- */
  const projSel = $("#proj-sel");
  let projectsCache = [];
  async function loadProjects() {
    try {
      projectsCache = (await cc.projects.list()) || [];
    } catch {
      projectsCache = [];
    }
    if (projSel) {
      const cur = state.projectId || "";
      projSel.innerHTML =
        '<option value="">📁 Проект: —</option>' +
        projectsCache
          .map((p) => `<option value="${esc(p.id)}"${p.id === cur ? " selected" : ""}>📁 ${esc(p.name)}</option>`)
          .join("");
    }
    if (window.CC && window.CC.Project && window.CC.Project.onChange) {
      window.CC.Project.onChange(state.projectId);
    }
  }
  if (projSel)
    projSel.addEventListener("change", () => {
      state.projectId = projSel.value || null;
      state.project = projectsCache.find((p) => p.id === state.projectId) || null;
      CC.toast(
        state.project
          ? "Проект «" + state.project.name + "»: своя память + папка приклеена к чатам"
          : "Проект снят — память глобальная"
      );
      if (window.CC && window.CC.Project && window.CC.Project.onChange) window.CC.Project.onChange(state.projectId);
    });
  const projNew = $("#proj-new");
  if (projNew)
    projNew.addEventListener("click", async () => {
      CC.toast("Выбери папку проекта (название поименуешь сразу после)");
      const r = await cc.projects.create("");
      if (r && r.ok) {
        await loadProjects();
        projSel.value = r.project.id;
        projSel.dispatchEvent(new Event("change"));
      } else if (r && r.error && !/отмен/i.test(r.error)) {
        CC.toast("Проект: " + r.error, "err");
      }
    });

  /** Свёртка с отдельными ответами моделей совета. */
  function insertCouncilBlock(body, members) {
    const d = document.createElement("details");
    d.className = "council-details";
    const okCount = members.filter((m) => m.ok).length;
    d.innerHTML = `<summary>🧠 Code: отдельные ответы моделей (${okCount}/${members.length})</summary>`;
    for (const m of members) {
      const div = document.createElement("div");
      div.className = "council-member" + (m.ok ? "" : " failed");
      div.innerHTML = `<b>${esc(m.id)}</b>` +
        (m.ok ? `<pre>${esc(m.text)}</pre>` : `<span class="cm-err">— ${esc(m.error || "не ответила")}</span>`);
      d.appendChild(div);
    }
    body.prepend(d);
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

  cc.chat.onCouncil(({ chatId, members }) => {
    if (chatId) state.activeChatId = chatId;
    state.council = members; // показываем в onDone, когда финал уже на месте
  });

  /* ---------- Инструменты ИИ: карточки действий ---------- */
  function lastAssistantBody() {
    if (state.currentBody) return state.currentBody;
    const all = messagesEl.querySelectorAll(".msg.assistant .msg-body");
    return all.length ? all[all.length - 1] : null;
  }
  cc.chat.onAction(({ chatId, card }) => {
    if (chatId) state.activeChatId = chatId;
    const body = lastAssistantBody() || pushMsg("assistant", "", state.label || "");
    const d = document.createElement("div");
    d.className = "act-card " + (card.state || "running");
    d.innerHTML = `<span class="act-ico">${esc(card.icon || "•")}</span>` +
      `<span class="act-title">${esc(card.title || card.kind || "")}</span>` +
      (card.detail ? `<span class="act-detail">${esc(card.detail)}</span>` : "") +
      (card.state === "running" ? '<span class="act-spin">⏳</span>' : card.state === "ok" ? '<span class="act-ok">✓</span>' : '<span class="act-bad">✗</span>');
    // «running»-карточка заменяется итоговой: обновляем последнюю того же kind
    const prev = body.querySelector('.act-card[data-kind="' + (card.kind || "") + '"]');
    if (prev && card.state !== "running") prev.replaceWith(d);
    else if (prev && card.state === "running") return; // уже есть running
    else body.appendChild(d);
    d.dataset.kind = card.kind || "";
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  /* Новая итерация петли: финализируем текущий блок, открываем новый */
  cc.chat.onIter(({ chatId }) => {
    if (chatId) state.activeChatId = chatId;
    const caret = state.currentBody && state.currentBody.querySelector(".caret");
    if (caret) caret.remove();
    state.currentBody = null;
    state.hasTokens = false;
  });

  /* Убрали блоки-команды из видимого текста */
  cc.chat.onCleanup(({ chatId, text }) => {
    if (chatId) state.activeChatId = chatId;
    const body = state.currentBody;
    if (body) {
      const caret = body.querySelector(".caret");
      if (caret) caret.remove();
      // сохраняем карточки действий: переносим их после чистки
      const cards = [...body.querySelectorAll(".act-card")];
      body.textContent = text || "";
      cards.forEach((c) => body.appendChild(c));
      const caret2 = document.createElement("span");
      caret2.className = "caret";
      caret2.textContent = "▍";
      body.appendChild(caret2);
    }
  });

  /* Подтверждение (ИИ хочет записать файл) */
  cc.chat.onConfirm(({ chatId, actionId, title, detail, preview }) => {
    if (chatId) state.activeChatId = chatId;
    CC.confirm(
      title || "Подтверждение",
      (detail || "") + (preview ? "\n\n<начало файла>\n" + preview.slice(0, 800) + (preview.length > 800 ? "…" : "") : "")
    ).then((ok) => cc.chat.confirmReply(actionId, ok));
  });

  cc.chat.onToken(({ chatId, text }) => {
    if (chatId) state.activeChatId = chatId;
    hideStatus();
    if (!state.currentBody) state.currentBody = pushMsg("assistant", "", state.label || state.modelName);
    state.hasTokens = true;
    // ВАЖНО: вставляем текст НОВОЙ текстовой нодрой ПЕРЕД кареткой.
    // (Было: currentBody.textContent += text — чтение textContent
    // «запекало» символ каретки ▍ внутрь текста: «Пр▍ивет».)
    let caret = state.currentBody.querySelector(".caret");
    if (!caret) {
      caret = document.createElement("span");
      caret.className = "caret";
      caret.textContent = "▍";
      state.currentBody.appendChild(caret);
    }
    caret.before(document.createTextNode(text));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  cc.chat.onDone(({ chatId, attempts, migratedFrom, council: councilDone, editsMade, isSelf }) => {
    if (chatId) state.activeChatId = chatId;
    const caret = state.currentBody && state.currentBody.querySelector(".caret");
    if (caret) caret.remove();
    // Code-режим: показываем отдельные ответы моделей свёрткой над финалом
    if (state.currentBody && (councilDone || state.council)) {
      insertCouncilBlock(state.currentBody, councilDone || state.council);
    }
    state.council = null;
    hideStatus();
    setBusy(false);
    commitSnapshot();
    if (migratedFrom) {
      CC.toast("Лимит чата достигнут — история перенесена в новый чат, старый удалён");
    }
    // Self-режим: были правки файлов приложения → баннер «Перезапустить»
    if (isSelf && editsMade) {
      state.selfEdits = true;
      showSelfRestartBar();
    }
    // задача завершена: оверлей маскота + чим (если включено в настройках)
    cc.mascot.taskDone();
  });

  /* ---------- Self-баннер: применить правки (перезапуск) ---------- */
  function showSelfRestartBar() {
    let bar = $("#self-restart-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "self-restart-bar";
      bar.className = "self-restart-bar";
      bar.innerHTML =
        '<span>🛠 ИИ изменил файлы Charon Code. Чтобы правки вступили в силу — перезапусти приложение:</span>' +
        '<button class="glass-btn pill-btn primary sm" id="self-restart-btn">⟳ Перезапустить Charon Code</button>';
      const iz = document.querySelector(".input-zone");
      if (iz) iz.parentElement.insertBefore(bar, iz);
    }
    bar.classList.remove("hidden");
    $("#self-restart-btn").onclick = async () => {
      $("#self-restart-btn").disabled = true;
      CC.toast("Перезапускаю Charon Code…");
      await cc.app.relaunch();
    };
  }

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
    // проект чата (если ещё не выбран — подставляем)
    if (chat.project) {
      if (!projectsCache.length) await loadProjects();
      if (projectsCache.some((p) => p.id === chat.project)) {
        state.projectId = chat.project;
        state.project = projectsCache.find((p) => p.id === chat.project);
        if (projSel) projSel.value = chat.project;
      }
    }
    messagesEl.innerHTML = "";
    for (const m of chat.messages) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        if (m.system) {
          // сводка результатов инструментов — компактной строкой
          const d = document.createElement("div");
          d.className = "sys-note";
          d.textContent = "⚙ " + String(m.content).replace(/^\[Система\]\s*/, "").slice(0, 400);
          messagesEl.appendChild(d);
          continue;
        }
        pushMsg("user", esc(m.content) +
          (m.screen ? '<span class="msg-screen-tag">📷 экран</span>' : "") +
          (m.code ? '<span class="msg-code-tag">🧠 Код</span>' : "") +
          (m.self ? '<span class="msg-code-tag">🛠 Self</span>' : "") +
          (m.plugin ? '<span class="msg-plugin-tag">🧩 /' + esc(m.plugin.command) + "</span>" : "") +
          (m.files && m.files.length ? m.files.map((f) => '<span class="msg-file-tag">📎 ' + esc(f) + "</span>").join("") : ""), chat.model);
      } else {
        const body = pushMsg("assistant", esc(m.content), chat.model);
        if (m.council && m.council.length) insertCouncilBlock(body, m.council);
      }
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
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  /* Авто-растяжение: длинный текст идёт ВНИЗ (до 140px), а не вправо */
  function autoSize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
  }
  inputEl.addEventListener("input", autoSize);

  window.CC = window.CC || {};
  Object.assign(window.CC, {
    Chat: { send, loadChat, newChat, state, setScreenMode },
    Project: {
      current: () => state.project,
      id: () => state.projectId,
      onChange: null, // ui.js вешает: (projectId) => обновление вкладки «Память»
    },
  });
  loadProjects();
  refreshPluginCmds();
})();
