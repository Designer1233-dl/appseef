"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const https = require("https");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
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
const WITHDRAWAL_COOLDOWN_MS = 10000;
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
const TELEGRAM_BOT_TOKEN = envStr("BOR_TELEGRAM_BOT_TOKEN", envStr("TELEGRAM_BOT_TOKEN", envStr("BOT_TOKEN", "")));
const TELEGRAM_AUTH_MAX_AGE_SECONDS = envInt("BOR_TELEGRAM_AUTH_MAX_AGE_SECONDS", 86400);
const ADMIN_TELEGRAM_IDS = new Set(
  envStr(
    "BOR_ADMIN_TELEGRAM_IDS",
    envStr("ADMIN_ID", envStr("OWNER_ID", typeof process.env.BOR_DEFAULT_ADMIN_ID === "string" ? process.env.BOR_DEFAULT_ADMIN_ID : ""))
  )
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
);

const CRYPTOBOT_ENABLED = envBool("BOR_CRYPTOBOT_ENABLED", true);
const CRYPTOBOT_BOT_USERNAME = envStr("BOR_CRYPTOBOT_BOT_USERNAME", "CryptoBot");
const CRYPTOBOT_API_TOKEN = envStr("BOR_CRYPTOBOT_API_TOKEN", envStr("CRYPTOBOT_API_TOKEN", envStr("CRYPTO_PAY_API_TOKEN", "")));
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
let rouletteBonusTimer = null;
const requestContext = new AsyncLocalStorage();

function minesResetDelayMs() {
  return 5000 + Math.floor(Math.random() * 15001);
}

