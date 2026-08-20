"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const https = require("https");
const path = require("path");
const { URL } = require("url");

const BASE_DIR = __dirname;
const PUBLIC_DIR = path.join(BASE_DIR, "public");
const DEFAULT_DATA_PATH = path.join(BASE_DIR, "bor-data.json");
const HOSTED_DATA_PATH = "/app/data/bor-data.json";

function envStr(name, fallback) {
  const value = process.env[name];
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function envStrAlias(primary, fallback, defaultValue) {
  const primaryValue = process.env[primary];
  if (typeof primaryValue === "string" && primaryValue.trim()) {
    return primaryValue.trim();
  }
  const fallbackValue = process.env[fallback];
  if (typeof fallbackValue === "string" && fallbackValue.trim()) {
    return fallbackValue.trim();
  }
  return defaultValue;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return fallback;
  }
  const parsed = Number.parseFloat(raw.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function resolveDataPath() {
  const customPath = process.env.BOR_DB_PATH;
  if (typeof customPath === "string" && customPath.trim()) {
    return customPath.trim();
  }
  if (fs.existsSync(path.dirname(HOSTED_DATA_PATH))) {
    return HOSTED_DATA_PATH;
  }
  return DEFAULT_DATA_PATH;
}

const HOST = envStr("BOR_HOST", "0.0.0.0");
const PORT = envInt("PORT", envInt("BOR_PORT", 8080));
const DATA_PATH = resolveDataPath();

const APP_TITLE = envStr("BOR_APP_TITLE", "BOR");
const APP_MODE = envStr("BOR_APP_MODE", "mini-app");
const DEFAULT_ADMIN_ID = envInt("BOR_DEFAULT_ADMIN_ID", 1);
const DEFAULT_ADMIN_USERNAME = envStr("BOR_DEFAULT_ADMIN_USERNAME", "borlegend");
const DEFAULT_ADMIN_DISPLAY_NAME = envStr("BOR_DEFAULT_ADMIN_DISPLAY_NAME", "Пухляк");

const CRYPTOBOT_ENABLED = envBool("BOR_CRYPTOBOT_ENABLED", false);
const CRYPTOBOT_BOT_USERNAME = envStr("BOR_CRYPTOBOT_BOT_USERNAME", "CryptoBot");
const CRYPTOBOT_API_TOKEN = envStr("BOR_CRYPTOBOT_API_TOKEN", "");
const CRYPTOBOT_WEBHOOK_SECRET = envStr("BOR_CRYPTOBOT_WEBHOOK_SECRET", "");
const CRYPTOBOT_ASSET = envStr("BOR_CRYPTOBOT_ASSET", "USDT");
const CRYPTOBOT_TESTNET = envBool("BOR_CRYPTOBOT_TESTNET", false);
const CRYPTOBOT_INVOICE_EXPIRES_IN = envInt("BOR_CRYPTOBOT_INVOICE_EXPIRES_IN", 3600);

const WEBAPP_URL = envStrAlias("WEBAPP_URL", "BOR_TELEGRAM_WEBAPP_URL", "");
const WEBHOOK_BASE_URL = envStrAlias("WEBHOOK_BASE_URL", "BOR_WEBHOOK_BASE_URL", "");

const AUTO_DEPOSIT_DEFAULT = envBool("BOR_AUTO_DEPOSIT_DEFAULT", true);
const AUTO_WITHDRAW_DEFAULT = envBool("BOR_AUTO_WITHDRAW_DEFAULT", true);
const AUTO_WITHDRAW_LIMIT = envFloat("BOR_AUTO_WITHDRAW_LIMIT", 100);
const RISK_ALERTS_DEFAULT = envInt("BOR_RISK_ALERTS_DEFAULT", 3);
const VIP_SILVER_DEFAULT = envInt("BOR_VIP_SILVER_DEFAULT", 120);
const VIP_GOLD_DEFAULT = envInt("BOR_VIP_GOLD_DEFAULT", 44);
const FREEZE_QUEUE_DEFAULT = envInt("BOR_FREEZE_QUEUE_DEFAULT", 1);

const CRYPTO_PAY_BASE_URL = CRYPTOBOT_TESTNET ? "https://testnet-pay.crypt.bot/api/" : "https://pay.crypt.bot/api/";

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function webhookUrl() {
  if (!WEBHOOK_BASE_URL || !CRYPTOBOT_WEBHOOK_SECRET) {
    return "";
  }
  return `${WEBHOOK_BASE_URL.replace(/\/$/, "")}/api/cryptobot/webhook/${CRYPTOBOT_WEBHOOK_SECRET}`;
}

function cryptoEnabled() {
  return CRYPTOBOT_ENABLED && Boolean(CRYPTOBOT_API_TOKEN);
}

function defaultState() {
  const now = new Date();
  const promoA = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const promoB = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const wheelEnd = new Date(now.getTime() + 13 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

  return {
    users: [
      {
        id: DEFAULT_ADMIN_ID,
        username: DEFAULT_ADMIN_USERNAME,
        display_name: DEFAULT_ADMIN_DISPLAY_NAME,
        balance: 428.4,
        in_game: 96,
        games_played: 35,
        wins: 7,
        volume: 5.44,
        is_admin: 1,
        vip_level: "Silver"
      }
    ],
    settings: {
      auto_deposit: AUTO_DEPOSIT_DEFAULT ? "1" : "0",
      auto_withdraw: AUTO_WITHDRAW_DEFAULT ? "1" : "0",
      risk_alerts: String(RISK_ALERTS_DEFAULT),
      vip_silver: String(VIP_SILVER_DEFAULT),
      vip_gold: String(VIP_GOLD_DEFAULT),
      freeze_queue: String(FREEZE_QUEUE_DEFAULT)
    },
    activity: [
      { id: 1, username: "storm.qq", action: "Создал депозит через CryptoBot на 85 USDT", tag: "02:03", created_at: nowIso() },
      { id: 2, username: "nightdrop", action: "Выигрыш x50 и автозачисление 214 USDT", tag: "01:58", created_at: nowIso() },
      { id: 3, username: "mika", action: "Попытка вывода с нового устройства", tag: "risk", created_at: nowIso() },
      { id: 4, username: DEFAULT_ADMIN_USERNAME, action: "Вошёл по ссылке в денежное колесо", tag: "01:44", created_at: nowIso() }
    ],
    withdrawals: [
      { id: 1, username: "shiro", amount: 125, status: "pending", risk_score: "clean", created_at: nowIso() },
      { id: 2, username: "loki", amount: 52, status: "review", risk_score: "medium", created_at: nowIso() }
    ],
    promos: [
      { id: 1, code: "BORVIP", activation_limit: 30, activated_count: 8, deposit_required: 1, deposit_min: 25, expires_at: promoA, bonus_amount: 10, active: 1, created_at: nowIso() },
      { id: 2, code: "GREENSPIN", activation_limit: 50, activated_count: 41, deposit_required: 0, deposit_min: 0, expires_at: promoB, bonus_amount: 5, active: 1, created_at: nowIso() }
    ],
    wheels: [
      { id: 1, slug: "wheel-bor-8902", title: "Weekly Money Wheel", prize_pool: 500, deposit_required: 0, required_deposit: 0, participants: 31, winners_count: 5, prize_per_winner: 100, ends_at: wheelEnd, status: "scheduled", created_at: nowIso() }
    ],
    wheel_entries: [],
    deposits: [],
    counters: {
      activity: 5,
      withdrawals: 3,
      promos: 3,
      wheels: 2,
      deposits: 1,
      wheel_entries: 1
    }
  };
}

let state = defaultState();

async function ensureDataFile() {
  await fsp.mkdir(path.dirname(DATA_PATH), { recursive: true });
  try {
    const raw = await fsp.readFile(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    state = {
      ...defaultState(),
      ...parsed,
      counters: {
        ...defaultState().counters,
        ...(parsed.counters || {})
      }
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Failed to read data file, using defaults:", error.message);
    }
    await persistState();
  }
}

async function persistState() {
  await fsp.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fsp.writeFile(DATA_PATH, JSON.stringify(state, null, 2), "utf8");
}

function nextId(key) {
  const current = state.counters[key] || 1;
  state.counters[key] = current + 1;
  return current;
}

function addLog(username, action, tag) {
  state.activity.unshift({
    id: nextId("activity"),
    username,
    action,
    tag,
    created_at: nowIso()
  });
  state.activity = state.activity.slice(0, 20);
}

function getUser() {
  return state.users.find((user) => user.id === DEFAULT_ADMIN_ID) || state.users[0];
}

function appMeta() {
  return {
    title: APP_TITLE,
    mode: APP_MODE,
    webappUrl: WEBAPP_URL,
    webhookBaseUrl: WEBHOOK_BASE_URL,
    webhookUrl: webhookUrl(),
    cryptobotEnabled: CRYPTOBOT_ENABLED,
    cryptobotConfigured: Boolean(CRYPTOBOT_API_TOKEN),
    cryptobotBotUsername: CRYPTOBOT_BOT_USERNAME,
    cryptobotAsset: CRYPTOBOT_ASSET
  };
}

function x50Feed() {
  return [
    { user: "@neo", amount: 0.2 },
    { user: "@ash", amount: 0.55 },
    { user: "@sai", amount: 1 },
    { user: "@kei", amount: 0.8 },
    { user: "@ida", amount: 0.4 }
  ];
}

function games() {
  return [
    { name: "Pulse", icon: "🎲", note: "live", theme: "pulse" },
    { name: "Limbo", icon: "📈", note: "green", theme: "limbo" },
    { name: "Crash", icon: "☄", note: "hot", theme: "crash" },
    { name: "Mines", icon: "💣", note: "risk", theme: "mines" },
    { name: "Slot", icon: "🎰", note: "jackpot", theme: "slot" },
    { name: "Blackjack", icon: "🂡", note: "cards", theme: "blackjack" }
  ];
}

function bootstrapPayload() {
  return {
    app: appMeta(),
    user: getUser(),
    settings: state.settings,
    activity: state.activity,
    withdrawals: [...state.withdrawals].sort((a, b) => b.id - a.id),
    promos: [...state.promos].sort((a, b) => b.id - a.id),
    wheels: [...state.wheels].sort((a, b) => b.id - a.id),
    deposits: [...state.deposits].sort((a, b) => b.id - a.id).slice(0, 8),
    x50Feed: x50Feed(),
    games: games()
  };
}

function createMockInvoice(user, amount, requestId) {
  const slug = `mock_${requestId}`;
  const webapp = WEBAPP_URL || "";
  return {
    invoice_id: null,
    hash: slug,
    bot_invoice_url: `https://t.me/${CRYPTOBOT_BOT_USERNAME}?start=${slug}`,
    mini_app_invoice_url: webapp ? `${webapp}?invoice=${slug}` : "",
    web_app_invoice_url: webapp ? `${webapp}?invoice=${slug}` : "",
    status: "active",
    payload: JSON.stringify({ mock: true, user_id: user.id, amount }),
    paid_asset: null,
    paid_amount: null
  };
}

function buildInvoicePayload(user, amount, requestId) {
  const appUrl = WEBAPP_URL || `http://localhost:${PORT}`;
  return {
    asset: CRYPTOBOT_ASSET,
    amount: amount.toFixed(2),
    description: `${APP_TITLE} deposit for @${user.username}`,
    hidden_message: `Баланс в ${APP_TITLE} обновится автоматически после оплаты.`,
    paid_btn_name: "callback",
    paid_btn_url: appUrl,
    payload: JSON.stringify({
      bor_request_id: requestId,
      user_id: user.id,
      username: user.username,
      amount
    }),
    allow_comments: false,
    allow_anonymous: true,
    expires_in: CRYPTOBOT_INVOICE_EXPIRES_IN
  };
}

function cryptoApiRequest(method, payload) {
  if (!cryptoEnabled()) {
    return Promise.reject(new Error("CryptoBot API not configured"));
  }

  const url = new URL(method, CRYPTO_PAY_BASE_URL);
  const body = JSON.stringify(payload || {});

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Crypto-Pay-API-Token": CRYPTOBOT_API_TOKEN,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        },
        timeout: 20000
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const parsed = JSON.parse(raw);
            if (!parsed.ok) {
              reject(new Error(parsed.error || "CryptoBot request failed"));
              return;
            }
            resolve(parsed.result);
          } catch (error) {
            reject(new Error(`CryptoBot invalid response: ${raw}`));
          }
        });
      }
    );

    req.on("error", (error) => reject(new Error(`CryptoBot unavailable: ${error.message}`)));
    req.on("timeout", () => {
      req.destroy(new Error("CryptoBot timeout"));
    });
    req.write(body);
    req.end();
  });
}

