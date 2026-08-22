"use strict";

const state = {
  data: null,
  selectedX50: "x2",
  x50TrackOffset: -560,
  spinning: false,
  countdownTimer: null,
  clockTimer: null,
  crashTimer: null,
  crashStartedAt: 0,
  crashActive: false,
  roundClosesAt: 0,
  roundDurationMs: 10000,
  lastRouletteKey: "",
  x50TrackSignature: "",
  depositTimer: null,
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
    cancelled: "отменено",
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
  const telegramInitData = window.Telegram?.WebApp?.initData || "";
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": telegramInitData,
      ...(options.headers || {})
    },
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
    delete button.dataset.originalText;
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

function renderX50(roulette) {
  const segments = Array.isArray(roulette.segments) ? roulette.segments : [];
  const trackSignature = segments.map((segment) => `${segment.label}:${segment.multiplier || ""}`).join("|");
  if (state.x50TrackSignature !== trackSignature) {
    const trackItems = buildX50Sequence(segments);
    $("#rouletteWheel").innerHTML = trackItems.map((segment) => `<div class="x50-segment ${x50Class(segment.label)}" data-track-label="${escapeHtml(segment.label)}">${escapeHtml(segment.label)}</div>`).join("");
    state.x50TrackSignature = trackSignature;
  }

  const playableSegments = segments.filter((segment) => String(segment.label).toUpperCase() !== "БОНУС");
  const round = roulette.round || {};
  const bets = Array.isArray(round.bets) ? round.bets : [];
  const inGame = Number(roulette?.round?.totalBet || 0);
  const inGameElement = $("#rouletteInGame");
  if (inGameElement) inGameElement.textContent = `${asMoney(inGame)} USDT`;
  state.roundClosesAt = round.active ? Number(round.closesAt || 0) : 0;
  state.roundDurationMs = Number(round.durationMs || 10000);
  const participants = Array.isArray(round.participants) ? round.participants : [];
  $("#roulettePlayersCount").textContent = `${participants.length} ${participants.length === 1 ? "игрок" : participants.length > 1 && participants.length < 5 ? "игрока" : "игроков"}`;
  $("#rouletteYourBet").textContent = `Ваша ставка: ${asMoney(round.userTotalBet)} USDT`;
  $("#roulettePlayers").innerHTML = participants.length ? participants.map((participant) => {
    const username = safeText(participant.username, "player");
    return `<div class="roulette-player"><i>${escapeHtml(username.slice(0, 1).toUpperCase())}</i><div><strong>@${escapeHtml(username)}</strong><small>${participant.betsCount} ${participant.betsCount === 1 ? "ставка" : "ставки"}</small></div><b>${asMoney(participant.amount)} USDT</b></div>`;
  }).join("") : '<div class="roulette-empty">Стань первым участником раунда</div>';
  $("#multiplierRow").innerHTML = playableSegments.map((segment, index) => {
    const active = String(segment.label).toUpperCase() === state.selectedX50.toUpperCase();
    const placedBet = bets.find((bet) => String(bet.choice).toUpperCase() === String(segment.label).toUpperCase());
    const placed = Boolean(placedBet);
    return `<button class="multiplier-card ${active ? "selected" : ""} ${placed ? "placed" : ""}" data-x50-choice="${escapeHtml(segment.label)}" type="button"><div class="${x50Class(segment.label)}">${escapeHtml(segment.label)}</div><small>${placed ? `Ваша ставка · ${asMoney(placedBet.amount)} USDT` : "Выбрать сектор"}</small></button>`;
  }).join("");

  const bonus = roulette.bonus || {};
  const countdown = Number(round.secondsLeft || 0);
  const countdownElement = $("#rouletteCountdown");
  const roundLabel = $(".round-state span");
  const spinButton = $("#spinButton");
  const spinButtonText = spinButton?.querySelector("span");
  if (countdownElement) countdownElement.textContent = round.active ? countdown.toFixed(1) : bonus.locked ? "BOR" : "10.0";
  if (!round.active) {
    countdownElement?.classList.remove("urgent");
    const progressElement = $("#rouletteProgress");
    if (progressElement) progressElement.style.width = bonus.locked ? "100%" : "0%";
  }
  if (roundLabel) roundLabel.textContent = bonus.active
    ? "выбери одну карту"
    : round.active
      ? `ваших ставок ${bets.length}/${round.maxBets || 2} · деньги списаны`
      : "до следующей игры";

  const canPlace = !bonus.locked && (!round.active || bets.length < Number(round.maxBets || 2));
  if (spinButton) spinButton.disabled = !canPlace;
  if (spinButtonText) spinButtonText.textContent = bonus.active ? "Выбрать карту" : bonus.locked ? "Бонусный раунд" : round.active && bets.length === 1 ? "Поставить ещё" : "Сделать ставку";

  const last = roulette.lastResult;
  if (last) {
    const won = last.won ?? Number(last.payout) > 0;
    $("#rouletteResult").textContent = won
      ? `Выпало ${last.label}. Выигрыш: ${asMoney(last.payout)} USDT.`
      : `Выпало ${last.label}. Ставка на ${safeText(last.choice, "другой сектор")} не сыграла.`;
    $("#rouletteResult").classList.toggle("win", won);
  }

  if (round.active) {
    $("#rouletteResult").textContent = bets.length === 1
      ? "Ставка принята. Можно выбрать другой множитель и поставить второй раз."
      : "Две ставки приняты. Ждём результат раунда.";
    $("#rouletteResult").classList.remove("win");
  }
  if (bonus.active) {
    $("#rouletteResult").textContent = "Выпал БОНУС. Открой одну красную карту BOR.";
    $("#rouletteResult").classList.remove("win");
    openBonusModal(bonus);
  } else if (bonus.waiting) {
    $("#rouletteResult").textContent = `Карта выбрана: x${bonus.multiplier}. Начислено ${asMoney(bonus.payout)} USDT. Ждём остальных игроков.`;
    $("#rouletteResult").classList.add("win");
    closeBonusModal();
  } else if (bonus.locked) {
    $("#rouletteResult").textContent = "Идёт бонусный раунд участников. Следующий общий раунд скоро начнётся.";
    $("#rouletteResult").classList.remove("win");
    closeBonusModal();
  } else {
    closeBonusModal();
  }

  const result = roulette.lastResult;
  const resultKey = result ? `${result.rotation}:${result.label}:${result.payout}:${result.bonusMultiplier || ""}` : "";
  if (resultKey && resultKey !== state.lastRouletteKey && !result.pendingBonus) {
    state.lastRouletteKey = resultKey;
    animateRouletteResult(result);
  }
}

