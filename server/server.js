import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import crypto, { randomUUID } from "crypto";
import { Pool } from "pg";

// Velora API: PostgreSQL + auth propia + OAuth Google/GitHub.
dotenv.config();

const app = express();

app.set("trust proxy", 1);

app.use(express.json());

const CLIENT_URL = (process.env.CLIENT_URL || "http://localhost:5173").replace(/\/$/, "");
const PORT = process.env.PORT || 3001;
const SESSION_COOKIE = "velora_session";

const isProd =
  process.env.NODE_ENV === "production" ||
  CLIENT_URL.includes("vercel.app");

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      const normalizedOrigin = origin.replace(/\/$/, "");
      const normalizedClientUrl = CLIENT_URL.replace(/\/$/, "");

      const isAllowed =
        normalizedOrigin === normalizedClientUrl ||
        normalizedOrigin.endsWith(".vercel.app");

      if (isAllowed) return callback(null, true);

      return callback(new Error("CORS bloqueado"));
    },
    credentials: true,
  })
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: false }
      : false,
});

const isSandbox = (process.env.TRUELAYER_ENV || "sandbox") === "sandbox";
const TL_AUTH_BASE = isSandbox ? "https://auth.truelayer-sandbox.com" : "https://auth.truelayer.com";
const TL_API_BASE = isSandbox ? "https://api.truelayer-sandbox.com" : "https://api.truelayer.com";

let trueLayerTokens = null;
let lastTrueLayerError = null;

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Falta ${name} en server/.env`);
  return process.env[name];
}

function cookieOptions(maxAgeDays = 30) {
  return {
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
    path: "/",
    maxAge: maxAgeDays * 24 * 60 * 60 * 1000,
  };
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(v => {
    const [k, ...rest] = v.trim().split("=");
    return [k, decodeURIComponent(rest.join("="))];
  }));
}

function cleanUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatar_url, provider: user.provider };
}

async function initDb() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT,
      provider TEXT NOT NULL DEFAULT 'email',
      provider_id TEXT,
      avatar_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '✨',
      color TEXT NOT NULL DEFAULT '#ec4899',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      description TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      category TEXT NOT NULL DEFAULT 'Otros',
      source TEXT NOT NULL DEFAULT 'Manual',
      type TEXT NOT NULL CHECK (type IN ('income','expense')),
      external_id TEXT,
      raw JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      category TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, month, category)
    );


    CREATE TABLE IF NOT EXISTS merchant_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      merchant_key TEXT NOT NULL,
      category TEXT NOT NULL,
      confidence NUMERIC(4,2) NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, merchant_key)
    );

    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS normalized_merchant TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_confidence NUMERIC(4,2) DEFAULT 0.5;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_reason TEXT DEFAULT 'legacy';
  `);
}

async function createSession(res, userId) {
  const sid = crypto.randomBytes(32).toString("hex");

  await pool.query(
    "INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '30 days')",
    [sid, userId]
  );

  res.cookie(SESSION_COOKIE, sid, cookieOptions());

  return sid;
}