function verifyCryptobotSignature(rawBody, signature) {
  if (!CRYPTOBOT_API_TOKEN) {
    return false;
  }
  const secret = crypto.createHash("sha256").update(CRYPTOBOT_API_TOKEN).digest();
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return digest === signature;
}

async function sendJson(res, statusCode, payload) {
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": data.length
  });
  res.end(data);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) {
    return { raw, body: {} };
  }
  return { raw, body: JSON.parse(raw.toString("utf8")) };
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "text/plain; charset=utf-8";
}

async function serveStatic(reqPath, res) {
  if (reqPath === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  const relative = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
  let filePath = path.resolve(PUBLIC_DIR, relative);
  const publicRoot = path.resolve(PUBLIC_DIR);

  if (!filePath.startsWith(publicRoot)) {
    await sendJson(res, 404, { error: "File not found" });
    return;
  }

  let stat = null;
  try {
    stat = await fsp.stat(filePath);
  } catch {}

  if (!stat || stat.isDirectory()) {
    if (path.extname(relative)) {
      await sendJson(res, 404, { error: "File not found" });
      return;
    }
    filePath = path.join(PUBLIC_DIR, "index.html");
  }

  const data = await fsp.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Content-Length": data.length
  });
  res.end(data);
}

function createDepositRecord(user, amount, source, invoice, requestId) {
  return {
    id: nextId("deposits"),
    request_id: requestId,
    username: user.username,
    user_id: user.id,
    amount,
    asset: CRYPTOBOT_ASSET,
    source,
    invoice_id: invoice.invoice_id || null,
    invoice_hash: invoice.hash || null,
    invoice_url: invoice.bot_invoice_url || "",
    mini_app_invoice_url: invoice.mini_app_invoice_url || "",
    web_app_invoice_url: invoice.web_app_invoice_url || "",
    payload: invoice.payload || "",
    status: invoice.status || "active",
    credited: 0,
    credited_at: null,
    paid_amount: invoice.paid_amount || null,
    paid_asset: invoice.paid_asset || null,
    comment: "awaiting payment",
    created_at: nowIso(),
    updated_at: nowIso()
  };
}