function updateX50Clock() {
  const countdownElement = $("#rouletteCountdown");
  const progressElement = $("#rouletteProgress");
  if (!countdownElement || !progressElement || !state.roundClosesAt) return;
  const remainingMs = Math.max(0, state.roundClosesAt - Date.now());
  const remaining = remainingMs / 1000;
  countdownElement.textContent = remaining.toFixed(1);
  countdownElement.classList.toggle("urgent", remaining <= 3);
  progressElement.style.width = `${Math.max(0, Math.min(100, remainingMs / state.roundDurationMs * 100))}%`;
}

function animateRouletteResult(result) {
  const track = $("#rouletteWheel");
  const windowElement = $("#rouletteWindow");
  if (!track || !windowElement) return;
  const targetLabels = [...track.querySelectorAll("[data-track-label]")];
  const matching = targetLabels.filter((item) => item.dataset.trackLabel.toUpperCase() === String(result.label).toUpperCase());
  const target = matching[Math.max(0, matching.length - 2)] || targetLabels[targetLabels.length - 4];
  if (!target) return;
  const targetCenter = target.offsetLeft + target.offsetWidth / 2;
  const finalOffset = Math.round(windowElement.clientWidth / 2 - targetCenter);
  const startOffset = finalOffset + Math.max(650, windowElement.clientWidth * 2);
  track.classList.remove("rolling");
  track.style.transition = "none";
  track.style.transform = `translate3d(${startOffset}px,0,0)`;
  void track.offsetWidth;
  track.style.transition = "";
  requestAnimationFrame(() => {
    track.classList.add("rolling");
    track.style.transform = `translate3d(${finalOffset}px,0,0)`;
  });
  window.setTimeout(() => track.classList.remove("rolling"), 4800);
  state.x50TrackOffset = finalOffset;
}

function openBonusModal(bonus) {
  const modal = $("#bonusModal");
  if (!modal || modal.classList.contains("open")) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  $("#bonusCards").innerHTML = (bonus.cards || []).map((card) => `<button class="bonus-card" data-bonus-index="${card.index}" type="button"><span>BOR</span><small>Открыть</small></button>`).join("");
  $("#bonusBet").textContent = `${asMoney(bonus.bet)} USDT`;
}

