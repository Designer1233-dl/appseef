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
const MINES_GRID_SIZE = 25;
const DEPOSIT_MIN_AMOUNT = 0.2;
const ROULETTE_MIN_BET = 0.1;
const MINES_MIN_BET = 0.1;
const CRASH_MIN_BET = 0.1;
const ROULETTE_MAX_BETS = 2;
const ROULETTE_BET_LOCK_MS = 10000;
const ROULETTE_SEGMENTS = [
  { label: "x2", multiplier: 2, color: "#168ce8", weight: 46 },
  { label: "x3", multiplier: 3, color: "#ef9d19", weight: 28 },
  { label: "x5", multiplier: 5, color: "#24bd68", weight: 17 },
  { label: "x50", multiplier: 50, color: "#ef3544", weight: 3 },
  { label: "БОНУС", multiplier: 10, color: "#7d55de", weight: 6 }
];

function envStr(name, fallback) {
  const value = process.env[name];
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function envStrAlias(primary, fallback, defaultValue) {
  const first = process.env[primary];
  if (typeof first === "string" && first.trim()) {
    return first.trim();
  }
  const second = process.env[fallback];
  if (typeof second === "string" && second.trim()) {
    return second.trim();
  }
  return defaultValue;
}

function envInt(name, fallback) {
  const value = process.env[name];
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(name, fallback) {
  const value = process.env[name];
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (typeof value !== "string") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function resolveDataPath() {
  const custom = process.env.BOR_DB_PATH;
  if (typeof custom === "string" && custom.trim()) {
    return custom.trim();
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
const APP_MODE = envStr("BOR_APP_MODE", "мини-приложение");
const DEFAULT_USER_ID = envInt("BOR_DEFAULT_ADMIN_ID", 1);
const DEFAULT_USERNAME = envStr("BOR_DEFAULT_ADMIN_USERNAME", "borlegend");
const DEFAULT_DISPLAY_NAME = envStr("BOR_DEFAULT_ADMIN_DISPLAY_NAME", "Пухляк");

const CRYPTOBOT_ENABLED = envBool("BOR_CRYPTOBOT_ENABLED", false);
const CRYPTOBOT_BOT_USERNAME = envStr("BOR_CRYPTOBOT_BOT_USERNAME", "CryptoBot");
const CRYPTOBOT_API_TOKEN = envStr("BOR_CRYPTOBOT_API_TOKEN", "");
const CRYPTOBOT_WEBHOOK_SECRET = envStr("BOR_CRYPTOBOT_WEBHOOK_SECRET", "");
const CRYPTOBOT_ASSET = envStr("BOR_CRYPTOBOT_ASSET", "USDT");
const CRYPTOBOT_TESTNET = envBool("BOR_CRYPTOBOT_TESTNET", false);
const CRYPTOBOT_INVOICE_EXPIRES_IN = envInt("BOR_CRYPTOBOT_INVOICE_EXPIRES_IN", 3600);

const WEBAPP_URL = envStrAlias("WEBAPP_URL", "BOR_TELEGRAM_WEBAPP_URL", "");
const PAYMENT_BASE_URL = envStrAlias("BOR_PAYMENT_BASE_URL", "PAYMENT_BASE_URL", "");
const WEBHOOK_BASE_URL = envStrAlias("WEBHOOK_BASE_URL", "BOR_WEBHOOK_BASE_URL", "");
const AUTO_WITHDRAW_DEFAULT = envBool("BOR_AUTO_WITHDRAW_DEFAULT", true);
const AUTO_WITHDRAW_LIMIT = envFloat("BOR_AUTO_WITHDRAW_LIMIT", 150);
const AUTO_DEPOSIT_SYNC_ENABLED = envBool("BOR_AUTO_DEPOSIT_SYNC_ENABLED", true);
const AUTO_DEPOSIT_SYNC_INTERVAL_MS = envInt("BOR_AUTO_DEPOSIT_SYNC_INTERVAL_MS", 30000);

const CRYPTO_PAY_BASE_URL = CRYPTOBOT_TESTNET ? "https://testnet-pay.crypt.bot/api/" : "https://pay.crypt.bot/api/";

let state = null;
let depositSyncInFlight = false;
let rouletteTimer = null;

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

function makeGames() {
  return [
    { id: "mines", name: "Мины", icon: "✦", note: "доступно", theme: "mines", live: true },
    { id: "crash", name: "Ракета", icon: "↗", note: "доступно", theme: "crash", live: true },
    { id: "slots", name: "Слоты", icon: "777", note: "в разработке", theme: "locked", live: false },
    { id: "dice", name: "Кости", icon: "◆", note: "в разработке", theme: "locked", live: false }
  ];
}

function defaultState() {
  const now = new Date();
  const promoA = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const promoB = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const wheelEnd = new Date(now.getTime() + 13 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

  return {
    users: [
      {
        id: DEFAULT_USER_ID,
        username: DEFAULT_USERNAME,
        display_name: DEFAULT_DISPLAY_NAME,
        balance: 0,
        in_game: 0,
        games_played: 0,
        wins: 0,
        volume: 0,
        is_admin: 1,
        vip_level: "Серебро"
      }
    ],
    settings: {
      auto_withdraw: AUTO_WITHDRAW_DEFAULT ? "1" : "0",
      risk_alerts: "0",
      vip_silver: "0",
      vip_gold: "0",
      freeze_queue: "0"
    },
    activity: [
      { id: 1, username: "storm.qq", action: "Создал депозит через CryptoBot на 85 USDT", tag: "02:03", created_at: nowIso() },
      { id: 2, username: "nightdrop", action: "Выигрыш x50 и автозачисление 214 USDT", tag: "01:58", created_at: nowIso() },
      { id: 3, username: "mika", action: "Попытка вывода с нового устройства", tag: "risk", created_at: nowIso() },
      { id: 4, username: DEFAULT_USERNAME, action: "Вошёл по ссылке в денежное колесо", tag: "01:44", created_at: nowIso() }
    ],
    withdrawals: [
      { id: 1, username: "shiro", amount: 125, status: "pending", risk_score: "clean", created_at: nowIso() },
      { id: 2, username: "loki", amount: 52, status: "review", risk_score: "medium", created_at: nowIso() }
    ],
    promos: [
      { id: 1, code: "BORVIP", activation_limit: 30, activated_count: 8, deposit_required: 1, deposit_min: 25, expires_at: promoA, bonus_amount: 10, active: 1, created_at: nowIso() },
      { id: 2, code: "BORSTART", activation_limit: 50, activated_count: 41, deposit_required: 0, deposit_min: 0, expires_at: promoB, bonus_amount: 5, active: 1, created_at: nowIso() }
    ],
    wheels: [
      { id: 1, slug: "wheel-bor-8902", title: "Еженедельное денежное колесо", prize_pool: 500, deposit_required: 0, required_deposit: 0, participants: 31, winners_count: 5, prize_per_winner: 100, ends_at: wheelEnd, status: "scheduled", created_at: nowIso() }
    ],
    wheel_entries: [],
    deposits: [],
    games: makeGames(),
    counters: {
      activity: 5,
      withdrawals: 3,
      promos: 3,
      wheels: 2,
      deposits: 1
    },
    minesSession: null,
    crashSession: null,
    lastRoulette: null,
    rouletteRound: null,
    rouletteBonus: null
  };
}

function sanitizeUser(user) {
  const rawVip = typeof user?.vip_level === "string" && user.vip_level.trim() ? user.vip_level.trim() : "Серебро";
  const localizedVip = rawVip.toLowerCase() === "silver" ? "Серебро" : rawVip.toLowerCase() === "gold" ? "Золото" : rawVip;
  return {
    id: user && Number.isFinite(Number(user.id)) ? Number(user.id) : DEFAULT_USER_ID,
    username: typeof user?.username === "string" && user.username.trim() ? user.username.trim() : DEFAULT_USERNAME,
    display_name: typeof user?.display_name === "string" && user.display_name.trim() ? user.display_name.trim() : DEFAULT_DISPLAY_NAME,
    balance: Number.isFinite(Number(user?.balance)) ? Math.max(0, Number(user.balance)) : 0,
    in_game: Number.isFinite(Number(user?.in_game)) ? Math.max(0, Number(user.in_game)) : 0,
    games_played: Number.isFinite(Number(user?.games_played)) ? Math.max(0, Math.trunc(Number(user.games_played))) : 0,
    wins: Number.isFinite(Number(user?.wins)) ? Math.max(0, Math.trunc(Number(user.wins))) : 0,
    volume: Number.isFinite(Number(user?.volume)) ? Math.max(0, Number(user.volume)) : 0,
    is_admin: user?.is_admin == null ? 1 : user.is_admin ? 1 : 0,
    vip_level: localizedVip
  };
}

function sanitizeStateShape(parsed) {
  const defaults = defaultState();
  const parsedCounters = parsed.counters || {};
  return {
    ...defaults,
    users: Array.isArray(parsed.users) && parsed.users.length
      ? parsed.users.map((user) => sanitizeUser(user))
      : defaults.users,
    activity: Array.isArray(parsed.activity) && parsed.activity.length ? parsed.activity : defaults.activity,
    withdrawals: Array.isArray(parsed.withdrawals) && parsed.withdrawals.length ? parsed.withdrawals : defaults.withdrawals,
    promos: Array.isArray(parsed.promos) && parsed.promos.length ? parsed.promos : defaults.promos,
    wheels: Array.isArray(parsed.wheels) && parsed.wheels.length ? parsed.wheels : defaults.wheels,
    wheel_entries: Array.isArray(parsed.wheel_entries) ? parsed.wheel_entries : defaults.wheel_entries,
    deposits: Array.isArray(parsed.deposits) ? parsed.deposits : defaults.deposits,
    settings: { ...defaults.settings, ...(parsed.settings || {}) },
    counters: {
      activity: Math.max(defaults.counters.activity, Number(parsedCounters.activity) || 0),
      withdrawals: Math.max(defaults.counters.withdrawals, Number(parsedCounters.withdrawals) || 0),
      promos: Math.max(defaults.counters.promos, Number(parsedCounters.promos) || 0),
      wheels: Math.max(defaults.counters.wheels, Number(parsedCounters.wheels) || 0),
      deposits: Math.max(defaults.counters.deposits, Number(parsedCounters.deposits) || 0)
    },
    games: makeGames(),
    minesSession: parsed.minesSession && typeof parsed.minesSession === "object" ? parsed.minesSession : null,
    crashSession: parsed.crashSession && typeof parsed.crashSession === "object" ? parsed.crashSession : null,
    lastRoulette: parsed.lastRoulette && typeof parsed.lastRoulette === "object" ? parsed.lastRoulette : null,
    rouletteRound: parsed.rouletteRound && typeof parsed.rouletteRound === "object" ? parsed.rouletteRound : null,
    rouletteBonus: parsed.rouletteBonus && typeof parsed.rouletteBonus === "object" ? parsed.rouletteBonus : null
  };
}

async function ensureState() {
  await fsp.mkdir(path.dirname(DATA_PATH), { recursive: true });
  try {
    const raw = await fsp.readFile(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    state = sanitizeStateShape(parsed);
    await persistState();
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Failed to read data file:", error.message);
    }
    state = defaultState();
    await persistState();
  }
  scheduleRouletteRound();
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

function getUser() {
  return state.users[0];
}

function isAdminUser() {
  return Boolean(getUser().is_admin);
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

function minesView() {
  if (!state.minesSession) {
    return {
      active: false,
      mineCount: 3,
      bet: 0,
      revealed: [],
      safePicks: 0,
      potentialWin: 0,
      lastOutcome: null
    };
  }
  const session = state.minesSession;
  return {
    active: session.active,
    mineCount: session.mineCount,
    bet: session.bet,
    revealed: session.revealed,
    safePicks: session.safePicks,
    potentialWin: Number((session.bet * session.multiplier).toFixed(2)),
    lastOutcome: session.lastOutcome || null
  };
}

function crashMultiplier(startedAt) {
  const elapsed = Math.max(0, Date.now() - Number(startedAt || Date.now()));
  return Number(Math.max(1, Math.exp(elapsed / 18000)).toFixed(2));
}

function crashView() {
  const session = state.crashSession;
  if (!session) {
    return { active: false, status: "waiting", bet: 0, multiplier: 1, lastOutcome: null };
  }
  const current = session.active ? Math.min(Number(session.crash_multiplier), crashMultiplier(session.started_at)) : Number(session.multiplier || 1);
  return {
    active: Boolean(session.active),
    status: session.active ? "running" : session.status || "crashed",
    bet: Number(session.bet || 0),
    multiplier: Number(current.toFixed(2)),
    lastOutcome: session.lastOutcome || null
  };
}

async function settleCrashIfNeeded() {
  const session = state.crashSession;
  if (!session?.active || crashMultiplier(session.started_at) < Number(session.crash_multiplier)) {
    return false;
  }
  const user = getUser();
  const multiplier = Number(session.crash_multiplier);
  session.active = false;
  session.status = "crashed";
  session.multiplier = multiplier;
  session.lastOutcome = { type: "loss", multiplier };
  user.in_game = Number(Math.max(0, user.in_game - Number(session.bet)).toFixed(2));
  user.games_played += 1;
  user.volume = Number((user.volume + Number(session.bet)).toFixed(2));
  addLog(user.username || "player", `Ракета остановилась на x${multiplier.toFixed(2)}`, "loss");
  await persistState();
  return true;
}

function rouletteView() {
  const round = state.rouletteRound;
  if (!round || !round.active) {
    return { active: false, bets: [], totalBet: 0, secondsLeft: 0, maxBets: ROULETTE_MAX_BETS };
  }
  const bets = Array.isArray(round.bets) ? round.bets : [];
  return {
    active: true,
    bets: bets.map((bet) => ({ choice: bet.choice, amount: bet.amount })),
    totalBet: Number(bets.reduce((sum, bet) => sum + Number(bet.amount || 0), 0).toFixed(2)),
    closesAt: round.closes_at,
    secondsLeft: Math.max(0, Number(((Number(round.closes_at) - Date.now()) / 1000).toFixed(1))),
    maxBets: ROULETTE_MAX_BETS
  };
}

function rouletteBonusView() {
  const bonus = state.rouletteBonus;
  if (!bonus || !bonus.active) {
    return { active: false, cards: [], bet: 0, chosenIndex: null };
  }
  return {
    active: true,
    bet: bonus.bet,
    chosenIndex: Number.isInteger(bonus.chosen_index) ? bonus.chosen_index : null,
    cards: (bonus.cards || []).map((card) => ({ index: card.index, label: "BOR" }))
  };
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
    deposits: [...state.deposits].sort((a, b) => b.id - a.id).slice(0, 10),
    games: state.games,
    roulette: {
      segments: ROULETTE_SEGMENTS,
      lastResult: state.lastRoulette,
      round: rouletteView(),
      bonus: rouletteBonusView()
    },
    mines: minesView(),
    crash: crashView()
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

function requestOrigin(req) {
  const configured = PAYMENT_BASE_URL || WEBAPP_URL;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Use the incoming host when an optional URL variable is malformed.
    }
  }
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || (req.socket.encrypted ? "https" : "http");
  const host = req.headers.host || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

function paymentUrl(req, invoice) {
  const key = invoice.hash || invoice.invoice_id;
  return key ? `${requestOrigin(req)}/pay/${encodeURIComponent(String(key))}` : "";
}

function buildInvoicePayload(user, amount, requestId) {
  const appUrl = WEBAPP_URL || `http://localhost:${PORT}`;
  return {
    asset: CRYPTOBOT_ASSET,
    amount: amount.toFixed(2),
    description: `${APP_TITLE} deposit for @${user.username || "player"}`,
    hidden_message: `Баланс в ${APP_TITLE} обновится только после подтвержденной оплаты.`,
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
          } catch {
            reject(new Error(`CryptoBot invalid response: ${raw}`));
          }
        });
      }
    );

    req.on("error", (error) => reject(new Error(`CryptoBot unavailable: ${error.message}`)));
    req.on("timeout", () => req.destroy(new Error("CryptoBot timeout")));
    req.write(body);
    req.end();
  });
}

function reqHeader(headers, name) {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] || "";
  }
  return value || "";
}