async function resetMinesIfNeeded() {
  const session = state?.minesSession;
  if (!session || session.active || !session.reset_at || Date.now() < Number(session.reset_at)) {
    return false;
  }
  state.minesSession = null;
  await persistState();
  return true;
}

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
    { id: "mines", name: "Мины", icon: "💣", note: "доступно", theme: "mines", live: true },
    { id: "crash", name: "Ракета", icon: "🚀", note: "доступно", theme: "crash", live: true },
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
        wager_remaining: 0,
        is_admin: 1,
        vip_level: "Серебро"
      }
    ],
    settings: {
      auto_withdraw: AUTO_WITHDRAW_DEFAULT ? "1" : "0",
      risk_alerts: "0",
      vip_silver: "0",
      vip_gold: "0",
      freeze_queue: "0",
      min_withdraw: "1"
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
      { id: 1, code: "BORVIP", activation_limit: 30, activated_count: 8, deposit_required: 1, deposit_min: 25, expires_at: promoA, bonus_amount: 10, wager_multiplier: 1, active: 1, created_at: nowIso() },
      { id: 2, code: "BORSTART", activation_limit: 50, activated_count: 41, deposit_required: 0, deposit_min: 0, expires_at: promoB, bonus_amount: 5, wager_multiplier: 1, active: 1, created_at: nowIso() }
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
    wager_remaining: Number.isFinite(Number(user?.wager_remaining)) ? Math.max(0, Number(user.wager_remaining)) : 0,
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
  if (state.rouletteBonus?.active) {
    state.rouletteBonus.selections = state.rouletteBonus.selections && typeof state.rouletteBonus.selections === "object" ? state.rouletteBonus.selections : {};
    state.rouletteBonus.expires_at = Number(state.rouletteBonus.expires_at) || Date.now() + 20000;
    scheduleRouletteBonus();
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

function getUser() {
  const telegramAuth = requestContext.getStore()?.telegramAuth;
  if (telegramAuth?.valid && Number.isSafeInteger(telegramAuth.telegramId)) {
    let user = state.users.find((item) => Number(item.id) === telegramAuth.telegramId);
    if (!user) {
      const telegramUser = telegramAuth.telegramUser || {};
      const displayName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(" ").trim();
      user = sanitizeUser({
        id: telegramAuth.telegramId,
        username: telegramUser.username || `user${telegramAuth.telegramId}`,
        display_name: displayName || telegramUser.username || `Пользователь ${telegramAuth.telegramId}`,
        balance: 0,
        in_game: 0,
        games_played: 0,
        wins: 0,
        volume: 0,
        is_admin: telegramAuth.isAdmin ? 1 : 0,
        vip_level: "Серебро"
      });
      state.users.push(user);
    }
    user.is_admin = telegramAuth.isAdmin ? 1 : 0;
    return user;
  }
  return state.users[0];
}

function telegramRequestAuth(req) {
  if (!TELEGRAM_BOT_TOKEN) {
    return { valid: false, isAdmin: false, reason: "bot_token_missing" };
  }
  const initData = String(reqHeader(req.headers, "x-telegram-init-data") || "").trim();
  if (!initData) {
    return { valid: false, isAdmin: false, reason: "init_data_missing" };
  }
  const params = new URLSearchParams(initData);
  const receivedHash = String(params.get("hash") || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(receivedHash)) {
    return { valid: false, isAdmin: false, reason: "hash_missing" };
  }
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(TELEGRAM_BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  const validSignature = crypto.timingSafeEqual(Buffer.from(calculatedHash, "hex"), Buffer.from(receivedHash, "hex"));
  if (!validSignature) {
    return { valid: false, isAdmin: false, reason: "signature_invalid" };
  }
  const authDate = Number(params.get("auth_date") || 0);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(authDate) || authDate <= 0 || Math.abs(nowSeconds - authDate) > TELEGRAM_AUTH_MAX_AGE_SECONDS) {
    return { valid: false, isAdmin: false, reason: "auth_expired" };
  }
  let telegramUser = null;
  try {
    telegramUser = JSON.parse(params.get("user") || "null");
  } catch {
    return { valid: false, isAdmin: false, reason: "user_invalid" };
  }
  const telegramId = Number(telegramUser?.id);
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
    return { valid: false, isAdmin: false, reason: "user_missing" };
  }
  return { valid: true, isAdmin: ADMIN_TELEGRAM_IDS.has(telegramId), telegramId, telegramUser };
}

function addLog(username, action, tag) {
  state.activity.unshift({
    id: nextId("activity"),
    username,
    action,
    tag,
    created_at: nowIso()
  });
  state.activity = state.activity.slice(0, 500);
}

function appMeta() {
  return {
    title: APP_TITLE,
    mode: APP_MODE,
    webappUrl: WEBAPP_URL,
    webhookBaseUrl: WEBHOOK_BASE_URL,
    webhookUrl: webhookUrl(),
    telegramAuthConfigured: Boolean(TELEGRAM_BOT_TOKEN && ADMIN_TELEGRAM_IDS.size),
    telegramBotTokenConfigured: Boolean(TELEGRAM_BOT_TOKEN),
    adminIdsConfigured: ADMIN_TELEGRAM_IDS.size > 0,
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
  const currentUser = getUser();
  if (session.active && Number(session.user_id) !== Number(currentUser.id)) {
    return {
      active: false,
      mineCount: 3,
      bet: 0,
      revealed: [],
      safePicks: 0,
      potentialWin: 0,
      lastOutcome: null,
      busy: true
    };
  }
  return {
    active: session.active,
    mineCount: session.mineCount,
    bet: session.bet,
    revealed: session.revealed,
    safePicks: session.safePicks,
    potentialWin: Number((session.bet * session.multiplier).toFixed(2)),
    lastOutcome: session.lastOutcome || null,
    resetAt: Number(session.reset_at || 0),
    secondsToReset: session.reset_at ? Math.max(0, Math.ceil((Number(session.reset_at) - Date.now()) / 1000)) : 0
  };
}

function crashMultiplier(startedAt) {
  const elapsed = Math.max(0, Date.now() - Number(startedAt || Date.now()));
  return Number(Math.min(100, Math.max(1, Math.exp(elapsed / 7000))).toFixed(2));
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
    startedAt: session.active ? Number(session.started_at || 0) : 0,
    multiplier: Number(current.toFixed(2)),
    lastOutcome: session.lastOutcome || null
  };
}

async function settleCrashIfNeeded() {
  const session = state.crashSession;
  if (!session?.active || crashMultiplier(session.started_at) < Number(session.crash_multiplier)) {
    return false;
  }
  const user = state.users.find((item) => Number(item.id) === Number(session.user_id));
  if (!user) {
    session.active = false;
    session.status = "crashed";
    session.multiplier = Number(session.crash_multiplier);
    return true;
  }
  const multiplier = Number(session.crash_multiplier);
  session.active = false;
  session.status = "crashed";
  session.multiplier = multiplier;
  session.lastOutcome = { type: "loss", multiplier };
  user.in_game = Number(Math.max(0, user.in_game - Number(session.bet)).toFixed(2));
  user.games_played += 1;
  user.volume = Number((user.volume + Number(session.bet)).toFixed(2));
  applyWagerTurnover(user, Number(session.bet));
  addLog(user.username || "player", `Ракета остановилась на x${multiplier.toFixed(2)}`, "loss");
  await persistState();
  return true;
}

function rouletteView() {
  const round = state.rouletteRound;
  const currentUser = getUser();
  if (!round || !round.active) {
    return { active: false, bets: [], participants: [], totalBet: 0, userTotalBet: 0, secondsLeft: 0, durationMs: ROULETTE_BET_LOCK_MS, maxBets: ROULETTE_MAX_BETS };
  }
  const allBets = Array.isArray(round.bets) ? round.bets : [];
  const bets = allBets
    .filter((bet) => Number(bet.user_id) === Number(currentUser.id));
  const participantMap = new Map();
  for (const bet of allBets) {
    const key = Number(bet.user_id);
    const participant = participantMap.get(key) || { userId: key, username: bet.username || "player", amount: 0, betsCount: 0 };
    participant.amount = Number((participant.amount + Number(bet.amount || 0)).toFixed(2));
    participant.betsCount += 1;
    participantMap.set(key, participant);
  }
  return {
    active: true,
    bets: bets.map((bet) => ({ choice: bet.choice, amount: bet.amount })),
    participants: [...participantMap.values()],
    totalBet: Number(allBets.reduce((sum, bet) => sum + Number(bet.amount || 0), 0).toFixed(2)),
    userTotalBet: Number(bets.reduce((sum, bet) => sum + Number(bet.amount || 0), 0).toFixed(2)),
    opensAt: round.opens_at,
    closesAt: round.closes_at,
    secondsLeft: Math.max(0, Number(((Number(round.closes_at) - Date.now()) / 1000).toFixed(1))),
    durationMs: Math.max(1, Number(round.closes_at) - Number(round.opens_at || (round.closes_at - ROULETTE_BET_LOCK_MS))),
    maxBets: ROULETTE_MAX_BETS
  };
}

function rouletteBonusView() {
  const bonus = state.rouletteBonus;
  const currentUser = getUser();
  if (!bonus) {
    return { active: false, waiting: false, locked: false, eligible: false, cards: [], bet: 0, chosenIndex: null };
  }
  const userId = String(currentUser.id);
  const userBets = (bonus.bets || []).filter((bet) => Number(bet.user_id) === Number(currentUser.id));
  const selection = bonus.selections?.[userId] || null;
  const eligible = userBets.length > 0;
  return {
    active: Boolean(bonus.active && eligible && !selection),
    waiting: Boolean(bonus.active && eligible && selection),
    locked: Boolean(bonus.active),
    eligible,
    bet: Number(userBets.reduce((sum, bet) => sum + Number(bet.amount || 0), 0).toFixed(2)),
    chosenIndex: Number.isInteger(selection?.index) ? selection.index : null,
    multiplier: selection?.multiplier || null,
    payout: selection?.payout || 0,
    cards: (bonus.cards || []).map((card) => ({ index: card.index, label: "BOR" }))
  };
}

function bootstrapPayload(adminAuthorized = false) {
  const user = { ...getUser(), is_admin: adminAuthorized ? 1 : 0 };
  const telegramAuth = requestContext.getStore()?.telegramAuth || {};
  const totalVolume = state.users.reduce((sum, item) => sum + Number(item.volume || 0), 0);
  return {
    app: appMeta(),
    user,
    settings: adminAuthorized ? state.settings : {},
    activity: adminAuthorized ? state.activity : [],
    withdrawals: adminAuthorized ? [...state.withdrawals].sort((a, b) => b.id - a.id) : [],
    userWithdrawals: state.withdrawals
      .filter((item) => Number(item.user_id) === Number(user.id))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 30),
    promos: adminAuthorized ? [...state.promos].sort((a, b) => b.id - a.id) : [],
    admin: adminAuthorized ? { usersCount: state.users.length, totalVolume: Number(totalVolume.toFixed(2)) } : null,
    auth: {
      telegramValid: Boolean(telegramAuth.valid),
      telegramId: telegramAuth.valid ? telegramAuth.telegramId : null,
      adminAuthorized: Boolean(adminAuthorized),
      reason: telegramAuth.valid ? (adminAuthorized ? "admin" : "not_allowlisted") : telegramAuth.reason || "unknown"
    },
    wheels: [...state.wheels].sort((a, b) => b.id - a.id),
    deposits: state.deposits
      .filter((item) => Number(item.user_id) === Number(user.id))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 30),
    games: state.games,
    limits: { minWithdraw: Math.max(0.1, Number(state.settings.min_withdraw || 1)) },
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
  const payload = {
    asset: CRYPTOBOT_ASSET,
    amount: amount.toFixed(2),
    description: `Пополнение ${APP_TITLE} для @${user.username || "player"}`,
    hidden_message: `Баланс в ${APP_TITLE} обновится только после подтвержденной оплаты.`,
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
  if (/^https:\/\//i.test(WEBAPP_URL)) {
    payload.paid_btn_name = "callback";
    payload.paid_btn_url = WEBAPP_URL;
  }
  return payload;
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
              const apiError = parsed.error;
              const errorText = typeof apiError === "string"
                ? apiError
                : apiError && typeof apiError === "object"
                  ? [apiError.name, apiError.code, apiError.message].filter(Boolean).join(": ") || JSON.stringify(apiError)
                  : "CryptoBot request failed";
              reject(new Error(errorText));
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

function translateCryptoError(error) {
  const raw = String(error?.message || error || "").trim();
  const value = raw.toUpperCase();
  if (!raw) return "CryptoBot вернул пустую ошибку";
  if (value.includes("API NOT CONFIGURED")) return "API CryptoBot не настроен на сервере";
  if (value.includes("UNAUTHORIZED") || value.includes("TOKEN") && value.includes("INVALID")) return "Неверный API-токен Crypto Pay";
  if (value.includes("INSUFFICIENT") || value.includes("BALANCE")) return "Недостаточно USDT на балансе приложения Crypto Pay";
  if (value.includes("TRANSFERS_NOT_ALLOWED") || value.includes("TRANSFER") && value.includes("DISABLED")) return "Переводы выключены в настройках приложения Crypto Pay";
  if (value.includes("USER_NOT_FOUND") || value.includes("INVALID_USER") || value.includes("USER_ID")) return "Получатель не найден в CryptoBot — пользователь должен открыть @CryptoBot хотя бы один раз";
  if (value.includes("AMOUNT_TOO_SMALL") || value.includes("MIN_AMOUNT")) return "Сумма меньше минимальной суммы перевода CryptoBot";
  if (value.includes("AMOUNT_TOO_BIG") || value.includes("MAX_AMOUNT")) return "Сумма превышает лимит перевода CryptoBot";
  if (value.includes("SPEND_ID") || value.includes("DUPLICATE")) return "Этот идентификатор перевода уже использован; создайте новую заявку";
  if (value.includes("TIMEOUT")) return "CryptoBot не ответил вовремя";
  if (value.includes("UNAVAILABLE") || value.includes("ECONN") || value.includes("ENOTFOUND")) return "Сервис CryptoBot временно недоступен";
  return `Ошибка CryptoBot: ${raw}`;
}

function validTelegramUserId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0;
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
  const user = state.users.find((item) => Number(item.id) === Number(deposit.user_id))
    || state.users.find((item) => String(item.username) === String(deposit.username));
  if (!user) return false;
  deposit.credited = 1;
  deposit.credited_at = nowIso();
  deposit.paid_amount = amountToCredit;
  deposit.paid_asset = paidAsset || deposit.asset;
  deposit.status = "paid";
  deposit.updated_at = nowIso();
  deposit.comment = "credited";
  user.balance = Number((user.balance + amountToCredit).toFixed(2));
  user.wager_remaining = Number((Number(user.wager_remaining || 0) + amountToCredit).toFixed(2));
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
  return spendBalanceForUser(user, amount);
}

function spendBalanceForUser(user, amount) {
  if (amount <= 0 || amount > user.balance) {
    return false;
  }
  user.balance = Number((user.balance - amount).toFixed(2));
  return true;
}

function awardBalance(amount) {
  awardBalanceForUser(getUser(), amount);
}

function awardBalanceForUser(user, amount) {
  user.balance = Number((user.balance + amount).toFixed(2));
}

function applyWagerTurnover(user, amount) {
  if (!user || !Number.isFinite(Number(amount)) || Number(amount) <= 0) return;
  user.wager_remaining = Number(Math.max(0, Number(user.wager_remaining || 0) - Number(amount)).toFixed(2));
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
    "Content-Length": data.length,
    "Cache-Control": /\.(?:html|js|css)$/i.test(filePath) ? "no-store, no-cache, must-revalidate" : "public, max-age=86400"
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
  if (!cryptoEnabled()) {
    await sendJson(res, 503, { error: "CryptoBot не настроен: укажи BOR_CRYPTOBOT_API_TOKEN и перезапусти сервер" });
    return;
  }
  const requestId = crypto.randomUUID().replace(/-/g, "");
  let invoice;
  let source;

  try {
    invoice = await cryptoApiRequest("createInvoice", buildInvoicePayload(user, amount, requestId));
    source = "cryptobot";
    if (!invoice || !(invoice.bot_invoice_url || invoice.mini_app_invoice_url || invoice.web_app_invoice_url)) {
      throw new Error("CryptoBot не вернул ссылку созданного счёта");
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
    data: bootstrapPayload(Boolean(res.adminAuthorized))
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
      data: bootstrapPayload(Boolean(res.adminAuthorized))
    });
    return;
  }

  await sendJson(res, 200, {
    ok: true,
    stats: syncResult,
    data: bootstrapPayload(Boolean(res.adminAuthorized))
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

  if (!validTelegramUserId(user.id)) {
    await sendJson(res, 400, { error: "Вывод доступен только после входа через Telegram Mini App: не получен Telegram ID" });
    return;
  }
  const latestWithdrawal = state.withdrawals
    .filter((item) => Number(item.user_id) === Number(user.id))
    .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))[0];
  const cooldownLeftMs = latestWithdrawal ? WITHDRAWAL_COOLDOWN_MS - (Date.now() - Date.parse(latestWithdrawal.created_at || 0)) : 0;
  if (cooldownLeftMs > 0) {
    await sendJson(res, 429, { error: `Подожди ${Math.ceil(cooldownLeftMs / 1000)} сек. перед новой заявкой`, retryAfter: Math.ceil(cooldownLeftMs / 1000) });
    return;
  }

  const minWithdraw = Math.max(0.1, Number(state.settings.min_withdraw || 1));
  if (!Number.isFinite(amount) || amount < minWithdraw) {
    await sendJson(res, 400, { error: `Минимальный вывод ${minWithdraw.toFixed(2)} USDT` });
    return;
  }
  if (amount > user.balance) {
    await sendJson(res, 400, { error: "Недостаточно средств" });
    return;
  }
  if (Number(user.wager_remaining || 0) > 0) {
    await sendJson(res, 400, { error: `Сначала отыграй вагер: осталось ${Number(user.wager_remaining).toFixed(2)} USDT оборота` });
    return;
  }

  user.balance = Number((user.balance - amount).toFixed(2));
  const withdrawal = {
    id: nextId("withdrawals"),
    username: user.username || "player",
    user_id: user.id,
    amount,
    asset: CRYPTOBOT_ASSET,
    status: "pending",
    risk_score: state.settings.risk_alerts === "1" && amount > AUTO_WITHDRAW_LIMIT ? "review" : "clean",
    auto_requested: state.settings.auto_withdraw === "1" ? 1 : 0,
    spend_id: `bor_withdraw_${crypto.randomUUID().replace(/-/g, "")}`.slice(0, 64),
    created_at: nowIso()
  };
  state.withdrawals.unshift(withdrawal);
  addLog(user.username || "player", `Подал заявку на вывод ${amount.toFixed(2)} ${CRYPTOBOT_ASSET}`, "withdrawal");
  await persistState();

  const autoAllowed = state.settings.auto_withdraw === "1" && state.settings.freeze_queue !== "1" && withdrawal.risk_score !== "review";
  if (autoAllowed) {
    try {
      withdrawal.transfer_attempted_at = nowIso();
      await persistState();
      const transfer = await cryptoApiRequest("transfer", {
        user_id: Number(user.id),
        asset: CRYPTOBOT_ASSET,
        amount: amount.toFixed(2),
        spend_id: withdrawal.spend_id
      });
      withdrawal.status = "approved";
      withdrawal.transfer_id = transfer?.transfer_id || null;
      withdrawal.completed_at = transfer?.completed_at || nowIso();
      withdrawal.updated_at = nowIso();
      addLog(user.username || "player", `Автовывод выполнен: ${amount.toFixed(2)} ${CRYPTOBOT_ASSET}`, "withdrawal");
    } catch (error) {
      withdrawal.status = "review";
      withdrawal.auto_error = translateCryptoError(error).slice(0, 300);
      withdrawal.updated_at = nowIso();
      addLog(user.username || "player", `Ошибка автовывода ${amount.toFixed(2)} ${CRYPTOBOT_ASSET}: ${withdrawal.auto_error}`, "risk");
    }
    await persistState();
  }

  await sendJson(res, 200, {
    ok: true,
    status: withdrawal.status,
    auto: autoAllowed,
    data: bootstrapPayload(Boolean(res.adminAuthorized))
  });
}