function creditDepositIfNeeded(deposit, paidAmount, paidAsset) {
  if (deposit.credited) {
    return false;
  }
  const amountToCredit = typeof paidAmount === "number" ? paidAmount : deposit.amount;
  const user = getUser();
  user.balance += amountToCredit;
  user.volume += amountToCredit;
  deposit.credited = 1;
  deposit.credited_at = nowIso();
  deposit.paid_amount = paidAmount ?? deposit.paid_amount;
  deposit.paid_asset = paidAsset ?? deposit.paid_asset;
  deposit.updated_at = nowIso();
  addLog(deposit.username, `Оплата инвойса зачислена: ${amountToCredit.toFixed(2)} ${paidAsset || deposit.asset}`, "deposit");
  return true;
}

function applyInvoiceUpdate(invoice) {
  const byHash = state.deposits.find((item) => item.invoice_hash && item.invoice_hash === invoice.hash);
  const byId = state.deposits.find((item) => item.invoice_id && item.invoice_id === invoice.invoice_id);
  const deposit = byHash || byId;
  if (!deposit) {
    return { credited: false, status: "missing" };
  }

  deposit.status = invoice.status || deposit.status;
  deposit.comment = invoice.status === "paid" ? "paid" : deposit.comment;
  deposit.updated_at = nowIso();

  if (invoice.status === "paid") {
    const paidAmount = invoice.paid_amount == null ? null : Number(invoice.paid_amount);
    const credited = creditDepositIfNeeded(deposit, Number.isFinite(paidAmount) ? paidAmount : null, invoice.paid_asset || null);
    return { credited, status: deposit.status };
  }

  return { credited: false, status: deposit.status };
}

