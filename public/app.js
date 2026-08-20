const state = {
  data: null,
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

function showMessage(text) {
  $("#cashierResult").textContent = text;
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

function asMoney(value) {
  return Number(value || 0).toFixed(2);
}

function renderFeed(feed) {
  $("#x50Feed").innerHTML = feed
    .map((item) => `<div>${item.user}<strong>${item.amount.toFixed(2)}</strong></div>`)
    .join("");
}

function renderGames(games) {
  $("#gameGrid").innerHTML = games
    .map(
      (game) => `
        <div class="game-card ${game.theme}">
          <div class="game-icon">${game.icon}</div>
          <div class="game-note">${game.note}</div>
          <div class="game-title">${game.name}</div>
        </div>
      `
    )
    .join("");
}

function renderActivity(activity) {
  $("#activityLog").innerHTML = activity
    .map(
      (item) => `
        <div class="list-item">
          <div>
            <strong>@${item.username}</strong>
            ${item.action}
          </div>
          <span class="badge ${item.tag === "risk" ? "redy" : item.tag === "promo" ? "goldy" : "greeny"}">${item.tag}</span>
        </div>
      `
    )
    .join("");
}

function renderWithdrawals(withdrawals) {
  $("#withdrawalList").innerHTML = withdrawals
    .map(
      (item) => `
        <div class="list-item">
          <div>
            <strong>#${item.id} • @${item.username}</strong>
            ${asMoney(item.amount)} USDT • ${item.status}
          </div>
          <div class="row-actions">
            <button class="mini-btn ok" data-approve="${item.id}" type="button">Подтвердить</button>
            <button class="mini-btn no" data-reject="${item.id}" type="button">Отклонить</button>
          </div>
        </div>
      `
    )
    .join("");
}

function renderPromos(promos) {
  $("#promoList").innerHTML = promos
    .map(
      (promo) => `
        <div class="list-item">
          <div>
            <strong>${promo.code}</strong>
            ${promo.activated_count}/${promo.activation_limit} активаций • ${promo.deposit_required ? `депозит от ${promo.deposit_min}` : "без депозита"}
          </div>
          <button class="mini-btn no" data-delete-promo="${promo.id}" type="button">Удалить</button>
        </div>
      `
    )
    .join("");
}

function renderWheel(wheels) {
  const wheel = wheels[0];
  if (!wheel) {
    return;
  }

  $("#wheelPool").textContent = `${asMoney(wheel.prize_pool)} USDT`;
  $("#wheelStatus").textContent = wheel.status === "scheduled" ? "ссылка активна" : wheel.status;
  $("#wheelDepositBadge").textContent = wheel.deposit_required ? `депозит от ${wheel.required_deposit}` : "без депозита";
  $("#wheelParticipants").textContent = `${wheel.participants} участников`;
  $("#wheelLink").value = `${window.location.origin}/?start=${wheel.slug}`;
  $("#joinWheel").dataset.slug = wheel.slug;

  $("#wheelInfo").innerHTML = `
    <div class="list-item">
      <div>
        <strong>Условие</strong>
        ${wheel.deposit_required ? `Нужен депозит от ${wheel.required_deposit} USDT` : "Нажал по ссылке и вошёл в мини‑апп"}
      </div>
      <span class="badge greeny">OK</span>
    </div>
    <div class="list-item">
      <div>
        <strong>Начало прокрутки</strong>
        Завершение ${wheel.ends_at}
      </div>
      <span class="badge goldy">таймер</span>
    </div>
    <div class="list-item">
      <div>
        <strong>Начисление</strong>
        ${wheel.winners_count} победителей по ${asMoney(wheel.prize_per_winner)} USDT
      </div>
      <span class="badge">${wheel.title}</span>
    </div>
  `;
}

function renderRisk(settings) {
  $("#riskPills").innerHTML = `
    <span>VIP Silver ${settings.vip_silver || "0"}</span>
    <span>VIP Gold ${settings.vip_gold || "0"}</span>
    <span>Risk alerts ${settings.risk_alerts || "0"}</span>
    <span>Freeze queue ${settings.freeze_queue || "0"}</span>
  `;
}

function renderUser(user) {
  $("#headerBalance").textContent = asMoney(user.balance);
  $("#profileName").textContent = user.display_name;
  $("#profileUsername").textContent = `@${user.username}`;
  $("#profileId").textContent = `ID ${user.id}`;
  $("#profileBalance").textContent = asMoney(user.balance);
  $("#profileInGame").textContent = asMoney(user.in_game);
  $("#statGames").textContent = user.games_played;
  $("#statWins").textContent = user.wins;
  $("#statVolume").textContent = asMoney(user.volume);
  $("#vipBadge").textContent = user.vip_level;
  $("#adminButton").style.visibility = user.is_admin ? "visible" : "hidden";
}

function renderSettings(settings) {
  $("#depositToggle").classList.toggle("on", settings.auto_deposit === "1");
  $("#withdrawToggle").classList.toggle("on", settings.auto_withdraw === "1");
}

function renderDeposits(data) {
  const items = data.deposits || [];
  const latest = items[0];
  $("#invoiceHint").textContent = data.app.cryptobotConfigured
    ? `Webhook: ${data.app.webhookUrl || "не настроен"}`
    : "CryptoBot API token не задан, сейчас работает mock-режим.";

  $("#depositList").innerHTML = items.length
    ? items
        .map(
          (item) => `
            <div class="list-item">
              <div>
                <strong>${asMoney(item.amount)} ${item.asset}</strong>
                ${item.status} • ${item.credited ? "зачислено" : "ожидает оплату"}
              </div>
              <a class="ghost-link" href="${item.mini_app_invoice_url || item.web_app_invoice_url || item.invoice_url || "#"}" target="_blank" rel="noreferrer">${item.invoice_hash || "open"}</a>
            </div>
          `
        )
        .join("")
    : `<div class="list-item"><div><strong>Счетов пока нет</strong>Создай первый инвойс, он появится здесь.</div><span class="badge">0</span></div>`;

  if (latest) {
    const latestUrl = latest.mini_app_invoice_url || latest.web_app_invoice_url || latest.invoice_url;
    if (latestUrl) {
      $("#latestInvoiceLink").href = latestUrl;
      $("#latestInvoiceLink").textContent = "Открыть последний счёт";
    } else {
      $("#latestInvoiceLink").removeAttribute("href");
      $("#latestInvoiceLink").textContent = "Ссылка появится после создания счёта";
    }
  }
}

function renderAppMeta(app) {
  document.title = `${app.title} Mini App`;
  $("#appTitle").textContent = app.title;
  $("#brandTitle").textContent = app.title;
  $("#appMode").textContent = app.mode;
}

function render(data) {
  state.data = data;
  renderAppMeta(data.app);
  renderUser(data.user);
  renderSettings(data.settings);
  renderFeed(data.x50Feed);
  renderGames(data.games);
  renderActivity(data.activity);
  renderWithdrawals(data.withdrawals);
  renderPromos(data.promos);
  renderWheel(data.wheels);
  renderRisk(data.settings);
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
  showMessage(`${result.message}. ${result.invoiceUrl ? `Ссылка: ${result.invoiceUrl}` : ""}`);
  if (result.invoiceUrl) {
    window.open(result.invoiceUrl, "_blank", "noopener,noreferrer");
  }
}

async function syncDeposits() {
  const result = await api("/api/deposits/sync");
  render(result.data);
  showMessage(`Проверено счетов: ${result.stats.checked}, новых зачислений: ${result.stats.updated}`);
}

async function submitWithdrawal(amountValue) {
  const amount = Number(amountValue);
  const result = await api("/api/withdrawals", {
    method: "POST",
    body: JSON.stringify({ amount }),
  });
  render(result.data);
  showMessage(`Заявка создана. Статус: ${result.status}`);
}

async function activatePromo() {
  const code = $("#promoActivateCode").value.trim();
  const result = await api("/api/promos/activate", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
  render(result.data);
  $("#promoActivateCode").value = "";
  showMessage(result.message);
}

async function toggleSetting(key, value) {
  const result = await api("/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ key, value }),
  });
  render(result.data);
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
  showMessage("Промокод создан");
}

async function createWheel() {
  const result = await api("/api/admin/wheels", {
    method: "POST",
    body: JSON.stringify({
      slug: $("#wheelSlug").value.trim(),
      title: $("#wheelTitle").value.trim(),
      prize_pool: Number($("#wheelPrize").value || 0),
      minutes_until_end: Number($("#wheelMinutes").value || 10),
      winners_count: Number($("#wheelWinners").value || 1),
      required_deposit: Number($("#wheelRequiredDeposit").value || 0),
      deposit_required: $("#wheelDepositRequired").checked,
    }),
  });
  render(result.data);
  showMessage("Колесо создано");
}

async function joinWheel(slug) {
  const result = await api(`/api/wheels/${slug}/join`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  render(result.data);
  showMessage("Участие подтверждено");
}

async function setWithdrawalStatus(id, action) {
  const result = await api(`/api/admin/withdrawals/${id}/${action}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  render(result.data);
  showMessage(`Заявка ${action === "approve" ? "подтверждена" : "отклонена"}`);
}

async function deletePromo(id) {
  const result = await api(`/api/admin/promos/${id}/delete`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  render(result.data);
  showMessage("Промокод удалён");
}

function bindStaticEvents() {
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((item) => item.classList.remove("active"));
      sections.forEach((section) => section.classList.remove("active"));
      tab.classList.add("active");
      document.querySelector(`[data-section="${tab.dataset.tab}"]`).classList.add("active");
    });
  });

  adminTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      adminTabs.forEach((item) => item.classList.remove("active"));
      adminSections.forEach((section) => section.classList.remove("active"));
      tab.classList.add("active");
      document.querySelector(`[data-admin-section="${tab.dataset.adminTab}"]`).classList.add("active");
    });
  });

  $("#adminButton").addEventListener("click", () => openPanel("admin"));
  $("#openCashier").addEventListener("click", () => openPanel("cashier"));
  $("#quickWithdraw").addEventListener("click", () => openPanel("cashier"));
  $("#closeAdmin").addEventListener("click", closePanels);
  $("#closeSheet").addEventListener("click", closePanels);
  overlay.addEventListener("click", closePanels);

  $("#depositToggle").addEventListener("click", async () => {
    const next = !$("#depositToggle").classList.contains("on");
    await toggleSetting("auto_deposit", next);
  });

  $("#withdrawToggle").addEventListener("click", async () => {
    const next = !$("#withdrawToggle").classList.contains("on");
    await toggleSetting("auto_withdraw", next);
  });

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
      await submitWithdrawal($("#withdrawAmount").value);
    } catch (error) {
      showMessage(error.message);
    }
  });

  $("#activatePromo").addEventListener("click", async () => {
    try {
      await activatePromo();
    } catch (error) {
      showMessage(error.message);
    }
  });

  $("#createPromo").addEventListener("click", async () => {
    try {
      await createPromo();
    } catch (error) {
      showMessage(error.message);
    }
  });

  $("#createWheel").addEventListener("click", async () => {
    try {
      await createWheel();
    } catch (error) {
      showMessage(error.message);
    }
  });

  document.body.addEventListener("click", async (event) => {
    const target = event.target;
    const approveId = target.dataset.approve;
    const rejectId = target.dataset.reject;
    const deletePromoId = target.dataset.deletePromo;
    const wheelSlug = target.dataset.slug;

    try {
      if (approveId) {
        await setWithdrawalStatus(approveId, "approve");
      }
      if (rejectId) {
        await setWithdrawalStatus(rejectId, "reject");
      }
      if (deletePromoId) {
        await deletePromo(deletePromoId);
      }
      if (wheelSlug) {
        await joinWheel(wheelSlug);
      }
    } catch (error) {
      showMessage(error.message);
    }
  });
}

async function boot() {
  bindStaticEvents();
  await refresh();
}

boot().catch((error) => {
  showMessage(error.message);
});