async function handleCancelWithdrawal(withdrawalId, res) {
  const user = getUser();
  const withdrawal = state.withdrawals.find((item) => String(item.id) === String(withdrawalId));
  if (!withdrawal || Number(withdrawal.user_id) !== Number(user.id)) {
    await sendJson(res, 404, { error: "Заявка на вывод не найдена" });
    return;
  }
  if (!["pending", "review"].includes(withdrawal.status) || withdrawal.transfer_attempted_at || withdrawal.transfer_id || withdrawal.auto_error) {
    await sendJson(res, 409, { error: "Эту заявку уже нельзя отменить" });
    return;
  }
  withdrawal.status = "cancelled";
  withdrawal.cancelled_at = nowIso();
  withdrawal.updated_at = nowIso();
  user.balance = Number((Number(user.balance || 0) + Number(withdrawal.amount || 0)).toFixed(2));
  addLog(user.username || "player", `Отменил вывод ${Number(withdrawal.amount || 0).toFixed(2)} ${withdrawal.asset || CRYPTOBOT_ASSET}`, "withdrawal");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload(Boolean(res.adminAuthorized)) });
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
    const hasRequiredDeposit = state.deposits.some((deposit) => Number(deposit.user_id) === Number(user.id) && deposit.credited && Number(deposit.paid_amount || deposit.amount || 0) >= Number(promo.deposit_min || 0));
    if (!hasRequiredDeposit) {
      await sendJson(res, 400, { error: `Для этого промокода нужен депозит от ${Number(promo.deposit_min || 0).toFixed(2)} ${CRYPTOBOT_ASSET}` });
      return;
    }
  }

  promo.activated_count += 1;
  promo.activated_user_ids = [...activatedUserIds, user.id];
  user.balance = Number((user.balance + promo.bonus_amount).toFixed(2));
  const wagerMultiplier = Math.max(0, Number(promo.wager_multiplier || 0));
  user.wager_remaining = Number((Number(user.wager_remaining || 0) + promo.bonus_amount * wagerMultiplier).toFixed(2));
  addLog(user.username || "player", `Активировал промокод ${code} на ${promo.bonus_amount.toFixed(2)} ${CRYPTOBOT_ASSET}`, "promo");
  await persistState();
  await sendJson(res, 200, { ok: true, message: `Промокод ${code} активирован`, data: bootstrapPayload(Boolean(res.adminAuthorized)) });
}