function verifyCryptobotSignature(rawBody, signature) {
  if (!CRYPTOBOT_API_TOKEN) {
    return false;
  }
  const secret = crypto.createHash("sha256").update(CRYPTOBOT_API_TOKEN).digest();
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return digest === signature;
}

function createDepositRecord(user, amount, source, invoice, requestId) {
  return {
    id: nextId("deposits"),
    request_id: requestId,
    username: user.username || "player",
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
  deposit.credited = 1;
  deposit.credited_at = nowIso();
  deposit.paid_amount = amountToCredit;
  deposit.paid_asset = paidAsset || deposit.asset;
  deposit.status = "paid";
  deposit.updated_at = nowIso();
  deposit.comment = "credited";
  user.balance = Number((user.balance + amountToCredit).toFixed(2));
  user.volume = Number((user.volume + amountToCredit).toFixed(2));
  addLog(user.username || "player", `Пополнение подтверждено: ${amountToCredit.toFixed(2)} ${deposit.asset}`, "deposit");
  return true;
}

function applyInvoiceUpdate(invoice) {
  const deposit = state.deposits.find((item) => item.invoice_hash && item.invoice_hash === invoice.hash)
    || state.deposits.find((item) => item.invoice_id && item.invoice_id === invoice.invoice_id);
  if (!deposit) {
    return { credited: false, status: "missing" };
  }
  deposit.status = invoice.status || deposit.status;
  deposit.updated_at = nowIso();
  if (invoice.status === "paid") {
    const paidAmount = invoice.paid_amount == null ? null : Number(invoice.paid_amount);
    const credited = creditDepositIfNeeded(deposit, Number.isFinite(paidAmount) ? paidAmount : null, invoice.paid_asset || null);
    return { credited, status: "paid" };
  }
  return { credited: false, status: deposit.status };
}

function sampleRandomIndices(total, count) {
  const source = Array.from({ length: total }, (_, index) => index);
  for (let i = source.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [source[i], source[j]] = [source[j], source[i]];
  }
  return source.slice(0, count).sort((a, b) => a - b);
}

function minesMultiplier(mineCount, safePicks) {
  if (safePicks <= 0) {
    return 1;
  }
  const growth = 0.28 + mineCount * 0.11;
  return Number((1 + safePicks * growth).toFixed(2));
}

function spendBalance(amount) {
  const user = getUser();
  if (amount <= 0 || amount > user.balance) {
    return false;
  }
  user.balance = Number((user.balance - amount).toFixed(2));
  return true;
}

function awardBalance(amount) {
  const user = getUser();
  user.balance = Number((user.balance + amount).toFixed(2));
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

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  return "text/plain; charset=utf-8";
}

async function serveStatic(requestPath, res) {
  if (requestPath === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  let filePath = path.resolve(PUBLIC_DIR, relative);
  const publicRoot = path.resolve(PUBLIC_DIR);
  if (!filePath.startsWith(publicRoot)) {
    await sendJson(res, 404, { error: "Файл не найден" });
    return;
  }

  let stat = null;
  try {
    stat = await fsp.stat(filePath);
  } catch {}

  if (!stat || stat.isDirectory()) {
    if (path.extname(relative)) {
      await sendJson(res, 404, { error: "Файл не найден" });
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

async function handleCreateInvoice(body, res, req) {
  const amount = Number(body.amount || 0);
  if (!Number.isFinite(amount) || amount < DEPOSIT_MIN_AMOUNT) {
    await sendJson(res, 400, { error: `Минимальное пополнение ${DEPOSIT_MIN_AMOUNT.toFixed(2)} USDT` });
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
  addLog(user.username || "player", `Создан счёт на ${amount.toFixed(2)} ${CRYPTOBOT_ASSET}`, "invoice");
  await persistState();

  await sendJson(res, 200, {
    ok: true,
    message: "Счёт создан. Баланс изменится только после оплаты.",
    // Открываем именно счёт CryptoBot, а не промежуточную ссылку приложения.
    invoiceUrl: invoice.bot_invoice_url || invoice.mini_app_invoice_url || invoice.web_app_invoice_url || "",
    data: bootstrapPayload()
  });
}

async function handleSyncDeposits(res) {
  const syncResult = await syncDepositsOnce();
  if (!res) {
    return syncResult;
  }

  if (!cryptoEnabled()) {
    await sendJson(res, 200, {
      ok: true,
      stats: syncResult,
      data: bootstrapPayload()
    });
    return;
  }

  await sendJson(res, 200, {
    ok: true,
    stats: syncResult,
    data: bootstrapPayload()
  });
}

async function syncDepositsOnce() {
  if (depositSyncInFlight) {
    return { checked: 0, updated: 0, skipped: true };
  }

  depositSyncInFlight = true;
  try {
    if (!cryptoEnabled()) {
      return { checked: state.deposits.length, updated: 0, skipped: false };
    }

    const result = await cryptoApiRequest("getInvoices", { status: "paid", count: 100 });
    const items = Array.isArray(result.items) ? result.items : [];
    let updated = 0;
    for (const invoice of items) {
      if (applyInvoiceUpdate(invoice).credited) {
        updated += 1;
      }
    }
    await persistState();
    return { checked: items.length, updated, skipped: false };
  } catch (error) {
    return { checked: 0, updated: 0, skipped: false, error: error.message };
  } finally {
    depositSyncInFlight = false;
  }
}

async function handleWithdrawal(body, res) {
  const amount = Number(body.amount || 0);
  const user = getUser();

  if (!Number.isFinite(amount) || amount < 1) {
    await sendJson(res, 400, { error: "Минимальный вывод 1 USDT" });
    return;
  }
  if (amount > user.balance) {
    await sendJson(res, 400, { error: "Недостаточно средств" });
    return;
  }

  const queueFrozen = state.settings.freeze_queue === "1";
  const status = !queueFrozen && state.settings.auto_withdraw === "1" && amount <= AUTO_WITHDRAW_LIMIT ? "approved" : "pending";
  user.balance = Number((user.balance - amount).toFixed(2));
  state.withdrawals.unshift({
    id: nextId("withdrawals"),
    username: user.username || "player",
    amount,
    status,
    risk_score: amount <= AUTO_WITHDRAW_LIMIT ? "clean" : "review",
    created_at: nowIso()
  });
  addLog(user.username || "player", `Создан вывод ${amount.toFixed(2)} ${CRYPTOBOT_ASSET}`, status);
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

  const activatedUserIds = Array.isArray(promo.activated_user_ids) ? promo.activated_user_ids : [];
  if (activatedUserIds.includes(user.id)) {
    await sendJson(res, 400, { error: "Вы уже активировали этот промокод" });
    return;
  }
  if (promo.expires_at && Date.parse(promo.expires_at) < Date.now()) {
    await sendJson(res, 400, { error: "Срок действия промокода истёк" });
    return;
  }
  if (promo.deposit_required) {
    const hasRequiredDeposit = state.deposits.some((deposit) => deposit.credited && Number(deposit.paid_amount || deposit.amount || 0) >= Number(promo.deposit_min || 0));
    if (!hasRequiredDeposit) {
      await sendJson(res, 400, { error: `Для этого промокода нужен депозит от ${Number(promo.deposit_min || 0).toFixed(2)} ${CRYPTOBOT_ASSET}` });
      return;
    }
  }

  promo.activated_count += 1;
  promo.activated_user_ids = [...activatedUserIds, user.id];
  user.balance = Number((user.balance + promo.bonus_amount).toFixed(2));
  addLog(user.username || "player", `Активировал промокод ${code} на ${promo.bonus_amount.toFixed(2)} ${CRYPTOBOT_ASSET}`, "promo");
  await persistState();
  await sendJson(res, 200, { ok: true, message: `Промокод ${code} активирован`, data: bootstrapPayload() });
}

async function handleAdminCreatePromo(body, res) {
  if (!isAdminUser()) {
    await sendJson(res, 403, { error: "Требуются права администратора" });
    return;
  }

  const code = String(body.code || "").trim().toUpperCase();
  const activationLimit = Number(body.activation_limit || 0);
  const depositRequired = body.deposit_required ? 1 : 0;
  const depositMin = Number(body.deposit_min || 0);
  const bonusAmount = Number(body.bonus_amount || 0);
  const expiresAt = String(body.expires_at || "").trim();

  if (!code || !Number.isFinite(activationLimit) || activationLimit <= 0) {
    await sendJson(res, 400, { error: "Заполни код и лимит активаций" });
    return;
  }
  if (state.promos.some((item) => item.code === code)) {
    await sendJson(res, 409, { error: "Промокод уже существует" });
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

async function handleAdminAdjustBalance(body, res) {
  if (!isAdminUser()) {
    await sendJson(res, 403, { error: "Требуются права администратора" });
    return;
  }

  const amount = Number(body.amount || 0);
  const operation = String(body.operation || "").trim();
  const user = getUser();
  if (!Number.isFinite(amount) || amount <= 0) {
    await sendJson(res, 400, { error: "Укажи сумму больше нуля" });
    return;
  }
  if (!['add', 'remove'].includes(operation)) {
    await sendJson(res, 400, { error: "Некорректная операция" });
    return;
  }
  if (operation === "remove" && amount > user.balance) {
    await sendJson(res, 400, { error: "На балансе недостаточно средств" });
    return;
  }

  user.balance = Number((user.balance + (operation === "add" ? amount : -amount)).toFixed(2));
  addLog("admin", `${operation === "add" ? "Начислил" : "Списал"} ${amount.toFixed(2)} ${CRYPTOBOT_ASSET} пользователю @${user.username}`, "admin");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload() });
}

async function handleAdminWithdrawalStatus(withdrawalId, body, res) {
  if (!isAdminUser()) {
    await sendJson(res, 403, { error: "Требуются права администратора" });
    return;
  }

  const withdrawal = state.withdrawals.find((item) => String(item.id) === withdrawalId);
  const newStatus = String(body.status || "").trim();
  if (!withdrawal) {
    await sendJson(res, 404, { error: "Заявка не найдена" });
    return;
  }
  if (!["approved", "rejected"].includes(newStatus)) {
    await sendJson(res, 400, { error: "Некорректный статус заявки" });
    return;
  }
  if (!["pending", "review"].includes(withdrawal.status)) {
    await sendJson(res, 409, { error: "Эта заявка уже обработана" });
    return;
  }

  withdrawal.status = newStatus;
  withdrawal.updated_at = nowIso();
  if (newStatus === "rejected") {
    awardBalance(Number(withdrawal.amount || 0));
  }
  addLog("admin", `${newStatus === "approved" ? "Одобрил" : "Отклонил"} вывод ${Number(withdrawal.amount || 0).toFixed(2)} ${CRYPTOBOT_ASSET} для @${withdrawal.username}`, "withdrawal");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload() });
}

async function handleAdminSettings(body, res) {
  if (!isAdminUser()) {
    await sendJson(res, 403, { error: "Требуются права администратора" });
    return;
  }

  for (const key of ["auto_withdraw", "risk_alerts", "freeze_queue"]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      state.settings[key] = body[key] ? "1" : "0";
    }
  }
  addLog("admin", "Обновил настройки автоматизации и безопасности", "settings");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload() });
}

async function handleDeletePromo(promoId, res) {
  if (!isAdminUser()) {
    await sendJson(res, 403, { error: "Требуются права администратора" });
    return;
  }

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

function pickRouletteSegment() {
  const totalWeight = ROULETTE_SEGMENTS.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * totalWeight;
  for (let index = 0; index < ROULETTE_SEGMENTS.length; index += 1) {
    roll -= ROULETTE_SEGMENTS[index].weight;
    if (roll <= 0) {
      return { segment: ROULETTE_SEGMENTS[index], index };
    }
  }
  return { segment: ROULETTE_SEGMENTS[0], index: 0 };
}

function makeRouletteBonusCards() {
  const values = [2, 2, 2, 3, 5, 7, 10, 12, 14, 15];
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values.map((multiplier, index) => ({ index, multiplier }));
}

function scheduleRouletteRound() {
  if (rouletteTimer) {
    clearTimeout(rouletteTimer);
    rouletteTimer = null;
  }
  const round = state?.rouletteRound;
  if (!round || !round.active) {
    return;
  }
  const delay = Math.max(0, Number(round.closes_at) - Date.now());
  rouletteTimer = setTimeout(() => {
    settleRouletteRound().catch((error) => console.error("Roulette settlement failed:", error));
  }, delay);
}

async function settleRouletteRound() {
  const round = state?.rouletteRound;
  if (!round || !round.active) {
    return;
  }
  if (Number(round.closes_at) > Date.now()) {
    scheduleRouletteRound();
    return;
  }

  const bets = Array.isArray(round.bets) ? round.bets : [];
  const totalBet = Number(bets.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2));
  const user = getUser();
  const picked = pickRouletteSegment();
  const segment = picked.segment;
  const resultBase = {
    label: segment.label,
    multiplier: segment.multiplier,
    bets: bets.map((item) => ({ choice: item.choice, amount: item.amount })),
    totalBet,
    rotation: 1800 + Math.floor(Math.random() * 720) + (360 / ROULETTE_SEGMENTS.length) * picked.index
  };

  state.rouletteRound = null;
  if (rouletteTimer) {
    clearTimeout(rouletteTimer);
    rouletteTimer = null;
  }

  user.in_game = Number(Math.max(0, user.in_game - totalBet).toFixed(2));
  user.games_played += bets.length;
  user.volume = Number((user.volume + totalBet).toFixed(2));

  if (segment.label.toUpperCase() === "БОНУС") {
    state.rouletteBonus = {
      active: true,
      bet: totalBet,
      bets,
      cards: makeRouletteBonusCards(),
      chosen_index: null
    };
    state.lastRoulette = { ...resultBase, choice: bets.map((item) => item.choice).join(" + "), won: false, payout: 0, net: Number((-totalBet).toFixed(2)), pendingBonus: true };
    addLog(user.username || "player", `X50: выпал БОНУС для ${totalBet.toFixed(2)} ${CRYPTOBOT_ASSET}`, "bonus");
  } else {
    let payout = 0;
    let winningBets = 0;
    for (const bet of bets) {
      if (String(bet.choice).toUpperCase() === segment.label.toUpperCase()) {
        payout += Number((Number(bet.amount) * segment.multiplier).toFixed(2));
        winningBets += 1;
      }
    }
    payout = Number(payout.toFixed(2));
    if (payout > 0) {
      awardBalance(payout);
      user.wins += winningBets;
    }
    state.rouletteBonus = null;
    state.lastRoulette = {
      ...resultBase,
      choice: bets.map((item) => item.choice).join(" + "),
      won: payout > 0,
      payout,
      net: Number((payout - totalBet).toFixed(2)),
      pendingBonus: false
    };
    addLog(user.username || "player", `X50: выпало ${segment.label}, ставка ${totalBet.toFixed(2)} ${CRYPTOBOT_ASSET}`, payout > 0 ? "win" : "loss");
  }
  await persistState();
}

async function handleRouletteSpin(body, res) {
  const bet = Number(body.bet || 0);
  const choice = String(body.choice || "x2").trim().toUpperCase();
  const validChoice = ROULETTE_SEGMENTS.find((item) => item.label.toUpperCase() === choice && item.label.toUpperCase() !== "БОНУС");
  if (!Number.isFinite(bet) || bet < ROULETTE_MIN_BET) {
    await sendJson(res, 400, { error: `Минимальная ставка ${ROULETTE_MIN_BET.toFixed(2)} USDT` });
    return;
  }
  if (!validChoice) {
    await sendJson(res, 400, { error: "Выбери множитель от x2 до x50" });
    return;
  }
  if (state.rouletteBonus?.active) {
    await sendJson(res, 400, { error: "Сначала выбери карту бонуса" });
    return;
  }
  const user = getUser();
  if (state.rouletteRound?.active && Number(state.rouletteRound.closes_at) <= Date.now()) {
    await settleRouletteRound();
  }
  const round = state.rouletteRound;
  if (round?.active && round.bets.length >= ROULETTE_MAX_BETS) {
    await sendJson(res, 400, { error: "В этом раунде уже две ставки" });
    return;
  }
  if (round?.active && round.bets.some((item) => String(item.choice).toUpperCase() === choice)) {
    await sendJson(res, 400, { error: "Вторая ставка должна быть на другой множитель" });
    return;
  }
  if (!spendBalance(bet)) {
    await sendJson(res, 400, { error: "Недостаточно средств для ставки" });
    return;
  }
  if (!round?.active) {
    state.rouletteRound = { active: true, opens_at: Date.now(), closes_at: Date.now() + ROULETTE_BET_LOCK_MS, bets: [] };
  }
  state.rouletteRound.bets.push({ choice: validChoice.label, amount: Number(bet.toFixed(2)) });
  user.in_game = Number((user.in_game + bet).toFixed(2));
  addLog(user.username || "player", `X50: ставка ${bet.toFixed(2)} ${CRYPTOBOT_ASSET} на ${validChoice.label}`, "bet");
  await persistState();
  scheduleRouletteRound();
  await sendJson(res, 200, { ok: true, status: "bet_accepted", data: bootstrapPayload() });
}

async function handleRouletteBonusPick(body, res) {
  const index = Number(body.index);
  const bonus = state.rouletteBonus;
  if (!bonus?.active) {
    await sendJson(res, 400, { error: "Активного бонуса нет" });
    return;
  }
  if (!Number.isInteger(index) || index < 0 || index >= bonus.cards.length) {
    await sendJson(res, 400, { error: "Некорректная карта" });
    return;
  }
  if (Number.isInteger(bonus.chosen_index)) {
    await sendJson(res, 400, { error: "Карта уже выбрана" });
    return;
  }
  const card = bonus.cards[index];
  const user = getUser();
  const payout = Number((bonus.bet * card.multiplier).toFixed(2));
  bonus.chosen_index = index;
  bonus.multiplier = card.multiplier;
  bonus.payout = payout;
  bonus.active = false;
  awardBalance(payout);
  user.wins += 1;
  state.lastRoulette = {
    ...(state.lastRoulette || {}),
    choice: "БОНУС",
    won: true,
    bonusMultiplier: card.multiplier,
    payout,
    net: Number((payout - bonus.bet).toFixed(2)),
    pendingBonus: false
  };
  addLog(user.username || "player", `X50: карта BOR дала x${card.multiplier}, выплата ${payout.toFixed(2)} ${CRYPTOBOT_ASSET}`, "win");
  await persistState();
  await sendJson(res, 200, { ok: true, multiplier: card.multiplier, payout, data: bootstrapPayload() });
}

async function handleMinesStart(body, res) {
  const bet = Number(body.bet || 0);
  const mineCount = Number(body.mineCount || 3);

  if (!Number.isFinite(bet) || bet < MINES_MIN_BET) {
    await sendJson(res, 400, { error: `Минимальная ставка ${MINES_MIN_BET.toFixed(2)} USDT` });
    return;
  }
  if (!Number.isInteger(mineCount) || mineCount < 3 || mineCount > 24) {
    await sendJson(res, 400, { error: "Количество мин: от 3 до 24" });
    return;
  }
  if (state.minesSession?.active) {
    await sendJson(res, 400, { error: "Сначала заверши текущую игру" });
    return;
  }
  if (!spendBalance(bet)) {
    await sendJson(res, 400, { error: "Недостаточно средств для старта" });
    return;
  }

  const user = getUser();
  user.in_game = Number((user.in_game + bet).toFixed(2));
  state.minesSession = {
    active: true,
    bet,
    mineCount,
    mines: sampleRandomIndices(MINES_GRID_SIZE, mineCount),
    revealed: [],
    safePicks: 0,
    multiplier: 1,
    lastOutcome: null
  };
  addLog(user.username || "player", `Мины: игра началась со ставкой ${bet.toFixed(2)} ${CRYPTOBOT_ASSET}`, "mines");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload() });
}