async function getUserFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  const sid = bearerToken || parseCookies(req)[SESSION_COOKIE];

  if (!sid) return null;

  const { rows } = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now()`,
    [sid]
  );

  return rows[0] || null;
}

async function requireAuth(req, res, next) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: "Inicia sesión para usar Velora." });
    req.user = user;
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function seedUserDefaults(userId) {
  const defaults = [
    ["Salario", "💸", "#10b981"], ["Extra", "🌟", "#a78bfa"],
    ["Ahorro", "🐷", "#22c55e"], ["Impuestos", "🧾", "#64748b"],
    ["Gobierno", "🏛️", "#7c3aed"], ["Facturas", "🧾", "#0ea5e9"],
    ["Coche", "🚗", "#f59e0b"], ["Supermercado", "🛒", "#86efac"],
    ["Comida", "🥗", "#f97316"], ["Vivienda", "🏡", "#60a5fa"],
    ["Transporte", "🚕", "#facc15"], ["Viajes", "✈️", "#2dd4bf"],
    ["Shopping", "🛍️", "#fb7185"], ["Suscripciones", "📱", "#38bdf8"], ["Seguros", "🛡️", "#818cf8"],
    ["Ocio", "🎀", "#ec4899"], ["Salud", "🧘‍♀️", "#14b8a6"],
    ["Belleza", "💅", "#f472b6"], ["Inversión", "📈", "#8b5cf6"], ["Gobierno", "🏛️", "#6366f1"], ["Facturas", "⚡", "#0ea5e9"], ["Viajes", "✈️", "#06b6d4"], ["Transferencias", "🔁", "#94a3b8"], ["Otros", "✨", "#94a3b8"]
  ];
  for (const row of defaults) {
    await pool.query(
      "INSERT INTO categories (user_id, name, emoji, color) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, name) DO NOTHING",
      [userId, ...row]
    );
  }
}

const MERCHANT_ALIASES = new Map([
  ["amzn", "amazon"], ["amazon marketplace", "amazon"], ["amazon black friday", "amazon"],
  ["tfl", "transport for london"], ["transport for london", "transport for london"],
  ["edf", "edf energy"], ["edf energy", "edf energy"],
  ["dvla", "dvla"], ["dvla tax", "dvla"], ["dvla licence", "dvla"],
  ["hmrc", "hmrc"], ["working tax credit", "working tax credit"],
  ["save the change", "save the change"],
  ["butlins", "butlins holidays"], ["butlins holidays", "butlins holidays"],
  ["morrisons petrol", "morrisons petrol"], ["tesco extra", "tesco"], ["tesco", "tesco"],
  ["asda stoes", "asda"], ["asda stores", "asda"], ["asda", "asda"],
  ["aa insurance", "aa insurance"], ["axa wealth", "axa"], ["axa", "axa"],
  ["tailscom", "tailscom"], ["circle trading", "circle uk trading"], ["circle uk trading", "circle uk trading"],
  ["jane doe", "person transfer"], ["john smith", "person transfer"]
]);

const MERCHANT_DB = [
  { key: "working tax credit", category: "Gobierno", confidence: 0.99, words: ["working tax credit"] },
  { key: "hmrc", category: "Impuestos", confidence: 0.99, words: ["hmrc", "hacienda", "aeat"] },
  { key: "dvla", category: "Coche", confidence: 0.99, words: ["dvla", "vehicle licence", "road tax"] },
  { key: "save the change", category: "Ahorro", confidence: 0.99, words: ["save the change", "round up", "redondeo"] },
  { key: "edf energy", category: "Facturas", confidence: 0.98, words: ["edf energy", "edf"] },
  { key: "outgoing dd", category: "Facturas", confidence: 0.78, words: ["outgoing dd", "direct debit", "domiciliacion", "domiciliación"] },
  { key: "butlins holidays", category: "Viajes", confidence: 0.96, words: ["butlins", "holidays", "holiday", "hotel", "booking", "airbnb"] },
  { key: "morrisons petrol", category: "Transporte", confidence: 0.98, words: ["morrisons petrol", "petrol", "fuel", "gasolina", "shell", "bp", "cepsa", "repsol"] },
  { key: "tesco", category: "Supermercado", confidence: 0.98, words: ["tesco", "tesco extra", "asda", "asda stoes", "asda stores", "sainsbury", "waitrose", "lidl", "aldi", "mercadona", "carrefour", "morrisons"] },
  { key: "amazon", category: "Shopping", confidence: 0.96, words: ["amazon", "amzn", "black friday", "zara", "shein", "primark", "ikea", "decathlon"] },
  { key: "aa insurance", category: "Seguros", confidence: 0.97, words: ["insurance", "seguro", "aa insurance", "axa", "mapfre", "allianz", "zurich"] },
  { key: "tailscom", category: "Suscripciones", confidence: 0.92, words: ["tailscom", "vodafone", "movistar", "orange", "o2", "netflix", "spotify", "icloud", "disney"] },
  { key: "person transfer", category: "Transferencias", confidence: 0.62, words: ["jane doe", "john smith", "mr ", "ms ", "mrs "] },
  { key: "circle uk trading", category: "Extra", confidence: 0.70, words: ["circle uk trading", "circle trading"] }
];

const CATEGORY_RULES = [
  { category: "Salario", confidence: 0.9, rx: /\b(nomina|nómina|salary|payroll|wage|pension|employer salary)\b/i },
  { category: "Gobierno", confidence: 0.95, rx: /\b(benefit|tax credit|working tax credit|universal credit|sepe|seguridad social|government|gobierno)\b/i },
  { category: "Ahorro", confidence: 0.9, rx: /\b(save the change|savings?|ahorro|hucha|round.?up|redondeo)\b/i },
  { category: "Coche", confidence: 0.88, rx: /\b(dvla|licen[cs]e|vehicle|car tax|road tax|itv|dgt|trafico|tráfico|parking|aparcamiento)\b/i },
  { category: "Impuestos", confidence: 0.86, rx: /\b(tax|hmrc|impuesto|hacienda|aeat|council tax)\b/i },
  { category: "Facturas", confidence: 0.82, rx: /\b(energy|electric|electricity|gas|water|utility|utilities|edf|iberdrola|endesa|outgoing dd|direct debit|domiciliaci[oó]n)\b/i },
  { category: "Transporte", confidence: 0.82, rx: /\b(petrol|gasolina|fuel|uber|cabify|bolt|taxi|metro|renfe|bus|train|tfl)\b/i },
  { category: "Supermercado", confidence: 0.85, rx: /\b(mercadona|carrefour|lidl|aldi|tesco|asda|morrisons|sainsbury|waitrose|grocery|supermarket|supermercado)\b/i },
  { category: "Seguros", confidence: 0.85, rx: /\b(insurance|seguro|aseguradora|axa|mapfre|mutua|allianz|zurich)\b/i },
  { category: "Shopping", confidence: 0.78, rx: /\b(amazon|amzn|zara|hm|h&m|shein|primark|ikea|decathlon|shopping|shop|store|retail)\b/i },
  { category: "Suscripciones", confidence: 0.78, rx: /\b(netflix|spotify|hbo|max|disney|prime video|youtube|icloud|storage|phone|mobile|subscription|suscrip)\b/i },
  { category: "Comida", confidence: 0.74, rx: /\b(restaurant|restaurante|bar|cafe|coffee|starbucks|mcdonald|burger|kfc|glovo|deliveroo|just eat|uber eats|food)\b/i },
  { category: "Vivienda", confidence: 0.75, rx: /\b(alquiler|rent|hipoteca|mortgage|home|vivienda)\b/i },
  { category: "Salud", confidence: 0.72, rx: /\b(farmacia|pharmacy|doctor|clinic|hospital|dentist|dental|salud|health|therapy)\b/i },
  { category: "Belleza", confidence: 0.72, rx: /\b(sephora|primor|druni|perfume|maquillaje|peluquer|hair|beauty|cosmetic|nails|spa)\b/i },
  { category: "Viajes", confidence: 0.76, rx: /\b(holiday|holidays|travel|hotel|booking|airbnb|flight|ryanair|iberia|vueling|butlins)\b/i },
  { category: "Ocio", confidence: 0.65, rx: /\b(cine|cinema|movie|teatro|ticket|event|gaming|steam|playstation|xbox|book|libro)\b/i },
  { category: "Inversión", confidence: 0.75, rx: /\b(btc|eth|crypto|coinbase|wallet|binance|kraken|broker|invers|investment|etherscan)\b/i },
];

function normalizeMerchant(text = "") {
  const base = String(text)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/paypal \*/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(ltd|limited|sl|sa|plc|uk|es|card|payment|pos|online|the|mr|mrs|ms|co|company)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [alias, canonical] of MERCHANT_ALIASES.entries()) {
    if (base.includes(alias)) return canonical;
  }
  return base;
}

function similarity(a, b) {
  const aa = new Set(normalizeMerchant(a).split(" ").filter(Boolean));
  const bb = new Set(normalizeMerchant(b).split(" ").filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let inter = 0;
  for (const x of aa) if (bb.has(x)) inter++;
  return inter / Math.max(aa.size, bb.size);
}

function detectCategoryDetailed(text, amount) {
  const normalized = normalizeMerchant(text);
  const original = String(text || "").toLowerCase();

  for (const merchant of MERCHANT_DB) {
    if (merchant.words.some(w => normalized.includes(w) || original.includes(w))) {
      if (amount > 0 && ["Facturas", "Supermercado", "Shopping", "Transporte", "Coche", "Seguros", "Viajes"].includes(merchant.category)) continue;
      return { category: amount > 0 && merchant.category === "Transferencias" ? "Extra" : merchant.category, confidence: merchant.confidence, reason: `merchant:${merchant.key}`, normalized };
    }
  }

  if (amount > 0) {
    const incomeRule = CATEGORY_RULES.find(r => r.category === "Salario" && r.rx.test(normalized));
    if (incomeRule) return { category: "Salario", confidence: incomeRule.confidence, reason: "rule:salary", normalized };
    const govRule = CATEGORY_RULES.find(r => r.category === "Gobierno" && r.rx.test(normalized));
    if (govRule) return { category: "Gobierno", confidence: govRule.confidence, reason: "rule:government", normalized };
    return { category: "Extra", confidence: 0.55, reason: "income:fallback", normalized };
  }

  let winner = { category: "Otros", confidence: 0.25, reason: "fallback:otros", normalized };
  for (const rule of CATEGORY_RULES) {
    if (["Salario", "Gobierno"].includes(rule.category)) continue;
    if (rule.rx.test(normalized)) {
      if (rule.confidence > winner.confidence) winner = { category: rule.category, confidence: rule.confidence, reason: `rule:${rule.category}`, normalized };
    }
  }
  return winner;
}

function detectCategory(text, amount) {
  return detectCategoryDetailed(text, amount).category;
}

async function classifyTransactionDetailed(userId, text, amount, preferredCategory) {
  const normalized = normalizeMerchant(text);
  if (preferredCategory) return { category: preferredCategory, confidence: 1, reason: "user:selected", normalized };

  const learned = await pool.query("SELECT category, confidence FROM merchant_rules WHERE user_id=$1 AND merchant_key=$2", [userId, normalized]);
  if (learned.rows[0]) return { category: learned.rows[0].category, confidence: Number(learned.rows[0].confidence), reason: "learned:merchant", normalized };

  const rule = detectCategoryDetailed(text, amount);
  if (rule.category !== "Otros" && rule.confidence >= 0.7) return rule;

  const { rows } = await pool.query(
    `SELECT normalized_merchant, description, category FROM transactions
     WHERE user_id=$1 AND category <> 'Otros'
     ORDER BY created_at DESC LIMIT 500`,
    [userId]
  );
  let best = { category: rule.category, score: rule.confidence, merchant: null };
  for (const row of rows) {
    const score = similarity(normalized, row.normalized_merchant || row.description);
    if (score > best.score) best = { category: row.category, score, merchant: row.normalized_merchant || row.description };
  }
  if (best.score >= 0.58) return { category: best.category, confidence: Math.min(0.92, best.score), reason: "similarity:user_history", normalized };
  return rule;
}

async function classifyTransaction(userId, text, amount, preferredCategory) {
  return (await classifyTransactionDetailed(userId, text, amount, preferredCategory)).category;
}

function normaliseBankTransaction(tx, accountId) {
  const amount = Number(tx.amount || 0);
  const stablePayload = [accountId, tx.transaction_id || "", tx.timestamp || tx.transaction_time || tx.value_timestamp || "", tx.description || tx.merchant_name || "", amount, tx.currency || "EUR"].join("|");
  const externalId = tx.transaction_id || crypto.createHash("sha256").update(stablePayload).digest("hex").slice(0, 32);
  return {
    externalId: `truelayer:${accountId}:${externalId}`,
    accountId,
    date: (tx.timestamp || tx.transaction_time || tx.value_timestamp || new Date().toISOString()).slice(0, 10),
    description: tx.description || tx.merchant_name || "Movimiento bancario",
    amount,
    currency: tx.currency || "EUR",
    category: detectCategory(tx.description || tx.merchant_name || "", amount),
    source: "TrueLayer",
    type: amount >= 0 ? "income" : "expense",
    raw: tx
  };
}

function normaliseEthTransaction(tx, chainId) {
  const ethValue = Number(tx.value || 0) / 1e18;
  const feeEth = Number(tx.gasUsed || 0) * Number(tx.gasPrice || 0) / 1e18;
  const timestamp = Number(tx.timeStamp || 0) * 1000;
  const amount = -Math.abs(Number((ethValue + feeEth).toFixed(2)));
  return {
    externalId: `etherscan:${chainId}:${tx.hash}`,
    date: new Date(timestamp || Date.now()).toISOString().slice(0, 10),
    description: `Wallet tx ${tx.hash?.slice(0, 10)}...`,
    amount,
    currency: "EUR",
    category: "Inversión",
    source: `Etherscan chain ${chainId}`,
    type: "expense",
    raw: tx
  };
}

function txDuplicateKey(tx) {
  return [String(tx.date).slice(0,10), normalizeMerchant(tx.description), Number(tx.amount).toFixed(2), tx.source || "Manual"].join("|");
}

async function cleanupDuplicates(userId) {
  // Conserva una sola fila por día + descripción normalizada + importe + origen.
  // Evita que el sandbox de TrueLayer acumule las mismas transacciones al importar varias veces.
  await pool.query(`
    DELETE FROM transactions t
    USING transactions d
    WHERE t.user_id=$1 AND d.user_id=$1
      AND t.id <> d.id
      AND t.created_at < d.created_at
      AND t.date = d.date
      AND round(t.amount::numeric, 2) = round(d.amount::numeric, 2)
      AND lower(regexp_replace(t.description, '[^a-zA-Z0-9]+', ' ', 'g')) = lower(regexp_replace(d.description, '[^a-zA-Z0-9]+', ' ', 'g'))
      AND t.source = d.source
  `, [userId]);
}

async function upsertTransaction(userId, tx) {
  const learnedCategory = await classifyTransaction(userId, tx.description, Number(tx.amount), tx.category === "Otros" ? undefined : tx.category);
  tx.category = learnedCategory;

  // Deduplicación defensiva también cuando TrueLayer no devuelve un id estable.
  const dup = await pool.query(
    `SELECT * FROM transactions
     WHERE user_id=$1 AND date=$2 AND round(amount::numeric,2)=round($3::numeric,2)
       AND lower(regexp_replace(description, '[^a-zA-Z0-9]+', ' ', 'g')) = lower(regexp_replace($4, '[^a-zA-Z0-9]+', ' ', 'g'))
       AND source=$5
     ORDER BY created_at DESC LIMIT 1`,
    [userId, tx.date, tx.amount, tx.description, tx.source]
  );
  if (dup.rows[0]) {
    const { rows } = await pool.query(
      `UPDATE transactions SET
        external_id = COALESCE(transactions.external_id, $2),
        raw = COALESCE($3, transactions.raw),
        category = CASE WHEN transactions.category = 'Otros' THEN $4 ELSE transactions.category END
       WHERE id=$1 RETURNING *`,
      [dup.rows[0].id, tx.externalId || null, tx.raw || null, tx.category]
    );
    return { ...rows[0], amount: Number(rows[0].amount) };
  }

  const { rows } = await pool.query(
    `INSERT INTO transactions (user_id, date, description, amount, currency, category, source, type, external_id, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (user_id, external_id) DO UPDATE SET
       date = EXCLUDED.date, description = EXCLUDED.description, amount = EXCLUDED.amount,
       category = CASE WHEN transactions.category = 'Otros' THEN EXCLUDED.category ELSE transactions.category END,
       raw = EXCLUDED.raw
     RETURNING *`,
    [userId, tx.date, tx.description, tx.amount, tx.currency || "EUR", tx.category, tx.source, tx.type, tx.externalId || null, tx.raw || null]
  );
  return { ...rows[0], amount: Number(rows[0].amount) };
}

async function oauthUpsert(provider, profile) {
  const { email, name, avatarUrl, providerId } = profile;
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, provider, provider_id, avatar_url)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, provider = EXCLUDED.provider, provider_id = EXCLUDED.provider_id, avatar_url = EXCLUDED.avatar_url
     RETURNING *`,
    [email, name || email.split("@")[0], provider, providerId, avatarUrl]
  );
  await seedUserDefaults(rows[0].id);
  return rows[0];
}