async function handleAdminCreatePromo(body, res) {
  if (!res.adminAuthorized) {
    await sendJson(res, 403, { error: "Требуются права администратора" });
    return;
  }

  const code = String(body.code || "").trim().toUpperCase();
  const activationLimit = Number(body.activation_limit || 0);
  const depositRequired = body.deposit_required ? 1 : 0;
  const depositMin = Number(body.deposit_min || 0);
  const bonusAmount = Number(body.bonus_amount || 0);
  const wagerMultiplier = Number(body.wager_multiplier ?? 1);
  const expiresAt = String(body.expires_at || "").trim();

  if (!code || !Number.isFinite(activationLimit) || activationLimit <= 0) {
    await sendJson(res, 400, { error: "Заполни код и лимит активаций" });
    return;
  }
  if (state.promos.some((item) => item.code === code)) {
    await sendJson(res, 409, { error: "Промокод уже существует" });
    return;
  }
  if (!Number.isFinite(wagerMultiplier) || wagerMultiplier < 0 || wagerMultiplier > 100) {
    await sendJson(res, 400, { error: "Вагер должен быть от x0 до x100" });
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
    wager_multiplier: Number(wagerMultiplier.toFixed(2)),
    active: 1,
    created_at: nowIso()
  });
  addLog("admin", `Создал промокод ${code}`, "promo");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload(Boolean(res.adminAuthorized)) });
}

