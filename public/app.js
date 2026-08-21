"use strict";

const state = {
  data: null,
  selectedX50: "x2",
  x50TrackOffset: -560,
  spinning: false,
  countdown: 13.8,
  countdownTimer: null,
  toastTimer: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function asMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

function safeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function translateStatus(value) {
  const map = {
    pending: "ожидает",
    approved: "одобрено",
    rejected: "отклонено",
    review: "на проверке",
    clean: "без риска",
    medium: "средний риск",
    active: "активен",
    paid: "оплачен",
    invoice: "счёт",
    win: "победа",
    loss: "проигрыш",
    promo: "промокод",
    deposit: "пополнение",
    mines: "мины",
    settings: "настройки",
    admin: "администратор",
    withdrawal: "вывод",
    risk: "риск"
  };
  return map[String(value || "").toLowerCase()] || safeText(value, "—");
}

function localizeAction(value) {
  return safeText(value, "Операция")
    .replaceAll("Mines", "Мины")
    .replaceAll("cashout", "получение выигрыша")
    .replaceAll("invoice", "счёт");
}

function setMessage(selector, message, type = "success") {
  const element = $(selector);
  if (!element) return;
  element.textContent = message;
  element.classList.remove("success", "error");
  if (message) element.classList.add(type);
}

function toast(message) {
  const element = $("#toast");
  if (!element) return;
  element.textContent = message;
  element.classList.add("open");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.remove("open"), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    throw new Error("Сервер вернул некорректный ответ");
  }
  if (!response.ok) {
    throw new Error(data.error || "Не удалось выполнить запрос");
  }
  return data;
}

function setButtonBusy(button, busy, busyText = "Подождите…") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function openPanel(kind, pane = null) {
  $("#overlay").classList.add("open");
  $("#adminPanel").classList.toggle("open", kind === "admin");
  $("#cashierSheet").classList.toggle("open", kind === "cashier");
  document.body.style.overflow = "hidden";
  if (kind === "cashier" && pane) switchCashierTab(pane);
}

function closePanels() {
  $("#overlay").classList.remove("open");
  $("#adminPanel").classList.remove("open");
  $("#cashierSheet").classList.remove("open");
  document.body.style.overflow = "";
}