function closeBonusModal() {
  const modal = $("#bonusModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

async function pickBonusCard(index, button) {
  if (!button || button.disabled) return;
  $$("[data-bonus-index]").forEach((card) => { card.disabled = true; });
  button.classList.add("flipped");
  try {
    const result = await api("/api/roulette/bonus", { method: "POST", body: JSON.stringify({ index }) });
    button.innerHTML = `<span class="bonus-prize">x${result.multiplier}</span><small>Выигрыш</small>`;
    $("#bonusCards").classList.add("revealed");
    render(result.data);
    toast(`Карта BOR: x${result.multiplier}. Начислено ${asMoney(result.payout)} USDT.`);
    window.setTimeout(closeBonusModal, 1800);
  } catch (error) {
    $$("[data-bonus-index]").forEach((card) => { card.disabled = false; });
    button.classList.remove("flipped");
    toast(error.message);
  }
}

function renderGames(games) {
  const list = Array.isArray(games) ? games : [];
  $("#gameGrid").innerHTML = list.map((game) => `
    <button class="game-card ${escapeHtml(game.theme)}" ${game.live ? `data-open-game="${escapeHtml(game.id)}"` : "disabled"} type="button">
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
  const reserved = Number(user?.in_game || 0);
  $("#minesInGame").textContent = asMoney(reserved) + " USDT";
  $("#minesBalanceHint").textContent = "Доступно: " + asMoney(user?.balance) + " USDT. Резерв: " + asMoney(reserved) + " USDT до результата.";
  const minesAction = $("#startMines");
  const canCashout = active && Number(session.safePicks || 0) > 0;
  const waitingReset = !active && Boolean(outcome);
  minesAction.textContent = active ? "Забрать выигрыш" : waitingReset ? "Раунд завершён" : "Начать игру";
  minesAction.disabled = (active && !canCashout) || waitingReset;
  minesAction.classList.toggle("cashout-ready", canCashout);

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
    const label = isMine
      ? '<img src="/assets/mines-bomb.jpg" alt="Мина">'
      : isSafe
        ? '<img src="/assets/mines-safe.jpg" alt="Безопасная клетка">'
        : "";
    const accessible = isMine ? "Мина" : isSafe ? "Безопасная клетка" : `Клетка ${index + 1}`;
    return `<button class="mine-tile ${className}" data-cell="${index}" type="button" aria-label="${accessible}" ${disabled ? "disabled" : ""}>${label}</button>`;
  }).join("");

  const outcomePanel = $("#minesOutcome");
  const outcomeTitle = $("#minesOutcomeTitle");
  const outcomeAmount = $("#minesOutcomeAmount");
  const outcomeReset = $("#minesOutcomeReset");
  outcomePanel.classList.toggle("open", Boolean(outcome?.type === "loss" || outcome?.type === "cashout"));
  outcomePanel.classList.toggle("win", outcome?.type === "cashout");
  outcomePanel.classList.toggle("loss", outcome?.type === "loss");
  if (outcome?.type === "cashout") {
    outcomeTitle.textContent = "Вы забрали";
    outcomeAmount.textContent = `${asMoney(outcome.payout)} $`;
  } else if (outcome?.type === "loss") {
    outcomeTitle.textContent = "Вы проиграли";
    outcomeAmount.textContent = `−${asMoney(outcome.amount || session.bet)} $`;
  } else {
    outcomeTitle.textContent = "";
    outcomeAmount.textContent = "";
  }
  outcomeReset.textContent = Number(session.secondsToReset || 0) > 0 ? `Новое поле через ${session.secondsToReset} сек.` : "";

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
  $("#profileWagerRemaining").textContent = `${asMoney(user.wager_remaining)} USDT`;
  $("#profileWager").classList.toggle("complete", Number(user.wager_remaining || 0) <= 0);
  $("#vipBadge").textContent = safeText(user.vip_level, "Серебро");
  $("#adminPanel").classList.toggle("hidden", !user.is_admin);
  if (!user.is_admin && $("#adminPanel").classList.contains("open")) closePanels();
  ["#adminButton", "#profileAdminButton", "#openAdminFromMenu"].forEach((selector) => $(selector)?.classList.toggle("hidden", !user.is_admin));

  $("#adminUserName").textContent = displayName;
  $("#adminUserHandle").textContent = `@${username}`;
  $("#adminUserBalance").textContent = `${asMoney(user.balance)} USDT`;
  $(".mini-avatar").textContent = initial;
}

function renderAdminAccessHint(data) {
  const oldHint = $("#adminAccessHint");
  oldHint?.remove();
  if (data.user?.is_admin) return;
  const menu = $(".profile-menu");
  if (!menu) return;
  const hint = document.createElement("div");
  hint.id = "adminAccessHint";
  hint.className = "admin-access-hint";
  if (!data.app?.telegramBotTokenConfigured || !data.app?.adminIdsConfigured) {
    const missing = [];
    if (!data.app?.telegramBotTokenConfigured) missing.push("BOT_TOKEN");
    if (!data.app?.adminIdsConfigured) missing.push("ADMIN_ID");
    hint.textContent = `Админка закрыта: на сервере не настроено ${missing.join(" и ")}.`;
  } else if (!data.auth?.telegramValid) {
    hint.textContent = "Админка закрыта: открой приложение именно из кнопки Telegram-бота, чтобы Telegram передал подпись.";
  } else {
    hint.textContent = `Админка закрыта: Telegram ID ${data.auth.telegramId} не совпадает с ADMIN_ID на сервере.`;
  }
  menu.appendChild(hint);
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
  $("#withdrawalList").innerHTML = items.length ? items.map((item) => {
    const hasTelegramId = Number.isSafeInteger(Number(item.user_id)) && Number(item.user_id) > 0;
    const pendingActions = hasTelegramId
      ? `<button class="mini-action approve" data-withdraw-status="approved" data-withdraw-id="${item.id}" type="button">Одобрить</button><button class="mini-action" data-withdraw-status="rejected" data-withdraw-id="${item.id}" type="button">Отклонить</button>`
      : `<button class="mini-action" data-withdraw-status="rejected" data-withdraw-id="${item.id}" type="button">Отклонить тестовую</button>`;
    const identityWarning = hasTelegramId ? "" : " · нет Telegram ID";
    return `
    <div class="admin-list-item">
      <div><strong>@${escapeHtml(item.username)} · ${asMoney(item.amount)} USDT</strong><span>${escapeHtml(translateStatus(item.status))} · ${escapeHtml(translateStatus(item.risk_score))}${escapeHtml(identityWarning)}${item.auto_error ? ` · ${escapeHtml(item.auto_error)}` : ""}</span></div>
      <div class="item-actions">${item.status === "pending" || item.status === "review" ? pendingActions : `<small>${escapeHtml(translateStatus(item.status))}</small>`}</div>
    </div>`;
  }).join("") : '<div class="admin-list-item"><div><strong>Заявок нет</strong><span>Очередь вывода пуста.</span></div></div>';
}

function renderPromos(promos) {
  const items = Array.isArray(promos) ? promos : [];
  $("#adminPromosCount").textContent = String(items.filter((promo) => promo.active).length);
  $("#promoList").innerHTML = items.length ? items.map((promo) => `
    <div class="admin-list-item">
      <div><strong>${escapeHtml(promo.code)}</strong><span>${promo.activated_count}/${promo.activation_limit} активаций · бонус ${asMoney(promo.bonus_amount)} USDT · вагер x${Number(promo.wager_multiplier || 0).toFixed(1)}</span></div>
      <button class="mini-action" data-delete-promo="${promo.id}" type="button">Удалить</button>
    </div>`).join("") : '<div class="admin-list-item"><div><strong>Промокодов нет</strong><span>Создайте первый промокод.</span></div></div>';
}

function renderDeposits(data) {
  const items = Array.isArray(data.deposits) ? data.deposits : [];
  $("#invoiceHint").textContent = data.app.cryptobotConfigured
    ? "Оплата счёта проверяется автоматически в течение 30 секунд."
    : "Платёжный токен не настроен: доступен демонстрационный режим счёта.";

  $("#paymentLight").classList.toggle("online", Boolean(data.app.cryptobotConfigured));
  $("#paymentStatus").textContent = data.app.cryptobotConfigured ? "Подключён" : "Демо-режим";

  $("#depositList").innerHTML = items.length ? items.map((item) => {
    const status = item.credited ? "paid" : String(item.status || "pending").toLowerCase();
    return `<div class="wallet-operation ${escapeHtml(status)}"><i>↓</i><div><strong>+${asMoney(item.paid_amount || item.amount)} ${escapeHtml(item.asset || "USDT")}</strong><span>${item.credited ? "Зачислено на баланс" : escapeHtml(translateStatus(status))} · ${formatHistoryDate(item.created_at)}</span></div><b>${item.credited ? "Успешно" : escapeHtml(translateStatus(status))}</b></div>`;
  }).join("") : '<div class="wallet-history-empty">Пополнений пока нет</div>';

  const withdrawals = Array.isArray(data.userWithdrawals) ? data.userWithdrawals : [];
  $("#userWithdrawalList").innerHTML = withdrawals.length ? withdrawals.map((item) => {
    const status = String(item.status || "pending").toLowerCase();
    const canCancel = (status === "pending" || status === "review") && !item.transfer_attempted_at && !item.transfer_id && !item.auto_error;
    return `<div class="wallet-operation withdrawal ${escapeHtml(status)}"><i>↑</i><div><strong>−${asMoney(item.amount)} ${escapeHtml(item.asset || "USDT")}</strong><span>${escapeHtml(translateStatus(status))} · ${formatHistoryDate(item.created_at)}</span>${item.auto_error ? `<small>${escapeHtml(item.auto_error)}</small>` : ""}</div><b>${escapeHtml(translateStatus(status))}</b>${canCancel ? `<button class="cancel-withdraw" data-cancel-withdraw="${item.id}" type="button">Отменить</button>` : ""}</div>`;
  }).join("") : '<div class="wallet-history-empty">Выводов пока нет</div>';

  updateWithdrawalCooldown(withdrawals);

}

function formatHistoryDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "без даты";
  return date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function updateWithdrawalCooldown(withdrawals = state.data?.userWithdrawals || []) {
  const latest = withdrawals[0];
  const elapsed = latest ? Date.now() - new Date(latest.created_at).getTime() : 10000;
  const left = Math.max(0, Math.ceil((10000 - elapsed) / 1000));
  const button = $("#withdrawButton");
  const hint = $("#withdrawCooldown");
  if (button && !button.dataset.originalText) button.disabled = left > 0;
  if (hint) {
    hint.textContent = left > 0 ? `Новая заявка через ${left} сек.` : "Новая заявка доступна";
    hint.classList.toggle("ready", left === 0);
  }
}

async function cancelWithdrawal(id) {
  const result = await api(`/api/withdrawals/${id}/cancel`, { method: "POST", body: "{}" });
  render(result.data);
  toast("Заявка отменена, средства возвращены на баланс.");
}

function renderSettings(settings) {
  $("#settingAutoWithdraw").checked = settings?.auto_withdraw === "1";
  $("#settingRiskAlerts").checked = settings?.risk_alerts === "1";
  $("#settingFreezeQueue").checked = settings?.freeze_queue === "1";
  $("#settingMinWithdraw").value = Number(settings?.min_withdraw || 1).toFixed(2);
}

function renderCrash(crash) {
  const session = crash || {};
  const stage = $("#crashStage");
  const rocket = $("#crashRocket");
  const multiplier = Number(session.multiplier || 1);
  const active = Boolean(session.active);
  const crashed = session.status === "crashed";
  $("#crashMultiplier").textContent = `×${multiplier.toFixed(2)}`;
  $("#crashStatus").textContent = active ? "Ракета летит" : crashed ? `Взрыв на x${multiplier.toFixed(2)}` : session.status === "cashed_out" ? "Выигрыш забран" : "Готова к старту";
  stage.classList.toggle("running", active);
  stage.classList.toggle("crashed", crashed);
  stage.classList.toggle("cashed-out", session.status === "cashed_out");
  state.crashActive = active;
  state.crashStartedAt = active ? Number(session.startedAt || Date.now()) : 0;
  const flight = Math.min(1, Math.max(0, (multiplier - 1) / 5));
  rocket.style.transform = `translate(${flight * 170}px, ${-flight * 105}px) rotate(${flight * 18 - 8}deg)`;
  $("#crashResult").textContent = active ? "Ракета летит. Забирай выигрыш до взрыва." : crashed ? `Ракета взорвалась на x${multiplier.toFixed(2)}. Ставка сгорела.` : session.status === "cashed_out" ? `Выигрыш ${asMoney(session.lastOutcome?.payout)} USDT зачислен на баланс.` : "Сделай ставку и забери выигрыш до взрыва.";
  $("#crashResult").classList.toggle("win", session.status === "cashed_out");
  const button = $("#startCrash");
  button.textContent = active ? "Забрать выигрыш" : "Запустить ракету";
  button.disabled = false;
  button.classList.toggle("cashout-ready", active);
}

function updateCrashAnimation() {
  if (!state.crashActive || !state.crashStartedAt) return;
  const elapsed = Math.max(0, Date.now() - state.crashStartedAt);
  const multiplier = Math.min(100, Math.max(1, Math.exp(elapsed / 7000)));
  const flight = Math.min(1, Math.max(0, (multiplier - 1) / 5));
  const multiplierElement = $("#crashMultiplier");
  const rocket = $("#crashRocket");
  if (multiplierElement) multiplierElement.textContent = `×${multiplier.toFixed(2)}`;
  if (rocket) rocket.style.transform = `translate(${flight * 170}px, ${-flight * 105}px) rotate(${flight * 18 - 8}deg)`;
}

function renderAdminSummary(data) {
  $("#adminUsersCount").textContent = String(data.admin?.usersCount || 0);
  $("#adminVolume").textContent = asMoney(data.admin?.totalVolume);
}

function render(data) {
  state.data = data;
  document.title = `${safeText(data.app?.title, "BOR")} — мини-приложение`;
  $("#brandTitle").textContent = safeText(data.app?.title, "BOR");
  const minWithdraw = Math.max(0.1, Number(data.limits?.minWithdraw || 1));
  $("#withdrawAmount").min = String(minWithdraw);
  $("#withdrawAmount").placeholder = minWithdraw.toFixed(2);
  renderUser(data.user || {});
  renderAdminAccessHint(data);
  renderX50(data.roulette || {});
  renderGames(data.games || []);
  renderMines(data.mines || {}, data.user || {});
  renderCrash(data.crash || {});
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

function startRoundPolling() {
  clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(() => {
    if (!state.spinning) refresh().catch(() => {});
  }, 1000);
  clearInterval(state.clockTimer);
  state.clockTimer = setInterval(updateX50Clock, 100);
  clearInterval(state.crashTimer);
  state.crashTimer = setInterval(updateCrashAnimation, 50);
  clearInterval(state.depositTimer);
  state.depositTimer = setInterval(() => syncDeposits().catch(() => {}), 30000);
  setInterval(() => updateWithdrawalCooldown(), 1000);
}

function setBetValue(selector, action) {
  const input = $(selector);
  const minimum = 0.1;
  const current = Math.max(minimum, Number(input.value || minimum));
  const balance = Math.max(minimum, Number(state.data?.user?.balance || minimum));
  if (action === "half") input.value = Math.max(minimum, current / 2).toFixed(2);
  if (action === "double") input.value = Math.min(balance, current * 2).toFixed(2);
  if (action === "max") input.value = balance.toFixed(2);
}

function selectX50(label) {
  state.selectedX50 = label;
  $$('[data-x50-choice]').forEach((button) => button.classList.toggle("selected", button.dataset.x50Choice === label));
}

async function spinRoulette() {
  if (state.spinning || state.data?.roulette?.bonus?.active) return;
  const button = $("#spinButton");
  const bet = Number($("#rouletteBet").value || 0);
  state.spinning = true;
  setButtonBusy(button, true, "Ставка принимается…");
  try {
    const result = await api("/api/roulette/spin", {
      method: "POST",
      body: JSON.stringify({ bet, choice: state.selectedX50 })
    });
    render(result.data);
    toast(result.status === "bet_accepted" ? "Ставка принята. Деньги списаны." : "Готово");
  } finally {
    state.spinning = false;
    setButtonBusy(button, false);
    if (state.data?.roulette?.round?.bets?.length >= 2) button.disabled = true;
  }
}

async function startMines() {
  const button = $("#startMines");
  setButtonBusy(button, true, "Начинаем…");
  try {
    const result = await api("/api/mines/start", {
      method: "POST",
      body: JSON.stringify({ bet: Number($("#minesBet").value || 0), mineCount: Number($("#mineCount").value || 3) })
    });
    render(result.data);
  } finally {
    setButtonBusy(button, false);
    if (state.data) renderMines(state.data.mines || {}, state.data.user || {});
  }
}

async function revealMine(index) {
  const result = await api("/api/mines/reveal", { method: "POST", body: JSON.stringify({ index }) });
  render(result.data);
}

async function cashoutMines() {
  const button = $("#startMines");
  setButtonBusy(button, true, "Забираем…");
  try {
    const result = await api("/api/mines/cashout", { method: "POST", body: "{}" });
    render(result.data);
  } finally {
    setButtonBusy(button, false);
    if (state.data) renderMines(state.data.mines || {}, state.data.user || {});
  }
}

async function startCrash() {
  const button = $("#startCrash");
  setButtonBusy(button, true, "Запускаем…");
  try {
    const result = await api("/api/crash/start", { method: "POST", body: JSON.stringify({ bet: Number($("#crashBet").value || 0) }) });
    render(result.data);
  } finally { setButtonBusy(button, false); if (state.data) renderCrash(state.data.crash || {}); }
}

async function cashoutCrash() {
  const button = $("#startCrash");
  setButtonBusy(button, true, "Забираем…");
  try {
    const result = await api("/api/crash/cashout", { method: "POST", body: "{}" });
    render(result.data);
    toast(`Ракета: начислено ${asMoney(result.payout)} USDT.`);
  } finally { setButtonBusy(button, false); if (state.data) renderCrash(state.data.crash || {}); }
}

async function handleCrashAction() {
  if (state.data?.crash?.active) await cashoutCrash(); else await startCrash();
}

async function handleMinesAction() {
  if (state.data?.mines?.active) {
    await cashoutMines();
  } else {
    await startMines();
  }
}

async function submitDeposit() {
  const button = $("#depositButton");
  const amount = Number($("#depositAmount").value || 0);
  if (!Number.isFinite(amount) || amount < 0.2) {
    setMessage("#cashierResult", "Минимальное пополнение 0.20 USDT", "error");
    return;
  }
  setButtonBusy(button, true, "Создаём счёт…");
  try {
    const result = await api("/api/deposit/create-check", { method: "POST", body: JSON.stringify({ amount }) });
    render(result.data);
    setMessage("#cashierResult", result.message);
    if (result.invoiceUrl) {
      const telegramWebApp = window.Telegram?.WebApp;
      if (/^https?:\/\/t\.me\//i.test(result.invoiceUrl) && telegramWebApp?.openTelegramLink) {
        telegramWebApp.openTelegramLink(result.invoiceUrl);
      } else if (telegramWebApp?.openLink) {
        telegramWebApp.openLink(result.invoiceUrl);
      } else {
        window.open(result.invoiceUrl, "_blank", "noopener,noreferrer");
      }
    }
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
    setMessage("#cashierResult", result.status === "approved" ? "Автовывод успешно отправлен через CryptoBot." : result.status === "review" ? "Автовывод не прошёл. Заявк�� отправлена администратору." : "Заявка на вывод отправлена администратору.");
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
        wager_multiplier: Number($("#promoWager").value || 0),
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
  const username = $("#adminBalanceUsername").value.trim().replace(/^@+/, "");
  const amount = Number($("#adminBalanceAmount").value || 0);
  const result = await api("/api/admin/users/balance", { method: "POST", body: JSON.stringify({ username, amount, operation }) });
  render(result.data);
  $("#adminBalanceAmount").value = "";
  setMessage("#adminOverviewMessage", `${operation === "add" ? "Начислено" : "Списано"} для @${result.target.username}. Баланс: ${asMoney(result.target.balance)} USDT.`);
}

async function resetAllBalances() {
  const button = $("#adminResetAllBalances");
  const confirmed = window.confirm("Обнулить баланс и средства в играх абсолютно у всех пользователей? Отменить это действие будет нельзя.");
  if (!confirmed) return;
  setButtonBusy(button, true, "Обнуляем…");
  try {
    const result = await api("/api/admin/users/reset-balances", {
      method: "POST",
      body: JSON.stringify({ confirmation: "RESET_ALL_BALANCES" })
    });
    render(result.data);
    setMessage("#adminOverviewMessage", `Обнулено аккаунтов: ${result.clearedUsers}. Очищено: ${asMoney(result.clearedAmount)} USDT.`);
    toast("Все балансы обнулены.");
  } finally {
    setButtonBusy(button, false);
  }
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
        freeze_queue: $("#settingFreezeQueue").checked,
        min_withdraw: Number($("#settingMinWithdraw").value || 1)
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

  $("#betMinus").addEventListener("click", () => { $("#rouletteBet").value = Math.max(0.1, Number($("#rouletteBet").value || 0.1) - 0.1).toFixed(2); });
  $("#betPlus").addEventListener("click", () => { $("#rouletteBet").value = (Number($("#rouletteBet").value || 0.1) + 0.1).toFixed(2); });
  $$('[data-bet-action]').forEach((button) => button.addEventListener("click", () => setBetValue("#rouletteBet", button.dataset.betAction)));
  $$('[data-mines-bet]').forEach((button) => button.addEventListener("click", () => setBetValue("#minesBet", button.dataset.minesBet)));
  $$('[data-mine-count]').forEach((button) => button.addEventListener("click", () => {
    $("#mineCount").value = button.dataset.mineCount;
    $$('[data-mine-count]').forEach((item) => item.classList.toggle("active", item === button));
  }));
  $$('[data-deposit-amount]').forEach((button) => button.addEventListener("click", () => { $("#depositAmount").value = button.dataset.depositAmount; }));

  $("#spinButton").addEventListener("click", () => spinRoulette().catch((error) => { $("#rouletteResult").textContent = error.message; toast(error.message); }));
  $("#startMines").addEventListener("click", () => handleMinesAction().catch((error) => { $("#minesResult").textContent = error.message; toast(error.message); }));
  $("#startCrash").addEventListener("click", () => handleCrashAction().catch((error) => { $("#crashResult").textContent = error.message; toast(error.message); }));
  $$('[data-crash-bet]').forEach((button) => button.addEventListener("click", () => setBetValue("#crashBet", button.dataset.crashBet)));
  $("#depositButton").addEventListener("click", () => submitDeposit().catch((error) => setMessage("#cashierResult", error.message, "error")));
  $("#withdrawButton").addEventListener("click", () => submitWithdrawal().catch((error) => setMessage("#cashierResult", error.message, "error")));
  $("#activatePromo").addEventListener("click", () => activatePromo().catch((error) => toast(error.message)));
  $("#createPromo").addEventListener("click", () => createPromo().catch((error) => setMessage("#adminPromoMessage", error.message, "error")));
  $("#adminBalanceAdd").addEventListener("click", () => adjustBalance("add").catch((error) => setMessage("#adminOverviewMessage", error.message, "error")));
  $("#adminBalanceRemove").addEventListener("click", () => adjustBalance("remove").catch((error) => setMessage("#adminOverviewMessage", error.message, "error")));
  $("#adminResetAllBalances").addEventListener("click", () => resetAllBalances().catch((error) => setMessage("#adminOverviewMessage", error.message, "error")));
  $("#saveSettings").addEventListener("click", () => saveSettings().catch((error) => setMessage("#adminSettingsMessage", error.message, "error")));
  $("#refreshAdmin").addEventListener("click", () => refresh().then(() => toast("Данные обновлены.")).catch((error) => toast(error.message)));

  document.body.addEventListener("click", (event) => {
    const target = event.target.closest("button, a");
    if (!target) return;
    if (target.dataset.x50Choice) selectX50(target.dataset.x50Choice);
    if (target.dataset.bonusIndex !== undefined) pickBonusCard(Number(target.dataset.bonusIndex), target);
    if (target.dataset.cell !== undefined) revealMine(Number(target.dataset.cell)).catch((error) => { $("#minesResult").textContent = error.message; });
    if (target.dataset.deletePromo) deletePromo(target.dataset.deletePromo).catch((error) => toast(error.message));
    if (target.dataset.withdrawId) changeWithdrawalStatus(target.dataset.withdrawId, target.dataset.withdrawStatus).catch((error) => toast(error.message));
    if (target.dataset.cancelWithdraw) cancelWithdrawal(target.dataset.cancelWithdraw).catch((error) => toast(error.message));
    if (target.dataset.openGame === "mines") $("#minesGame").scrollIntoView({ behavior: "smooth", block: "start" });
    if (target.dataset.openGame === "crash") $("#crashGame").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("#closeBonus").addEventListener("click", closeBonusModal);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closePanels(); closeBonusModal(); } });
}

async function boot() {
  const telegramWebApp = window.Telegram?.WebApp;
  if (telegramWebApp) {
    telegramWebApp.ready();
    telegramWebApp.expand();
  }
  bindEvents();
  startRoundPolling();
  await refresh();
}

boot().catch((error) => toast(`Не удалось загрузить приложение: ${error.message}`));