async function handleMinesReveal(body, res) {
  const index = Number(body.index);
  const session = state.minesSession;
  if (!session || !session.active) {
    await sendJson(res, 400, { error: "Сначала начни игру в мины" });
    return;
  }
  if (!Number.isInteger(index) || index < 0 || index >= MINES_GRID_SIZE) {
    await sendJson(res, 400, { error: "Некорректная клетка" });
    return;
  }
  if (session.revealed.includes(index)) {
    await sendJson(res, 400, { error: "Эта клетка уже открыта" });
    return;
  }

  session.revealed.push(index);
  session.revealed.sort((a, b) => a - b);
  const user = getUser();

  if (session.mines.includes(index)) {
    session.active = false;
    session.lastOutcome = { type: "loss", mineIndex: index, mines: session.mines };
    user.games_played += 1;
    user.volume = Number((user.volume + session.bet).toFixed(2));
    user.in_game = Number(Math.max(0, user.in_game - session.bet).toFixed(2));
    addLog(user.username || "player", `Мины: взрыв на клетке ${index + 1}`, "loss");
    await persistState();
    await sendJson(res, 200, { ok: true, data: bootstrapPayload() });
    return;
  }

  session.safePicks += 1;
  session.multiplier = minesMultiplier(session.mineCount, session.safePicks);
  session.lastOutcome = { type: "safe", index };
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload() });
}