async function handleCreateInvoice(body, res) {
  const amount = Number(body.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    await sendJson(res, 400, { error: "Введите сумму больше 0" });
    return;
  }

  const user = getUser();
  const requestId = crypto.randomUUID().replace(/-/g, "");

  let invoice;
  let source;
  try {
    if (cryptoEnabled()) {
      invoice = await cryptoApiRequest("createInvoice", buildInvoicePayload(user, amount, requestId));
      source = "cryptobot";
    } else {
      invoice = createMockInvoice(user, amount, requestId);
      source = "mock";
    }
  } catch (error) {
    await sendJson(res, 502, { error: error.message });
    return;
  }

  state.deposits.unshift(createDepositRecord(user, amount, source, invoice, requestId));
  addLog(user.username, `Создан инвойс на ${amount.toFixed(2)} ${CRYPTOBOT_ASSET}`, "invoice");
  await persistState();

  const invoiceUrl = invoice.mini_app_invoice_url || invoice.web_app_invoice_url || invoice.bot_invoice_url || "";
  await sendJson(res, 200, {
    ok: true,
    message: `Инвойс на ${amount.toFixed(2)} ${CRYPTOBOT_ASSET} создан`,
    invoiceUrl,
    invoiceHash: invoice.hash || null,
    data: bootstrapPayload()
  });
}