function goSection(name) {
  $$('[data-tab]').forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  $$('[data-section]').forEach((section) => section.classList.toggle("active", section.dataset.section === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function switchAdminTab(name) {
  $$('[data-admin-tab]').forEach((tab) => tab.classList.toggle("active", tab.dataset.adminTab === name));
  $$('[data-admin-section]').forEach((section) => section.classList.toggle("active", section.dataset.adminSection === name));
}

function switchCashierTab(name) {
  $$('[data-cashier-tab]').forEach((tab) => tab.classList.toggle("active", tab.dataset.cashierTab === name));
  $$('[data-cashier-pane]').forEach((pane) => pane.classList.toggle("active", pane.dataset.cashierPane === name));
}

function x50Class(label) {
  const value = String(label || "").toUpperCase();
  if (value === "X2") return "blue";
  if (value === "X3") return "orange";
  if (value === "X5") return "green";
  if (value === "X50") return "red";
  return "purple";
}

function buildX50Sequence(segments, repeats = 9) {
  const source = segments.length ? segments : [
    { label: "x2" }, { label: "x3" }, { label: "x5" }, { label: "x50" }, { label: "БОНУС" }
  ];
  const list = [];
  for (let round = 0; round < repeats; round += 1) {
    const offset = round % source.length;
    for (let index = 0; index < source.length; index += 1) {
      list.push(source[(index + offset) % source.length]);
    }
  }
  return list;
}

function renderX50(roulette, feed) {
  const segments = Array.isArray(roulette.segments) ? roulette.segments : [];
  const trackItems = buildX50Sequence(segments);
  $("#rouletteWheel").innerHTML = trackItems.map((segment) => `<div class="x50-segment ${x50Class(segment.label)}" data-track-label="${escapeHtml(segment.label)}">${escapeHtml(segment.label)}</div>`).join("");

  const feedValues = Array.isArray(feed) ? feed : [];
  $("#multiplierRow").innerHTML = segments.map((segment, index) => {
    const feedItem = feedValues[index] || {};
    const player = safeText(feedItem.user, "свободно");
    const amount = feedItem.amount ? `${asMoney(feedItem.amount)} USDT` : "выбрать";
    const active = String(segment.label).toUpperCase() === state.selectedX50.toUpperCase();
    return `<button class="multiplier-card ${active ? "selected" : ""}" data-x50-choice="${escapeHtml(segment.label)}" type="button"><div class="${x50Class(segment.label)}">${escapeHtml(segment.label)}</div><small>${escapeHtml(player)} · ${escapeHtml(amount)}</small></button>`;
  }).join("");

  $("#x50Feed").innerHTML = feedValues.map((item) => `<span>${escapeHtml(item.user)} — ${asMoney(item.amount)} USDT</span>`).join("");

  const last = roulette.lastResult;
  if (last) {
    const won = last.won ?? Number(last.payout) > 0;
    $("#rouletteResult").textContent = won
      ? `Выпало ${last.label}. Выигрыш: ${asMoney(last.payout)} USDT.`
      : `Выпало ${last.label}. Ставка на ${safeText(last.choice, "другой сектор")} не сыграла.`;
    $("#rouletteResult").classList.toggle("win", won);
  }
}

function renderGames(games) {
  const list = Array.isArray(games) ? games : [];
  $("#gameGrid").innerHTML = list.map((game) => `
    <button class="game-card ${escapeHtml(game.theme)}" ${game.live ? 'data-open-game="mines"' : "disabled"} type="button">
      <div class="game-icon">${escapeHtml(game.icon)}</div>
      <div class="game-note">${escapeHtml(game.note)}</div>
      <div class="game-title">${escapeHtml(game.name)}</div>
      <div class="game-status">${game.live ? "Играть сейчас" : "Скоро откроется"}</div>
    </button>
  `).join("");
}

function renderMines(mines, user) {
  const session = mines || {};
  const active = Boolean(session.active);
  const revealed = new Set(session.revealed || []);
  const outcome = session.lastOutcome || null;
  const mineIndexes = new Set(outcome?.type === "loss" ? outcome.mines || [] : []);
  const multiplier = Number(session.bet) > 0 ? Number(session.potentialWin || 0) / Number(session.bet) : 1;

  $("#minesPotential").textContent = `${asMoney(session.potentialWin)} USDT`;
  $("#minesSafePicks").textContent = String(session.safePicks || 0);
  $("#minesMultiplier").textContent = `×${Number.isFinite(multiplier) ? multiplier.toFixed(2) : "1.00"}`;
  $("#minesInGame").textContent = `${asMoney(user?.in_game)} USDT`;
  $("#startMines").disabled = active;
  $("#startMines").textContent = active ? "Игра идёт" : "Начать игру";
  $("#cashoutMines").disabled = !active || Number(session.safePicks || 0) < 1;

  const count = Number(session.mineCount || $("#mineCount").value || 3);
  $("#mineCount").value = String(count);
  $$('[data-mine-count]').forEach((button) => button.classList.toggle("active", Number(button.dataset.mineCount) === count));

  const progressMultipliers = [1.08, 1.23, 1.42, 1.64];
  $("#minesProgress").innerHTML = progressMultipliers.map((value, index) => `<span class="${Number(session.safePicks || 0) === index ? "active" : ""}"><b>${index + 1}</b>&nbsp; ${value.toFixed(2)}×</span>`).join("");

  $("#minesGrid").innerHTML = Array.from({ length: 25 }, (_, index) => {
    const isMine = mineIndexes.has(index);
    const isSafe = revealed.has(index) && !isMine;
    const disabled = !active || revealed.has(index) || isMine;
    const className = isMine ? "mine" : isSafe ? "safe" : "";
    const label = isMine ? "✹" : isSafe ? "◆" : "";
    const accessible = isMine ? "Мина" : isSafe ? "Безопасная клетка" : `Клетка ${index + 1}`;
    return `<button class="mine-tile ${className}" data-cell="${index}" type="button" aria-label="${accessible}" ${disabled ? "disabled" : ""}>${label}</button>`;
  }).join("");

  let message = "Начни игру и открывай безопасные клетки.";
  if (active) message = "Игра идёт. Открывай клетки или забирай выигрыш.";
  if (outcome?.type === "loss") message = "Открыта мина. Ставка проиграна.";
  if (outcome?.type === "cashout") message = `Выигрыш ${asMoney(outcome.payout)} USDT зачислен на баланс.`;
  $("#minesResult").textContent = message;
  $("#minesResult").classList.toggle("win", outcome?.type === "cashout");
}

function renderUser(user) {
  const username = safeText(user.username, "пользователь");
  const displayName = safeText(user.display_name, "Пользователь");
  const initial = displayName.slice(0, 1).toUpperCase();
  $("#headerBalance").textContent = asMoney(user.balance);
  $("#cashierBalance").innerHTML = `${asMoney(user.balance)} <small>USDT</small>`;
  $("#profileName").textContent = displayName;
  $("#profileUsername").textContent = `@${username}`;
  $("#profileId").textContent = `ID ${user.id || 1}`;
  $("#profileAvatar").textContent = initial;
  $("#avatarButton").textContent = initial;
  $("#profileBalance").innerHTML = `${asMoney(user.balance)} <small>USDT</small>`;
  $("#profileInGame").textContent = `${asMoney(user.in_game)} USDT`;
  $("#profileGamesPlayed").textContent = String(user.games_played || 0);
  $("#profileWins").textContent = String(user.wins || 0);
  $("#profileVolume").innerHTML = `${asMoney(user.volume)} <small>USDT</small>`;
  $("#vipBadge").textContent = safeText(user.vip_level, "Серебро");
  ["#adminButton", "#profileAdminButton", "#openAdminFromMenu"].forEach((selector) => $(selector)?.classList.toggle("hidden", !user.is_admin));

  $("#adminUserName").textContent = displayName;
  $("#adminUserHandle").textContent = `@${username}`;
  $("#adminUserBalance").textContent = `${asMoney(user.balance)} USDT`;
  $(".mini-avatar").textContent = initial;
}

function renderActivity(activity) {
  const items = Array.isArray(activity) ? activity : [];
  const itemHtml = (item, compact = false) => `
    <div class="${compact ? "timeline-item" : "admin-list-item"}">
      ${compact ? '<div class="timeline-icon">↗</div>' : ""}
      <div><strong>@${escapeHtml(item.username || "пользователь")}</strong><span>${escapeHtml(localizeAction(item.action))}</span></div>
      <small>${escapeHtml(translateStatus(item.tag))}</small>
    </div>`;
  $("#activityLog").innerHTML = items.length ? items.map((item) => itemHtml(item)).join("") : '<div class="admin-list-item"><div><strong>Операций пока нет</strong><span>Новые действия появятся здесь.</span></div></div>';
  $("#adminActivityPreview").innerHTML = items.length ? items.slice(0, 4).map((item) => itemHtml(item, true)).join("") : '<div class="timeline-item"><div class="timeline-icon">•</div><div><strong>Лента пуста</strong><span>Ожидаем первые действия.</span></div></div>';
}

function renderWithdrawals(withdrawals) {
  const items = Array.isArray(withdrawals) ? withdrawals : [];
  const pending = items.filter((item) => item.status === "pending" || item.status === "review").length;
  $("#withdrawBadge").textContent = `${pending} ${pending === 1 ? "новая" : "новых"}`;
  $("#adminPending").textContent = String(pending);
  $("#withdrawalList").innerHTML = items.length ? items.map((item) => `
    <div class="admin-list-item">
      <div><strong>@${escapeHtml(item.username)} · ${asMoney(item.amount)} USDT</strong><span>${escapeHtml(translateStatus(item.status))} · ${escapeHtml(translateStatus(item.risk_score))}</span></div>
      <div class="item-actions">${item.status === "pending" || item.status === "review" ? `<button class="mini-action approve" data-withdraw-status="approved" data-withdraw-id="${item.id}" type="button">Одобрить</button><button class="mini-action" data-withdraw-status="rejected" data-withdraw-id="${item.id}" type="button">Отклонить</button>` : `<small>${escapeHtml(translateStatus(item.status))}</small>`}</div>
    </div>`).join("") : '<div class="admin-list-item"><div><strong>Заявок нет</strong><span>Очередь вывода пуста.</span></div></div>';
}

function renderPromos(promos) {
  const items = Array.isArray(promos) ? promos : [];
  $("#adminPromosCount").textContent = String(items.filter((promo) => promo.active).length);
  $("#promoList").innerHTML = items.length ? items.map((promo) => `
    <div class="admin-list-item">
      <div><strong>${escapeHtml(promo.code)}</strong><span>${promo.activated_count}/${promo.activation_limit} активаций · бонус ${asMoney(promo.bonus_amount)} USDT</span></div>
      <button class="mini-action" data-delete-promo="${promo.id}" type="button">Удалить</button>
    </div>`).join("") : '<div class="admin-list-item"><div><strong>Промокодов нет</strong><span>Создайте первый промокод.</span></div></div>';
}

function renderDeposits(data) {
  const items = Array.isArray(data.deposits) ? data.deposits : [];
  $("#invoiceHint").textContent = data.app.cryptobotConfigured
    ? "Оплата проверяется автоматически; можно запустить проверку вручную."
    : "Платёжный токен не настроен: доступен демонстрационный режим счёта.";

  $("#paymentLight").classList.toggle("online", Boolean(data.app.cryptobotConfigured));
  $("#paymentStatus").textContent = data.app.cryptobotConfigured ? "Подключён" : "Демо-режим";

  $("#depositList").innerHTML = items.length ? items.slice(0, 4).map((item) => `
    <div class="deposit-item"><div><strong>${asMoney(item.amount)} ${escapeHtml(item.asset)}</strong><span>${item.credited ? "зачислено" : escapeHtml(translateStatus(item.status))}</span></div><small>${escapeHtml(item.invoice_hash || "счёт")}</small></div>
  `).join("") : "";

  const latest = items[0];
  const link = $("#latestInvoiceLink");
  const latestUrl = latest && (latest.mini_app_invoice_url || latest.web_app_invoice_url || latest.invoice_url);
  if (latestUrl) {
    link.href = latestUrl;
    link.textContent = "Открыть счёт";
    link.classList.remove("hidden");
  } else {
    link.removeAttribute("href");
    link.textContent = "Счёта ещё нет";
  }
}

function renderSettings(settings) {
  $("#settingAutoWithdraw").checked = settings?.auto_withdraw === "1";
  $("#settingRiskAlerts").checked = settings?.risk_alerts === "1";
  $("#settingFreezeQueue").checked = settings?.freeze_queue === "1";
}

function renderAdminSummary(data) {
  $("#adminUsersCount").textContent = "1";
  $("#adminVolume").textContent = asMoney(data.user?.volume);
}

function render(data) {
  state.data = data;
  document.title = `${safeText(data.app?.title, "BOR")} — мини-приложение`;
  $("#brandTitle").textContent = safeText(data.app?.title, "BOR");
  renderUser(data.user || {});
  renderX50(data.roulette || {}, data.x50Feed || []);
  renderGames(data.games || []);
  renderMines(data.mines || {}, data.user || {});
  renderActivity(data.activity || []);
  renderWithdrawals(data.withdrawals || []);
  renderPromos(data.promos || []);
  renderDeposits(data);
  renderSettings(data.settings || {});
  renderAdminSummary(data);
}

async function refresh() {
  const payload = await api("/api/bootstrap");
  render(payload);
}

function startCountdown() {
  clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(() => {
    if (state.spinning) return;
    state.countdown -= 0.1;
    if (state.countdown <= 0) state.countdown = 13.8;
    const element = $("#rouletteCountdown");
    if (element) element.textContent = state.countdown.toFixed(1);
  }, 100);
}

function setBetValue(selector, action) {
  const input = $(selector);
  const current = Math.max(1, Number(input.value || 1));
  const balance = Math.max(1, Number(state.data?.user?.balance || 1));
  if (action === "half") input.value = Math.max(1, current / 2).toFixed(2);
  if (action === "double") input.value = Math.min(balance, current * 2).toFixed(2);
  if (action === "max") input.value = balance.toFixed(2);
}

function selectX50(label) {
  state.selectedX50 = label;
  $$('[data-x50-choice]').forEach((button) => button.classList.toggle("selected", button.dataset.x50Choice === label));
}

async function spinRoulette() {
  if (state.spinning) return;
  const button = $("#spinButton");
  const bet = Number($("#rouletteBet").value || 0);
  state.spinning = true;
  setButtonBusy(button, true, "Игра идёт…");
  try {
    const result = await api("/api/roulette/spin", {
      method: "POST",
      body: JSON.stringify({ bet, choice: state.selectedX50 })
    });
    const track = $("#rouletteWheel");
    const targetLabels = [...track.querySelectorAll("[data-track-label]")];
    const matching = targetLabels.filter((item) => item.dataset.trackLabel === result.result.label);
    const target = matching[Math.max(0, matching.length - 2)] || targetLabels[targetLabels.length - 4];
    const windowWidth = $("#rouletteWindow").clientWidth;
    const targetCenter = target.offsetLeft + target.offsetWidth / 2;
    const finalOffset = Math.round(windowWidth / 2 - targetCenter);
    track.style.transform = `translate3d(${finalOffset}px,0,0)`;
    state.x50TrackOffset = finalOffset;
    state.countdown = 13.8;
    await new Promise((resolve) => setTimeout(resolve, 4700));
    render(result.data);
    requestAnimationFrame(() => {
      const newTrack = $("#rouletteWheel");
      newTrack.style.transition = "none";
      newTrack.style.transform = "translate3d(-560px,0,0)";
      requestAnimationFrame(() => { newTrack.style.transition = ""; });
    });
  } finally {
    state.spinning = false;
    setButtonBusy(button, false);
  }
}

async function startMines() {
  const button = $("#startMines");
  setButtonBusy(button, true);
  try {
    const result = await api("/api/mines/start", {
      method: "POST",
      body: JSON.stringify({ bet: Number($("#minesBet").value || 0), mineCount: Number($("#mineCount").value || 3) })
    });
    render(result.data);
  } finally {
    setButtonBusy(button, false);
    const active = Boolean(state.data?.mines?.active);
    button.disabled = active;
    button.textContent = active ? "Игра идёт" : "Начать игру";
  }
}

async function revealMine(index) {
  const result = await api("/api/mines/reveal", { method: "POST", body: JSON.stringify({ index }) });
  render(result.data);
}

async function cashoutMines() {
  const result = await api("/api/mines/cashout", { method: "POST", body: "{}" });
  render(result.data);
}

async function submitDeposit() {
  const button = $("#depositButton");
  setButtonBusy(button, true, "Создаём счёт…");
  try {
    const result = await api("/api/deposit/create-check", { method: "POST", body: JSON.stringify({ amount: Number($("#depositAmount").value || 0) }) });
    render(result.data);
    setMessage("#cashierResult", result.message);
    if (result.invoiceUrl) window.open(result.invoiceUrl, "_blank", "noopener,noreferrer");
  } finally {
    setButtonBusy(button, false);
  }
}

async function syncDeposits() {
  const button = $("#syncDeposits");
  setButtonBusy(button, true, "Проверяем…");
  try {
    const result = await api("/api/deposits/sync");
    render(result.data);
    setMessage("#cashierResult", `Проверено счетов: ${result.stats.checked}. Новых оплат: ${result.stats.updated}.`);
  } finally {
    setButtonBusy(button, false);
  }
}

async function submitWithdrawal() {
  const button = $("#withdrawButton");
  setButtonBusy(button, true, "Создаём заявку…");
  try {
    const result = await api("/api/withdrawals", { method: "POST", body: JSON.stringify({ amount: Number($("#withdrawAmount").value || 0) }) });
    render(result.data);
    setMessage("#cashierResult", `Заявка создана. Статус: ${translateStatus(result.status)}.`);
  } finally {
    setButtonBusy(button, false);
  }
}

async function activatePromo() {
  const code = $("#promoActivateCode").value.trim();
  const result = await api("/api/promos/activate", { method: "POST", body: JSON.stringify({ code }) });
  render(result.data);
  $("#promoActivateCode").value = "";
  toast(result.message);
}

async function createPromo() {
  const button = $("#createPromo");
  setButtonBusy(button, true, "Создаём…");
  try {
    const localDate = $("#promoExpiresAt").value;
    const result = await api("/api/admin/promos", {
      method: "POST",
      body: JSON.stringify({
        code: $("#promoCode").value.trim(),
        bonus_amount: Number($("#promoBonus").value || 0),
        activation_limit: Number($("#promoLimit").value || 0),
        deposit_min: Number($("#promoDepositMin").value || 0),
        expires_at: localDate ? new Date(localDate).toISOString() : "",
        deposit_required: $("#promoDepositRequired").checked
      })
    });
    render(result.data);
    setMessage("#adminPromoMessage", "Промокод создан.");
  } finally {
    setButtonBusy(button, false);
  }
}

async function deletePromo(id) {
  const result = await api(`/api/admin/promos/${id}/delete`, { method: "POST", body: "{}" });
  render(result.data);
  toast("Промокод удалён.");
}

async function adjustBalance(operation) {
  const amount = Number($("#adminBalanceAmount").value || 0);
  const result = await api("/api/admin/users/balance", { method: "POST", body: JSON.stringify({ amount, operation }) });
  render(result.data);
  $("#adminBalanceAmount").value = "";
  setMessage("#adminOverviewMessage", operation === "add" ? "Баланс начислен." : "Средства списаны.");
}

async function changeWithdrawalStatus(id, statusValue) {
  const result = await api(`/api/admin/withdrawals/${id}/status`, { method: "POST", body: JSON.stringify({ status: statusValue }) });
  render(result.data);
  toast(statusValue === "approved" ? "Вывод одобрен." : "Вывод отклонён и возвращён на баланс.");
}

async function saveSettings() {
  const button = $("#saveSettings");
  setButtonBusy(button, true, "Сохраняем…");
  try {
    const result = await api("/api/admin/settings", {
      method: "POST",
      body: JSON.stringify({
        auto_withdraw: $("#settingAutoWithdraw").checked,
        risk_alerts: $("#settingRiskAlerts").checked,
        freeze_queue: $("#settingFreezeQueue").checked
      })
    });
    render(result.data);
    setMessage("#adminSettingsMessage", "Настройки сохранены.");
  } finally {
    setButtonBusy(button, false);
  }
}

function bindEvents() {
  $$('[data-tab]').forEach((tab) => tab.addEventListener("click", () => goSection(tab.dataset.tab)));
  $$('[data-go-section]').forEach((button) => button.addEventListener("click", () => goSection(button.dataset.goSection)));
  $$('[data-admin-tab]').forEach((tab) => tab.addEventListener("click", () => switchAdminTab(tab.dataset.adminTab)));
  $$('[data-open-admin-section]').forEach((button) => button.addEventListener("click", () => switchAdminTab(button.dataset.openAdminSection)));
  $$('[data-cashier-tab]').forEach((tab) => tab.addEventListener("click", () => switchCashierTab(tab.dataset.cashierTab)));
  $("#overlay").addEventListener("click", closePanels);
  $("#closeAdmin").addEventListener("click", closePanels);
  $("#closeSheet").addEventListener("click", closePanels);
  $("#openCashier").addEventListener("click", () => openPanel("cashier", "deposit"));
  $("#profileDeposit").addEventListener("click", () => openPanel("cashier", "deposit"));
  $("#profileWithdraw").addEventListener("click", () => openPanel("cashier", "withdraw"));
  ["#adminButton", "#profileAdminButton", "#openAdminFromMenu"].forEach((selector) => $(selector)?.addEventListener("click", () => openPanel("admin")));

  $("#betMinus").addEventListener("click", () => { $("#rouletteBet").value = Math.max(1, Number($("#rouletteBet").value || 1) - 1).toFixed(2); });
  $("#betPlus").addEventListener("click", () => { $("#rouletteBet").value = (Number($("#rouletteBet").value || 0) + 1).toFixed(2); });
  $$('[data-bet-action]').forEach((button) => button.addEventListener("click", () => setBetValue("#rouletteBet", button.dataset.betAction)));
  $$('[data-mines-bet]').forEach((button) => button.addEventListener("click", () => setBetValue("#minesBet", button.dataset.minesBet)));
  $$('[data-mine-count]').forEach((button) => button.addEventListener("click", () => {
    $("#mineCount").value = button.dataset.mineCount;
    $$('[data-mine-count]').forEach((item) => item.classList.toggle("active", item === button));
  }));
  $$('[data-deposit-amount]').forEach((button) => button.addEventListener("click", () => { $("#depositAmount").value = button.dataset.depositAmount; }));

  $("#spinButton").addEventListener("click", () => spinRoulette().catch((error) => { $("#rouletteResult").textContent = error.message; toast(error.message); }));
  $("#startMines").addEventListener("click", () => startMines().catch((error) => { $("#minesResult").textContent = error.message; toast(error.message); }));
  $("#cashoutMines").addEventListener("click", () => cashoutMines().catch((error) => { $("#minesResult").textContent = error.message; toast(error.message); }));
  $("#depositButton").addEventListener("click", () => submitDeposit().catch((error) => setMessage("#cashierResult", error.message, "error")));
  $("#syncDeposits").addEventListener("click", () => syncDeposits().catch((error) => setMessage("#cashierResult", error.message, "error")));
  $("#withdrawButton").addEventListener("click", () => submitWithdrawal().catch((error) => setMessage("#cashierResult", error.message, "error")));
  $("#activatePromo").addEventListener("click", () => activatePromo().catch((error) => toast(error.message)));
  $("#createPromo").addEventListener("click", () => createPromo().catch((error) => setMessage("#adminPromoMessage", error.message, "error")));
  $("#adminBalanceAdd").addEventListener("click", () => adjustBalance("add").catch((error) => setMessage("#adminOverviewMessage", error.message, "error")));
  $("#adminBalanceRemove").addEventListener("click", () => adjustBalance("remove").catch((error) => setMessage("#adminOverviewMessage", error.message, "error")));
  $("#saveSettings").addEventListener("click", () => saveSettings().catch((error) => setMessage("#adminSettingsMessage", error.message, "error")));
  $("#refreshAdmin").addEventListener("click", () => refresh().then(() => toast("Данные обновлены.")).catch((error) => toast(error.message)));

  document.body.addEventListener("click", (event) => {
    const target = event.target.closest("button, a");
    if (!target) return;
    if (target.dataset.x50Choice) selectX50(target.dataset.x50Choice);
    if (target.dataset.cell !== undefined) revealMine(Number(target.dataset.cell)).catch((error) => { $("#minesResult").textContent = error.message; });
    if (target.dataset.deletePromo) deletePromo(target.dataset.deletePromo).catch((error) => toast(error.message));
    if (target.dataset.withdrawId) changeWithdrawalStatus(target.dataset.withdrawId, target.dataset.withdrawStatus).catch((error) => toast(error.message));
    if (target.dataset.openGame === "mines") $("#minesGame").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closePanels(); });
}

async function boot() {
  bindEvents();
  startCountdown();
  await refresh();
}

boot().catch((error) => toast(`Не удалось загрузить приложение: ${error.message}`));