async function handleMinesCashout(res) {
  const session = state.minesSession;
  if (!session || !session.active || session.safePicks < 1) {
    await sendJson(res, 400, { error: "В игре в мины пока нечего забирать" });
    return;
  }

  const user = getUser();
  const payout = Number((session.bet * session.multiplier).toFixed(2));
  awardBalance(payout);
  user.in_game = Number(Math.max(0, user.in_game - session.bet).toFixed(2));
  user.games_played += 1;
  user.wins += 1;
  user.volume = Number((user.volume + session.bet).toFixed(2));
  state.minesSession = {
    ...session,
    active: false,
    lastOutcome: { type: "cashout", payout, multiplier: session.multiplier }
  };
  addLog(user.username || "player", `Мины: получен выигрыш ${payout.toFixed(2)} ${CRYPTOBOT_ASSET}`, "win");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload() });
}

function randomCrashMultiplier() {
  return Number(Math.max(1.2, Math.min(20, 1.1 + Math.pow(Math.random(), 1.8) * 8)).toFixed(2));
}

async function handleCrashStart(body, res) {
  const bet = Number(body.bet || 0);
  if (!Number.isFinite(bet) || bet < CRASH_MIN_BET) {
    await sendJson(res, 400, { error: `Минимальная ставка ${CRASH_MIN_BET.toFixed(2)} USDT` });
    return;
  }
  await settleCrashIfNeeded();
  if (state.crashSession?.active) {
    await sendJson(res, 400, { error: "Сначала забери выигрыш или дождись остановки ракеты" });
    return;
  }
  if (!spendBalance(bet)) {
    await sendJson(res, 400, { error: "Недостаточно средств для старта" });
    return;
  }
  const user = getUser();
  user.in_game = Number((user.in_game + bet).toFixed(2));
  state.crashSession = {
    active: true,
    status: "running",
    bet: Number(bet.toFixed(2)),
    started_at: Date.now(),
    crash_multiplier: randomCrashMultiplier(),
    multiplier: 1,
    lastOutcome: null
  };
  addLog(user.username || "player", `Ракета стартовала со ставкой ${bet.toFixed(2)} ${CRYPTOBOT_ASSET}`, "bet");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload() });
}

