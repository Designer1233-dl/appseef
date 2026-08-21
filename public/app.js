const state = {
  data: null,
  rouletteRotation: 0,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const tabs = $$("[data-tab]");
const sections = $$("[data-section]");
const adminTabs = $$("[data-admin-tab]");
const adminSections = $$("[data-admin-section]");
const overlay = $("#overlay");
const adminPanel = $("#adminPanel");
const cashierSheet = $("#cashierSheet");

function showMessage(text, target = "#cashierResult") {
  $(target).textContent = text;
}

function asMoney(value) {
  return Number(value || 0).toFixed(2);
}

function closePanels() {
  overlay.classList.remove("open");
  adminPanel.classList.remove("open");
  cashierSheet.classList.remove("open");
}

function openPanel(kind) {
  overlay.classList.add("open");
  adminPanel.classList.toggle("open", kind === "admin");
  cashierSheet.classList.toggle("open", kind === "cashier");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function renderActivity(activity) {
  $("#activityLog").innerHTML = activity.length
    ? activity
        .map(
          (item) => `
            <div class="list-item">
              <div>
                <strong>@${item.username}</strong>
                ${item.action}
              </div>
              <span>${item.tag}</span>
            </div>
          `
        )
        .join("")
    : `<div class="list-item"><div><strong>Лог пуст</strong>Операции появятся после действий.</div></div>`;
}

function renderFeed(feed) {
  $("#x50Feed").innerHTML = feed.length
    ? feed
        .map(
          (item) => `
            <div class="feed-item">
              <span>${item.user}</span>
              <strong>${asMoney(item.amount)} USDT</strong>
            </div>
          `
        )
        .join("")
    : `<div class="feed-item"><span>Лента пуста</span><strong>Ждём первых x50</strong></div>`;
}

function renderWithdrawals(withdrawals) {
  $("#withdrawalList").innerHTML = withdrawals.length
    ? withdrawals
        .map(
          (item) => `
            <div class="list-item">
              <div>
                <strong>@${item.username}</strong>
                ${asMoney(item.amount)} USDT • ${item.status}
              </div>
              <span>${item.risk_score}</span>
            </div>
          `
        )
        .join("")
    : `<div class="list-item"><div><strong>Выводов пока нет</strong>Новые заявки появятся здесь.</div></div>`;
}

function renderPromos(promos) {
  $("#promoList").innerHTML = promos.length
    ? promos
        .map(
          (promo) => `
            <div class="list-item">
              <div>
                <strong>${promo.code}</strong>
                ${promo.activated_count}/${promo.activation_limit} активаций • ${promo.deposit_required ? `депозит от ${promo.deposit_min}` : "без депозита"}
              </div>
              <button class="secondary-btn promo-delete" data-delete-promo="${promo.id}" type="button">Удалить</button>
            </div>
          `
        )
        .join("")
    : `<div class="list-item"><div><strong>Промокодов нет</strong>Создай первый промокод в админке.</div></div>`;
}

function renderGames(games) {
  $("#gameGrid").innerHTML = games
    .map(
      (game) => `
        <div class="game-card ${game.theme}">
          <div class="game-icon">${game.icon}</div>
          <div class="game-note">${game.note}</div>
          <div class="game-title">${game.name}</div>
          <div class="game-status">${game.live ? "Играй ниже" : "Скоро откроем"}</div>
        </div>
      `
    )
    .join("");
}

function renderRoulette(roulette) {
  const wheel = $("#rouletteWheel");
  const segments = roulette.segments || [];

  $("#multiplierRow").innerHTML = segments
    .map((segment) => `<div class="multiplier-pill">${segment.label}</div>`)
    .join("");

  if (roulette.lastResult) {
    state.rouletteRotation = roulette.lastResult.rotation;
    wheel.style.transform = `rotate(${state.rouletteRotation}deg)`;
    $("#rouletteResult").textContent =
      roulette.lastResult.multiplier > 0
        ? `Выпало ${roulette.lastResult.label}. Выплата: ${asMoney(roulette.lastResult.payout)} USDT`
        : `Выпало ${roulette.lastResult.label}. Ставка не сыграла.`;
  } else {
    $("#rouletteResult").textContent = "Выигрыш появится после прокрутки.";
  }
}

function renderMines(mines) {
  const active = mines.active;
  const revealed = new Set(mines.revealed || []);
  const outcome = mines.lastOutcome;
  const mineIndexes = new Set(outcome && outcome.type === "loss" ? outcome.mines || [] : []);
  const multiplier = mines.bet ? mines.potentialWin / mines.bet : 1;

  $("#minesPotential").textContent = `${asMoney(mines.potentialWin)} USDT`;
  $("#minesSafePicks").textContent = String(mines.safePicks || 0);
  $("#minesMultiplier").textContent = `x${Number(multiplier).toFixed(2)}`;
  $("#cashoutMines").disabled = !active || (mines.safePicks || 0) < 1;

  if (outcome?.type === "loss") {
    showMessage("Мина открыта. Ставка сгорела.", "#minesResult");
  } else if (outcome?.type === "cashout") {
    showMessage(`Кэшаут: ${asMoney(outcome.payout)} USDT`, "#minesResult");
  } else if (active) {
    showMessage("Игра идёт. Ищи безопасные клетки или забирай выигрыш.", "#minesResult");
  } else {
    showMessage("Запусти игру и открывай безопасные клетки.", "#minesResult");
  }

  $("#minesGrid").innerHTML = Array.from({ length: 25 }, (_, index) => {
    const isSafe = revealed.has(index) && !mineIndexes.has(index);
    const isMine = mineIndexes.has(index);
    const disabled = !active || revealed.has(index) || isMine;
    const className = isMine ? "mine" : isSafe ? "safe" : "";
    const label = isMine ? "✕" : isSafe ? "◆" : "•";
    return `<button class="mine-tile ${className}" data-cell="${index}" type="button" ${disabled ? "disabled" : ""}>${label}</button>`;
  }).join("");
}

function renderDeposits(data) {
  const items = data.deposits || [];
  const latest = items[0];
  $("#invoiceHint").textContent = data.app.cryptobotConfigured
    ? "Оплаченный счёт будет зачтён после webhook или ручной проверки."
    : "CryptoBot API не настроен. Сейчас можно проверить только интерфейс.";

  $("#depositList").innerHTML = items.length
    ? items
        .map(
          (item) => `
            <div class="list-item">
              <div>
                <strong>${asMoney(item.amount)} ${item.asset}</strong>
                ${item.credited ? "зачислено" : item.status}
              </div>
              <span>${item.invoice_hash || "invoice"}</span>
            </div>
          `
        )
        .join("")
    : `<div class="list-item"><div><strong>Счётов пока нет</strong>Создай первый счёт в кассе.</div></div>`;

  if (latest) {
    const latestUrl = latest.mini_app_invoice_url || latest.web_app_invoice_url || latest.invoice_url;
    if (latestUrl) {
      $("#latestInvoiceLink").href = latestUrl;
      $("#latestInvoiceLink").textContent = "Открыть счёт";
    } else {
      $("#latestInvoiceLink").removeAttribute("href");
      $("#latestInvoiceLink").textContent = "Ссылка недоступна";
    }
  }
}

function renderUser(user) {
  $("#headerBalance").textContent = `${asMoney(user.balance)} USDT`;
  $("#profileName").textContent = user.display_name || "Пустой профиль";
  $("#profileUsername").textContent = user.username ? `@${user.username}` : "Данные подтянутся из Telegram позже.";
  $("#profileId").textContent = `ID ${user.id || 1}`;
  $("#profileBalance").textContent = `${asMoney(user.balance)} USDT`;
  $("#profileInGame").textContent = `${asMoney(user.in_game)} USDT`;
  $("#profileGamesPlayed").textContent = String(user.games_played ?? 0);
  $("#profileWins").textContent = String(user.wins ?? 0);
  $("#profileVolume").textContent = `${asMoney(user.volume)} USDT`;
  $("#vipBadge").textContent = user.vip_level || "Silver";
  $("#adminButton").classList.toggle("hidden", !user.is_admin);
}

function renderMeta(app) {
  document.title = `${app.title} Mini App`;
  $("#brandTitle").textContent = app.title;
  $("#appMode").textContent = app.mode;
}

async function activatePromo() {
  const code = $("#promoActivateCode").value.trim();
  const result = await api("/api/promos/activate", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
  render(result.data);
  $("#promoActivateCode").value = "";
  showMessage(result.message, "#cashierResult");
}

async function createPromo() {
  const result = await api("/api/admin/promos", {
    method: "POST",
    body: JSON.stringify({
      code: $("#promoCode").value.trim(),
      bonus_amount: Number($("#promoBonus").value || 0),
      activation_limit: Number($("#promoLimit").value || 0),
      deposit_min: Number($("#promoDepositMin").value || 0),
      expires_at: $("#promoExpiresAt").value.trim(),
      deposit_required: $("#promoDepositRequired").checked,
    }),
  });
  render(result.data);
  showMessage("Промокод создан", "#cashierResult");
}

async function deletePromo(id) {
  const result = await api(`/api/admin/promos/${id}/delete`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  render(result.data);
  showMessage("Промокод удалён", "#cashierResult");
}

function render(data) {
  state.data = data;
  renderMeta(data.app);
  renderUser(data.user);
  renderFeed(data.x50Feed || []);
  renderActivity(data.activity || []);
  renderWithdrawals(data.withdrawals || []);
  renderPromos(data.promos || []);
  renderGames(data.games || []);
  renderRoulette(data.roulette || { segments: [] });
  renderMines(data.mines || {});
  renderDeposits(data);
}

async function refresh() {
  const payload = await api("/api/bootstrap");
  render(payload);
}

async function submitDeposit() {
  const amount = Number($("#depositAmount").value || 0);
  const result = await api("/api/deposit/create-check", {
    method: "POST",
    body: JSON.stringify({ amount }),
  });
  render(result.data);
  showMessage(result.message);
  if (result.invoiceUrl) {
    window.open(result.invoiceUrl, "_blank", "noopener,noreferrer");
  }
}

async function syncDeposits() {
  const result = await api("/api/deposits/sync");
  render(result.data);
  showMessage(`Проверено счетов: ${result.stats.checked}, новых оплат: ${result.stats.updated}`);
}

async function submitWithdrawal() {
  const amount = Number($("#withdrawAmount").value || 0);
  const result = await api("/api/withdrawals", {
    method: "POST",
    body: JSON.stringify({ amount }),
  });
  render(result.data);
  showMessage(`Вывод создан. Статус: ${result.status}`);
}

async function spinRoulette() {
  const bet = Number($("#rouletteBet").value || 0);
  const result = await api("/api/roulette/spin", {
    method: "POST",
    body: JSON.stringify({ bet }),
  });
  $("#rouletteWheel").style.transform = `rotate(${result.result.rotation}deg)`;
  render(result.data);
}

async function startMines() {
  const bet = Number($("#minesBet").value || 0);
  const mineCount = Number($("#mineCount").value || 3);
  const result = await api("/api/mines/start", {
    method: "POST",
    body: JSON.stringify({ bet, mineCount }),
  });
  render(result.data);
}

async function revealMine(index) {
  const result = await api("/api/mines/reveal", {
    method: "POST",
    body: JSON.stringify({ index }),
  });
  render(result.data);
}

async function cashoutMines() {
  const result = await api("/api/mines/cashout", {
    method: "POST",
    body: JSON.stringify({}),
  });
  render(result.data);
}

function bindTabs() {
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((item) => item.classList.remove("active"));
      sections.forEach((section) => section.classList.remove("active"));
      tab.classList.add("active");
      document.querySelector(`[data-section="${tab.dataset.tab}"]`).classList.add("active");
    });
  });
}

