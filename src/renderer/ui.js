/* ============================================================
   ui.js — интерфейс Charon Code (рендерер)
   ------------------------------------------------------------
   Авторизация (локальная) · титлбар · Overview (реальная
   статистика) · модели трёх провайдеров · сессия Arena ·
   дровер «Файлы/Терминал» · поповеры · модалки · тосты.
   ============================================================ */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  /* ============================================================
     ТОСТЫ / МОДАЛКИ
     ============================================================ */
  function toast(msg, ms = 2600) {
    const t = document.createElement("div");
    t.className = "toast glass";
    t.textContent = msg;
    $("#toasts").appendChild(t);
    requestAnimationFrame(() => t.classList.add("in"));
    setTimeout(() => {
      t.classList.remove("in");
      setTimeout(() => t.remove(), 320);
    }, ms);
  }

  /** Подтверждение пользователя (запись файла / запуск команды). */
  function confirm(title, detail, yesLabel = "Подтвердить") {
    return new Promise((resolve) => {
      $("#confirm-title").textContent = title;
      const d = $("#confirm-detail");
      d.textContent = detail;
      d.style.whiteSpace = "pre-wrap";
      $("#confirm-yes").textContent = yesLabel;
      const modal = $("#modal-confirm");
      modal.classList.remove("hidden");
      const done = (v) => {
        modal.classList.add("hidden");
        $("#confirm-yes").onclick = null;
        $("#confirm-no").onclick = null;
        resolve(v);
      };
      $("#confirm-yes").onclick = () => done(true);
      $("#confirm-no").onclick = () => done(false);
    });
  }

  /** Диагностическое окно ошибки (на русском) + «Переподключиться». */
  let errorRetry = null;
  function showError(message, retryable, onRetry) {
    $("#err-text").textContent = message;
    $("#err-retry").classList.toggle("hidden", !retryable);
    errorRetry = onRetry || null;
    $("#modal-error").classList.remove("hidden");
  }
  $("#err-close").addEventListener("click", () => $("#modal-error").classList.add("hidden"));
  $("#err-retry").addEventListener("click", () => {
    $("#modal-error").classList.add("hidden");
    if (errorRetry) { const f = errorRetry; errorRetry = null; f(); }
  });

  /* ============================================================
     ПОПОВЕРЫ: открытие/закрытие
     ============================================================ */
  const pops = {
    model: $("#pop-model"),
    history: $("#pop-history"),
    settings: $("#pop-settings"),
    whats: $("#pop-whats"),
  };
  function openPop(name) {
    Object.entries(pops).forEach(([k, el]) => el.classList.toggle("hidden", k !== name));
  }
  function closePops() {
    Object.values(pops).forEach((el) => el.classList.add("hidden"));
  }
  $$("[data-close]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); closePops(); })
  );
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".pop")) closePops();
  });

  /* ============================================================
     АВТОРИЗАЦИЯ (только локально, на этом ПК)
     ============================================================ */
  let authMode = "login";
  function setAuthMode(m) {
    authMode = m;
    $("#tab-login").classList.toggle("active", m === "login");
    $("#tab-reg").classList.toggle("active", m === "reg");
    const reg = m === "reg";
    $("#pass2-wrap").classList.toggle("hidden", !reg);
    $("#auth-pass2").classList.toggle("hidden", !reg);
    $("#auth-submit").textContent = reg ? "Зарегистрироваться" : "Войти";
    $("#auth-err").textContent = "";
  }
  $("#tab-login").addEventListener("click", () => setAuthMode("login"));
  $("#tab-reg").addEventListener("click", () => setAuthMode("reg"));

  async function doAuth() {
    const u = $("#auth-user").value.trim();
    const p = $("#auth-pass").value;
    const p2 = $("#auth-pass2").value;
    $("#auth-err").textContent = "";
    try {
      let r;
      if (authMode === "login") r = await cc.auth.login(u, p);
      else {
        if (p !== p2) throw new Error("Пароли не совпадают.");
        r = await cc.auth.register(u, p);
      }
      await enterApp(r.username);
    } catch (e) {
      $("#auth-err").textContent = e.message || String(e);
    }
  }
  $("#auth-submit").addEventListener("click", doAuth);
  ["#auth-user", "#auth-pass", "#auth-pass2"].forEach((s) =>
    $(s).addEventListener("keydown", (e) => { if (e.key === "Enter") doAuth(); })
  );

  /** Вход в приложение после авторизации. */
  async function enterApp(username) {
    $("#greet-name").textContent = username;
    $("#auth-screen").classList.add("hidden");
    $("#app-screen").classList.remove("hidden");

    const s = await cc.settings.get();
    applyModelBadge(s.model.provider, s.model.id);
    // сохраняем выбранную модель в состояние чата (иначе первая
    // отправка будет игнорироваться — providerId пуст)
    const cst = window.CC.Chat.state;
    cst.providerId = s.model.provider;
    cst.modelId = s.model.id;
    cst.modelName = s.model.id;

    loadModels();
    loadStats();
    checkArenaSilent();
    applyMascotSettings(s); // мини-маскот по настройкам
    renderChips();
  }

  /* ============================================================
     ОКНО (mac-кнопки)
     ============================================================ */
  $("#btn-close").addEventListener("click", () => cc.win.close());
  $("#btn-min").addEventListener("click", () => cc.win.minimize());
  $("#btn-max").addEventListener("click", () => cc.win.toggleMax());

  /* ============================================================
     ВКЛАДКИ + СТАТИСТИКА (реальные локальные данные)
     ============================================================ */
  $$("#tabs .tab").forEach((t) =>
    t.addEventListener("click", () => {
      $$("#tabs .tab").forEach((x) => x.classList.toggle("active", x === t));
      const isModels = t.dataset.tab === "models";
      $("#pane-overview").classList.toggle("hidden", isModels);
      $("#pane-models").classList.toggle("hidden", !isModels);
    })
  );

  const PEAK_LABELS = ["00–03", "03–07", "07–11", "11–14", "14–17", "17–21", "21–24"];

  async function loadStats() {
    try {
      const s = await cc.stats.get();
      $("#st-sessions").textContent = s.sessions;
      $("#st-messages").textContent = s.messages;
      $("#st-tokens").textContent = s.tokens;
      $("#st-days").textContent = s.days;
      $("#st-fav").textContent = (s.favorite || "—").length > 26 ? s.favorite.slice(0, 24) + "…" : s.favorite || "—";
      // пик: самая «горячая» из 7 полос
      const rowSum = Array(7).fill(0);
      (s.heat || []).forEach((col) => col.forEach((v, r) => { rowSum[r] += v; }));
      let bi = 0;
      rowSum.forEach((v, i) => { if (v > rowSum[bi]) bi = i; });
      $("#st-peak").textContent = rowSum[bi] ? PEAK_LABELS[bi] + " ч" : "—";
      // heatmap: 24 дня (столбцы) × 7 полос (строки)
      let html = "";
      for (let col = 0; col < 24; col++) {
        for (let r = 0; r < 7; r++) {
          const v = (s.heat && s.heat[col] ? s.heat[col][r] : 0) || 0;
          const lv = v >= 10 ? 3 : v >= 4 ? 2 : v >= 1 ? 1 : 0;
          html += `<i class="hm${lv ? " hm-" + lv : ""}"></i>`;
        }
      }
      $("#heatmap").innerHTML = html;
    } catch { /* статистика не критична */ }
  }

  /* ============================================================
     МОДЕЛИ: три провайдера (Arena-агенты / dahl / OpenRouter free)
     ============================================================ */
  const modelsCache = { arena: [], dahl: [], openrouter: [], xkiro: [] };
  const modelsNote = {}; // провайдер -> текст ошибки/подсказки
  const GROUPS = [
    { id: "arena", label: "Arena AI · агенты сессии", dot: "g-arena" },
    { id: "dahl", label: "dahl.global", dot: "g-dahl" },
    { id: "openrouter", label: "OpenRouter · только free", dot: "g-or" },
    { id: "xkiro", label: "XRouter · xkiro.com (free)", dot: "g-xkiro" },
  ];

  function modelTag(m, provider) {
    if (provider === "arena") return "agent";
    if (provider === "dahl") return "dahl";
    return "free";
  }

  function modelRowHTML(m, provider, label, dot) {
    const sel = window.CC && window.CC.Chat.state.modelId === m.id && window.CC.Chat.state.providerId === provider;
    return `<div class="model-row${sel ? " active" : ""}" data-provider="${provider}" data-id="${m.id}">
      <span class="m-dot ${dot}"></span>
      <div class="m-info"><b>${escHtml(m.name)}${m.vision ? '<span class="m-vision" title="Видит изображения — может смотреть скриншоты экрана"> 👁</span>' : ""}</b><small>${label}</small></div>
      <span class="m-tag${m.free ? " free" : ""}">${modelTag(m, provider)}</span>
      <button class="glass-btn pill-btn sm m-pick">${sel ? "выбрана" : "Выбрать"}</button>
    </div>`;
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderModelLists(filter = "") {
    const f = filter.trim().toLowerCase();
    let html = "";
    for (const g of GROUPS) {
      const list = modelsCache[g.id].filter(
        (m) => !f || m.name.toLowerCase().includes(f) || g.label.toLowerCase().includes(f)
      );
      html += `<div class="models-group">${escHtml(g.label)}</div>`;
      if (modelsNote[g.id]) {
        html += `<div class="models-note">⚠ ${escHtml(modelsNote[g.id])}</div>`;
      }
      html += list.length
        ? list.map((m) => modelRowHTML(m, g.id, g.label, g.dot)).join("")
        : (modelsNote[g.id] ? "" : `<div class="empty">Модели не загружены</div>`);
    }
    $("#models-list").innerHTML = html || `<div class="empty">Ничего не найдено</div>`;
    $("#pop-models").innerHTML = html || `<div class="empty">Ничего не найдено</div>`;
  }

  async function loadModels() {
    for (const g of GROUPS) {
      modelsNote[g.id] = null;
      const r = await cc.providers.listModels(g.id);
      if (r.ok) {
        modelsCache[g.id] = r.models || [];
      } else {
        modelsCache[g.id] = [];
        modelsNote[g.id] = r.error || "не удалось загрузить";
      }
    }
    renderModelLists($("#model-search").value);
  }
  $("#btn-models-refresh").addEventListener("click", async () => {
    toast("Обновляю список моделей…");
    await loadModels();
    toast("Список моделей обновлён");
  });
  $("#model-search").addEventListener("input", (e) => renderModelLists(e.target.value));
  $("#pop-model-search").addEventListener("input", (e) => {
    const f = e.target.value.toLowerCase();
    const rows = $$("#pop-models .model-row").filter((r) => {
      const name = r.querySelector(".m-info b").textContent.toLowerCase();
      return !f || name.includes(f);
    });
    $$("#pop-models .model-row, #pop-models .models-group, #pop-models .models-note, #pop-models .empty").forEach((el) => {
      el.style.display = el.classList.contains("model-row") ? (rows.includes(el) ? "" : "none") : "";
    });
  });

  /** Выбор модели (клик по строке в любом списке). */
  function selectModel(provider, id) {
    const st = window.CC.Chat.state;
    // «видение» экрана: новая модель без vision → выключаем режим
    if (st.screenMode) {
      const g = modelsCache[provider] || [];
      const m = g.find((x) => x.id === id);
      if (!m || !m.vision) {
        window.CC.Chat.setScreenMode(null);
        toast("Режим «видение экрана» выключен: модель не видит изображения");
      }
    }
    st.providerId = provider;
    st.modelId = id;
    st.modelName = id;
    applyModelBadge(provider, id);
    cc.settings.save({ model: { provider, id } });
    renderModelLists($("#model-search").value);
    toast("Модель: " + id);
  }
  function applyModelBadge(provider, id) {
    $("#model-name").textContent = id.length > 34 ? id.slice(0, 32) + "…" : id;
    $("#model-tier").textContent =
      provider === "arena" ? "Arena" : provider === "dahl" ? "dahl" : provider === "xkiro" ? "xkiro" : "free";
  }
  document.addEventListener("click", (e) => {
    const row = e.target.closest(".model-row");
    if (row) selectModel(row.dataset.provider, row.dataset.id);
  });

  /* ============================================================
     СЕССИЯ ARENA (отдельная кнопочка, 3 экземпляра)
     ============================================================ */
  let arenaBusy = false;
  function refreshArena(btn) {
    if (arenaBusy) return;
    arenaBusy = true;
    $("#sess-ico").classList.add("spinning");
    btn.classList.add("is-busy");
    $("#sess-state").textContent = "обновление…";
    cc.providers.refreshArena().then((r) => {
      $("#sess-ico").classList.remove("spinning");
      btn.classList.remove("is-busy");
      arenaBusy = false;
      if (r.ok) {
        $("#sess-state").textContent = "активна ✓" + (r.user ? " · " + r.user : "");
        toast("Сессия Arena активна" + (r.user ? " (" + r.user + ")" : "") + " — агентов в списке: " + (r.agents ? r.agents.length : 0));
        // обновляем список агентов
        cc.providers.listModels("arena").then((res) => {
          if (res.ok) { modelsCache.arena = res.models; renderModelLists($("#model-search").value); }
        });
      } else {
        $("#sess-state").textContent = "нет";
        showError(r.error || "Не удалось обновить сессию Arena", true, () => refreshArena($("#btn-session")));
      }
    });
  }
  function checkArenaSilent() {
    cc.providers.refreshArena().then((r) => {
      $("#sess-state").textContent = r.ok ? "активна" + (r.user ? " · " + r.user : "") : "нет куки";
      if (r.ok) modelsCache.arena = r.agents || [];
      renderModelLists($("#model-search").value);
    });
  }
  ["#btn-session", "#btn-session-2", "#btn-session-3"].forEach((s) =>
    $(s).addEventListener("click", (e) => refreshArena(e.currentTarget))
  );

  /* ============================================================
     КНОПКА МОДЕЛИ (поповер) + ИСТОРИЯ
     ============================================================ */
  $("#btn-model").addEventListener("click", (e) => {
    e.stopPropagation();
    if (pops.model.classList.contains("hidden")) openPop("model");
    else closePops();
  });
  /** Список чатов в поповере «История» (открытие + после удаления). */
  async function renderHistory() {
    const list = $("#pop-history-list");
    const chats = await cc.chat.list();
    let html = `<div class="history-new"><button class="glass-btn pill-btn" id="hist-new">＋ Новый чат</button></div>`;
    html += chats.length
      ? chats.map((c) => `<div class="history-row" data-id="${c.id}" title="${escHtml(c.model)}">
          <div class="m-info"><b>${escHtml(c.title)}</b><small>${escHtml(c.model)} · ${c.count} сообщ. · ${new Date(c.updatedAt).toLocaleDateString()}</small></div>
          <button class="icon-btn hist-del" data-id="${c.id}" title="Удалить чат (в архив)">🗑</button>
        </div>`).join("")
      : `<div class="empty">Пока нет чатов — начни первый</div>`;
    list.innerHTML = html;
    $("#hist-new").addEventListener("click", () => {
      closePops();
      window.CC.Chat.newChat();
    });
    $$("#pop-history-list .history-row").forEach((r) =>
      r.addEventListener("click", () => {
        closePops();
        window.CC.Chat.loadChat(r.dataset.id);
      })
    );
    $$("#pop-history-list .hist-del").forEach((b) =>
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = await confirm(
          "Удалить чат?",
          "Переписка переедет в архив (AppData\\Roaming\\Charon Code\\chats\\archive) — из интерфейса пропадёт.",
          "Удалить"
        );
        if (!ok) return;
        await cc.chat.delete(b.dataset.id);
        toast("Чат удалён");
        renderHistory();
      })
    );
  }
  $("#btn-history").addEventListener("click", (e) => {
    e.stopPropagation();
    const list = $("#pop-history-list");
    list.innerHTML = `<div class="empty">Загрузка…</div>`;
    if (pops.history.classList.contains("hidden")) openPop("history");
    renderHistory();
  });

  /* ============================================================
     НАСТРОЙКИ (ключи, лимит, маскот, выход)
     ============================================================ */
  $("#btn-settings").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (pops.settings.classList.contains("hidden")) {
      const s = await cc.settings.get();
      $("#key-or").value = s.keys.openrouter || "";
      $("#key-dahl").value = s.keys.dahl || "";
      $("#key-arena").value = s.keys.arenaCookie || "";
      $("#key-xkiro").value = s.keys.xkiro || "";
      $("#key-github").value = s.keys.github || "";
      $("#key-gitlab").value = s.keys.gitlab || "";
      $("#set-arena-limit").value = s.arenaLimit;
      $("#set-mascot").checked = s.mascotShow !== false;
      $("#set-mascot-anim").checked = s.mascotAnim !== false;
      $("#set-chime").checked = s.chimeOnDone !== false;
      $("#set-mascot-scale").value = String(s.mascotScale || 1);
      openPop("settings");
    } else closePops();
  });
  $("#btn-save").addEventListener("click", async () => {
    const saved = await cc.settings.save({
      keys: {
        openrouter: $("#key-or").value.trim(),
        dahl: $("#key-dahl").value.trim(),
        arenaCookie: $("#key-arena").value.trim(),
        xkiro: $("#key-xkiro").value.trim(),
        github: $("#key-github").value.trim(),
        gitlab: $("#key-gitlab").value.trim(),
      },
      arenaLimit: Math.max(4, Number($("#set-arena-limit").value) || 30),
      mascotShow: $("#set-mascot").checked,
      mascotAnim: $("#set-mascot-anim").checked,
      mascotScale: Math.min(2, Math.max(0.6, Number($("#set-mascot-scale").value) || 1)),
      chimeOnDone: $("#set-chime").checked,
      showMascotOnDone: $("#set-mascot").checked,
    });
    closePops();
    toast("Настройки сохранены (только на этом ПК)");
    applyMascotSettings(saved);
    checkArenaSilent();
  });
  $("#btn-logout").addEventListener("click", async () => {
    await cc.auth.logout();
    location.reload();
  });

  /* What's new */
  $("#btn-whatsnew").addEventListener("click", (e) => {
    e.stopPropagation();
    if (pops.whats.classList.contains("hidden")) openPop("whats");
    else closePops();
  });

  /* ============================================================
     ДРОУЕР: ФАЙЛЫ / ТЕРМИНАЛ
     ============================================================ */
  const drawer = $("#drawer");
  function openDrawer(pane) {
    drawer.classList.remove("hidden");
    $("#pane-files").classList.toggle("hidden", pane !== "files");
    $("#pane-term").classList.toggle("hidden", pane !== "term");
    $("#pane-conn").classList.toggle("hidden", pane !== "conn");
    $("#dt-files").classList.toggle("active", pane === "files");
    $("#dt-term").classList.toggle("active", pane === "term");
    $("#dt-conn").classList.toggle("active", pane === "conn");
    if (pane === "files" && !Files.dir) Files.loadDir();
    if (pane === "conn") openConnPane();
  }
  $("#btn-files").addEventListener("click", () => openDrawer("files"));
  $("#btn-term").addEventListener("click", () => openDrawer("term"));
  $("#btn-conn").addEventListener("click", () => openDrawer("conn"));
  $("#dt-files").addEventListener("click", () => openDrawer("files"));
  $("#dt-term").addEventListener("click", () => openDrawer("term"));
  $("#dt-conn").addEventListener("click", () => openDrawer("conn"));
  $("#dt-close").addEventListener("click", () => drawer.classList.add("hidden"));

  /* ---------- Файлы ---------- */
  const Files = {
    dir: null,
    selectedFile: null,

    async loadDir(p) {
      const r = await cc.files.list(p || undefined);
      if (!r.ok) { toast(r.error || "Не удалось открыть папку"); return; }
      this.dir = r.path;
      $("#files-path").value = r.path;
      const listEl = $("#files-list");
      listEl.innerHTML = r.parent
        ? `<button class="file-item dir" data-name=".."><span class="fi-ico">📂</span>..</button>`
        : "";
      listEl.innerHTML += r.items.length
        ? r.items.map((it) => `<button class="file-item${it.dir ? " dir" : ""}" data-name="${escHtml(it.name)}">
            <span class="fi-ico">${it.dir ? "📂" : "📄"}</span>${escHtml(it.name)}
            ${it.dir ? "" : `<span class="fi-size">${fmtSize(it.size)}</span>`}</button>`).join("")
        : `<div class="empty">Пустая папка</div>`;
      $("#files-preview").textContent = "";
      $("#files-preview-name").textContent = "Выбери файл";
      this.selectedFile = null;

      $$("#files-list .file-item").forEach((b) =>
        b.addEventListener("click", () => this.onItem(b.dataset.name))
      );
    },

    join(name) {
      return name === ".." ? this.dir.replace(/[^\\]+[\\/]$/, "") || this.dir : this.dir + "\\" + name;
    },

    async onItem(name) {
      const full = this.join(name);
      const r = await cc.files.list(full);
      if (r.ok) { this.loadDir(full); return; }
      // это файл
      const fr = await cc.files.read(full);
      if (!fr.ok) {
        toast(fr.error || "Не удалось прочитать файл");
        return;
      }
      this.selectedFile = full;
      $("#files-preview-name").textContent = full.split("\\").pop();
      const prev = $("#files-preview");
      prev.textContent = fr.content;
      $("#files-preview-name").textContent = full.split("\\").pop() + "  (редактируй и нажми «Сохранить»)";
    },
  };
  function fmtSize(n) {
    if (n > 1048576) return (n / 1048576).toFixed(1) + " МБ";
    if (n > 1024) return (n / 1024).toFixed(1) + " КБ";
    return n + " Б";
  }
  $("#files-preview").setAttribute("contenteditable", "true");
  $("#files-preview").setAttribute("spellcheck", "false");
  $("#files-up").addEventListener("click", () => Files.loadDir($("#files-path").value.replace(/[^\\]+[\\/]$/, "") || undefined));
  $("#files-pick").addEventListener("click", async () => {
    const r = await cc.files.pick();
    if (r.ok) Files.loadDir(r.path);
  });
  $("#files-reveal").addEventListener("click", () => cc.files.reveal(Files.dir));
  $("#files-openfile").addEventListener("click", () => {
    if (Files.selectedFile) cc.files.open(Files.selectedFile);
    else toast("Сначала выбери файл");
  });
  $("#files-save").addEventListener("click", async () => {
    if (!Files.selectedFile) { toast("Нет открытого файла"); return; }
    const ok = await confirm(
      "Сохранить файл?",
      "Записать изменения в:\n\n" + Files.selectedFile,
      "Сохранить"
    );
    if (!ok) return;
    const r = await cc.files.write(Files.selectedFile, $("#files-preview").textContent);
    toast(r.ok ? "Файл сохранён" : "Ошибка: " + r.error);
  });

  /* ---------- Терминал ---------- */
  const Term = {
    runId: null,
    running: false,
    append(text) {
      const out = $("#term-out");
      out.textContent += text;
      out.scrollTop = out.scrollHeight;
    },
    async runCmd() {
      const cmd = $("#term-cmd").value.trim();
      if (!cmd || this.running) return;
      const shell = $("#term-shell").value;
      const cwd = $("#term-cwd").value.trim();
      const ok = await confirm(
        "Запустить команду в " + (shell === "cmd" ? "CMD" : "PowerShell") + "?",
        "Команда: " + cmd + (cwd ? "\nПапка: " + cwd : ""),
        "Запустить"
      );
      if (!ok) return;
      $("#term-cmd").value = "";
      this.append("\n❯ " + cmd + "\n");
      const r = await cc.terminal.run({ command: cmd, shell, cwd: cwd || undefined });
      if (!r.ok) { this.append("Ошибка запуска: " + r.error + "\n"); return; }
      this.runId = r.runId;
      this.running = true;
    },
  };
  $("#term-run").addEventListener("click", () => Term.runCmd());
  $("#term-cmd").addEventListener("keydown", (e) => { if (e.key === "Enter") Term.runCmd(); });
  $("#term-stop").addEventListener("click", () => { if (Term.runId) cc.terminal.kill(Term.runId); });
  $("#term-clear").addEventListener("click", () => { $("#term-out").textContent = ""; });
  cc.terminal.onOut(({ runId, text }) => { if (runId === Term.runId) Term.append(text); });
  cc.terminal.onDone(({ runId, code, error }) => {
    if (runId !== Term.runId) return;
    Term.running = false;
    Term.runId = null;
    Term.append(error ? "Ошибка: " + error + "\n" : "\n[завершено, код: " + code + "]\n");
  });

  /* ============================================================
     КОННЕКТОРЫ: GitHub / GitLab / Google Drive
     ============================================================ */
  /** Текущая «папка проекта»: активный чип → папка файлов → HOME. */
  function projectDir() {
    const chip = $("#chips .chip.active");
    if (chip && chip.dataset.path) return chip.dataset.path;
    if (Files.dir) return Files.dir;
    return undefined;
  }

  function setStatus(prefix, r) {
    const el = $("#" + prefix + "-status");
    if (r.ok) {
      el.textContent = "✓ " + (r.info || "подключён");
      el.title = r.info || "";
      el.classList.add("ok");
    } else {
      el.textContent = r.needsSetup ? "⚙ настройка" : "✗";
      el.title = r.error || "";
      el.classList.remove("ok");
    }
  }

  /**
   * Фабрика для git-коннекторов (GitHub и GitLab).
   * prefix = "gh" | "gl", cid = "github" | "gitlab".
   */
  function gitConn(prefix, cid) {
    const connectBtn = $("#" + prefix + "-connect");
    const setupEl = document.querySelector(`#conn-${cid} .conn-setup`);
    const activeEl = $("#" + prefix + "-active");
    const repoSel = $("#" + prefix + "-repo");
    const filesEl = $("#" + prefix + "-files");
    const actionsEl = $("#" + prefix + "-actions");
    const st = { repos: [], repo: null, branch: null, path: "", file: null, opened: false };

    const noun = cid === "github" ? "репозиторий" : "проект";

    async function enterConnected() {
      if (st.opened) return;
      st.opened = true;
      setupEl.classList.add("hidden");
      activeEl.classList.remove("hidden");
      loadRepos();
    }

    async function loadRepos() {
      repoSel.innerHTML = `<option value="">Загрузка…</option>`;
      const r = await cc.connectors.action(cid, "listRepos", []);
      if (!r.ok) { CC.showError(r.error, true, loadRepos); return; }
      st.repos = r.data;
      repoSel.innerHTML = `<option value="">— Выбери ${noun} —</option>` +
        r.data.map((x, i) =>
          `<option value="${i}">${x.private ? "🔒 " : ""}${escHtml(x.full_name)}</option>`).join("");
      st.repo = null; st.branch = null; st.path = ""; st.file = null;
      filesEl.innerHTML = `<div class="empty">Выбери ${noun} сверху</div>`;
      actionsEl.classList.add("hidden");
    }

    function currentRepo() {
      const i = Number(repoSel.value);
      return st.repos[i] || null;
    }

    repoSel.addEventListener("change", () => {
      const r = currentRepo();
      if (!r) { st.repo = null; filesEl.innerHTML = `<div class="empty">Выбери ${noun} сверху</div>`; actionsEl.classList.add("hidden"); return; }
      st.repo = r.full_name;
      st.branch = r.default_branch || "";
      st.path = "";
      st.file = null;
      loadDir("");
    });

    async function loadDir(p) {
      st.path = p;
      filesEl.innerHTML = `<div class="empty">Загрузка…</div>`;
      actionsEl.classList.add("hidden");
      const r = await cc.connectors.action(cid, "listDir", [st.repo, p, st.branch]);
      if (!r.ok) { filesEl.innerHTML = `<div class="empty">⚠ ${escHtml(r.error)}</div>`; return; }
      let html = "";
      if (p) html += `<button class="conn-fitem dir" data-path="">📂 ..</button>`;
      const dirs = r.data.filter((x) => x.type === "tree" || x.type === "dir");
      const files = r.data.filter((x) => x.type === "blob" || x.type === "file");
      html += dirs.map((x) => `<button class="conn-fitem dir" data-path="${escHtml(x.path)}">📂 ${escHtml(x.name)}</button>`).join("");
      html += files.map((x) => `<button class="conn-fitem" data-path="${escHtml(x.path)}">📄 ${escHtml(x.name)}<span class="fi-size">${fmtSize(x.size)}</span></button>`).join("");
      if (!r.data.length) html += `<div class="empty">Пустая папка</div>`;
      filesEl.innerHTML = html;
      $$("#" + prefix + "-files .conn-fitem").forEach((b) => b.addEventListener("click", () => openItem(b.dataset.path)));
    }

    async function openItem(p) {
      const r = await cc.connectors.action(cid, "listDir", [st.repo, p, st.branch]);
      if (r.ok) { loadDir(p); return; } // это каталог
      // файл
      const f = await cc.connectors.action(cid, "readFile", [st.repo, p]);
      if (!f.ok) { toast("Не удалось прочитать: " + (f.error || "")); return; }
      st.file = f.data;
      $("#" + prefix + "-file-name").textContent = p + (f.data.truncated ? " (показаны первые 300 КБ)" : "");
      const prev = $("#" + prefix + "-preview");
      prev.textContent = f.data.text;
      actionsEl.classList.remove("hidden");
      actionsEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    connectBtn.addEventListener("click", async () => {
      connectBtn.disabled = true;
      connectBtn.textContent = "Подключаю…";
      const r = await cc.connectors.saveToken(cid, $("#" + prefix + "-token").value.trim());
      connectBtn.disabled = false;
      connectBtn.textContent = "Подключить " + (cid === "github" ? "GitHub" : "GitLab");
      if (r.ok) {
        setStatus(prefix, r);
        toast((cid === "github" ? "GitHub" : "GitLab") + " подключён: " + (r.info || ""));
        enterConnected();
      } else {
        setStatus(prefix, r);
        CC.showError(r.error, true, () => connectBtn.click());
      }
    });
    // Enter в поле токена = подключить
    $("#" + prefix + "-token").addEventListener("keydown", (e) => { if (e.key === "Enter") connectBtn.click(); });

    $("#" + prefix + "-refresh").addEventListener("click", loadRepos);

    /* 💬 В чат — файл улетает модели в контекст (остаётся в истории) */
    $("#" + prefix + "-to-chat").addEventListener("click", () => {
      if (!st.file) return;
      const raw =
        `📄 Файл из ${cid}: ${st.repo}/${st.file.path}\n\n` +
        "```\n" + st.file.text + "\n```\n\n" +
        "Изучи этот файл и будь готов отвечать на вопросы о нём.";
      closePops();
      drawer.classList.add("hidden");
      CC.Chat.send(raw);
      toast("Файл отправлен в чат — спрашивай о нём что угодно");
    });

    /* 💾 В папку проекта */
    $("#" + prefix + "-save-file").addEventListener("click", async () => {
      if (!st.file) return;
      const dir = projectDir();
      const ok = await confirm(
        "Сохранить файл в папку проекта?",
        "Файл: " + st.repo + "/" + st.file.path + "\nВ папку: " + (dir || "(домашняя)") + "\n\nЕсли файл с таким именем уже есть — сохранится как «имя (1).…»",
        "Сохранить"
      );
      if (!ok) return;
      const r = await cc.connectors.action(cid, "saveFile", [st.file.path, st.file.text, dir]);
      toast(r.ok ? "Сохранено: " + r.dir : "Ошибка: " + r.error, 3600);
    });

    /* 📦 Скачать весь репозиторий/проект */
    $("#" + prefix + "-dl-repo").addEventListener("click", async () => {
      const r = currentRepo();
      if (!r) return;
      const dir = projectDir();
      const ok = await confirm(
        "Скачать весь " + noun + "?",
        r.full_name + " (ветка: " + (st.branch || "main") + ")\nВ папку: " + (dir || "(домашняя)") + "\\" + r.name + "\n\nХвост: до 500 МБ, может занять время.",
        "Скачать"
      );
      if (!ok) return;
      toast("Скачиваю " + r.full_name + "…", 4000);
      const res = await cc.connectors.action(cid, "downloadRepo", [r.full_name, r.default_branch || st.branch, dir]);
      if (res.ok) toast("Готово: " + res.dir + " (" + res.files + " файлов)", 5000);
      else CC.showError(res.error, true, () => $("#" + prefix + "-dl-repo").click());
    });

    return {
      /** автопроверка при открытии вкладки */
      async autocheck() {
        const s = await cc.settings.get();
        const hasToken = !!(s.keys && s.keys[cid]);
        if (hasToken) {
          $("#" + prefix + "-token").value = s.keys[cid] || "";
          const r = await cc.connectors.check(cid);
          setStatus(prefix, r);
          if (r.ok) enterConnected();
        } else {
          setStatus(prefix, { ok: false, error: "не подключён" });
        }
      },
    };
  }

  const Gh = gitConn("gh", "github");
  const Gl = gitConn("gl", "gitlab");

  /* Google Drive: инструкция по OAuth */
  $("#gd-info").addEventListener("click", async () => {
    const r = await cc.connectors.check("googledrive");
    CC.showError(r.error || "Нужна настройка OAuth", false, null);
  });

  /* ---------- вкладка «Коннекторы» ---------- */
  let connLoaded = false;
  function openConnPane() {
    if (!connLoaded) {
      connLoaded = true;
      Gh.autocheck();
      Gl.autocheck();
    }
  }

  /* ============================================================
     ПАПКИ-ЧИПЫ (проектные папки)
     ============================================================ */
  let chips = [];
  try { chips = JSON.parse(localStorage.getItem("cc.chips") || "[]"); } catch { chips = []; }

  function renderChips() {
    const el = $("#chips");
    el.innerHTML = `<button class="chip${!chips.length ? " active" : ""}" data-path="">🖥 Local</button>` +
      chips.map((c, i) => `<button class="chip" data-path="${escHtml(c.path)}" data-i="${i}">📁 ${escHtml(c.label)}</button>`).join("") +
      `<button class="chip" id="chip-add" title="Добавить папку проекта">＋</button>`;
    $$("#chips .chip").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.id === "chip-add") { addChip(); return; }
        $$("#chips .chip").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        const p = b.dataset.path;
        $("#term-cwd").value = p;
        // Local (пустой путь) = домашняя папка — открываем её в файлах
        Files.loadDir(p || undefined);
      })
    );
  }
  async function addChip() {
    const r = await cc.files.pick();
    if (!r.ok) return;
    chips.push({ label: r.path.split("\\").pop() || r.path, path: r.path });
    localStorage.setItem("cc.chips", JSON.stringify(chips));
    renderChips();
    toast("Папка добавлена: " + r.path);
  }
  $("#btn-plus").addEventListener("click", addChip);

  /* ============================================================
     МАСКОТ (мини в строке папок) + ЧИМ
     ============================================================ */
  /* ============================================================
     МАСКОТ: мини в строке папок + настройки (вкл/выкл, анимация,
     следит за мышкой) + тихий чим
     ============================================================ */
  let miniSprite = null;
  let chimeEnabled = true;

  /** Применить настройки маскота: показ, анимация, размер (мини + оверлей). */
  function applyMascotSettings(s) {
    const show = s.mascotShow !== false;
    const anim = s.mascotAnim !== false;
    const scale = Math.min(2, Math.max(0.6, Number(s.mascotScale) || 1));
    chimeEnabled = s.chimeOnDone !== false;
    const c = $("#mini-canvas");
    if (!c) return;
    if (!miniSprite) miniSprite = new window.CharonSprite(c, { blink: true, anim });
    miniSprite.setHidden(!show);
    miniSprite.setAnim(anim);
    c.style.transform = "scale(" + scale + ")";
    c.style.transformOrigin = "left bottom";
    cc.mascot.setScale(scale); // оверлей в main пересчитает под масштаб
    if (show && anim) miniSprite.startIdle();
  }

  // Глаза (и рука, когда курсор рядом) следят за мышкой по всей странице.
  let _mmT = 0;
  document.addEventListener("mousemove", (e) => {
    if (!miniSprite || miniSprite.canvas.style.display === "none") return;
    const now = Date.now();
    if (now - _mmT < 60) return;
    _mmT = now;
    miniSprite.lookAt(e.pageX, e.pageY);
  });

  window.addEventListener("load", () => {
    const c = $("#mini-canvas");
    if (c && !miniSprite) {
      miniSprite = new window.CharonSprite(c, { blink: true });
      miniSprite.startIdle();
    }
    c && c.addEventListener("click", () => {
      // призвать маскота (оверлей + чим) — то же, что при завершении задачи
      cc.mascot.taskDone();
    });
  });
  // main показал оверлей → играем тихий чим в главном окне (если включён)
  cc.mascot.onWave(() => {
    if (!chimeEnabled) return;
    const chime = $("#chime");
    try { chime.currentTime = 0; const p = chime.play(); if (p && p.catch) p.catch(() => {}); } catch { /* нет звука */ }
  });

  /* ============================================================
     ПРОЧЕЕ
     ============================================================ */
  $("#btn-notice-x").addEventListener("click", () => {
    const n = $("#notice");
    n.classList.add("out");
    setTimeout(() => n.classList.add("hidden"), 320);
  });

  /* ============================================================
     СТАРТ
     ============================================================ */
  window.CC = window.CC || {};
  Object.assign(window.CC, { toast, confirm, showError, updateModelBadge: applyModelBadge, checkArenaSilent, models: modelsCache });

  (async () => {
    const st = await cc.auth.status();
    if (st && st.username) {
      await enterApp(st.username);
    } else {
      $("#auth-screen").classList.remove("hidden");
      // маскот на экране входа тоже живой
      const as = new window.CharonSprite($("#auth-mascot"), { blink: true });
      as.startIdle();
      const t = setTimeout(() => as.wave(2), 900);
    }
  })();
})();