app.get("/api/health", async (_req, res) => res.json({ ok: true, postgres: true, trueLayerConnected: Boolean(trueLayerTokens?.access_token) }));

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email y contraseña son obligatorios." });
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      "INSERT INTO users (email, name, password_hash, provider) VALUES ($1,$2,$3,'email') RETURNING *",
      [email.toLowerCase(), name || email.split("@")[0], hash]
    );
    await seedUserDefaults(rows[0].id);
    const token = await createSession(res, rows[0].id);
    res.json({ user: cleanUser(rows[0]), token });
  } catch (error) {
    res.status(400).json({ error: error.code === "23505" ? "Ese email ya existe." : error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [String(email || "").toLowerCase()]);
    const user = rows[0];
    if (!user?.password_hash || !(await bcrypt.compare(password || "", user.password_hash))) {
      return res.status(401).json({ error: "Email o contraseña incorrectos." });
    }
    const token = await createSession(res, user.id);
    res.json({ user: cleanUser(user), token });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  const sid = bearerToken || parseCookies(req)[SESSION_COOKIE];
  if (sid) await pool.query("DELETE FROM sessions WHERE id = $1", [sid]);
  res.clearCookie(SESSION_COOKIE, cookieOptions(0));
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => res.json({ user: cleanUser(await getUserFromRequest(req)) }));

app.get("/auth/google", (_req, res) => res.redirect("/api/auth/google"));
app.get("/auth/github", (_req, res) => res.redirect("/api/auth/github"));

app.get("/api/auth/google", (_req, res) => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", requireEnv("GOOGLE_CLIENT_ID"));
  url.searchParams.set("redirect_uri", requireEnv("GOOGLE_REDIRECT_URI"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  res.redirect(url.toString());
});

app.get("/auth/google/callback", (req, res) => res.redirect(`/api/auth/google/callback?${new URLSearchParams(req.query).toString()}`));
app.get("/api/auth/google/callback", async (req, res) => {
  try {
    const body = new URLSearchParams({ code: req.query.code, client_id: requireEnv("GOOGLE_CLIENT_ID"), client_secret: requireEnv("GOOGLE_CLIENT_SECRET"), redirect_uri: requireEnv("GOOGLE_REDIRECT_URI"), grant_type: "authorization_code" });
    const token = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }).then(r => r.json());
    const profile = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${token.access_token}` } }).then(r => r.json());
    const user = await oauthUpsert("google", { email: profile.email, name: profile.name, avatarUrl: profile.picture, providerId: profile.sub });
    await createSession(res, user.id);
    res.redirect(CLIENT_URL);
  } catch (error) { res.redirect(`${CLIENT_URL}?auth=google_error`); }
});

app.get("/api/auth/github", (_req, res) => {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", requireEnv("GITHUB_CLIENT_ID"));
  url.searchParams.set("redirect_uri", requireEnv("GITHUB_REDIRECT_URI"));
  url.searchParams.set("scope", "read:user user:email");
  res.redirect(url.toString());
});

app.get("/auth/github/callback", (req, res) => res.redirect(`/api/auth/github/callback?${new URLSearchParams(req.query).toString()}`));
app.get("/api/auth/github/callback", async (req, res) => {
  try {
    const body = new URLSearchParams({ code: req.query.code, client_id: requireEnv("GITHUB_CLIENT_ID"), client_secret: requireEnv("GITHUB_CLIENT_SECRET"), redirect_uri: requireEnv("GITHUB_REDIRECT_URI") });
    const token = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body }).then(r => r.json());
    const headers = { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json" };
    const gh = await fetch("https://api.github.com/user", { headers }).then(r => r.json());
    const emails = await fetch("https://api.github.com/user/emails", { headers }).then(r => r.json());
    const primary = Array.isArray(emails) ? emails.find(e => e.primary)?.email : null;
    const user = await oauthUpsert("github", { email: primary || gh.email, name: gh.name || gh.login, avatarUrl: gh.avatar_url, providerId: String(gh.id) });
    await createSession(res, user.id);
    res.redirect(CLIENT_URL);
  } catch (error) { res.redirect(`${CLIENT_URL}?auth=github_error`); }
});

app.get("/api/categories", requireAuth, async (req, res) => {
  await seedUserDefaults(req.user.id);
  const { rows } = await pool.query("SELECT * FROM categories WHERE user_id=$1 ORDER BY created_at", [req.user.id]);
  res.json({ results: rows });
});

app.post("/api/categories", requireAuth, async (req, res) => {
  const { name, emoji = "✨", color = "#ec4899" } = req.body;
  const { rows } = await pool.query("INSERT INTO categories (user_id, name, emoji, color) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, name) DO UPDATE SET emoji=$3,color=$4 RETURNING *", [req.user.id, name, emoji, color]);
  res.json(rows[0]);
});

app.get("/api/transactions", requireAuth, async (req, res) => {
  const { month, year } = req.query;
  const params = [req.user.id];
  let where = "user_id=$1";
  if (month) { params.push(`${month}%`); where += ` AND date::text LIKE $${params.length}`; }
  if (year) { params.push(`${year}%`); where += ` AND date::text LIKE $${params.length}`; }
  const { rows } = await pool.query(`SELECT * FROM transactions WHERE ${where} ORDER BY date DESC, created_at DESC`, params);
  res.json({ results: rows.map(r => ({ ...r, amount: Number(r.amount) })) });
});

app.post("/api/transactions", requireAuth, async (req, res) => {
  const amount = Number(req.body.amount);
  const classification = await classifyTransactionDetailed(req.user.id, req.body.description, amount, req.body.category);
  const tx = { date: req.body.date, description: req.body.description, amount, currency: req.body.currency || "EUR", category: classification.category, source: req.body.source || "Manual", type: amount >= 0 ? "income" : "expense", normalizedMerchant: classification.normalized, categoryConfidence: classification.confidence, categoryReason: classification.reason };
  res.json(await upsertTransaction(req.user.id, tx));
});

app.post("/api/transactions/reclassify", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at", [req.user.id]);
  const updated = [];
  for (const row of rows) {
    const classification = await classifyTransactionDetailed(req.user.id, row.description, Number(row.amount));
    const category = classification.category;
    if (category !== row.category || classification.confidence != Number(row.category_confidence || 0)) {
      const result = await pool.query("UPDATE transactions SET category=$1, normalized_merchant=$2, category_confidence=$3, category_reason=$4 WHERE id=$5 AND user_id=$6 RETURNING *", [category, classification.normalized, classification.confidence, classification.reason, row.id, req.user.id]);
      updated.push({ ...result.rows[0], amount: Number(result.rows[0].amount) });
    }
  }
  await seedUserDefaults(req.user.id);
  res.json({ updated: updated.length, results: updated });
});

app.post("/api/transactions/dedupe", requireAuth, async (req, res) => {
  await cleanupDuplicates(req.user.id);
  const { rows } = await pool.query("SELECT * FROM transactions WHERE user_id=$1 ORDER BY date DESC, created_at DESC", [req.user.id]);
  res.json({ ok: true, results: rows.map(r => ({ ...r, amount: Number(r.amount) })) });
});


app.put("/api/transactions/:id/category", requireAuth, async (req, res) => {
  const { category } = req.body;
  if (!category) return res.status(400).json({ error: "Categoría obligatoria." });
  const found = await pool.query("SELECT * FROM transactions WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!found.rows[0]) return res.status(404).json({ error: "Movimiento no encontrado." });
  const merchantKey = normalizeMerchant(found.rows[0].description);
  await pool.query(
    `INSERT INTO merchant_rules (user_id, merchant_key, category, confidence) VALUES ($1,$2,$3,1)
     ON CONFLICT (user_id, merchant_key) DO UPDATE SET category=EXCLUDED.category, confidence=1, updated_at=now()`,
    [req.user.id, merchantKey, category]
  );
  const { rows } = await pool.query(
    "UPDATE transactions SET category=$1, normalized_merchant=$2, category_confidence=1, category_reason='user:corrected' WHERE id=$3 AND user_id=$4 RETURNING *",
    [category, merchantKey, req.params.id, req.user.id]
  );
  res.json({ ...rows[0], amount: Number(rows[0].amount) });
});

app.post("/api/transactions/dedupe", requireAuth, async (req, res) => {
  const result = await pool.query(
    `WITH ranked AS (
      SELECT id, row_number() OVER (
        PARTITION BY user_id, date, description, amount, source
        ORDER BY created_at ASC
      ) AS rn
      FROM transactions WHERE user_id=$1
    ), deleted AS (
      DELETE FROM transactions t USING ranked r
      WHERE t.id=r.id AND r.rn > 1
      RETURNING t.id
    ) SELECT count(*)::int AS deleted FROM deleted`,
    [req.user.id]
  );
  res.json({ deleted: result.rows[0]?.deleted || 0 });
});

app.delete("/api/transactions/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM transactions WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  res.json({ ok: true });
});

app.get("/api/budgets", requireAuth, async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const { rows } = await pool.query("SELECT * FROM budgets WHERE user_id=$1 AND month=$2 ORDER BY category", [req.user.id, month]);
  res.json({ results: rows.map(r => ({ ...r, amount: Number(r.amount) })) });
});

app.put("/api/budgets", requireAuth, async (req, res) => {
  const { month, category, amount } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO budgets (user_id, month, category, amount) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, month, category) DO UPDATE SET amount=EXCLUDED.amount, updated_at=now() RETURNING *`,
    [req.user.id, month, category, Number(amount)]
  );
  res.json(rows[0]);
});