async function handleAdminAdjustBalance(body, res) {
  if (!res.adminAuthorized) {
    await sendJson(res, 403, { error: "Требуются права администратора" });
    return;
  }

  const amount = Number(body.amount || 0);
  const operation = String(body.operation || "").trim();
  const username = String(body.username || "").trim().replace(/^@+/, "").toLowerCase();
  if (!username) {
    await sendJson(res, 400, { error: "Укажи username пользователя" });
    return;
  }
  let user = state.users.find((item) => String(item.username || "").trim().replace(/^@+/, "").toLowerCase() === username);
  if (!user && operation === "add") {
    const nextUserId = state.users.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
    user = sanitizeUser({
      id: nextUserId,
      username,
      display_name: username,
      balance: 0,
      in_game: 0,
      games_played: 0,
      wins: 0,
      volume: 0,
      is_admin: 0,
      vip_level: "Серебро"
    });
    state.users.push(user);
  }
  if (!user) {
    await sendJson(res, 404, { error: `Пользователь @${username} не найден` });
    return;
  }
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
  await sendJson(res, 200, {
    ok: true,
    target: { username: user.username, balance: user.balance },
    data: bootstrapPayload(Boolean(res.adminAuthorized))
  });
}

async function handleAdminWithdrawalStatus(withdrawalId, body, res) {
  if (!res.adminAuthorized) {
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

  if (newStatus === "approved") {
    if (!validTelegramUserId(withdrawal.user_id)) {
      withdrawal.status = "review";
      withdrawal.auto_error = "У заявки нет Telegram ID получателя. Это тестовая или старая заявка — отклоните её и создайте новую через Telegram Mini App.";
      withdrawal.updated_at = nowIso();
      await persistState();
      await sendJson(res, 400, { error: withdrawal.auto_error });
      return;
    }
    try {
      withdrawal.transfer_attempted_at = nowIso();
      await persistState();
      const transfer = await cryptoApiRequest("transfer", {
        user_id: Number(withdrawal.user_id),
        asset: withdrawal.asset || CRYPTOBOT_ASSET,
        amount: Number(withdrawal.amount || 0).toFixed(2),
        spend_id: withdrawal.spend_id || `bor_withdraw_${withdrawal.id}`
      });
      withdrawal.transfer_id = transfer?.transfer_id || null;
      withdrawal.completed_at = transfer?.completed_at || nowIso();
      delete withdrawal.auto_error;
    } catch (error) {
      withdrawal.status = "review";
      withdrawal.auto_error = translateCryptoError(error).slice(0, 300);
      withdrawal.updated_at = nowIso();
      await persistState();
      await sendJson(res, 502, { error: withdrawal.auto_error });
      return;
    }
  }

  withdrawal.status = newStatus;
  withdrawal.updated_at = nowIso();
  if (newStatus === "rejected") {
    const withdrawalUser = state.users.find((item) => Number(item.id) === Number(withdrawal.user_id))
      || state.users.find((item) => String(item.username).toLowerCase() === String(withdrawal.username).toLowerCase());
    if (withdrawalUser) {
      withdrawalUser.balance = Number((Number(withdrawalUser.balance || 0) + Number(withdrawal.amount || 0)).toFixed(2));
    }
  }
  addLog("admin", `${newStatus === "approved" ? "Одобрил" : "Отклонил"} вывод ${Number(withdrawal.amount || 0).toFixed(2)} ${CRYPTOBOT_ASSET} для @${withdrawal.username}`, "withdrawal");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload(Boolean(res.adminAuthorized)) });
}