function bindAdminTabs() {
  adminTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      adminTabs.forEach((item) => item.classList.remove("active"));
      adminSections.forEach((section) => section.classList.remove("active"));
      tab.classList.add("active");
      document.querySelector(`[data-admin-section="${tab.dataset.adminTab}"]`).classList.add("active");
    });
  });
}

function bindEvents() {
  bindTabs();
  bindAdminTabs();
  $("#openCashier").addEventListener("click", () => openPanel("cashier"));
  $("#adminButton").addEventListener("click", () => openPanel("admin"));
  $("#closeAdmin").addEventListener("click", closePanels);
  $("#closeSheet").addEventListener("click", closePanels);
  overlay.addEventListener("click", closePanels);

  $("#depositButton").addEventListener("click", async () => {
    try {
      await submitDeposit();
    } catch (error) {
      showMessage(error.message);
    }
  });

  $("#syncDeposits").addEventListener("click", async () => {
    try {
      await syncDeposits();
    } catch (error) {
      showMessage(error.message);
    }
  });

  $("#withdrawButton").addEventListener("click", async () => {
    try {
      await submitWithdrawal();
    } catch (error) {
      showMessage(error.message);
    }
  });

  $("#spinButton").addEventListener("click", async () => {
    try {
      await spinRoulette();
    } catch (error) {
      showMessage(error.message, "#rouletteResult");
    }
  });

  $("#startMines").addEventListener("click", async () => {
    try {
      await startMines();
    } catch (error) {
      showMessage(error.message, "#minesResult");
    }
  });

  $("#cashoutMines").addEventListener("click", async () => {
    try {
      await cashoutMines();
    } catch (error) {
      showMessage(error.message, "#minesResult");
    }
  });

  $("#activatePromo").addEventListener("click", async () => {
    try {
      await activatePromo();
    } catch (error) {
      showMessage(error.message, "#cashierResult");
    }
  });

  $("#createPromo").addEventListener("click", async () => {
    try {
      await createPromo();
    } catch (error) {
      showMessage(error.message, "#cashierResult");
    }
  });

  document.body.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const promoId = target.dataset.deletePromo;
    if (promoId) {
      try {
        await deletePromo(promoId);
      } catch (error) {
        showMessage(error.message, "#cashierResult");
      }
      return;
    }
    const cell = target.dataset.cell;
    if (!cell) {
      return;
    }
    try {
      await revealMine(Number(cell));
    } catch (error) {
      showMessage(error.message, "#minesResult");
    }
  });
}

async function boot() {
  bindEvents();
  await refresh();
}

boot().catch((error) => {
  showMessage(error.message);
});