app.get("/api/truelayer/auth-url", requireAuth, (req, res) => {
  try {
    if ((process.env.TRUELAYER_ENV || "sandbox") === "production" && process.env.PRODUCTION_BANKING_CONFIRMED !== "true") {
      return res.status(400).json({ error: "Para conectar bancos reales, pon PRODUCTION_BANKING_CONFIRMED=true y verifica TrueLayer en producción." });
    }
    const clientId = requireEnv("TRUELAYER_CLIENT_ID");
    const redirectUri = requireEnv("TRUELAYER_REDIRECT_URI");
    const scopes = process.env.TRUELAYER_SCOPES || "info accounts balance transactions offline_access";
    const url = new URL(`${TL_AUTH_BASE}/`);
    url.searchParams.set("response_type", "code"); url.searchParams.set("client_id", clientId); url.searchParams.set("scope", scopes); url.searchParams.set("redirect_uri", redirectUri); url.searchParams.set("providers", "uk-cs-mock uk-ob-all es-ob-all"); url.searchParams.set("state", req.user.id);
    res.json({ url: url.toString(), environment: process.env.TRUELAYER_ENV || "sandbox" });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get("/truelayer/callback", (req, res) => res.redirect(`/api/truelayer/callback?${new URLSearchParams(req.query).toString()}`));
app.get("/api/truelayer/callback", async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error || !code) { lastTrueLayerError = `${error || "missing_code"}: ${error_description || ""}`; return res.redirect(`${CLIENT_URL}?bank=error`); }
  try {
    const body = new URLSearchParams({ grant_type: "authorization_code", client_id: requireEnv("TRUELAYER_CLIENT_ID"), client_secret: requireEnv("TRUELAYER_CLIENT_SECRET"), redirect_uri: requireEnv("TRUELAYER_REDIRECT_URI"), code });
    const data = await fetch(`${TL_AUTH_BASE}/connect/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }).then(r => r.json());
    if (!data.access_token) throw new Error(data.error_description || data.error || "No se pudo obtener token de TrueLayer");
    trueLayerTokens = data; lastTrueLayerError = null; res.redirect(`${CLIENT_URL}?bank=connected`);
  } catch (err) { lastTrueLayerError = err.message; res.redirect(`${CLIENT_URL}?bank=error`); }
});

async function trueLayerGet(path) {
  if (!trueLayerTokens?.access_token) throw new Error("TrueLayer no está conectado todavía.");
  const response = await fetch(`${TL_API_BASE}${path}`, { headers: { Authorization: `Bearer ${trueLayerTokens.access_token}` } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || `Error TrueLayer ${response.status}`);
  return data;
}

app.get("/api/truelayer/status", requireAuth, (_req, res) => res.json({ connected: Boolean(trueLayerTokens?.access_token), error: lastTrueLayerError, environment: process.env.TRUELAYER_ENV || "sandbox" }));


app.post("/api/demo/seed", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const year = String(new Date().getFullYear());
  const demoCategories = [
    ["Ingresos", "💸", "#34c759"], ["Vivienda", "🏠", "#8b5cf6"], ["Supermercado", "🛒", "#10b981"],
    ["Comida", "🥐", "#f97316"], ["Transporte", "🚇", "#3b82f6"], ["Shopping", "🛍️", "#ec4899"],
    ["Belleza", "🫧", "#f472b6"], ["Suscripciones", "🎧", "#6366f1"], ["Ocio", "🎟️", "#f59e0b"],
    ["Salud", "🩺", "#14b8a6"], ["Ahorro", "🌱", "#22c55e"], ["Viajes", "✈️", "#0ea5e9"], ["Otros", "✨", "#94a3b8"]
  ];
  for (const [name, emoji, color] of demoCategories) {
    await pool.query(
      "INSERT INTO categories (user_id, name, emoji, color) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, name) DO UPDATE SET emoji=$3, color=$4",
      [userId, name, emoji, color]
    );
  }

  await pool.query("DELETE FROM transactions WHERE user_id=$1 AND source='Demo'", [userId]);
  const recurring = [
    ["Nómina", 1850, "Ingresos", 1], ["Alquiler", -650, "Vivienda", 2], ["Spotify", -10.99, "Suscripciones", 4],
    ["Netflix", -12.99, "Suscripciones", 7], ["Gimnasio", -29.99, "Salud", 8], ["Ahorro mensual", -200, "Ahorro", 5]
  ];
  const variable = [
    ["Mercadona", -42.30, "Supermercado"], ["Lidl", -31.10, "Supermercado"], ["Starbucks", -5.60, "Comida"],
    ["Brunch con amigas", -22.50, "Comida"], ["Zara", -39.95, "Shopping"], ["Sephora", -27.90, "Belleza"],
    ["Renfe", -18.40, "Transporte"], ["Uber", -12.80, "Transporte"], ["Cine", -9.50, "Ocio"],
    ["Farmacia", -13.25, "Salud"], ["Hotel escapada", -88.00, "Viajes"], ["Café", -3.20, "Comida"]
  ];
  let inserted = 0;
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, "0");
    for (const [description, amount, category, day] of recurring) {
      await pool.query(
        `INSERT INTO transactions (user_id, date, description, amount, currency, category, source, type, external_id, raw, normalized_merchant, category_confidence, category_reason)
         VALUES ($1,$2,$3,$4,'EUR',$5,'Demo',$6,$7,$8,$9,1,'demo')
         ON CONFLICT (user_id, external_id) DO NOTHING`,
        [userId, `${year}-${mm}-${String(day).padStart(2,"0")}`, description, amount, category, amount > 0 ? "income" : "expense", `demo-${year}-${mm}-${description}`, { demo: true }, description.toLowerCase()]
      );
      inserted++;
    }
    for (let i = 0; i < 8; i++) {
      const item = variable[(m * 3 + i) % variable.length];
      const day = String(10 + ((i * 2 + m) % 17)).padStart(2, "0");
      const amount = Number((item[1] * (0.85 + ((i + m) % 5) * 0.08)).toFixed(2));
      await pool.query(
        `INSERT INTO transactions (user_id, date, description, amount, currency, category, source, type, external_id, raw, normalized_merchant, category_confidence, category_reason)
         VALUES ($1,$2,$3,$4,'EUR',$5,'Demo','expense',$6,$7,$8,1,'demo')
         ON CONFLICT (user_id, external_id) DO NOTHING`,
        [userId, `${year}-${mm}-${day}`, item[0], amount, item[2], `demo-${year}-${mm}-${i}-${item[0]}`, { demo: true }, item[0].toLowerCase()]
      );
      inserted++;
    }
  }

  const demoBudgets = { Vivienda: 700, Supermercado: 320, Comida: 180, Transporte: 120, Shopping: 160, Belleza: 120, Suscripciones: 60, Ocio: 160, Salud: 100, Ahorro: 250, Viajes: 140, Otros: 80 };
  for (let m = 1; m <= 12; m++) {
    const month = `${year}-${String(m).padStart(2, "0")}`;
    for (const [category, amount] of Object.entries(demoBudgets)) {
      await pool.query(
        `INSERT INTO budgets (user_id, month, category, amount) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, month, category) DO UPDATE SET amount=EXCLUDED.amount, updated_at=now()`,
        [userId, month, category, amount]
      );
    }
  }
  res.json({ ok: true, transactions: inserted, budgets: Object.keys(demoBudgets).length * 12 });
});

app.post("/api/truelayer/import", requireAuth, async (req, res) => {
  try {
    const from = req.body.from || "2026-01-01";
    const to = req.body.to || new Date().toISOString().slice(0, 10);
    const accounts = (await trueLayerGet("/data/v1/accounts")).results || [];
    const imported = [];
    for (const account of accounts) {
      const txData = await trueLayerGet(`/data/v1/accounts/${account.account_id}/transactions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      for (const tx of (txData.results || []).map(t => normaliseBankTransaction(t, account.account_id))) {
        const classification = await classifyTransactionDetailed(req.user.id, tx.description, Number(tx.amount), tx.category === "Otros" ? undefined : tx.category);
        tx.category = classification.category;
        tx.normalizedMerchant = classification.normalized;
        tx.categoryConfidence = classification.confidence;
        tx.categoryReason = classification.reason;
        imported.push(await upsertTransaction(req.user.id, tx));
      }
    }
    await cleanupDuplicates(req.user.id);
    const { rows } = await pool.query("SELECT * FROM transactions WHERE user_id=$1 ORDER BY date DESC, created_at DESC", [req.user.id]);
    res.json({ results: rows.map(r => ({ ...r, amount: Number(r.amount) })), imported: imported.length, accounts });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post("/api/etherscan/import", requireAuth, async (req, res) => {
  try {
    const apiKey = requireEnv("ETHERSCAN_API_KEY");
    const { chainId = "1", address } = req.body;
    const url = new URL("https://api.etherscan.io/v2/api");
    url.searchParams.set("chainid", chainId); url.searchParams.set("module", "account"); url.searchParams.set("action", "txlist"); url.searchParams.set("address", address); url.searchParams.set("startblock", "0"); url.searchParams.set("endblock", "99999999"); url.searchParams.set("page", "1"); url.searchParams.set("offset", "100"); url.searchParams.set("sort", "desc"); url.searchParams.set("apikey", apiKey);
    const data = await fetch(url).then(r => r.json());
    if (data.status === "0" && !String(data.message || "").toLowerCase().includes("no transactions")) throw new Error(data.result || data.message || "Error de Etherscan");
    const imported = [];
    for (const tx of (Array.isArray(data.result) ? data.result : []).map(t => normaliseEthTransaction(t, chainId))) imported.push(await upsertTransaction(req.user.id, tx));
    res.json({ results: imported });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

initDb().then(() => app.listen(PORT, () => console.log(`Velora API en http://localhost:${PORT}`))).catch((error) => {
  console.error("No se pudo iniciar PostgreSQL:", error.message);
  process.exit(1);
});