async function handleAdminResetAllBalances(body, res) {
  if (!res.adminAuthorized) {
    await sendJson(res, 403, { error: "Требуются права администратора" });
    return;
  }
  if (String(body.confirmation || "") !== "RESET_ALL_BALANCES") {
    await sendJson(res, 400, { error: "Массовое обнуление не подтверждено" });
    return;
  }

  let clearedUsers = 0;
  let clearedAmount = 0;
  for (const user of state.users) {
    const userFunds = Number(user.balance || 0) + Number(user.in_game || 0);
    if (userFunds > 0) clearedUsers += 1;
    clearedAmount += userFunds;
    user.balance = 0;
    user.in_game = 0;
  }
  state.rouletteRound = null;
  state.rouletteBonus = null;
  state.minesSession = null;
  state.crashSession = null;
  if (rouletteTimer) {
    clearTimeout(rouletteTimer);
    rouletteTimer = null;
  }
  addLog("admin", `Обнулил балансы всех пользователей: ${clearedUsers} аккаунтов, ${clearedAmount.toFixed(2)} ${CRYPTOBOT_ASSET}`, "admin");
  await persistState();
  await sendJson(res, 200, {
    ok: true,
    clearedUsers,
    clearedAmount: Number(clearedAmount.toFixed(2)),
    data: bootstrapPayload(Boolean(res.adminAuthorized))
  });
}

async function handleAdminSettings(body, res) {
  if (!res.adminAuthorized) {
    await sendJson(res, 403, { error: "Требуются права администратора" });
    return;
  }

  for (const key of ["auto_withdraw", "risk_alerts", "freeze_queue"]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      state.settings[key] = body[key] ? "1" : "0";
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "min_withdraw")) {
    const minWithdraw = Number(body.min_withdraw);
    if (!Number.isFinite(minWithdraw) || minWithdraw < 0.1 || minWithdraw > 100000) {
      await sendJson(res, 400, { error: "Минимальный вывод должен быть от 0.10 до 100000 USDT" });
      return;
    }
    state.settings.min_withdraw = Number(minWithdraw.toFixed(2)).toString();
  }
  addLog("admin", "Обновил настройки автоматизации и безопасности", "settings");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload(Boolean(res.adminAuthorized)) });
}