async function handleSyncDeposits(res) {
  if (!cryptoEnabled()) {
    await sendJson(res, 200, {
      ok: true,
      stats: { checked: state.deposits.length, updated: 0 },
      data: bootstrapPayload()
    });
    return;
  }

  try {
    const result = await cryptoApiRequest("getInvoices", { status: "paid", count: 100 });
    const items = Array.isArray(result.items) ? result.items : [];
    let updated = 0;
    for (const invoice of items) {
      if (applyInvoiceUpdate(invoice).credited) {
        updated += 1;
      }
    }
    await persistState();
    await sendJson(res, 200, {
      ok: true,
      stats: { checked: items.length, updated },
      data: bootstrapPayload()
    });
  } catch (error) {
    await sendJson(res, 502, { error: error.message });
  }
}

async function handleWithdrawal(body, res) {
  const amount = Number(body.amount || 0);
  const user = getUser();
  if (!Number.isFinite(amount) || amount <= 0) {
    await sendJson(res, 400, { error: "Введите сумму больше 0" });
    return;
  }
  if (amount > user.balance) {
    await sendJson(res, 400, { error: "Недостаточно средств" });
    return;
  }

  const status = state.settings.auto_withdraw === "1" && amount <= AUTO_WITHDRAW_LIMIT ? "approved" : "pending";
  const riskScore = amount <= AUTO_WITHDRAW_LIMIT ? "clean" : "medium";
  state.withdrawals.unshift({
    id: nextId("withdrawals"),
    username: user.username,
    amount,
    status,
    risk_score: riskScore,
    created_at: nowIso()
  });
  user.balance -= amount;
  addLog(user.username, `Создана заявка на вывод ${amount.toFixed(2)} ${CRYPTOBOT_ASSET}`, status);
  await persistState();
  await sendJson(res, 200, { ok: true, status, data: bootstrapPayload() });
}

async function handleActivatePromo(body, res) {
  const code = String(body.code || "").trim().toUpperCase();
  const promo = state.promos.find((item) => item.code === code && item.active);
  const user = getUser();
  if (!promo) {
    await sendJson(res, 400, { error: "Промокод не найден" });
    return;
  }
  if (promo.activated_count >= promo.activation_limit) {
    await sendJson(res, 400, { error: "Активации закончились" });
    return;
  }

  promo.activated_count += 1;
  user.balance += promo.bonus_amount;
  addLog(user.username, `Активировал промокод ${code} на ${promo.bonus_amount.toFixed(2)} ${CRYPTOBOT_ASSET}`, "promo");
  await persistState();
  await sendJson(res, 200, { ok: true, message: `Промокод ${code} активирован`, data: bootstrapPayload() });
}

async function handleAdminSettings(body, res) {
  const key = String(body.key || "").trim();
  if (!["auto_deposit", "auto_withdraw"].includes(key)) {
    await sendJson(res, 400, { error: "Недопустимая настройка" });
    return;
  }
  const value = body.value ? "1" : "0";
  state.settings[key] = value;
  const title = key === "auto_deposit" ? "автопополнение" : "автовыводы";
  addLog("admin", `Переключил ${title}: ${value === "1" ? "вкл" : "выкл"}`, "admin");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload() });
}