async function handleCrashCashout(res) {
  await settleCrashIfNeeded();
  const session = state.crashSession;
  if (!session?.active) {
    await sendJson(res, 400, { error: "Ракета уже остановилась" });
    return;
  }
  const user = getUser();
  const multiplier = Math.min(Number(session.crash_multiplier), crashMultiplier(session.started_at));
  const payout = Number((Number(session.bet) * multiplier).toFixed(2));
  session.active = false;
  session.status = "cashed_out";
  session.multiplier = Number(multiplier.toFixed(2));
  session.lastOutcome = { type: "cashout", multiplier: session.multiplier, payout };
  user.in_game = Number(Math.max(0, user.in_game - Number(session.bet)).toFixed(2));
  user.games_played += 1;
  user.wins += 1;
  user.volume = Number((user.volume + Number(session.bet)).toFixed(2));
  awardBalance(payout);
  addLog(user.username || "player", `Ракета: забрано ${payout.toFixed(2)} ${CRYPTOBOT_ASSET} на x${session.multiplier.toFixed(2)}`, "win");
  await persistState();
  await sendJson(res, 200, { ok: true, payout, data: bootstrapPayload() });
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
      await settleCrashIfNeeded();
      await sendJson(res, 200, bootstrapPayload());
      return;
    }
    if (parsed.pathname === "/api/deposits/sync") {
      await handleSyncDeposits(res);
      return;
    }
    if (parsed.pathname.startsWith("/pay/")) {
      const key = decodeURIComponent(parsed.pathname.slice("/pay/".length));
      const deposit = state.deposits.find((item) => String(item.invoice_hash || item.invoice_id || "") === key);
      if (!deposit || !deposit.invoice_url) {
        await sendJson(res, 404, { error: "Счёт не найден или уже недоступен" });
        return;
      }
      res.writeHead(302, { Location: deposit.invoice_url, "Cache-Control": "no-store" });
      res.end();
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
        await sendJson(res, 403, { error: "Доступ запрещён" });
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
        await sendJson(res, 400, { error: "Некорректные данные запроса" });
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
      await sendJson(res, 400, { error: "Некорректные данные запроса" });
      return;
    }

    if (parsed.pathname === "/api/deposit/create-check") {
      await handleCreateInvoice(body, res, req);
      return;
    }
    if (parsed.pathname === "/api/promos/activate") {
      await handleActivatePromo(body, res);
      return;
    }
    if (parsed.pathname === "/api/admin/promos") {
      await handleAdminCreatePromo(body, res);
      return;
    }
    if (parsed.pathname === "/api/admin/users/balance") {
      await handleAdminAdjustBalance(body, res);
      return;
    }
    if (parsed.pathname === "/api/admin/settings") {
      await handleAdminSettings(body, res);
      return;
    }
    if (parsed.pathname.startsWith("/api/admin/withdrawals/") && parsed.pathname.endsWith("/status")) {
      await handleAdminWithdrawalStatus(parsed.pathname.split("/")[4], body, res);
      return;
    }
    if (parsed.pathname.startsWith("/api/admin/promos/") && parsed.pathname.endsWith("/delete")) {
      await handleDeletePromo(parsed.pathname.split("/")[4], res);
      return;
    }
    if (parsed.pathname === "/api/withdrawals") {
      await handleWithdrawal(body, res);
      return;
    }
    if (parsed.pathname === "/api/roulette/spin") {
      await handleRouletteSpin(body, res);
      return;
    }
    if (parsed.pathname === "/api/roulette/bonus") {
      await handleRouletteBonusPick(body, res);
      return;
    }
    if (parsed.pathname === "/api/mines/start") {
      await handleMinesStart(body, res);
      return;
    }
    if (parsed.pathname === "/api/mines/reveal") {
      await handleMinesReveal(body, res);
      return;
    }
    if (parsed.pathname === "/api/mines/cashout") {
      await handleMinesCashout(res);
      return;
    }
    if (parsed.pathname === "/api/crash/start") {
      await handleCrashStart(body, res);
      return;
    }
    if (parsed.pathname === "/api/crash/cashout") {
      await handleCrashCashout(res);
      return;
    }

    await sendJson(res, 404, { error: "Адрес не найден" });
    return;
  }

  await sendJson(res, 405, { error: "Метод запроса не поддерживается" });
}

async function main() {
  await ensureState();
  if (AUTO_DEPOSIT_SYNC_ENABLED) {
    setInterval(() => {
      syncDepositsOnce().catch((error) => {
        console.error("Auto deposit sync failed:", error);
      });
    }, Math.max(5000, AUTO_DEPOSIT_SYNC_INTERVAL_MS));
  }
  const server = http.createServer((req, res) => {
    routeRequest(req, res).catch(async (error) => {
      console.error(error);
      if (!res.headersSent) {
        await sendJson(res, 500, { error: "Внутренняя ошибка сервера" });
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