async function handleDeletePromo(promoId, res) {
  if (!res.adminAuthorized) {
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
  await sendJson(res, 200, { ok: true, data: bootstrapPayload(Boolean(res.adminAuthorized)) });
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

function scheduleRouletteBonus() {
  if (rouletteBonusTimer) clearTimeout(rouletteBonusTimer);
  rouletteBonusTimer = null;
  const bonus = state?.rouletteBonus;
  if (!bonus?.active || !bonus.expires_at) return;
  rouletteBonusTimer = setTimeout(() => {
    settleRouletteBonusIfNeeded().catch((error) => console.error("Roulette bonus settlement failed:", error));
  }, Math.max(0, Number(bonus.expires_at) - Date.now()));
}

async function settleRouletteBonusIfNeeded() {
  const bonus = state?.rouletteBonus;
  if (!bonus?.active || !bonus.expires_at || Date.now() < Number(bonus.expires_at)) return false;
  bonus.selections = bonus.selections && typeof bonus.selections === "object" ? bonus.selections : {};
  for (const userId of bonus.user_ids || []) {
    const key = String(userId);
    if (bonus.selections[key]) continue;
    const card = bonus.cards[Math.floor(Math.random() * bonus.cards.length)];
    const userBets = bonus.bets.filter((bet) => Number(bet.user_id) === Number(userId));
    const payout = Number(userBets.reduce((sum, bet) => sum + Number((bet.amount * card.multiplier).toFixed(2)), 0).toFixed(2));
    const betUser = state.users.find((item) => Number(item.id) === Number(userId));
    if (betUser) {
      awardBalanceForUser(betUser, payout);
      betUser.wins += 1;
    }
    bonus.selections[key] = { index: card.index, multiplier: card.multiplier, payout, automatic: true };
    bonus.payout = Number((Number(bonus.payout || 0) + payout).toFixed(2));
  }
  bonus.active = false;
  state.lastRoulette = {
    ...(state.lastRoulette || {}),
    choice: "БОНУС",
    won: true,
    payout: Number(bonus.payout || 0),
    net: Number((Number(bonus.payout || 0) - Number(bonus.bet || 0)).toFixed(2)),
    pendingBonus: false
  };
  rouletteBonusTimer = null;
  await persistState();
  return true;
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

  const usersById = new Map(state.users.map((item) => [Number(item.id), item]));
  for (const bet of bets) {
    const betUser = usersById.get(Number(bet.user_id));
    if (!betUser) continue;
    const amount = Number(bet.amount || 0);
    betUser.in_game = Number(Math.max(0, betUser.in_game - amount).toFixed(2));
    betUser.games_played += 1;
    betUser.volume = Number((betUser.volume + amount).toFixed(2));
    applyWagerTurnover(betUser, amount);
  }

  if (segment.label.toUpperCase() === "БОНУС") {
    state.rouletteBonus = {
      active: true,
      bet: totalBet,
      bets,
      user_ids: [...new Set(bets.map((bet) => Number(bet.user_id)).filter(Number.isSafeInteger))],
      cards: makeRouletteBonusCards(),
      selections: {},
      payout: 0,
      expires_at: Date.now() + 20000
    };
    state.lastRoulette = { ...resultBase, choice: bets.map((item) => item.choice).join(" + "), won: false, payout: 0, net: Number((-totalBet).toFixed(2)), pendingBonus: true };
    addLog("игроки", `X50: выпал БОНУС для ${totalBet.toFixed(2)} ${CRYPTOBOT_ASSET}`, "bonus");
    scheduleRouletteBonus();
  } else {
    let payout = 0;
    let winningBets = 0;
    for (const bet of bets) {
      if (String(bet.choice).toUpperCase() === segment.label.toUpperCase()) {
        const betUser = usersById.get(Number(bet.user_id));
        if (!betUser) continue;
        const betPayout = Number((Number(bet.amount) * segment.multiplier).toFixed(2));
        payout += betPayout;
        awardBalanceForUser(betUser, betPayout);
        winningBets += 1;
        betUser.wins += 1;
      }
    }
    payout = Number(payout.toFixed(2));
    state.rouletteBonus = null;
    state.lastRoulette = {
      ...resultBase,
      choice: bets.map((item) => item.choice).join(" + "),
      won: payout > 0,
      payout,
      net: Number((payout - totalBet).toFixed(2)),
      pendingBonus: false
    };
     addLog("игроки", `X50: выпало ${segment.label}, общая ставка ${totalBet.toFixed(2)} ${CRYPTOBOT_ASSET}`, payout > 0 ? "win" : "loss");
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
  const userRoundBets = round?.active
    ? round.bets.filter((item) => Number(item.user_id) === Number(user.id))
    : [];
  if (round?.active && userRoundBets.length >= ROULETTE_MAX_BETS) {
    await sendJson(res, 400, { error: "В этом раунде уже две ставки" });
    return;
  }
  if (round?.active && userRoundBets.some((item) => String(item.choice).toUpperCase() === choice)) {
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
  state.rouletteRound.bets.push({ user_id: user.id, username: user.username, choice: validChoice.label, amount: Number(bet.toFixed(2)) });
  user.in_game = Number((user.in_game + bet).toFixed(2));
  addLog(user.username || "player", `X50: ставка ${bet.toFixed(2)} ${CRYPTOBOT_ASSET} на ${validChoice.label}`, "bet");
  await persistState();
  scheduleRouletteRound();
  await sendJson(res, 200, { ok: true, status: "bet_accepted", data: bootstrapPayload(Boolean(res.adminAuthorized)) });
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
  const card = bonus.cards[index];
  const user = getUser();
  const userBets = bonus.bets.filter((bet) => Number(bet.user_id) === Number(user.id));
  if (!userBets.length) {
    await sendJson(res, 403, { error: "Этот бонус относится к другой ставке" });
    return;
  }
  bonus.selections = bonus.selections && typeof bonus.selections === "object" ? bonus.selections : {};
  const userKey = String(user.id);
  if (bonus.selections[userKey]) {
    await sendJson(res, 400, { error: "Ты уже выбрал карту в этом бонусе" });
    return;
  }
  const payout = Number(userBets.reduce((sum, bet) => sum + Number((bet.amount * card.multiplier).toFixed(2)), 0).toFixed(2));
  bonus.selections[userKey] = { index, multiplier: card.multiplier, payout };
  bonus.payout = Number((Number(bonus.payout || 0) + payout).toFixed(2));
  awardBalanceForUser(user, payout);
  user.wins += 1;
  const allPicked = bonus.user_ids.every((id) => Boolean(bonus.selections[String(id)]));
  bonus.active = !allPicked;
  if (allPicked && rouletteBonusTimer) {
    clearTimeout(rouletteBonusTimer);
    rouletteBonusTimer = null;
  }
  state.lastRoulette = {
    ...(state.lastRoulette || {}),
    choice: "БОНУС",
    won: true,
    bonusMultiplier: card.multiplier,
    payout: Number(bonus.payout || 0),
    net: Number((Number(bonus.payout || 0) - bonus.bet).toFixed(2)),
    pendingBonus: !allPicked
  };
  addLog(user.username || "player", `X50: карта BOR дала x${card.multiplier}, выплата ${payout.toFixed(2)} ${CRYPTOBOT_ASSET}`, "win");
  await persistState();
  await sendJson(res, 200, { ok: true, multiplier: card.multiplier, payout, data: bootstrapPayload(Boolean(res.adminAuthorized)) });
}

async function handleMinesStart(body, res) {
  await resetMinesIfNeeded();
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
    await sendJson(res, 400, { error: Number(state.minesSession.user_id) === Number(getUser().id) ? "Сначала заверши текущую игру" : "Сейчас поле занято другим игроком" });
    return;
  }
  if (state.minesSession?.reset_at && Date.now() < Number(state.minesSession.reset_at)) {
    await sendJson(res, 400, { error: "Дождись обновления поля после прошлого раунда" });
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
    user_id: user.id,
    username: user.username,
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
  await sendJson(res, 200, { ok: true, data: bootstrapPayload(Boolean(res.adminAuthorized)) });
}

async function handleMinesReveal(body, res) {
  const index = Number(body.index);
  const session = state.minesSession;
  const user = getUser();
  if (!session || !session.active) {
    await sendJson(res, 400, { error: "Сначала начни игру в мины" });
    return;
  }
  if (Number(session.user_id) !== Number(user.id)) {
    await sendJson(res, 403, { error: "Эта игра принадлежит другому игроку" });
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
  if (session.mines.includes(index)) {
    session.active = false;
    session.reset_at = Date.now() + minesResetDelayMs();
    session.lastOutcome = { type: "loss", mineIndex: index, mines: session.mines, amount: session.bet };
    user.games_played += 1;
    user.volume = Number((user.volume + session.bet).toFixed(2));
    applyWagerTurnover(user, session.bet);
    user.in_game = Number(Math.max(0, user.in_game - session.bet).toFixed(2));
    addLog(user.username || "player", `Мины: взрыв на клетке ${index + 1}`, "loss");
    await persistState();
    await sendJson(res, 200, { ok: true, data: bootstrapPayload(Boolean(res.adminAuthorized)) });
    return;
  }

  session.safePicks += 1;
  session.multiplier = minesMultiplier(session.mineCount, session.safePicks);
  session.lastOutcome = { type: "safe", index };
  addLog(user.username || "player", `Мины: открыл безопасную клетку ${index + 1}, множитель x${session.multiplier.toFixed(2)}`, "mines");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload(Boolean(res.adminAuthorized)) });
}

async function handleMinesCashout(res) {
  const session = state.minesSession;
  const user = getUser();
  if (!session || !session.active || session.safePicks < 1) {
    await sendJson(res, 400, { error: "В игре в мины пока нечего забирать" });
    return;
  }
  if (Number(session.user_id) !== Number(user.id)) {
    await sendJson(res, 403, { error: "Эта игра принадлежит другому игроку" });
    return;
  }

  const payout = Number((session.bet * session.multiplier).toFixed(2));
  awardBalanceForUser(user, payout);
  user.in_game = Number(Math.max(0, user.in_game - session.bet).toFixed(2));
  user.games_played += 1;
  user.wins += 1;
  user.volume = Number((user.volume + session.bet).toFixed(2));
  applyWagerTurnover(user, session.bet);
  state.minesSession = {
    ...session,
    active: false,
    reset_at: Date.now() + minesResetDelayMs(),
    lastOutcome: { type: "cashout", payout, multiplier: session.multiplier }
  };
  addLog(user.username || "player", `Мины: получен выигрыш ${payout.toFixed(2)} ${CRYPTOBOT_ASSET}`, "win");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload(Boolean(res.adminAuthorized)) });
}

function randomCrashMultiplier() {
  const roll = Math.random();
  if (roll < 0.68) return Number((1.1 + Math.random() * 0.2).toFixed(2));
  if (roll < 0.93) return Number((1.3 + Math.pow(Math.random(), 2.2) * 8.7).toFixed(2));
  if (roll < 0.998) return Number((10 + Math.pow(Math.random(), 2) * 40).toFixed(2));
  return 100;
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
    user_id: user.id,
    username: user.username,
    bet: Number(bet.toFixed(2)),
    started_at: Date.now(),
    crash_multiplier: randomCrashMultiplier(),
    multiplier: 1,
    lastOutcome: null
  };
  addLog(user.username || "player", `Ракета стартовала со ставкой ${bet.toFixed(2)} ${CRYPTOBOT_ASSET}`, "bet");
  await persistState();
  await sendJson(res, 200, { ok: true, data: bootstrapPayload(Boolean(res.adminAuthorized)) });
}