async function handleAdminCreatePromo(body, res) {
  const code = String(body.code || "").trim().toUpperCase();
  const activationLimit = Number(body.activation_limit || 0);
  const depositRequired = body.deposit_required ? 1 : 0;
  const depositMin = Number(body.deposit_min || 0);
  const bonusAmount = Number(body.bonus_amount || 0);
  const expiresAt = String(body.expires_at || "").trim() || nowIso();
  if (!code || !Number.isFinite(activationLimit) || activationLimit <= 0) {
    await sendJson(res, 400, { error: "Заполни код и лимит активаций" });
    return;
  }

  state.promos.unshift({
    id: nextId("promos"),
    code,
    activation_limit: activationLimit,
    activated_count: 0,
    deposit_required: depositRequired,
    deposit_min: Number.isFinite(depositMin) ? depositMin : 0,
    expires_at: expiresAt,
    bonus_amount: Number.isFinite(bonusAmount) ? bonusAmount : 0,
    active: 1,
    created_at: nowIso()
  });
  addLog("admin", `Создал промокод ${code}`, "promo");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload() });
}

async function handleDeletePromo(promoId, res) {
  const index = state.promos.findIndex((promo) => String(promo.id) === promoId);
  if (index === -1) {
    await sendJson(res, 404, { error: "Промокод не найден" });
    return;
  }
  const [promo] = state.promos.splice(index, 1);
  addLog("admin", `Удалил промокод ${promo.code}`, "promo");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload() });
}

async function handleWithdrawalStatus(withdrawalId, status, res) {
  const row = state.withdrawals.find((item) => String(item.id) === withdrawalId);
  if (!row) {
    await sendJson(res, 404, { error: "Заявка не найдена" });
    return;
  }
  row.status = status;
  addLog("admin", `Заявка #${withdrawalId} ${status}`, "withdraw");
  if (status === "rejected" && row.username === DEFAULT_ADMIN_USERNAME) {
    getUser().balance += row.amount;
  }
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload() });
}

async function handleAdminCreateWheel(body, res) {
  const slug = String(body.slug || "").trim() || `wheel-${String(Date.now()).slice(-6)}`;
  const title = String(body.title || "").trim() || "BOR Money Wheel";
  const prizePool = Number(body.prize_pool || 0);
  const depositRequired = body.deposit_required ? 1 : 0;
  const requiredDeposit = Number(body.required_deposit || 0);
  const winnersCount = Number(body.winners_count || 1);
  const minutesUntilEnd = Number(body.minutes_until_end || 10);
  if (!Number.isFinite(prizePool) || prizePool <= 0) {
    await sendJson(res, 400, { error: "Призовой фонд должен быть больше 0" });
    return;
  }

  const endsAt = new Date(Date.now() + minutesUntilEnd * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const prizePerWinner = Number((prizePool / winnersCount).toFixed(2));
  state.wheels.unshift({
    id: nextId("wheels"),
    slug,
    title,
    prize_pool: prizePool,
    deposit_required: depositRequired,
    required_deposit: Number.isFinite(requiredDeposit) ? requiredDeposit : 0,
    participants: 0,
    winners_count: winnersCount,
    prize_per_winner: prizePerWinner,
    ends_at: endsAt,
    status: "scheduled",
    created_at: nowIso()
  });
  addLog("admin", `Создал колесо ${slug} на ${prizePool.toFixed(2)} ${CRYPTOBOT_ASSET}`, "wheel");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload() });
}

async function handleJoinWheel(slug, res) {
  const wheel = state.wheels.find((item) => item.slug === slug);
  const user = getUser();
  if (!wheel) {
    await sendJson(res, 404, { error: "Колесо не найдено" });
    return;
  }
  if (wheel.deposit_required && user.volume < wheel.required_deposit) {
    await sendJson(res, 400, { error: "Недостаточный депозит для участия" });
    return;
  }
  const exists = state.wheel_entries.find((entry) => entry.wheel_id === wheel.id && entry.username === user.username);
  if (exists) {
    await sendJson(res, 400, { error: "Ты уже участвуешь" });
    return;
  }

  state.wheel_entries.push({
    id: nextId("wheel_entries"),
    wheel_id: wheel.id,
    username: user.username,
    created_at: nowIso()
  });
  wheel.participants += 1;
  addLog(user.username, `Вступил в колесо ${slug}`, "wheel");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload() });
}

