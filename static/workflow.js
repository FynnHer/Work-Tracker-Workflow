"use strict";
// Workflow — kanban panel for Work Tracker. Opens from the tab on the right edge (or press W).
// Everything is wrapped so nothing collides with the tracker's globals in app.js.
(() => {
  // ---------------------------------------------------------- helpers

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const pad2 = (n) => String(n).padStart(2, "0");
  const fmtDur = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    return `${Math.floor(sec / 3600)}h ${pad2(Math.floor((sec % 3600) / 60))}m`;
  };
  const fmtClock = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    return `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`;
  };
  const hours = (sec) => fmtDur(sec).replace(" 00m", "");
  const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const shortDate = (s) => parseYmd(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const hue = (label) => [...label.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const store = {
    get(k) { try { return localStorage.getItem("workflow." + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem("workflow." + k, v); } catch { /* private mode */ } },
  };

  const svg = (body, extra = "") =>
    `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;
  const I = {
    board: svg('<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9.5 4v16M15 4v16"/>'),
    play: svg('<path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none"/>'),
    stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>'),
    x: svg('<path d="M6 6l12 12M18 6L6 18"/>', 'stroke-width="2.5"'),
    wide: svg('<path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"/>'),
    narrow: svg('<path d="M3 12h7M21 12h-7M7 8l4 4-4 4M17 8l-4 4 4 4"/>'),
    more: svg('<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 'stroke-width="2.5"'),
    list: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>'),
    cal: svg('<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>'),
    clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    text: svg('<path d="M5 7h14M5 12h14M5 17h9"/>'),
  };
  const PRIO = { "": "None", low: "Low", medium: "Medium", high: "High" };

  // ---------------------------------------------------------- state

  let board = null;        // last /api/workflow/board response
  let fetchedAt = 0;       // performance.now() of that response
  let view = "board";      // "board" | "archive"
  let dragId = null;       // card being dragged
  let editing = null;      // card open in the dialog (a copy)
  const filters = { q: "", label: "", prio: "" };

  const isOpen = () => document.body.classList.contains("wf-open");
  const liveExtra = () => (board && board.running ? (performance.now() - fetchedAt) / 1000 : 0);
  const columnById = (id) => board.columns.find((c) => c.id === id);
  const cardById = (id) => board.cards.find((c) => c.id === id);
  const cardsIn = (colId) => board.cards.filter((c) => c.column_id === colId).sort((a, b) => a.position - b.position);
  const tracked = (card) => card.tracked_seconds + (card.running ? liveExtra() : 0);

  // ---------------------------------------------------------- DOM skeleton

  document.body.insertAdjacentHTML("beforeend", `
    <button class="wf-tab" id="wf-tab" title="Workflow board (W)">${I.board}<span>Workflow</span><i class="wf-dot" id="wf-dot" hidden></i></button>
    <aside class="wf-panel" id="wf-panel" aria-label="Workflow">
      <div class="wf-resize" id="wf-resize" title="Drag to resize · double-click to reset"></div>
      <div class="wf-head">
        <h2>${I.board} Workflow</h2>
        <input type="search" class="wf-search" id="wf-q" placeholder="Search cards…">
        <select id="wf-label" aria-label="Filter by label"></select>
        <select id="wf-prio" aria-label="Filter by priority">
          <option value="">Any priority</option><option value="high">High</option>
          <option value="medium">Medium</option><option value="low">Low</option>
        </select>
        <span class="spacer"></span>
        <button class="btn ghost" id="wf-archive-btn">Archive</button>
        <button class="btn link" id="wf-wide" title="Full width"></button>
        <button class="btn link" id="wf-close" title="Close (Esc)" aria-label="Close">${I.x}</button>
      </div>
      <div class="wf-running" id="wf-running" hidden></div>
      <div class="wf-board" id="wf-board"></div>
      <div class="wf-archive" id="wf-archive" hidden></div>
    </aside>
    <div class="time-menu wf-menu" id="wf-menu" hidden></div>
    <div class="wf-error" id="wf-error" role="alert" hidden></div>
    <datalist id="wf-label-list"></datalist>
    <dialog class="wf-dialog" id="wf-dialog">
      <form id="wf-form">
        <div class="head">
          <input id="wf-f-title" required maxlength="300" aria-label="Title">
          <button type="button" class="btn link" id="wf-f-x" aria-label="Close">${I.x}</button>
        </div>
        <div class="wf-time">
          <div><div class="label">Tracked</div><span class="big" id="wf-f-tracked"></span> <span class="muted small" id="wf-f-est-note"></span></div>
          <span class="spacer" style="flex:1"></span>
          <button type="button" class="btn ghost" id="wf-f-link" hidden>Link running timer</button>
          <button type="button" class="btn start" id="wf-f-timer"></button>
        </div>
        <label>Description <textarea id="wf-f-desc" maxlength="20000" placeholder="Notes, links, acceptance criteria…"></textarea></label>
        <div class="grid">
          <label>Column <select id="wf-f-col"></select></label>
          <label>Priority <select id="wf-f-prio">${Object.entries(PRIO).map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select></label>
          <label>Due date <input type="date" id="wf-f-due"></label>
          <label>Estimate (hours) <input type="number" id="wf-f-est" min="0" max="1000" step="0.25" placeholder="—"></label>
        </div>
        <label>Labels <input id="wf-f-labels" list="wf-label-list" placeholder="Comma separated, e.g. client-a, bug"></label>
        <div>
          <h4>Checklist <span class="muted small" id="wf-f-check-count"></span></h4>
          <div class="wf-progress" id="wf-f-check-bar"><div></div></div>
          <ul class="wf-checklist" id="wf-f-checklist"></ul>
          <input id="wf-f-check-new" placeholder="Add an item and press Enter" style="width:100%;margin-top:4px">
        </div>
        <details id="wf-f-sessions-box"><summary class="small muted" id="wf-f-sessions-sum">Sessions</summary>
          <ul class="wf-sessions" id="wf-f-sessions"></ul></details>
        <div class="error small" id="wf-f-error"></div>
        <div class="actions">
          <button type="button" class="btn ghost danger" id="wf-f-delete">Delete</button>
          <button type="button" class="btn ghost" id="wf-f-archive">Archive</button>
          <span class="spacer"></span>
          <button type="button" class="btn ghost" id="wf-f-cancel">Cancel</button>
          <button class="btn start" id="wf-f-save">Save</button>
        </div>
      </form>
    </dialog>`);

  const panel = $("wf-panel"), menu = $("wf-menu"), dialog = $("wf-dialog");

  let errTimer;
  function showError(msg) {
    $("wf-error").textContent = msg;
    $("wf-error").hidden = false;
    clearTimeout(errTimer);
    errTimer = setTimeout(() => ($("wf-error").hidden = true), 4500);
  }
  const attempt = (fn) => async (...args) => { try { await fn(...args); } catch (e) { showError(e.message); } };

  /** Let the tracker page catch up after the timer changed here. */
  function trackerRefresh() {
    if (typeof window.refreshAll === "function") window.refreshAll().catch(() => {});
  }

  // ---------------------------------------------------------- open / close

  function setOpen(open) {
    document.body.classList.toggle("wf-open", open);
    store.set("open", open ? "1" : "");
    if (open) load().catch((e) => showError("Workflow: " + e.message));
    else menu.hidden = true;
  }
  function setWide(wide) {
    document.body.classList.toggle("wf-wide", wide);
    $("wf-wide").innerHTML = wide ? I.narrow : I.wide;
    $("wf-wide").title = wide ? "Narrow" : "Full width";
    store.set("wide", wide ? "1" : "");
  }
  $("wf-tab").onclick = () => setOpen(true);
  $("wf-close").onclick = () => setOpen(false);
  $("wf-wide").onclick = () => setWide(!document.body.classList.contains("wf-wide"));

  // Panel width: drag the left edge; the tracker keeps at least MIN_PAGE px next to it.
  const MIN_PANEL = 340, MIN_PAGE = 420;
  const defaultWidth = () => Math.round(window.innerWidth * 0.42);
  let panelWidth = Number(store.get("width")) || 0;
  function applyWidth() {
    const w = Math.round(Math.max(MIN_PANEL, Math.min(panelWidth || defaultWidth(), window.innerWidth - MIN_PAGE)));
    document.documentElement.style.setProperty("--wf-w", w + "px");
  }
  $("wf-resize").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    $("wf-resize").setPointerCapture(e.pointerId);
    document.body.classList.add("wf-resizing");
  });
  $("wf-resize").addEventListener("pointermove", (e) => {
    if (!document.body.classList.contains("wf-resizing")) return;
    panelWidth = window.innerWidth - e.clientX;
    applyWidth();
  });
  $("wf-resize").addEventListener("pointerup", () => {
    document.body.classList.remove("wf-resizing");
    store.set("width", String(Math.round(panelWidth)));
  });
  $("wf-resize").addEventListener("dblclick", () => { panelWidth = 0; store.set("width", ""); applyWidth(); });
  window.addEventListener("resize", applyWidth);
  applyWidth();

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (document.querySelector("dialog[open]")) return;
    if (e.key === "Escape" && !menu.hidden) { menu.hidden = true; return; }
    if (e.key === "Escape" && isOpen() && !typing) setOpen(false);
    if ((e.key === "w" || e.key === "W") && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) setOpen(!isOpen());
  });

  // ---------------------------------------------------------- load + render

  async function load() {
    board = await api("GET", "/api/workflow/board");
    fetchedAt = performance.now();
    render();
  }

  function render() {
    if (!board) return;
    $("wf-dot").hidden = !board.running_card_id;
    if (!isOpen()) return;
    renderFilters();
    renderRunning();
    $("wf-archive-btn").textContent = view === "archive" ? "Back to board" : `Archive (${board.archived_count})`;
    $("wf-board").hidden = view !== "board";
    $("wf-archive").hidden = view !== "archive";
    if (view === "board") renderBoard();
  }

  function renderFilters() {
    const labels = [...new Set(board.cards.flatMap((c) => c.labels))].sort((a, b) => a.localeCompare(b));
    if (filters.label && !labels.includes(filters.label)) labels.unshift(filters.label);
    $("wf-label").innerHTML = `<option value="">All labels</option>` +
      labels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
    $("wf-label").value = filters.label;
    $("wf-label").hidden = !labels.length;
    $("wf-label-list").innerHTML = labels.map((l) => `<option value="${esc(l)}">`).join("");
  }

  function renderRunning() {
    const bar = $("wf-running");
    const run = board.running;
    bar.hidden = !run;
    if (!run) return;
    const card = board.running_card_id && cardById(board.running_card_id);
    if (card) {
      bar.innerHTML = `<span class="positive">${I.clock}</span> <span>Working on <b>${esc(card.title)}</b></span>
        <span class="clock-sm" data-live="session"></span>
        <span class="muted">· card total <span data-live="card">${fmtDur(tracked(card))}</span></span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn stop" data-act="stop">Stop</button>`;
    } else {
      const options = board.cards.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join("");
      bar.innerHTML = `<span class="positive">${I.clock}</span>
        <span>Timer running${run.note ? `: <b>${esc(run.note)}</b>` : ""} <span class="clock-sm" data-live="session"></span></span>
        ${options ? `<select data-act="link" aria-label="Link to a card"><option value="">Count it towards a card…</option>${options}</select>` : ""}
        <span class="spacer" style="flex:1"></span>
        <button class="btn stop" data-act="stop">Stop</button>`;
    }
    tick();
  }

  $("wf-running").addEventListener("click", attempt(async (e) => {
    if (e.target.dataset.act !== "stop") return;
    await stopTimer();
  }));
  $("wf-running").addEventListener("change", attempt(async (e) => {
    if (e.target.dataset.act !== "link" || !e.target.value) return;
    await api("POST", `/api/workflow/cards/${e.target.value}/link`);
    await load();
    trackerRefresh();  // the tracker's note now shows the card title
  }));

  async function stopTimer() {
    const note = board.running && board.running.note;
    await api("POST", "/api/stop");
    const noteEl = $("note");  // the tracker's note field would otherwise keep the card title
    if (noteEl && noteEl.value === note) noteEl.value = "";
    await load();
    trackerRefresh();
  }

  async function toggleTimer(card) {
    if (card.running) return stopTimer();
    await api("POST", `/api/workflow/cards/${card.id}/start`);
    await load();
    trackerRefresh();
  }

  function matches(card) {
    if (filters.label && !card.labels.includes(filters.label)) return false;
    if (filters.prio && card.priority !== filters.prio) return false;
    if (filters.q) {
      const hay = [card.title, card.description, ...card.labels, ...card.checklist.map((i) => i.text)].join("\n").toLowerCase();
      return filters.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
    }
    return true;
  }

  function renderBoard() {
    if (!board) return;
    const wrap = $("wf-board");
    const scroll = wrap.scrollLeft;
    wrap.innerHTML = "";
    for (const col of board.columns) {
      const all = cardsIn(col.id);
      const over = col.wip_limit && all.length > col.wip_limit;
      const el = document.createElement("section");
      el.className = "wf-col" + (over ? " over-limit" : "");
      el.dataset.col = col.id;
      el.innerHTML = `
        <div class="wf-col-head">
          <h3 title="${esc(col.name)}">${esc(col.name)}</h3>
          ${col.is_done ? `<span class="wf-done-mark" title="Done column: cards here count as finished">${I.check}</span>` : ""}
          <span class="wf-count" title="${col.wip_limit ? "Cards / WIP limit" : "Cards"}">${all.length}${col.wip_limit ? " / " + col.wip_limit : ""}</span>
          <button class="btn link" data-act="col-menu" aria-label="Column menu">${I.more}</button>
        </div>
        <ul class="wf-cards"></ul>
        <div class="wf-add"><button class="btn link" data-act="add-card">+ Add card</button></div>`;
      const list = el.querySelector(".wf-cards");
      for (const card of all.filter(matches)) list.appendChild(cardEl(card, col));
      wrap.appendChild(el);
    }
    wrap.insertAdjacentHTML("beforeend",
      `<div class="wf-add-col"><button class="btn ghost" data-act="add-col">+ Add column</button></div>`);
    wrap.scrollLeft = scroll;
  }

  function cardEl(card, col) {
    const li = document.createElement("li");
    li.className = "wf-card" + (card.running ? " running" : "") + (col.is_done ? " done" : "");
    li.draggable = true;
    li.dataset.id = card.id;

    const meta = [];
    if (card.priority) meta.push(`<span title="${PRIO[card.priority]} priority"><i class="wf-prio ${card.priority}"></i>${PRIO[card.priority]}</span>`);
    if (card.due_date) {
      const days = Math.round((parseYmd(card.due_date) - parseYmd(board.today)) / 86400000);
      const cls = col.is_done ? "" : days < 0 ? "overdue" : days <= 1 ? "due-soon" : "";
      const when = days === 0 ? "Today" : days === 1 ? "Tomorrow" : shortDate(card.due_date);
      meta.push(`<span class="${cls}" title="Due ${esc(card.due_date)}${cls === "overdue" ? " — overdue" : ""}">${I.cal}${when}</span>`);
    }
    const doneItems = card.checklist.filter((i) => i.done).length;
    if (card.checklist.length) meta.push(`<span title="Checklist">${I.list}${doneItems}/${card.checklist.length}</span>`);
    if (card.description) meta.push(`<span title="Has a description">${I.text}</span>`);
    const sec = tracked(card);
    if (sec >= 60 || card.estimate || card.running) {
      const over = card.estimate && sec > card.estimate;
      meta.push(`<span class="tracked${over ? " over-estimate" : ""}" title="Tracked${card.estimate ? " / estimate" : ""}">${I.clock}`
        + `<span ${card.running ? 'data-live="card"' : ""}>${fmtDur(sec)}</span>${card.estimate ? " / " + hours(card.estimate) : ""}</span>`);
    }

    li.innerHTML = `
      <div class="wf-title"></div>
      <button class="wf-play" data-act="timer" title="${card.running ? "Stop timer" : "Start timer for this card"}">${card.running ? I.stop : I.play}</button>
      ${card.labels.length ? `<div class="wf-labels">${card.labels.map((l) => `<span class="wf-label" style="--h:${hue(l)}">${esc(l)}</span>`).join("")}</div>` : ""}
      ${meta.length ? `<div class="wf-meta">${meta.join("")}</div>` : ""}
      ${card.checklist.length ? `<div class="wf-progress"><div style="width:${(doneItems / card.checklist.length) * 100}%"></div></div>` : ""}`;
    li.querySelector(".wf-title").textContent = card.title;
    return li;
  }

  /** Live numbers once a second: the running session and the running card's total. */
  function tick() {
    if (!board || !board.running || !isOpen() || document.hidden) return;
    const extra = liveExtra();
    document.querySelectorAll('#wf-panel [data-live="session"]').forEach((el) => (el.textContent = fmtClock(board.running.seconds + extra)));
    const card = board.running_card_id && cardById(board.running_card_id);
    if (card) document.querySelectorAll('#wf-panel [data-live="card"]').forEach((el) => (el.textContent = fmtDur(tracked(card))));
    if (editing && card && editing.id === card.id) $("wf-f-tracked").textContent = fmtDur(tracked(card));
  }

  // ---------------------------------------------------------- board interactions

  $("wf-board").addEventListener("click", attempt(async (e) => {
    const act = e.target.closest("[data-act]");
    const cardNode = e.target.closest(".wf-card");
    if (act && act.dataset.act === "timer") return toggleTimer(cardById(Number(cardNode.dataset.id)));
    if (act && act.dataset.act === "col-menu") return openColumnMenu(act, Number(act.closest(".wf-col").dataset.col));
    if (act && act.dataset.act === "add-card") {
      const colId = Number(act.closest(".wf-col").dataset.col);  // read before the button leaves the page
      return inlineInput(act, "Card title, Enter to add", async (title) => {
        await api("POST", "/api/workflow/cards", { column_id: colId, title });
      });
    }
    if (act && act.dataset.act === "add-col") return inlineInput(act, "Column name, Enter to add", async (name) => {
      await api("POST", "/api/workflow/columns", { name });
    });
    if (cardNode) openCard(Number(cardNode.dataset.id));
  }));

  /** Swap a button for a text field; Enter creates (and keeps the field open for the next one). */
  function inlineInput(button, placeholder, create) {
    const input = document.createElement("input");
    input.placeholder = placeholder;
    input.maxLength = 300;
    button.replaceWith(input);
    input.focus();
    const restore = () => { if (input.isConnected) input.replaceWith(button); };
    input.addEventListener("blur", () => setTimeout(restore, 150));
    input.addEventListener("keydown", attempt(async (e) => {
      if (e.key === "Escape") { e.stopPropagation(); input.blur(); }
      if (e.key !== "Enter" || !input.value.trim()) return;
      await create(input.value.trim());
      const holder = input.closest(".wf-col")?.dataset.col;
      await load();
      // Keep adding: reopen the field in the re-rendered column.
      const again = holder ? document.querySelector(`.wf-col[data-col="${holder}"] [data-act="add-card"]`)
        : document.querySelector('[data-act="add-col"]');
      if (again) again.click();
    }));
  }

  // Drag & drop of cards between and within columns.
  const placeholder = document.createElement("li");
  placeholder.className = "wf-placeholder";

  $("wf-board").addEventListener("dragstart", (e) => {
    const node = e.target.closest(".wf-card");
    if (!node) return;
    dragId = Number(node.dataset.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(dragId));
    setTimeout(() => node.classList.add("dragging"), 0);
    menu.hidden = true;
  });
  $("wf-board").addEventListener("dragend", () => {
    dragId = null;
    placeholder.remove();
    document.querySelectorAll(".wf-card.dragging, .wf-col.drop-target").forEach((n) => n.classList.remove("dragging", "drop-target"));
  });
  $("wf-board").addEventListener("dragover", (e) => {
    const col = e.target.closest(".wf-col");
    if (dragId === null || !col) return;
    e.preventDefault();
    document.querySelectorAll(".wf-col.drop-target").forEach((n) => n !== col && n.classList.remove("drop-target"));
    col.classList.add("drop-target");
    const list = col.querySelector(".wf-cards");
    const next = [...list.querySelectorAll(".wf-card:not(.dragging)")].find((n) => {
      const r = n.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (next) list.insertBefore(placeholder, next);
    else list.appendChild(placeholder);
  });
  $("wf-board").addEventListener("drop", attempt(async (e) => {
    const col = e.target.closest(".wf-col");
    if (dragId === null || !col) return;
    e.preventDefault();
    const colId = Number(col.dataset.col);
    // Position among all cards of the column (some may be hidden by a filter).
    const ids = cardsIn(colId).map((c) => c.id).filter((id) => id !== dragId);
    if (placeholder.parentElement !== col.querySelector(".wf-cards")) col.querySelector(".wf-cards").appendChild(placeholder);
    let before = placeholder.nextElementSibling;
    while (before && !before.classList.contains("wf-card")) before = before.nextElementSibling;
    if (before && Number(before.dataset.id) === dragId) before = before.nextElementSibling;
    let after = placeholder.previousElementSibling;
    if (after && Number(after.dataset.id) === dragId) after = after.previousElementSibling;
    const position = before ? ids.indexOf(Number(before.dataset.id))
      : after ? ids.indexOf(Number(after.dataset.id)) + 1 : ids.length;
    const id = dragId;
    const card = cardById(id);
    const wasRunning = card.running;
    // Show the result right away, then sync.
    ids.splice(position, 0, id);
    card.column_id = colId;
    ids.forEach((cid, i) => (cardById(cid).position = i));
    placeholder.remove();
    renderBoard();
    await api("POST", `/api/workflow/cards/${id}/move`, { column_id: colId, position });
    await load();
    if (wasRunning && !cardById(id)?.running) trackerRefresh();  // moved to a done column: timer stopped
  }));

  // ---------------------------------------------------------- column menu

  function openColumnMenu(button, colId) {
    const col = columnById(colId);
    const idx = board.columns.indexOf(col);
    const count = cardsIn(colId).length;
    menu.innerHTML = `
      <label>Name <input type="text" data-f="name" maxlength="100"></label>
      <label>WIP limit <input type="number" data-f="wip" min="0" max="999"> <span class="muted small">0 = none</span></label>
      <label><input type="checkbox" data-f="done"> Done column</label>
      <button class="btn link" data-a="save"><b>Save</b></button>
      <hr>
      <button class="btn link" data-a="left" ${idx === 0 ? "disabled" : ""}>Move left</button>
      <button class="btn link" data-a="right" ${idx === board.columns.length - 1 ? "disabled" : ""}>Move right</button>
      <button class="btn link" data-a="archive" ${count ? "" : "disabled"}>Archive all cards (${count})</button>
      <button class="btn link" data-a="delete" style="color:var(--danger)">Delete column</button>`;
    menu.querySelector('[data-f="name"]').value = col.name;
    menu.querySelector('[data-f="wip"]').value = col.wip_limit;
    menu.querySelector('[data-f="done"]').checked = col.is_done;
    menu.onkeydown = (e) => { if (e.key === "Enter") menu.querySelector('[data-a="save"]').click(); };
    menu.onclick = attempt(async (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (!a) return;
      if (a === "save") {
        await api("PATCH", `/api/workflow/columns/${colId}`, {
          name: menu.querySelector('[data-f="name"]').value,
          wip_limit: Number(menu.querySelector('[data-f="wip"]').value) || 0,
          is_done: menu.querySelector('[data-f="done"]').checked,
        });
      } else if (a === "left" || a === "right") {
        const ids = board.columns.map((c) => c.id);
        const j = idx + (a === "left" ? -1 : 1);
        [ids[idx], ids[j]] = [ids[j], ids[idx]];
        await api("POST", "/api/workflow/columns/order", { ids });
      } else if (a === "archive") {
        if (!confirm(`Archive all ${count} card${count === 1 ? "" : "s"} in “${col.name}”?`)) return;
        await Promise.all(cardsIn(colId).map((c) => api("PATCH", `/api/workflow/cards/${c.id}`, { archived: true })));
        trackerRefresh();
      } else if (a === "delete") {
        if (!confirm(`Delete the column “${col.name}”?`)) return;
        await api("DELETE", `/api/workflow/columns/${colId}`);
      }
      menu.hidden = true;
      await load();
    });
    menu.hidden = false;  // so it can be measured
    const r = button.getBoundingClientRect();
    showMenuAt(r.right - menu.offsetWidth, r.bottom + 4);
    menu.querySelector('[data-f="name"]').focus();
  }

  /** Show the menu at (x, y), kept inside the window; flips up when there's no room below. */
  function showMenuAt(x, y) {
    menu.hidden = false;
    const viewW = document.documentElement.clientWidth;  // without the scrollbar
    const w = menu.offsetWidth, h = menu.offsetHeight;
    if (y + h > window.innerHeight - 8) y = Math.max(8, y - h);
    menu.style.left = Math.max(8, Math.min(x, viewW - w - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
  }
  document.addEventListener("mousedown", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-act="col-menu"]')) menu.hidden = true;
  });
  $("wf-board").addEventListener("scroll", () => (menu.hidden = true), true);

  // ---------------------------------------------------------- card menu (right click)

  $("wf-board").addEventListener("contextmenu", (e) => {
    const node = e.target.closest(".wf-card");
    if (!node || dragId !== null) return;
    e.preventDefault();
    openCardMenu(cardById(Number(node.dataset.id)), e.clientX, e.clientY);
  });

  function openCardMenu(card, x, y) {
    const others = board.columns.filter((c) => c.id !== card.column_id);
    menu.innerHTML = `
      <button class="btn link" data-a="open"><b>Open</b></button>
      <button class="btn link" data-a="timer">${card.running ? "Stop timer" : board.running ? "Switch timer to this card" : "Start timer"}</button>
      ${others.length ? `<hr><div class="wf-menu-label">Move to</div>
        ${others.map((c) => `<button class="btn link" data-a="move" data-col="${c.id}">${esc(c.name)}</button>`).join("")}` : ""}
      <hr><div class="wf-menu-label">Priority</div>
      <div class="wf-menu-row">${Object.entries(PRIO).map(([v, n]) =>
        `<button class="btn link${card.priority === v ? " on" : ""}" data-a="prio" data-v="${v}">${v ? `<i class="wf-prio ${v}"></i>` : ""}${n}</button>`).join("")}</div>
      <hr>
      <button class="btn link" data-a="duplicate">Duplicate</button>
      <button class="btn link" data-a="archive">Archive</button>
      <button class="btn link" data-a="delete" style="color:var(--danger)">Delete</button>`;
    menu.onkeydown = null;
    menu.onclick = attempt(async (e) => {
      const btn = e.target.closest("[data-a]");
      if (!btn) return;
      menu.hidden = true;
      const a = btn.dataset.a;
      if (a === "open") return openCard(card.id);
      if (a === "timer") return toggleTimer(card);
      if (a === "move") {
        await api("POST", `/api/workflow/cards/${card.id}/move`, { column_id: Number(btn.dataset.col), position: 1e6 });
      } else if (a === "prio") {
        await api("PATCH", `/api/workflow/cards/${card.id}`, { priority: btn.dataset.v });
      } else if (a === "duplicate") {
        const copy = await api("POST", "/api/workflow/cards", { column_id: card.column_id, title: card.title + " (copy)" });
        await api("PATCH", `/api/workflow/cards/${copy.id}`, {
          description: card.description, priority: card.priority, due_date: card.due_date, estimate: card.estimate,
          labels: card.labels, checklist: card.checklist.map((i) => ({ text: i.text, done: false })),
        });
        await api("POST", `/api/workflow/cards/${copy.id}/move`, { column_id: card.column_id, position: card.position + 1 });
      } else if (a === "archive") {
        await api("PATCH", `/api/workflow/cards/${card.id}`, { archived: true });
      } else if (a === "delete") {
        if (!confirm(`Delete “${card.title}”? Its tracked time stays in the tracker.`)) return;
        await api("DELETE", `/api/workflow/cards/${card.id}`);
      }
      await load();
      if (card.running && a !== "prio" && a !== "duplicate") trackerRefresh();  // a done column, archive or delete stops it
    });
    showMenuAt(x, y);
  }

  // ---------------------------------------------------------- filters, archive view

  $("wf-q").addEventListener("input", () => { filters.q = $("wf-q").value.trim(); renderBoard(); });
  $("wf-label").addEventListener("change", () => { filters.label = $("wf-label").value; renderBoard(); });
  $("wf-prio").addEventListener("change", () => { filters.prio = $("wf-prio").value; renderBoard(); });

  $("wf-archive-btn").onclick = attempt(async () => {
    view = view === "archive" ? "board" : "archive";
    if (view === "archive") await renderArchive();
    render();
  });

  async function renderArchive() {
    const cards = await api("GET", "/api/workflow/archive");
    const box = $("wf-archive");
    if (!cards.length) { box.innerHTML = `<p class="muted">No archived cards.</p>`; return; }
    box.innerHTML = `<ul></ul>`;
    const ul = box.querySelector("ul");
    for (const c of cards) {
      const li = document.createElement("li");
      const col = columnById(c.column_id);
      li.innerHTML = `<div class="grow"><b></b><div class="small muted">${col ? esc(col.name) : ""}
        ${c.done_at ? " · done " + shortDate(c.done_at.slice(0, 10)) : ""}${c.tracked_seconds ? " · " + fmtDur(c.tracked_seconds) + " tracked" : ""}</div></div>
        <button class="btn ghost" data-a="restore">Restore</button>
        <button class="btn link" data-a="delete">Delete</button>`;
      li.querySelector("b").textContent = c.title;
      li.onclick = attempt(async (e) => {
        const a = e.target.dataset.a;
        if (a === "restore") await api("PATCH", `/api/workflow/cards/${c.id}`, { archived: false });
        else if (a === "delete") {
          if (!confirm("Delete this card for good? Its tracked time stays in the tracker.")) return;
          await api("DELETE", `/api/workflow/cards/${c.id}`);
        } else return;
        await load();
        await renderArchive();
      });
      ul.appendChild(li);
    }
  }

  // ---------------------------------------------------------- card dialog

  function openCard(id) {
    const card = cardById(id);
    editing = { ...card, checklist: card.checklist.map((i) => ({ ...i })) };
    $("wf-f-title").value = card.title;
    $("wf-f-desc").value = card.description;
    $("wf-f-col").innerHTML = board.columns.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    $("wf-f-col").value = card.column_id;
    $("wf-f-prio").value = card.priority;
    $("wf-f-due").value = card.due_date || "";
    $("wf-f-est").value = card.estimate ? card.estimate / 3600 : "";
    $("wf-f-labels").value = card.labels.join(", ");
    $("wf-f-check-new").value = "";
    $("wf-f-error").textContent = "";
    $("wf-f-sessions-box").open = false;
    renderChecklist();
    renderCardTime();
    loadCardSessions();
    dialog.showModal();
    $("wf-f-title").focus();
  }

  function renderCardTime() {
    const card = cardById(editing.id) || editing;
    const sec = tracked(card);
    $("wf-f-tracked").textContent = fmtDur(sec);
    $("wf-f-est-note").textContent = card.estimate
      ? (sec > card.estimate ? `${fmtDur(sec - card.estimate)} over the ${hours(card.estimate)} estimate`
        : `of ${hours(card.estimate)} estimate · ${fmtDur(card.estimate - sec)} left`) : "";
    const btn = $("wf-f-timer");
    btn.textContent = card.running ? "Stop timer" : board.running ? "Switch timer to this card" : "Start timer";
    btn.className = "btn " + (card.running ? "stop" : "start");
    $("wf-f-link").hidden = !board.running || card.running;  // timer started elsewhere → count it here
  }

  async function loadCardSessions() {
    const id = editing.id;
    const sessions = await api("GET", `/api/workflow/cards/${id}/sessions`);
    if (!editing || editing.id !== id) return;
    $("wf-f-sessions-sum").textContent = `Sessions (${sessions.length})`;
    const ul = $("wf-f-sessions");
    ul.innerHTML = sessions.length ? "" : `<li class="muted">No time tracked on this card yet.</li>`;
    for (const s of sessions) {
      const li = document.createElement("li");
      const day = parseYmd(s.start_time.slice(0, 10)).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      li.innerHTML = `<span>${day}</span><span>${s.start_time.slice(11, 16)} – ${s.running ? "now" : s.end_time.slice(11, 16)}</span>
        <span class="grow">${fmtDur(s.seconds)}</span><button type="button" class="btn link" title="Stop counting this session towards the card (it stays in the tracker)">Unlink</button>`;
      li.querySelector("button").onclick = attempt(async () => {
        await api("DELETE", `/api/workflow/sessions/${s.id}`);
        await load();
        renderCardTime();
        await loadCardSessions();
      });
      ul.appendChild(li);
    }
  }

  function renderChecklist() {
    const ul = $("wf-f-checklist");
    ul.innerHTML = "";
    editing.checklist.forEach((item, i) => {
      const li = document.createElement("li");
      li.className = item.done ? "done" : "";
      li.innerHTML = `<input type="checkbox"><input type="text" maxlength="300"><button type="button" class="btn link" aria-label="Remove">${I.x}</button>`;
      const [box, text] = li.querySelectorAll("input");
      box.checked = item.done;
      text.value = item.text;
      box.onchange = () => { item.done = box.checked; li.className = item.done ? "done" : ""; checkCount(); };
      text.oninput = () => (item.text = text.value);
      li.querySelector("button").onclick = () => { editing.checklist.splice(i, 1); renderChecklist(); };
      ul.appendChild(li);
    });
    checkCount();
  }
  const checkCount = () => {
    const n = editing.checklist.length;
    const done = editing.checklist.filter((i) => i.done).length;
    $("wf-f-check-count").textContent = n ? `${done}/${n}` : "";
    $("wf-f-check-bar").hidden = !n;
    $("wf-f-check-bar").firstChild.style.width = n ? (done / n) * 100 + "%" : "0";
  };

  $("wf-f-check-new").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();  // don't submit the form
    const text = $("wf-f-check-new").value.trim();
    if (!text) return;
    editing.checklist.push({ text, done: false });
    $("wf-f-check-new").value = "";
    renderChecklist();
  });

  const closeDialog = () => { dialog.close(); editing = null; };
  $("wf-f-x").onclick = closeDialog;
  $("wf-f-cancel").onclick = closeDialog;
  dialog.addEventListener("cancel", () => (editing = null));  // Esc

  // Enter with nothing to type into focused (blank space, a checkbox): save and close the card.
  // (Listens on the document: a click on blank space can leave focus on <body>, outside the dialog.)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing || !dialog.open) return;
    const el = document.activeElement;
    const ownsEnter = (el.tagName === "INPUT" && el.type !== "checkbox") || /^(TEXTAREA|SELECT|BUTTON|SUMMARY|A)$/.test(el.tagName);
    if (ownsEnter || !editing) return;
    e.preventDefault();
    $("wf-form").requestSubmit();
  });

  $("wf-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const est = Number($("wf-f-est").value);
    try {
      const id = editing.id;
      const wasRunning = cardById(id).running;
      await api("PATCH", `/api/workflow/cards/${id}`, {
        title: $("wf-f-title").value,
        description: $("wf-f-desc").value,
        priority: $("wf-f-prio").value,
        due_date: $("wf-f-due").value || null,
        estimate: est > 0 ? Math.round(est * 3600) : 0,
        labels: $("wf-f-labels").value.split(","),
        checklist: editing.checklist,
      });
      const colId = Number($("wf-f-col").value);
      if (colId !== editing.column_id) await api("POST", `/api/workflow/cards/${id}/move`, { column_id: colId, position: 1e6 });
      closeDialog();
      await load();
      if (wasRunning) trackerRefresh();  // title is the tracker's note; a done column stops the timer
    } catch (err) {
      $("wf-f-error").textContent = err.message;
    }
  });

  $("wf-f-timer").onclick = attempt(async () => {
    await toggleTimer(cardById(editing.id));
    renderCardTime();
    await loadCardSessions();
  });
  $("wf-f-link").onclick = attempt(async () => {
    await api("POST", `/api/workflow/cards/${editing.id}/link`);
    await load();
    trackerRefresh();
    renderCardTime();
    await loadCardSessions();
  });
  $("wf-f-archive").onclick = attempt(async () => {
    await api("PATCH", `/api/workflow/cards/${editing.id}`, { archived: true });
    closeDialog();
    await load();
    trackerRefresh();
  });
  $("wf-f-delete").onclick = attempt(async () => {
    if (!confirm("Delete this card? Its tracked time stays in the tracker.")) return;
    const wasRunning = cardById(editing.id)?.running;
    await api("DELETE", `/api/workflow/cards/${editing.id}`);
    closeDialog();
    await load();
    if (wasRunning) trackerRefresh();
  });

  // ---------------------------------------------------------- stay in sync with the tracker page

  // Start/Stop and entry edits on the tracker page change what runs; catch up right after.
  for (const id of ["toggle", "session-form"]) {
    const el = $(id);
    if (el) el.addEventListener(id === "toggle" ? "click" : "submit", () => setTimeout(() => load().catch(() => {}), 400));
  }

  const busy = () => dragId !== null || (panel.contains(document.activeElement) && document.activeElement.tagName === "INPUT"
    && document.activeElement.id !== "wf-q");

  setInterval(() => { if (!document.hidden) tick(); }, 1000);
  setInterval(() => {
    if (document.hidden || busy() || !menu.hidden) return;
    load().catch(() => {});
  }, 10000);

  setWide(store.get("wide") === "1");
  if (store.get("open") === "1") setOpen(true);
  else load().catch((e) => showError("Workflow: " + e.message));
})();