async function handleCrashCashout(res) {
  await settleCrashIfNeeded();
  const session = state.crashSession;
  if (!session?.active) {
    await sendJson(res, 400, { error: "Ракета уже остановилась" });
    return;
  }
  const user = getUser();
  if (Number(session.user_id) !== Number(user.id)) {
    await sendJson(res, 403, { error: "Эта ракета принадлежит другому игроку" });
    return;
  }
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
  applyWagerTurnover(user, Number(session.bet));
  awardBalanceForUser(user, payout);
  addLog(user.username || "player", `Ракета: забрано ${payout.toFixed(2)} ${CRYPTOBOT_ASSET} на x${session.multiplier.toFixed(2)}`, "win");
  await persistState();
  await sendJson(res, 200, { ok: true, payout, data: bootstrapPayload(Boolean(res.adminAuthorized)) });
}

async function routeRequest(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const telegramAuth = telegramRequestAuth(req);
  res.telegramAuth = telegramAuth;
  res.adminAuthorized = Boolean(telegramAuth.valid && telegramAuth.isAdmin);

  if (parsed.pathname.startsWith("/api/admin/") && !res.adminAuthorized) {
    await sendJson(res, 403, { error: "Доступ к админ-панели запрещён" });
    return;
  }

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
      await resetMinesIfNeeded();
      await sendJson(res, 200, bootstrapPayload(Boolean(res.adminAuthorized)));
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
    if (parsed.pathname === "/api/admin/users/reset-balances") {
      await handleAdminResetAllBalances(body, res);
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
    if (parsed.pathname.startsWith("/api/withdrawals/") && parsed.pathname.endsWith("/cancel")) {
      await handleCancelWithdrawal(parsed.pathname.split("/")[3], res);
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
    const telegramAuth = telegramRequestAuth(req);
    requestContext.run({ telegramAuth }, () => routeRequest(req, res)).catch(async (error) => {
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