async function handleWebhook(secret, raw, res) {
  if (!CRYPTOBOT_WEBHOOK_SECRET || secret !== CRYPTOBOT_WEBHOOK_SECRET) {
    await sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  const signature = reqHeader(raw.headers, "crypto-pay-api-signature");
  if (!verifyCryptobotSignature(raw.body, signature)) {
    await sendJson(res, 403, { error: "Bad signature" });
    return;
  }
}

function reqHeader(headers, name) {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] || "";
  }
  return value || "";
}

async function routeRequest(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET") {
    if (parsed.pathname === "/health") {
      await sendJson(res, 200, {
        ok: true,
        status: "healthy",
        app: APP_TITLE,
        port: PORT,
        dataPath: DATA_PATH
      });
      return;
    }
    if (parsed.pathname === "/api/bootstrap") {
      await sendJson(res, 200, bootstrapPayload());
      return;
    }
    if (parsed.pathname === "/api/deposits/sync") {
      await handleSyncDeposits(res);
      return;
    }
    await serveStatic(parsed.pathname, res);
    return;
  }

  if (req.method === "POST") {
    const raw = await readBody(req);
    if (parsed.pathname.startsWith("/api/cryptobot/webhook/")) {
      const secret = parsed.pathname.split("/").pop() || "";
      if (!CRYPTOBOT_WEBHOOK_SECRET || secret !== CRYPTOBOT_WEBHOOK_SECRET) {
        await sendJson(res, 403, { error: "Forbidden" });
        return;
      }
      const signature = reqHeader(req.headers, "crypto-pay-api-signature");
      if (!verifyCryptobotSignature(raw, signature)) {
        await sendJson(res, 403, { error: "Bad signature" });
        return;
      }
      let payload = {};
      try {
        payload = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      } catch {
        await sendJson(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (payload.update_type !== "invoice_paid") {
        await sendJson(res, 200, { ok: true, ignored: true });
        return;
      }
      const result = applyInvoiceUpdate(payload.payload || {});
      await persistState();
      await sendJson(res, 200, { ok: true, credited: result.credited, status: result.status });
      return;
    }

    let body = {};
    try {
      body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      await sendJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    if (parsed.pathname === "/api/deposit/create-check") {
      await handleCreateInvoice(body, res);
      return;
    }
    if (parsed.pathname === "/api/withdrawals") {
      await handleWithdrawal(body, res);
      return;
    }
    if (parsed.pathname === "/api/promos/activate") {
      await handleActivatePromo(body, res);
      return;
    }
    if (parsed.pathname === "/api/admin/settings") {
      await handleAdminSettings(body, res);
      return;
    }
    if (parsed.pathname === "/api/admin/promos") {
      await handleAdminCreatePromo(body, res);
      return;
    }
    if (parsed.pathname.startsWith("/api/admin/promos/") && parsed.pathname.endsWith("/delete")) {
      await handleDeletePromo(parsed.pathname.split("/")[4], res);
      return;
    }
    if (parsed.pathname.startsWith("/api/admin/withdrawals/") && parsed.pathname.endsWith("/approve")) {
      await handleWithdrawalStatus(parsed.pathname.split("/")[4], "approved", res);
      return;
    }
    if (parsed.pathname.startsWith("/api/admin/withdrawals/") && parsed.pathname.endsWith("/reject")) {
      await handleWithdrawalStatus(parsed.pathname.split("/")[4], "rejected", res);
      return;
    }
    if (parsed.pathname === "/api/admin/wheels") {
      await handleAdminCreateWheel(body, res);
      return;
    }
    if (parsed.pathname.startsWith("/api/wheels/") && parsed.pathname.endsWith("/join")) {
      await handleJoinWheel(parsed.pathname.split("/")[3], res);
      return;
    }

    await sendJson(res, 404, { error: "Not found" });
    return;
  }

  await sendJson(res, 405, { error: "Method not allowed" });
}

async function main() {
  await ensureDataFile();
  const server = http.createServer((req, res) => {
    routeRequest(req, res).catch(async (error) => {
      console.error(error);
      if (!res.headersSent) {
        await sendJson(res, 500, { error: "Internal server error" });
      } else {
        res.end();
      }
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`BOR Node server started on http://${HOST}:${PORT}`);
    console.log(`Data path: ${DATA_PATH}`);
    console.log(`CryptoBot enabled: ${CRYPTOBOT_ENABLED}`);
    console.log(`Webhook URL: ${webhookUrl() || "not configured"}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
