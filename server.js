// ===== HERZFUNKE BACKEND – MIT BOT INTEGRATION =====
// npm install express cors bcryptjs jsonwebtoken multer sqlite3 socket.io node-fetch

try {
  // override: false — Shell/Hosting-ENV hat Vorrang vor .env (PORT z. B. für freien Port)
  require('dotenv').config({
    path: require('path').join(__dirname, '.env'),
    override: false,
  });
} catch {}

if (process.env.STRIPE_SECRET_KEY) {
  const k = String(process.env.STRIPE_SECRET_KEY);
  console.log(`🔑 Stripe-Key geladen (${k.startsWith('sk_test') ? 'Testmodus' : 'Live'}): ${k.slice(0, 10)}…`);
} else {
  console.log('⚠️  Kein STRIPE_SECRET_KEY – lege eine .env im Projektordner an oder setze die Variable.');
}

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

/** Persistenter Ordner (z. B. Render Disk /data, Docker-Volume). Standard: Projektordner. */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : __dirname;
const DB_PATH = path.join(DATA_DIR, process.env.SQLITE_FILE || 'herzfunke.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch (e) {
  console.error('DATA_DIR / uploads anlegen fehlgeschlagen:', e?.message || e);
}

const app = express();
if (String(process.env.TRUST_PROXY || '').trim() === '1' ||
    String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
  app.set('trust proxy', 1);
}
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'herzfunke-secret-aendern-in-produktion';
if (String(process.env.NODE_ENV || '').toLowerCase() === 'production' &&
    JWT_SECRET === 'herzfunke-secret-aendern-in-produktion') {
  console.error('⚠️  Production: setze JWT_SECRET in den Hosting-Umgebungsvariablen (min. 32 Zeichen).');
}
const PORT = process.env.PORT || 3000;
const MESSAGE_COST_COINS = Number(process.env.MESSAGE_COST_COINS || 10); // 10 Herzfunken = 1 Nachricht
/** Startguthaben für neue normale Nutzer (Herzfunken) */
const NEW_USER_SIGNUP_COINS = Math.min(1000000, Math.max(0, Number(process.env.NEW_USER_SIGNUP_COINS || 50) || 50));
const FREE_DAILY_SWIPES = Number(process.env.FREE_DAILY_SWIPES || 40); // Free-User Limit (Premium = unbegrenzt)
const ADMIN_USER_ID = Number(process.env.ADMIN_USER_ID || 0) || null;
// Ohne ENV: lokal automatisch Admin-Mail (Production: immer ADMIN_EMAIL in Render setzen!)
const _envAdmin = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_EMAIL =
  _envAdmin ||
  (String(process.env.NODE_ENV || '').toLowerCase() === 'production'
    ? null
    : 'dario.poprzen@gmail.com');
const BOT_AUTOREPLY = String(process.env.BOT_AUTOREPLY || '').trim() === '1'; // default: AUS
const MAIL_ENABLED = String(process.env.MAIL_ENABLED || '').trim() === '1';
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '').trim();
const SMTP_FROM = String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();

let BOT_USER_ID = null;
const onlineUsers = new Set();

function getMailer() {
  if (!MAIL_ENABLED) return null;
  if (!SMTP_HOST || !SMTP_FROM) return null;
  const auth = SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number.isFinite(SMTP_PORT) ? SMTP_PORT : 587,
    secure: Number(SMTP_PORT) === 465,
    auth,
  });
}

async function sendRegistrationEmail(toEmail, name) {
  const mailer = getMailer();
  if (!mailer) return { ok: false, skipped: true };
  const to = String(toEmail || '').trim();
  if (!to) return { ok: false, skipped: true };
  const safeName = String(name || '').trim() || 'dort';
  const subject = 'Registrierung erfolgreich – Herzfunke';
  const text = `Hallo ${safeName},\n\ndu hast dich erfolgreich bei Herzfunke registriert.\n\nLiebe Grüße\nHerzfunke`;
  try {
    await mailer.sendMail({
      from: SMTP_FROM,
      to,
      subject,
      text,
    });
    return { ok: true };
  } catch (e) {
    console.warn('MAIL sendRegistrationEmail failed:', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

app.use(cors());
// Stripe Webhook braucht RAW Body (vor JSON Parser!)
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

// API Root/Health (Debug-Hilfe, damit /api nicht "Cannot GET" zeigt)
app.get(['/api', '/api/health'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    port: PORT,
    time: new Date().toISOString(),
    messageCostCoins: MESSAGE_COST_COINS,
    newUserSignupCoins: NEW_USER_SIGNUP_COINS,
    newUserApproxFreeMessages: MESSAGE_COST_COINS > 0 ? Math.floor(NEW_USER_SIGNUP_COINS / MESSAGE_COST_COINS) : 0,
    hint: 'API läuft. Admin unter /admin öffnen.',
  });
});

// Startseite (robust)
app.get(['/', '/index.html'], (req, res) => {
  // Wichtig: Frontend nicht aggressiv cachen, sonst sieht man alte Logik (z. B. Wallet/Coins)
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'herzfunke_v6.html'));
});

// Payment-Return Pages (robust, unabhängig von express.static)
app.get(['/payment-success.html', '/payment-success.htm'], (req, res) => {
  res.sendFile(path.join(__dirname, 'payment-success.html'));
});
app.get(['/payment-cancel.html', '/payment-cancel.htm'], (req, res) => {
  res.sendFile(path.join(__dirname, 'payment-cancel.html'));
});

// Admin: VOR express.static — sonst liefert static admin.html ohne Injection (404 bei API).
function sendAdminHtml(req, res) {
  try {
    const htmlPath = path.join(__dirname, 'admin.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
      .split(',')[0]
      .trim();
    const host = req.get('host') || `localhost:${PORT}`;
    const apiBase = `${proto}://${host}/api`;
    const inject = `<script>window.__HF_API_BASE__=${JSON.stringify(apiBase)};</script>`;
    html = html.includes('</head>') ? html.replace('</head>', `${inject}</head>`) : `${inject}${html}`;
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.type('html').send(html);
  } catch (e) {
    console.error('admin.html:', e);
    res.status(500).send('Admin-Seite konnte nicht geladen werden.');
  }
}
app.get(['/admin', '/admin.html'], sendAdminHtml);

app.use(express.static('.'));

// ===== DATENBANK =====
const db = new sqlite3.Database(DB_PATH, err => {
  if (err) { console.error('DB Error:', err); process.exit(1); }
  console.log('✅ Datenbank verbunden');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    age INTEGER DEFAULT 25,
    city TEXT DEFAULT '',
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    bio TEXT DEFAULT '',
    photo TEXT DEFAULT '',
    interests TEXT DEFAULT '[]',
    is_bot INTEGER DEFAULT 0,
    is_online INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Migrations (idempotent): für Wallet/Payments & Pay-per-Message
  db.run(`ALTER TABLE users ADD COLUMN is_premium INTEGER DEFAULT 0`, [], () => {});
  db.run(`ALTER TABLE users ADD COLUMN premium_tier TEXT`, [], () => {});
  db.run(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`, [], () => {});
  db.run(`ALTER TABLE users ADD COLUMN is_managed INTEGER DEFAULT 0`, [], () => {});
  db.run(`ALTER TABLE users ADD COLUMN account_type TEXT DEFAULT 'user'`, [], () => {});
  db.run(`ALTER TABLE users ADD COLUMN coins INTEGER DEFAULT 0`, [], () => {});
  db.run(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`, [], () => {});
  db.run(`ALTER TABLE users ADD COLUMN free_msgs_used_today INTEGER DEFAULT 0`, [], () => {});
  db.run(`ALTER TABLE users ADD COLUMN free_msgs_date TEXT`, [], () => {});
  db.run(`ALTER TABLE users ADD COLUMN swipes_used_today INTEGER DEFAULT 0`, [], () => {});
  db.run(`ALTER TABLE users ADD COLUMN swipes_date TEXT`, [], () => {});
  db.run(`CREATE TABLE IF NOT EXISTS swipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    swiper_id INTEGER, target_id INTEGER, action TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(swiper_id, target_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user1_id INTEGER, user2_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user1_id, user2_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER, sender_id INTEGER,
    text TEXT NOT NULL, is_bot INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Migrations: Bildnachrichten + mehrere Profilbilder
  db.run(`ALTER TABLE messages ADD COLUMN image_url TEXT`, [], () => {});
  db.run(`CREATE TABLE IF NOT EXISTS user_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_primary INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, url)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS chat_read (
    user_id INTEGER NOT NULL,
    match_id INTEGER NOT NULL,
    last_read_message_id INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, match_id)
  )`);

  // Bot-User anlegen falls nicht vorhanden
  db.get("SELECT id FROM users WHERE is_bot = 1 LIMIT 1", [], async (err, row) => {
    if (row) {
      BOT_USER_ID = row.id;
      console.log(`🤖 Bot-User ID: ${BOT_USER_ID}`);
    } else {
      const hash = await bcrypt.hash('bot-internal-' + Date.now(), 10);
      db.run(
        `INSERT INTO users (name, age, city, email, password, bio, is_bot) VALUES (?,?,?,?,?,?,1)`,
        ['Seite Geld', 26, 'Berlin', 'bot@herzfunke.internal', hash, 'Ich freue mich, dich kennenzulernen 😊'],
        function(err) {
          if (!err) { BOT_USER_ID = this.lastID; console.log(`🤖 Bot erstellt: ID ${BOT_USER_ID}`); }
        }
      );
    }
  });
});

// ===== HELPERS =====
const dbGet = (sql, p=[]) => new Promise((res,rej) => db.get(sql, p, (e,r) => e ? rej(e) : res(r)));
const dbAll = (sql, p=[]) => new Promise((res,rej) => db.all(sql, p, (e,r) => e ? rej(e) : res(r)));
const dbRun = (sql, p=[]) => new Promise((res,rej) => db.run(sql, p, function(e){ e ? rej(e) : res(this); }));

/** Eine E-Mail = ein Account (Live): trim + Kleinbuchstaben; Abgleich immer case-insensitive. */
function normalizeUserEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function ensureNewUserSignupCoins(userId) {
  // Self-heal: falls ein neuer Nutzer 0 Coins hat (z. B. alter Server/Cache),
  // einmalig auf das Startguthaben anheben. (Nur wirklich "neu": noch keine Nachrichten gesendet.)
  try {
    const uid = Number(userId);
    if (!uid) return;
    const u = await dbGet('SELECT id, coins, created_at, account_type, is_bot FROM users WHERE id=?', [uid]);
    if (!u || Number(u.is_bot || 0) === 1) return;
    if (String(u.account_type || '').toLowerCase() !== 'user') return;
    const target = NEW_USER_SIGNUP_COINS;
    const cur = Number(u.coins || 0);
    if (cur >= target) return;
    const sent = await dbGet('SELECT id FROM messages WHERE CAST(COALESCE(sender_id,-1) AS INTEGER)=? LIMIT 1', [uid]);
    if (sent) return;
    await dbRun('UPDATE users SET coins=? WHERE id=? AND coins < ?', [target, uid, target]);
  } catch {}
}

// Einmalige Mini-Migration beim Start: falls es "neue" User mit zu wenig Coins gibt,
// die noch nie gesendet haben (z. B. Registrierung über alten Prozess), auf Startguthaben setzen.
(async () => {
  try {
    const target = NEW_USER_SIGNUP_COINS;
    await dbRun(
      `UPDATE users
       SET coins=?
       WHERE is_bot=0
         AND LOWER(COALESCE(account_type,''))='user'
         AND CAST(COALESCE(coins,0) AS INTEGER) < ?
         AND NOT EXISTS (
           SELECT 1 FROM messages m
           WHERE CAST(COALESCE(m.sender_id,-1) AS INTEGER)=CAST(users.id AS INTEGER)
           LIMIT 1
         )`,
      [target, target]
    );
  } catch {}
})();

async function ensurePrimaryPhoto(userId) {
  // Falls es noch kein user_photos gibt, aber users.photo gesetzt ist: einmalig migrieren
  try {
    const u = await dbGet('SELECT id, photo FROM users WHERE id=?', [userId]);
    if (!u) return;
    const url = String(u.photo || '').trim();
    if (!url) return;
    const exists = await dbGet('SELECT id FROM user_photos WHERE user_id=? LIMIT 1', [userId]);
    if (exists) return;
    await dbRun('INSERT OR IGNORE INTO user_photos (user_id, url, sort_order, is_primary) VALUES (?,?,0,1)', [userId, url]);
  } catch {}
}

async function getUserPhotos(userId) {
  await ensurePrimaryPhoto(userId);
  const rows = await dbAll(
    'SELECT id,url,sort_order,is_primary,created_at FROM user_photos WHERE user_id=? ORDER BY is_primary DESC, sort_order ASC, created_at DESC',
    [userId]
  );
  return rows.map(r => ({ ...r, is_primary: Number(r.is_primary || 0) }));
}

// Admin per ENV-E-Mail setzen (lokal praktisch: kein ID/Console nötig)
(async () => {
  try {
    if (!ADMIN_EMAIL) return;
    await dbRun('UPDATE users SET is_admin=1 WHERE LOWER(email)=?', [ADMIN_EMAIL]);
    console.log(`🛡️  Admin via ADMIN_EMAIL aktiv: ${ADMIN_EMAIL}`);
  } catch (e) {
    console.warn('⚠️  ADMIN_EMAIL konnte nicht gesetzt werden:', e.message);
  }
})();

// Einmalige Normalisierung: Seeder-Accounts als "seed" markieren (hilft Admin-Trennung)
(async () => {
  try {
    // Reihenfolge ist wichtig:
    // 1) Seed-Accounts (an E-Mail erkennbar)
    await dbRun(`UPDATE users SET account_type='seed' WHERE is_bot=0 AND email LIKE 'seed\\_%@herzfunke.local' ESCAPE '\\'`);
    // 2) Team = betreut
    await dbRun(`UPDATE users SET account_type='team' WHERE is_bot=0 AND is_managed=1`);
    // 3) Alles andere sind normale User (auch falls account_type früher fälschlich auf 'seed' stand)
    await dbRun(`
      UPDATE users
      SET account_type='user'
      WHERE is_bot=0
        AND (account_type IS NULL OR account_type='' OR account_type NOT IN ('user','seed','team') OR account_type='seed')
        AND is_managed=0
        AND email NOT LIKE 'seed\\_%@herzfunke.local' ESCAPE '\\'
    `);
  } catch {}
})();

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Nicht authentifiziert' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ message: 'Token ungültig' }); }
}
const safeUser = u => { if (!u) return null; const {password, ...s} = u; return s; };

// Socket.io JWT Auth (damit Admin & User nicht spoofbar sind)
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(); // optional (lokal), dann nur userId-Join wie bisher
    const payload = jwt.verify(String(token), JWT_SECRET);
    socket.user = payload;
    return next();
  } catch {
    return next(new Error('unauthorized'));
  }
});

/** HTTP-Admin und Socket „admins“-Room: identische Regeln (inkl. ADMIN_EMAIL → is_admin setzen). */
async function userHasAdminAccessPayload(payload) {
  if (!payload || payload.id == null) return false;
  const uid = Number(payload.id);
  if (!Number.isFinite(uid)) return false;
  if (ADMIN_USER_ID && uid === Number(ADMIN_USER_ID)) return true;
  const u = await dbGet('SELECT id, is_admin, email FROM users WHERE id=?', [uid]);
  if (!u) return false;
  const dbEmail = String(u.email || '').trim().toLowerCase();
  const jwtEmail = String(payload.email || '').trim().toLowerCase();
  if (ADMIN_EMAIL && (dbEmail === ADMIN_EMAIL || jwtEmail === ADMIN_EMAIL)) {
    try { await dbRun('UPDATE users SET is_admin=1 WHERE id=?', [uid]); } catch {}
    return true;
  }
  return Number(u.is_admin || 0) === 1;
}

async function requireAdmin(req, res, next) {
  try {
    if (!(await userHasAdminAccessPayload(req.user)))
      return res.status(403).json({ message: 'Admin erforderlich' });
    return next();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: 'Serverfehler' });
  }
}

function socketNumericUserId(socket) {
  const raw = socket.user?.id ?? socket.user?.userId ?? socket.user?.sub;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ===== PAYMENTS =====
try {
  const paymentRoutes = require('./payment-routes');
  const { isStripeConfigured } = require('./payments');
  app.use('/api/payments', paymentRoutes(db, auth));
  if (isStripeConfigured()) console.log('💳 Payment-Routen: AKTIV (Stripe Checkout/Testkarten möglich)');
  else console.log('💳 Payment-Routen: AKTIV (Preise sichtbar – für Checkout STRIPE_SECRET_KEY=sk_test_… setzen)');
} catch (err) {
  console.warn('⚠️  Payment-Routen nicht geladen:', err.message);
}

// ===== BOT FUNKTIONEN =====
async function saveMessageToDB({ matchId, senderId, text, isBot = false }) {
  const imageUrl = arguments[0]?.imageUrl ? String(arguments[0].imageUrl || '').trim() : null;
  const msgText = String(text || '').trim();
  const safeText = msgText || (imageUrl ? '📷 Bild' : '');
  const r = await dbRun('INSERT INTO messages (match_id, sender_id, text, is_bot, image_url) VALUES (?,?,?,?,?)',
    [matchId, senderId, safeText, isBot ? 1 : 0, imageUrl || null]);
  return await dbGet('SELECT * FROM messages WHERE id = ?', [r.lastID]);
}

/** Team/Seed/is_managed/Intern — wie zuvor. */
async function matchInvolvesTeamLikeProfile(matchId) {
  const row = await dbGet(
    `SELECT u1.is_managed AS x1, u1.is_bot AS b1, u1.account_type AS t1, u1.email AS e1,
            u2.is_managed AS x2, u2.is_bot AS b2, u2.account_type AS t2, u2.email AS e2
     FROM matches mm
     JOIN users u1 ON mm.user1_id = u1.id
     JOIN users u2 ON mm.user2_id = u2.id
     WHERE mm.id = ?`,
    [matchId]
  );
  if (!row) return false;
  const side = (m, t, e, b) => {
    if (Number(b || 0) === 1) return false;
    if (/^seed_.*@herzfunke\.local$/i.test(String(e || ''))) return true;
    if (Number(m || 0) === 1) return true;
    return ['team', 'seed'].includes(String(t || '').toLowerCase());
  };
  return side(row.x1, row.t1, row.e1, row.b1) || side(row.x2, row.t2, row.e2, row.b2);
}

/**
 * Admin-Push: alles außer „zwei normale App-Nutzer“ (kein Bot-Chat).
 * Erfasst z. B. @herzfunke.local-Teamaccounts ohne account_type.
 */
async function matchShouldNotifyAdmins(matchId) {
  const row = await dbGet(
    `SELECT u1.is_managed AS m1, u1.is_bot AS b1, u1.account_type AS t1, u1.email AS e1,
            u2.is_managed AS m2, u2.is_bot AS b2, u2.account_type AS t2, u2.email AS e2
     FROM matches mm
     JOIN users u1 ON mm.user1_id = u1.id
     JOIN users u2 ON mm.user2_id = u2.id
     WHERE mm.id = ?`,
    [matchId]
  );
  if (!row) return false;
  if (Number(row.b1 || 0) === 1 || Number(row.b2 || 0) === 1) return false;
  if (await matchInvolvesTeamLikeProfile(matchId)) return true;
  const plainSide = (m, t, e) => {
    const at = String(t || '').trim().toLowerCase();
    const plainType = !at || at === 'user';
    const internalMail = /@herzfunke\.local$/i.test(String(e || '').trim());
    return plainType && Number(m || 0) === 0 && !internalMail;
  };
  const p1 = plainSide(row.m1, row.t1, row.e1);
  const p2 = plainSide(row.m2, row.t2, row.e2);
  return !(p1 && p2);
}

// ===== UPLOAD =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR + path.sep),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 5*1024*1024 },
  fileFilter: (req, f, cb) => f.mimetype.startsWith('image/') ? cb(null,true) : cb(new Error('Nur Bilder')) });

// ===== ROUTES =====
app.get('/api/health', (req, res) => res.json({ status: 'ok', botId: BOT_USER_ID }));

// ===== DEV: SEED USERS (für mehr Accounts) =====
// Aufruf: POST /api/dev/seed?key=DEIN_KEY&count=200
// Setze dazu env: SEED_SECRET=DEIN_KEY
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(a) { return [...a].sort(() => Math.random() - 0.5); }

app.post('/api/dev/seed', async (req, res) => {
  try {
    const secret = process.env.SEED_SECRET;
    if (!secret) return res.status(404).json({ message: 'Seeder ist deaktiviert' });
    const key = String(req.query.key || '');
    if (key !== String(secret)) return res.status(403).json({ message: 'Nicht berechtigt' });

    const count = Math.max(1, Math.min(5000, Number(req.query.count || 200)));

    const firstNames = ['Sophie','Mia','Lena','Anna','Laura','Lea','Nina','Jana','Emma','Marie','Hannah','Sarah','Alina','Clara','Paula','Luca','Noah','Elias','Jonas','Leon','Finn','Ben','Paul','Tim','Tom','Max','Felix','Liam','David','Niklas','Julian'];
    const cities = ['Berlin','Hamburg','München','Köln','Frankfurt','Stuttgart','Düsseldorf','Leipzig','Dresden','Nürnberg','Bremen','Hannover','Essen','Dortmund','Wien','Graz','Linz','Salzburg','Innsbruck','Zürich','Basel'];
    const tags = ['Reisen','Fitness','Kochen','Kunst','Musik','Kino','Natur','Wandern','Tanzen','Gaming','Lesen','Fotografie','Café','Hundeliebe','Yoga','Tech','Mode','Sport','Roadtrips','Meditation'];
    const bios = [
      'Ich liebe gute Gespräche, Kaffee und spontane Trips.',
      'Zwischen Stadt & Natur – am liebsten beides.',
      'Humor ist mir wichtig. Schreib mir was Lustiges.',
      'Ich suche jemanden für Abenteuer und gemütliche Abende.',
      'Wenn du Pizza magst, sind wir schon fast ein Match.',
      'Ich bin neugierig, offen und immer für Neues zu haben.',
    ];

    const defaultPassword = process.env.SEED_DEFAULT_PASSWORD || 'Startklar123!';
    const hash = await bcrypt.hash(defaultPassword, 12);

    let created = 0;
    const now = Date.now();

    for (let i = 0; i < count; i++) {
      const name = pick(firstNames) + (Math.random() < 0.35 ? ` ${pick(['S.','K.','M.','L.','J.'])}` : '');
      const age = randInt(18, 45);
      const city = pick(cities);
      const interests = shuffle(tags).slice(0, randInt(3, 6));
      const bio = pick(bios);
      const email = `seed_${now}_${i}_${Math.random().toString(16).slice(2)}@herzfunke.local`;
      const photo = `https://i.pravatar.cc/300?img=${randInt(1, 70)}`;

      try {
        await dbRun(
          'INSERT INTO users (name, age, city, email, password, bio, photo, interests, is_bot, account_type) VALUES (?,?,?,?,?,?,?,?,0,?)',
          [name, age, city, email, hash, bio, photo, JSON.stringify(interests), 'seed']
        );
        created++;
      } catch {
        // ignore duplicates/errors and continue
      }
    }

    res.json({ ok: true, created, defaultPassword });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Serverfehler' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, age, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'Alle Felder ausfüllen' });
    if (password.length < 6) return res.status(400).json({ message: 'Passwort zu kurz' });
    if (age < 18) return res.status(400).json({ message: 'Mindestalter: 18 Jahre' });
    const emailNorm = normalizeUserEmail(email);
    if (!emailNorm) return res.status(400).json({ message: 'E-Mail angeben' });
    if (emailNorm.length > 254) return res.status(400).json({ message: 'E-Mail zu lang' });
    const exists = await dbGet('SELECT id FROM users WHERE LOWER(TRIM(email)) = ?', [emailNorm]);
    if (exists) return res.status(409).json({ message: 'E-Mail bereits registriert' });
    const hash = await bcrypt.hash(password, 12);
    const signupCoins = NEW_USER_SIGNUP_COINS;
    let result;
    try {
      result = await dbRun(
        'INSERT INTO users (name,age,email,password,account_type,coins) VALUES (?,?,?,?,?,?)',
        [name, age, emailNorm, hash, 'user', signupCoins]
      );
    } catch (insErr) {
      if (insErr && (insErr.code === 'SQLITE_CONSTRAINT' || String(insErr.message || '').includes('UNIQUE')))
        return res.status(409).json({ message: 'E-Mail bereits registriert' });
      throw insErr;
    }
    await ensureNewUserSignupCoins(result.lastID);
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [result.lastID]);
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    // Live: kein Auto-Match mit Bot (nur auf Wunsch aktivieren)
    if (BOT_AUTOREPLY && BOT_USER_ID) {
      const u1 = Math.min(user.id, BOT_USER_ID), u2 = Math.max(user.id, BOT_USER_ID);
      await dbRun('INSERT OR IGNORE INTO matches (user1_id, user2_id) VALUES (?,?)', [u1, u2]);
      console.log(`🤖 ${user.name} wurde automatisch mit Bot gematched (BOT_AUTOREPLY=1)`);
    }
    // Bestätigungs-Mail (nur Info, Registrierung bleibt auch ohne Mail erfolgreich)
    void sendRegistrationEmail(emailNorm, name);

    // Coins explizit in der Response (UI zeigt sofort korrekt)
    const safe = safeUser(user);
    res.status(201).json({ user: { ...safe, coins: Number(user?.coins || safe?.coins || 0) }, token });
  } catch(err) { console.error(err); res.status(500).json({ message: 'Serverfehler' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const emailNorm = normalizeUserEmail(email);
    const user = await dbGet(
      'SELECT * FROM users WHERE LOWER(TRIM(email))=? AND is_bot=0',
      [emailNorm]
    );
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(401).json({ message: 'E-Mail oder Passwort falsch' });
    await ensureNewUserSignupCoins(user.id);
    const user2 = await dbGet('SELECT * FROM users WHERE id=?', [user.id]);
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    const uOut = user2 || user;
    const safe = safeUser(uOut);
    res.json({ user: { ...safe, coins: Number(uOut?.coins || safe?.coins || 0) }, token });
  } catch { res.status(500).json({ message: 'Serverfehler' }); }
});

app.get('/api/profile', auth, async (req, res) => {
  await ensureNewUserSignupCoins(req.user.id);
  res.json(safeUser(await dbGet('SELECT * FROM users WHERE id=?', [req.user.id])));
});

// ===== ADMIN =====
app.get('/api/admin/me', auth, requireAdmin, async (req, res) => {
  const u = await dbGet('SELECT id,name,email,is_admin,coins,is_premium,premium_tier FROM users WHERE id=?', [req.user.id]);
  res.json({ ok: true, user: u || null });
});

async function adminCreateTeamProfile(req, res) {
  try {
    const { name, email, password, age, city, coins, kind } = req.body || {};
    const nameT = String(name || '').trim();
    let emailT = String(email || '').trim().toLowerCase();
    if (!nameT) return res.status(400).json({ message: 'Name ist erforderlich' });
    const isTeam = String(kind || 'team').toLowerCase() === 'team';
    if (!isTeam) {
      return res.status(403).json({ message: 'Hier nur Team-Profile anlegen. Nutzer-Accounts über die App-Registrierung.' });
    }
    const ageN = Math.max(18, Math.min(99, Number(age == null || age === '' ? 25 : age)));
    if (!emailT) {
      for (let i = 0; i < 8; i++) {
        const slug = crypto.randomBytes(6).toString('hex');
        const candidate = `admin_${Date.now()}_${slug}@herzfunke.local`;
        const taken = await dbGet('SELECT id FROM users WHERE LOWER(email)=?', [candidate]);
        if (!taken) {
          emailT = candidate;
          break;
        }
      }
      if (!emailT) return res.status(500).json({ message: 'Konnte keine eindeutige Kennung erzeugen' });
    } else {
      const exists = await dbGet('SELECT id FROM users WHERE LOWER(email)=?', [emailT]);
      if (exists) return res.status(409).json({ message: 'E-Mail ist bereits vergeben' });
    }
    const manualPw = String(password || '').trim();
    let passwordPlain;
    let returnPassword = false;
    if (manualPw.length >= 6) {
      passwordPlain = manualPw;
    } else {
      passwordPlain = crypto.randomBytes(18).toString('base64url');
      returnPassword = true;
    }
    const hash = await bcrypt.hash(passwordPlain, 12);
    const coinsN = Math.max(0, Math.min(1000000, Number(coins ?? 0)));
    const cityT = String(city || '').trim().slice(0, 80);
    const result = await dbRun(
      `INSERT INTO users (name,age,email,password,city,coins,is_managed,account_type,is_bot)
       VALUES (?,?,?,?,?,?,?,?,0)`,
      [nameT, ageN, emailT, hash, cityT, coinsN, 1, 'team']
    );
    const user = await dbGet('SELECT * FROM users WHERE id=?', [result.lastID]);
    res.status(201).json({
      user: safeUser(user),
      ...(returnPassword ? { initialPassword: passwordPlain } : {}),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Serverfehler' });
  }
}

// GET: Schnelltest im Browser — wenn 404, ist auf diesem Port kein aktueller server.js (oder falscher Prozess)
app.get('/api/admin/team-profile', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    postPath: '/api/admin/team-profile',
    hint: 'Team-Profil: POST mit JSON { name, kind: "team", … } und Authorization: Bearer …',
  });
});

// Eigenständiger Pfad (Admin-UI) – vor allen /api/admin/users/:id/… Routen
app.post('/api/admin/team-profile', auth, requireAdmin, adminCreateTeamProfile);

app.get('/api/admin/users', auth, requireAdmin, async (req, res) => {
  const kind = String(req.query.kind || 'all').toLowerCase(); // all | users | team
  const where =
    kind === 'users'
      ? `WHERE is_bot=0 AND is_managed=0
         AND email NOT LIKE 'seed\\_%@herzfunke.local' ESCAPE '\\'
         AND (account_type='user' OR account_type IS NULL OR account_type='')`
      : kind === 'team'
        ? `WHERE is_bot=0 AND (
            account_type IN ('team','seed') OR is_managed=1
            OR email LIKE 'seed\\_%@herzfunke.local' ESCAPE '\\'
          )`
        : 'WHERE is_bot=0';
  const rows = await dbAll(
    `SELECT id,name,age,city,email,photo,bio,interests,is_online,is_premium,premium_tier,is_managed,coins,created_at
     FROM users
     ${where}
     ORDER BY created_at DESC
     LIMIT 2000`
  );
  res.json(rows.map(r => ({
    ...r,
    is_managed: Number(r.is_managed || 0),
    is_premium: Number(r.is_premium || 0),
    interests: (() => { try { return JSON.parse(r.interests || '[]'); } catch { return []; } })()
  })));
});

app.post('/api/admin/users', auth, requireAdmin, adminCreateTeamProfile);

app.get('/api/admin/managed', auth, requireAdmin, async (req, res) => {
  const rows = await dbAll(
    `SELECT id,name,age,city,email,photo,bio,interests,is_online,is_premium,premium_tier,is_managed,coins,created_at
     FROM users
     WHERE is_bot=0 AND is_managed=1
     ORDER BY created_at DESC
     LIMIT 2000`
  );
  res.json(rows.map(r => ({
    ...r,
    is_managed: Number(r.is_managed || 0),
    is_premium: Number(r.is_premium || 0),
    interests: (() => { try { return JSON.parse(r.interests || '[]'); } catch { return []; } })()
  })));
});

async function requireManagedActor(req, res, next) {
  const actorId = Number(req.params.actorId);
  if (!actorId) return res.status(400).json({ message: 'Ungültige actorId' });
  // Admin-UI darf Unreads/Chats für jeden nicht‑Bot Account sehen (App-like Badges für alle Accounts).
  // Diese Middleware hängt NUR hinter requireAdmin, daher ist das ok.
  const a = await dbGet('SELECT id,is_bot FROM users WHERE id=?', [actorId]);
  if (!a || Number(a.is_bot || 0) === 1) return res.status(404).json({ message: 'Profil nicht gefunden' });
  req.actorId = actorId;
  next();
}

/** Match nur nach explizitem Admin-„Matchen“, nicht beim ersten Schreiben */
async function findMatchBetweenUsers(a, b) {
  const u1 = Math.min(Number(a), Number(b));
  const u2 = Math.max(Number(a), Number(b));
  return dbGet('SELECT id FROM matches WHERE user1_id=? AND user2_id=?', [u1, u2]);
}

/** Gleiche Logik wie GET /api/matches: unread_count + unopened für viewerId (App- oder Team-Nutzer). */
async function matchRowsWithUnreadForViewer(viewerId, rows) {
  const id = Number(viewerId);
  const out = [];
  for (const row of rows) {
    const mid = Number(row.match_id);
    const cr = await dbGet(
      'SELECT last_read_message_id FROM chat_read WHERE CAST(user_id AS INTEGER)=? AND CAST(match_id AS INTEGER)=?',
      [id, mid]
    );
    const after = Number(cr?.last_read_message_id || 0);
    const uc = await dbGet(
      `SELECT COUNT(*) AS c FROM messages
       WHERE CAST(match_id AS INTEGER)=?
         AND CAST(COALESCE(sender_id, -1) AS INTEGER) != CAST(? AS INTEGER)
         AND CAST(id AS INTEGER) > ?`,
      [mid, id, after]
    );
    const unreadCount = Number(uc?.c ?? uc?.C ?? 0);
    out.push({
      ...row,
      match_id: mid,
      user_id: Number(row.user_id),
      unread_count: unreadCount,
      unopened: cr ? 0 : 1,
    });
  }
  return out;
}

app.get('/api/admin/as/:actorId/matches', auth, requireAdmin, requireManagedActor, async (req, res) => {
  const id = req.actorId;
  const rows = await dbAll(`
    SELECT m.id as match_id,
      CASE WHEN m.user1_id=? THEN u2.id ELSE u1.id END as user_id,
      CASE WHEN m.user1_id=? THEN u2.name ELSE u1.name END as name,
      CASE WHEN m.user1_id=? THEN u2.age ELSE u1.age END as age,
      CASE WHEN m.user1_id=? THEN u2.city ELSE u1.city END as city,
      CASE WHEN m.user1_id=? THEN u2.photo ELSE u1.photo END as photo,
      CASE WHEN m.user1_id=? THEN u2.is_managed ELSE u1.is_managed END as is_managed,
      CASE WHEN m.user1_id=? THEN u2.is_bot ELSE u1.is_bot END as is_bot,
      m.created_at
    FROM matches m
    JOIN users u1 ON m.user1_id=u1.id
    JOIN users u2 ON m.user2_id=u2.id
    WHERE (m.user1_id=? OR m.user2_id=?)
      AND (CASE WHEN m.user1_id=? THEN u2.is_bot ELSE u1.is_bot END) = 0
    ORDER BY m.created_at DESC`, Array(10).fill(id));
  res.json(await matchRowsWithUnreadForViewer(id, rows));
});

/** MUSS vor GET …/messages/:matchId stehen — sonst wird „unread-by-user“ als matchId interpretiert. */
app.get('/api/admin/as/:actorId/unread-by-user', auth, requireAdmin, requireManagedActor, async (req, res) => {
  const actorId = req.actorId;
  try {
    const rows = await dbAll(
      `
      SELECT m.id as match_id,
        CASE WHEN m.user1_id=? THEN m.user2_id ELSE m.user1_id END as other_id
      FROM matches m
      JOIN users u1 ON m.user1_id=u1.id
      JOIN users u2 ON m.user2_id=u2.id
      WHERE (m.user1_id=? OR m.user2_id=?)
        AND (CASE WHEN m.user1_id=? THEN u2.is_bot ELSE u1.is_bot END) = 0
      `,
      [actorId, actorId, actorId, actorId]
    );
    const out = {};
    for (const row of rows) {
      const mid = Number(row.match_id);
      const otherId = Number(row.other_id);
      const cr = await dbGet(
        'SELECT last_read_message_id FROM chat_read WHERE CAST(user_id AS INTEGER)=? AND CAST(match_id AS INTEGER)=?',
        [actorId, mid]
      );
      const after = Number(cr?.last_read_message_id || 0);
      const c = await dbGet(
        `SELECT COUNT(*) AS c FROM messages
         WHERE CAST(match_id AS INTEGER)=?
           AND CAST(COALESCE(sender_id,-1) AS INTEGER) != CAST(? AS INTEGER)
           AND CAST(id AS INTEGER) > ?`,
        [mid, actorId, after]
      );
      const n = Number(c?.c ?? c?.C ?? 0);
      if (n > 0) {
        const k = String(otherId);
        out[k] = (out[k] || 0) + n;
      }
    }
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Serverfehler' });
  }
});

/**
 * Explizite Liste pro Match: userId (Gegenüber), matchId, unread — für Admin-Badges.
 * MUSS vor GET …/messages/:matchId stehen.
 */
app.get('/api/admin/as/:actorId/unread-per-match', auth, requireAdmin, requireManagedActor, async (req, res) => {
  const actorId = req.actorId;
  try {
    const rows = await dbAll(
      `
      SELECT m.id AS match_id,
        CASE WHEN m.user1_id=? THEN m.user2_id ELSE m.user1_id END AS user_id
      FROM matches m
      JOIN users u1 ON m.user1_id=u1.id
      JOIN users u2 ON m.user2_id=u2.id
      WHERE (m.user1_id=? OR m.user2_id=?)
        AND (CASE WHEN m.user1_id=? THEN u2.is_bot ELSE u1.is_bot END)=0
      ORDER BY m.created_at DESC
      `,
      [actorId, actorId, actorId, actorId]
    );
    const out = [];
    for (const row of rows) {
      const mid = Number(row.match_id);
      const uid = Number(row.user_id);
      if (!Number.isFinite(mid) || mid <= 0 || !Number.isFinite(uid) || uid <= 0) continue;
      const cr = await dbGet(
        'SELECT last_read_message_id FROM chat_read WHERE CAST(user_id AS INTEGER)=? AND CAST(match_id AS INTEGER)=?',
        [actorId, mid]
      );
      const after = Number(cr?.last_read_message_id || 0);
      const uc = await dbGet(
        `SELECT COUNT(*) AS c FROM messages
         WHERE CAST(match_id AS INTEGER)=?
           AND CAST(COALESCE(sender_id,-1) AS INTEGER)!=CAST(? AS INTEGER)
           AND CAST(id AS INTEGER)>?`,
        [mid, actorId, after]
      );
      const unread = Number(uc?.c ?? uc?.C ?? 0);
      out.push({ userId: uid, matchId: mid, unread });
    }
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Serverfehler' });
  }
});

app.get('/api/admin/as/:actorId/messages/:matchId', auth, requireAdmin, requireManagedActor, async (req, res) => {
  const matchId = Number(req.params.matchId);
  if (!matchId) return res.status(400).json({ message: 'Ungültige matchId' });
  const m = await dbGet('SELECT * FROM matches WHERE id=?', [matchId]);
  if (!m) return res.status(404).json({ message: 'Match nicht gefunden' });
  if (Number(m.user1_id) !== req.actorId && Number(m.user2_id) !== req.actorId)
    return res.status(403).json({ message: 'Kein Zugriff auf diesen Chat' });
  res.json(await dbAll('SELECT * FROM messages WHERE match_id=? ORDER BY created_at ASC', [matchId]));
});

/** Team-Profil hat Chat wie App-Nutzer: „gelesen“ bis zur letzten Nachricht (für Unread-Zähler). */
app.post('/api/admin/as/:actorId/messages/:matchId/read', auth, requireAdmin, requireManagedActor, async (req, res) => {
  const matchId = Number(req.params.matchId);
  if (!matchId) return res.status(400).json({ message: 'Ungültige matchId' });
  try {
    const m = await dbGet('SELECT * FROM matches WHERE id=?', [matchId]);
    if (!m) return res.status(404).json({ message: 'Match nicht gefunden' });
    if (Number(m.user1_id) !== req.actorId && Number(m.user2_id) !== req.actorId)
      return res.status(403).json({ message: 'Kein Zugriff auf diesen Chat' });
    const maxRow = await dbGet('SELECT COALESCE(MAX(id), 0) AS mid FROM messages WHERE match_id=?', [matchId]);
    const lastId = Number(maxRow?.mid || 0);
    const uid = Number(req.actorId);
    await dbRun(
      `INSERT INTO chat_read (user_id, match_id, last_read_message_id) VALUES (?,?,?)
       ON CONFLICT(user_id, match_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id`,
      [uid, matchId, lastId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Serverfehler' });
  }
});

app.post('/api/admin/as/:actorId/message', auth, requireAdmin, requireManagedActor, async (req, res) => {
  const { toUserId, text } = req.body || {};
  const targetId = Number(toUserId);
  const msgText = String(text || '').trim();
  if (!targetId || !msgText) return res.status(400).json({ message: 'toUserId und text erforderlich' });

  const target = await dbGet('SELECT id,is_bot FROM users WHERE id=?', [targetId]);
  if (!target || Number(target.is_bot || 0) === 1) return res.status(404).json({ message: 'Nutzer nicht gefunden' });

  const match = await findMatchBetweenUsers(req.actorId, targetId);
  if (!match) return res.status(400).json({ message: 'Kein Match – bitte zuerst „Matchen“.' });

  const msg = await saveMessageToDB({ matchId: match.id, senderId: req.actorId, text: msgText });
  io.to(`match_${match.id}`).emit('message', msg);
  io.to(`user_${req.actorId}`).emit('message', { matchId: match.id, message: msg });
  io.to(`user_${targetId}`).emit('message', { matchId: match.id, message: msg });
  io.to('admins').emit('managed_message', { matchId: match.id, message: msg, fromUserId: req.actorId, toUserId: targetId });
  res.status(201).json({ matchId: match.id, message: msg });
});

app.post('/api/admin/as/:actorId/message/image', auth, requireAdmin, requireManagedActor, upload.single('image'), async (req, res) => {
  try {
    const targetId = Number(req.body?.toUserId);
    if (!targetId) return res.status(400).json({ message: 'toUserId erforderlich' });
    if (!req.file) return res.status(400).json({ message: 'Kein Bild' });

    const target = await dbGet('SELECT id,is_bot FROM users WHERE id=?', [targetId]);
    if (!target || Number(target.is_bot || 0) === 1) return res.status(404).json({ message: 'Nutzer nicht gefunden' });

    const match = await findMatchBetweenUsers(req.actorId, targetId);
    if (!match) return res.status(400).json({ message: 'Kein Match – bitte zuerst „Matchen“.' });

    const url = `/uploads/${req.file.filename}`;
    const msg = await saveMessageToDB({ matchId: match.id, senderId: req.actorId, text: '', imageUrl: url });
    io.to(`match_${match.id}`).emit('message', msg);
    io.to(`user_${req.actorId}`).emit('message', { matchId: match.id, message: msg });
    io.to(`user_${targetId}`).emit('message', { matchId: match.id, message: msg });
    io.to('admins').emit('managed_message', { matchId: match.id, message: msg, fromUserId: req.actorId, toUserId: targetId });
    res.status(201).json({ matchId: match.id, message: msg });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Serverfehler' });
  }
});

// Match manuell: Team-Profil (Actor) ↔ Nutzer (ohne Nachricht)
app.post('/api/admin/as/:actorId/match', auth, requireAdmin, requireManagedActor, async (req, res) => {
  try {
    const targetId = Number(req.body?.userId);
    if (!targetId) return res.status(400).json({ message: 'userId erforderlich' });
    if (targetId === req.actorId) return res.status(400).json({ message: 'Ungültige Auswahl' });

    const target = await dbGet('SELECT id,is_bot FROM users WHERE id=?', [targetId]);
    if (!target || Number(target.is_bot || 0) === 1) return res.status(404).json({ message: 'Nutzer nicht gefunden' });

    const u1 = Math.min(req.actorId, targetId);
    const u2 = Math.max(req.actorId, targetId);
    await dbRun('INSERT OR IGNORE INTO matches (user1_id, user2_id) VALUES (?,?)', [u1, u2]);
    const match = await dbGet('SELECT id FROM matches WHERE user1_id=? AND user2_id=?', [u1, u2]);
    if (!match) return res.status(500).json({ message: 'Match konnte nicht erstellt werden' });

    console.log(`✅ Match nur per Admin-Matchen: id=${match.id} actor=${req.actorId} ↔ user=${targetId}`);

    const swipeRow = await dbGet(
      'SELECT action FROM swipes WHERE swiper_id=? AND target_id=?',
      [targetId, req.actorId]
    );
    const act = String(swipeRow?.action || '').toLowerCase();
    const likedTeamFirst = ['like', 'super'].includes(act);
    const actorRow = await dbGet('SELECT id,name,photo FROM users WHERE id=?', [req.actorId]);
    const targetRow = await dbGet('SELECT id,name,photo FROM users WHERE id=?', [targetId]);

    io.to(`user_${targetId}`).emit('new_match', {
      matchId: match.id,
      partnerId: req.actorId,
      partnerName: actorRow?.name || '',
      partnerPhoto: actorRow?.photo || '',
      likedFirst: !!likedTeamFirst,
    });
    io.to(`user_${req.actorId}`).emit('new_match', {
      matchId: match.id,
      partnerId: targetId,
      partnerName: targetRow?.name || '',
      partnerPhoto: targetRow?.photo || '',
      likedFirst: false,
    });

    res.json({ ok: true, matchId: match.id, likedFirst: !!likedTeamFirst });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Serverfehler' });
  }
});

app.post('/api/admin/users/:id/managed', auth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const managed = Number(req.body?.managed ? 1 : 0);
  if (!id) return res.status(400).json({ message: 'Ungültige ID' });
  await dbRun(
    `UPDATE users
     SET is_managed=?,
         account_type=CASE
           WHEN ?=1 THEN 'team'
           WHEN email LIKE 'seed\\_%@herzfunke.local' ESCAPE '\\' THEN 'seed'
           ELSE 'user'
         END
     WHERE id=? AND is_bot=0`,
    [managed, managed, id]
  );
  const u = await dbGet('SELECT id,is_managed FROM users WHERE id=?', [id]);
  res.json({ ok: true, user: u });
});

app.delete('/api/admin/users/:id', auth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: 'Ungültige ID' });
  if (ADMIN_USER_ID && id === Number(ADMIN_USER_ID)) return res.status(400).json({ message: 'Admin kann nicht gelöscht werden' });
  if (BOT_USER_ID && id === Number(BOT_USER_ID)) return res.status(400).json({ message: 'Bot kann nicht gelöscht werden' });

  const u = await dbGet('SELECT id,is_bot FROM users WHERE id=?', [id]);
  if (!u) return res.status(404).json({ message: 'Nutzer nicht gefunden' });
  if (Number(u.is_bot || 0) === 1) return res.status(400).json({ message: 'Bot kann nicht gelöscht werden' });

  // Alles zugehörige bereinigen (SQLite ohne FK-CASCADE)
  const matches = await dbAll('SELECT id FROM matches WHERE user1_id=? OR user2_id=?', [id, id]);
  for (const m of matches) {
    await dbRun('DELETE FROM messages WHERE match_id=?', [m.id]);
    await dbRun('DELETE FROM chat_read WHERE match_id=?', [m.id]);
  }
  await dbRun('DELETE FROM matches WHERE user1_id=? OR user2_id=?', [id, id]);
  await dbRun('DELETE FROM swipes WHERE swiper_id=? OR target_id=?', [id, id]);
  try { await dbRun('DELETE FROM purchases WHERE user_id=?', [id]); } catch {}
  await dbRun('DELETE FROM users WHERE id=?', [id]);

  res.json({ ok: true, deletedId: id });
});

app.patch('/api/admin/users/:id', auth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: 'Ungültige ID' });
  const body = req.body || {};

  const allowed = {
    name: (v) => String(v || '').trim().slice(0, 80),
    age: (v) => Math.max(18, Math.min(99, Number(v || 18))),
    city: (v) => String(v || '').trim().slice(0, 80),
    bio: (v) => String(v || '').trim().slice(0, 500),
    photo: (v) => String(v || '').trim().slice(0, 500),
    interests: (v) => JSON.stringify(Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean).slice(0, 30) : []),
    coins: (v) => Math.max(0, Math.min(1000000, Number(v || 0))),
    is_premium: (v) => Number(v ? 1 : 0),
    premium_tier: (v) => (v == null || v === '') ? null : String(v).toLowerCase(),
    is_managed: (v) => Number(v ? 1 : 0),
  };

  const updates = [];
  const params = [];
  for (const [k, fn] of Object.entries(allowed)) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      updates.push(`${k}=?`);
      params.push(fn(body[k]));
    }
  }
  if (!updates.length) return res.status(400).json({ message: 'Keine Felder zum Updaten' });

  await dbRun(`UPDATE users SET ${updates.join(', ')} WHERE id=? AND is_bot=0`, [...params, id]);
  const u = await dbGet('SELECT id,name,age,city,bio,photo,interests,coins,is_premium,premium_tier,is_managed FROM users WHERE id=?', [id]);
  res.json({
    ok: true,
    user: {
      ...u,
      is_managed: Number(u?.is_managed || 0),
      is_premium: Number(u?.is_premium || 0),
      interests: (() => { try { return JSON.parse(u?.interests || '[]'); } catch { return []; } })()
    }
  });
});

// Admin: Profilbilder verwalten (mehrere Bilder)
app.get('/api/admin/users/:id/photos', auth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: 'Ungültige ID' });
  res.json(await getUserPhotos(id));
});
app.post('/api/admin/users/:id/photos', auth, requireAdmin, upload.single('photo'), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: 'Ungültige ID' });
  if (!req.file) return res.status(400).json({ message: 'Kein Bild' });
  const url = `/uploads/${req.file.filename}`;
  await ensurePrimaryPhoto(id);
  const hasAny = await dbGet('SELECT id FROM user_photos WHERE user_id=? LIMIT 1', [id]);
  const makePrimary = hasAny ? 0 : 1;
  await dbRun('INSERT OR IGNORE INTO user_photos (user_id, url, sort_order, is_primary) VALUES (?,?,0,?)', [id, url, makePrimary]);
  if (makePrimary) await dbRun('UPDATE users SET photo=? WHERE id=?', [url, id]);
  res.status(201).json({ url, photos: await getUserPhotos(id) });
});
app.post('/api/admin/users/:id/photos/:photoId/primary', auth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const pid = Number(req.params.photoId);
  if (!id || !pid) return res.status(400).json({ message: 'Ungültige ID' });
  const p = await dbGet('SELECT id,url FROM user_photos WHERE id=? AND user_id=?', [pid, id]);
  if (!p) return res.status(404).json({ message: 'Bild nicht gefunden' });
  await dbRun('UPDATE user_photos SET is_primary=0 WHERE user_id=?', [id]);
  await dbRun('UPDATE user_photos SET is_primary=1 WHERE id=?', [pid]);
  await dbRun('UPDATE users SET photo=? WHERE id=?', [p.url, id]);
  res.json({ ok: true, primary: p.url, photos: await getUserPhotos(id) });
});
app.delete('/api/admin/users/:id/photos/:photoId', auth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const pid = Number(req.params.photoId);
  if (!id || !pid) return res.status(400).json({ message: 'Ungültige ID' });
  const p = await dbGet('SELECT id,url,is_primary FROM user_photos WHERE id=? AND user_id=?', [pid, id]);
  if (!p) return res.status(404).json({ message: 'Bild nicht gefunden' });
  await dbRun('DELETE FROM user_photos WHERE id=? AND user_id=?', [pid, id]);
  if (Number(p.is_primary || 0) === 1) {
    const next = await dbGet('SELECT id,url FROM user_photos WHERE user_id=? ORDER BY sort_order ASC, created_at DESC LIMIT 1', [id]);
    await dbRun('UPDATE user_photos SET is_primary=0 WHERE user_id=?', [id]);
    if (next) {
      await dbRun('UPDATE user_photos SET is_primary=1 WHERE id=?', [next.id]);
      await dbRun('UPDATE users SET photo=? WHERE id=?', [next.url, id]);
    } else {
      await dbRun('UPDATE users SET photo=? WHERE id=?', ['', id]);
    }
  }
  res.json({ ok: true, photos: await getUserPhotos(id) });
});

app.post('/api/admin/message', auth, requireAdmin, async (req, res) => {
  const { userId, text } = req.body || {};
  const targetId = Number(userId);
  const msgText = String(text || '').trim();
  if (!targetId || !msgText) return res.status(400).json({ message: 'userId und text erforderlich' });

  const target = await dbGet('SELECT id FROM users WHERE id=? AND is_bot=0', [targetId]);
  if (!target) return res.status(404).json({ message: 'Nutzer nicht gefunden' });

  const match = await findMatchBetweenUsers(req.user.id, targetId);
  if (!match) return res.status(400).json({ message: 'Kein Match – bitte zuerst „Matchen“ (Team-Profil ↔ Nutzer).' });

  const msg = await saveMessageToDB({ matchId: match.id, senderId: req.user.id, text: msgText });
  io.to(`match_${match.id}`).emit('message', msg);
  io.to(`user_${req.user.id}`).emit('message', { matchId: match.id, message: msg });
  io.to(`user_${targetId}`).emit('message', { matchId: match.id, message: msg });
  res.status(201).json({ matchId: match.id, message: msg });
});

app.get('/api/admin/matches/:userId', auth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!userId) return res.status(400).json({ message: 'Ungültige userId' });
  const id = userId;
  const rows = await dbAll(`
    SELECT m.id as match_id,
      CASE WHEN m.user1_id=? THEN u2.id ELSE u1.id END as user_id,
      CASE WHEN m.user1_id=? THEN u2.name ELSE u1.name END as name,
      CASE WHEN m.user1_id=? THEN u2.photo ELSE u1.photo END as photo,
      CASE WHEN m.user1_id=? THEN u2.is_bot ELSE u1.is_bot END as is_bot,
      m.created_at
    FROM matches m
    JOIN users u1 ON m.user1_id=u1.id
    JOIN users u2 ON m.user2_id=u2.id
    WHERE m.user1_id=? OR m.user2_id=?
    ORDER BY m.created_at DESC`, Array(6).fill(id));
  res.json(rows);
});

app.get('/api/admin/messages/:matchId', auth, requireAdmin, async (req, res) => {
  const matchId = Number(req.params.matchId);
  if (!matchId) return res.status(400).json({ message: 'Ungültige matchId' });
  res.json(await dbAll('SELECT * FROM messages WHERE match_id=? ORDER BY created_at ASC', [matchId]));
});

app.put('/api/profile', auth, async (req, res) => {
  const { name, age, city, bio, interests } = req.body;
  await dbRun('UPDATE users SET name=?,age=?,city=?,bio=?,interests=? WHERE id=?',
    [name, age, city, bio, JSON.stringify(interests||[]), req.user.id]);
  res.json(safeUser(await dbGet('SELECT * FROM users WHERE id=?', [req.user.id])));
});

app.post('/api/profile/photo', auth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Kein Bild' });
  const url = `/uploads/${req.file.filename}`;
  await dbRun('UPDATE users SET photo=? WHERE id=?', [url, req.user.id]);
  res.json({ photo: url });
});

// Mehrere Profilbilder
app.get('/api/profile/photos', auth, async (req, res) => {
  res.json(await getUserPhotos(req.user.id));
});
app.post('/api/profile/photos', auth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Kein Bild' });
  const url = `/uploads/${req.file.filename}`;
  await ensurePrimaryPhoto(req.user.id);
  const hasAny = await dbGet('SELECT id FROM user_photos WHERE user_id=? LIMIT 1', [req.user.id]);
  const makePrimary = hasAny ? 0 : 1;
  await dbRun(
    'INSERT OR IGNORE INTO user_photos (user_id, url, sort_order, is_primary) VALUES (?,?,0,?)',
    [req.user.id, url, makePrimary]
  );
  if (makePrimary) await dbRun('UPDATE users SET photo=? WHERE id=?', [url, req.user.id]);
  res.status(201).json({ url, photos: await getUserPhotos(req.user.id) });
});
app.post('/api/profile/photos/:photoId/primary', auth, async (req, res) => {
  const pid = Number(req.params.photoId);
  if (!pid) return res.status(400).json({ message: 'Ungültige photoId' });
  const p = await dbGet('SELECT id,url FROM user_photos WHERE id=? AND user_id=?', [pid, req.user.id]);
  if (!p) return res.status(404).json({ message: 'Bild nicht gefunden' });
  await dbRun('UPDATE user_photos SET is_primary=0 WHERE user_id=?', [req.user.id]);
  await dbRun('UPDATE user_photos SET is_primary=1 WHERE id=?', [pid]);
  await dbRun('UPDATE users SET photo=? WHERE id=?', [p.url, req.user.id]);
  res.json({ ok: true, primary: p.url, photos: await getUserPhotos(req.user.id) });
});
app.delete('/api/profile/photos/:photoId', auth, async (req, res) => {
  const pid = Number(req.params.photoId);
  if (!pid) return res.status(400).json({ message: 'Ungültige photoId' });
  const p = await dbGet('SELECT id,url,is_primary FROM user_photos WHERE id=? AND user_id=?', [pid, req.user.id]);
  if (!p) return res.status(404).json({ message: 'Bild nicht gefunden' });
  await dbRun('DELETE FROM user_photos WHERE id=? AND user_id=?', [pid, req.user.id]);
  // wenn primary gelöscht: nächstes Bild zum primary machen + users.photo setzen
  if (Number(p.is_primary || 0) === 1) {
    const next = await dbGet('SELECT id,url FROM user_photos WHERE user_id=? ORDER BY sort_order ASC, created_at DESC LIMIT 1', [req.user.id]);
    await dbRun('UPDATE user_photos SET is_primary=0 WHERE user_id=?', [req.user.id]);
    if (next) {
      await dbRun('UPDATE user_photos SET is_primary=1 WHERE id=?', [next.id]);
      await dbRun('UPDATE users SET photo=? WHERE id=?', [next.url, req.user.id]);
    } else {
      await dbRun('UPDATE users SET photo=? WHERE id=?', ['', req.user.id]);
    }
  }
  res.json({ ok: true, photos: await getUserPhotos(req.user.id) });
});

app.get('/api/discover', auth, async (req, res) => {
  const profiles = await dbAll(`
    SELECT id,name,age,city,bio,photo,interests,is_managed FROM users
    WHERE id!=? AND is_bot=0
    AND id NOT IN (SELECT target_id FROM swipes WHERE swiper_id=?)
    ORDER BY RANDOM() LIMIT 20`, [req.user.id, req.user.id]);
  res.json(profiles.map(p => ({ ...p, interests: JSON.parse(p.interests||'[]'), is_managed: Number(p.is_managed||0) })));
});

app.post('/api/swipe', auth, async (req, res) => {
  const { targetId, action } = req.body;
  const today = new Date().toISOString().slice(0, 10);
  const u = await dbGet('SELECT id, is_premium, swipes_used_today, swipes_date FROM users WHERE id=?', [req.user.id]);
  const isPremium = Number(u?.is_premium || 0) === 1;
  const swipesDate = u?.swipes_date || '';
  const used = Number(u?.swipes_used_today || 0);

  if (!isPremium) {
    if (swipesDate !== today) {
      await dbRun('UPDATE users SET swipes_used_today=0, swipes_date=? WHERE id=?', [today, req.user.id]);
    } else if (used >= FREE_DAILY_SWIPES) {
      return res.status(402).json({ message: 'Tageslimit erreicht. Mit Premium kannst du unbegrenzt swipen & liken.' });
    }
    await dbRun('UPDATE users SET swipes_used_today = swipes_used_today + 1, swipes_date=? WHERE id=?', [today, req.user.id]);
  } else if (swipesDate !== today) {
    // nur zur Hygiene zurücksetzen
    await dbRun('UPDATE users SET swipes_used_today=0, swipes_date=? WHERE id=?', [today, req.user.id]);
  }

  await dbRun('INSERT OR REPLACE INTO swipes (swiper_id,target_id,action) VALUES (?,?,?)',
    [req.user.id, targetId, action]);
  // Kein Match über Swipe: Matches nur per Admin „Matchen“ (POST /api/admin/as/:actorId/match)
  res.json({ isMatch: false });
});

app.get('/api/matches', auth, async (req, res) => {
  const id = Number(req.user.id);
  if (!Number.isFinite(id)) return res.status(401).json({ message: 'Ungültige Session' });
  const matches = await dbAll(
    `
    SELECT m.id as match_id,
      CASE WHEN m.user1_id=? THEN u2.id ELSE u1.id END as user_id,
      CASE WHEN m.user1_id=? THEN u2.name ELSE u1.name END as name,
      CASE WHEN m.user1_id=? THEN u2.age ELSE u1.age END as age,
      CASE WHEN m.user1_id=? THEN u2.city ELSE u1.city END as city,
      CASE WHEN m.user1_id=? THEN u2.photo ELSE u1.photo END as photo,
      CASE WHEN m.user1_id=? THEN u2.is_managed ELSE u1.is_managed END as is_managed,
      CASE WHEN m.user1_id=? THEN u2.is_bot ELSE u1.is_bot END as is_bot,
      m.created_at
    FROM matches m
    JOIN users u1 ON m.user1_id=u1.id
    JOIN users u2 ON m.user2_id=u2.id
    WHERE (m.user1_id=? OR m.user2_id=?)
      AND (CASE WHEN m.user1_id=? THEN u2.is_bot ELSE u1.is_bot END) = 0
    ORDER BY m.created_at DESC`,
    [...Array(7).fill(id), id, id, id]
  );
  res.json(await matchRowsWithUnreadForViewer(id, matches));
});

async function deleteMatchForUser(req, res) {
  const matchId = Number(req.params.matchId);
  if (!matchId) return res.status(400).json({ message: 'Ungültiges Match' });
  try {
    const m = await dbGet('SELECT * FROM matches WHERE id=?', [matchId]);
    if (!m) return res.status(404).json({ message: 'Match nicht gefunden' });
    if (m.user1_id !== req.user.id && m.user2_id !== req.user.id)
      return res.status(403).json({ message: 'Kein Zugriff' });
    await dbRun('DELETE FROM messages WHERE match_id=?', [matchId]);
    await dbRun('DELETE FROM chat_read WHERE match_id=?', [matchId]);
    await dbRun('DELETE FROM matches WHERE id=?', [matchId]);
    const otherId = m.user1_id === req.user.id ? m.user2_id : m.user1_id;
    io.to(`user_${otherId}`).emit('match_removed', { matchId });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Serverfehler' });
  }
}

app.delete('/api/matches/:matchId', auth, deleteMatchForUser);
// Fallback falls Proxy/Browser DELETE blockiert
app.post('/api/matches/:matchId/delete', auth, deleteMatchForUser);

async function countUnreadMessagesForUser(userId) {
  const uid = Number(userId);
  const rows = await dbAll('SELECT id FROM matches WHERE user1_id=? OR user2_id=?', [uid, uid]);
  let total = 0;
  for (const { id: mid } of rows) {
    const cr = await dbGet(
      'SELECT last_read_message_id FROM chat_read WHERE CAST(user_id AS INTEGER)=? AND CAST(match_id AS INTEGER)=?',
      [uid, mid]
    );
    const after = Number(cr?.last_read_message_id || 0);
    const c = await dbGet(
      `SELECT COUNT(*) AS c FROM messages
       WHERE CAST(match_id AS INTEGER)=?
         AND CAST(COALESCE(sender_id, -1) AS INTEGER) != CAST(? AS INTEGER)
         AND CAST(id AS INTEGER) > ?`,
      [mid, uid, after]
    );
    total += Number(c?.c ?? c?.C ?? 0);
  }
  return total;
}

app.get('/api/messages/unread-count', auth, async (req, res) => {
  try {
    const count = await countUnreadMessagesForUser(req.user.id);
    res.json({ count });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Serverfehler' });
  }
});

app.post('/api/messages/:matchId/read', auth, async (req, res) => {
  const matchId = Number(req.params.matchId);
  if (!matchId) return res.status(400).json({ message: 'Ungültiges Match' });
  try {
    const m = await dbGet('SELECT * FROM matches WHERE id=?', [matchId]);
    if (!m) return res.status(404).json({ message: 'Match nicht gefunden' });
    if (m.user1_id !== req.user.id && m.user2_id !== req.user.id)
      return res.status(403).json({ message: 'Kein Zugriff' });
    const maxRow = await dbGet('SELECT COALESCE(MAX(id), 0) AS mid FROM messages WHERE match_id=?', [matchId]);
    const mid = Number(maxRow?.mid || 0);
    const uid = Number(req.user.id);
    await dbRun(
      `INSERT INTO chat_read (user_id, match_id, last_read_message_id) VALUES (?,?,?)
       ON CONFLICT(user_id, match_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id`,
      [uid, matchId, mid]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Serverfehler' });
  }
});

app.get('/api/messages/:matchId', auth, async (req, res) => {
  res.json(await dbAll('SELECT * FROM messages WHERE match_id=? ORDER BY created_at ASC', [req.params.matchId]));
});

app.post('/api/messages', auth, async (req, res) => {
  const { matchId, text } = req.body;
  if (!String(text || '').trim()) return res.status(400).json({ message: 'Keine Nachricht' });
  try {
    const m = await dbGet('SELECT * FROM matches WHERE id=?', [matchId]);
    if (!m) return res.status(404).json({ message: 'Match nicht gefunden' });
    if (m.user1_id !== req.user.id && m.user2_id !== req.user.id)
      return res.status(403).json({ message: 'Kein Zugriff auf diesen Chat' });

    const user = await dbGet(
      'SELECT id, coins FROM users WHERE id=?',
      [req.user.id]
    );
    const currentCoins = Number(user?.coins || 0);
    if (currentCoins < MESSAGE_COST_COINS) {
      return res.status(402).json({
        message: `Nicht genug Herzfunken. Du brauchst ${MESSAGE_COST_COINS} pro Nachricht.`,
        needed: MESSAGE_COST_COINS,
        coins: currentCoins
      });
    }
    const upd = await dbRun(
      'UPDATE users SET coins = coins - ? WHERE id=? AND coins >= ?',
      [MESSAGE_COST_COINS, req.user.id, MESSAGE_COST_COINS]
    );
    if (!upd.changes) {
      const refreshed = await dbGet('SELECT coins FROM users WHERE id=?', [req.user.id]);
      return res.status(402).json({
        message: `Nicht genug Herzfunken. Du brauchst ${MESSAGE_COST_COINS} pro Nachricht.`,
        needed: MESSAGE_COST_COINS,
        coins: Number(refreshed?.coins || 0)
      });
    }

    const msg = await saveMessageToDB({ matchId, senderId: req.user.id, text: String(text || '').trim() });
    io.to(`match_${matchId}`).emit('message', msg);
    // Zusätzlich direkt an beide User-Räume (für Inbox/Popups ohne join_match)
    const otherId = (m.user1_id === req.user.id) ? m.user2_id : m.user1_id;
    io.to(`user_${req.user.id}`).emit('message', { matchId, message: msg });
    io.to(`user_${otherId}`).emit('message', { matchId, message: msg });

    if (await matchShouldNotifyAdmins(matchId)) {
      io.to('admins').emit('managed_message', { matchId, message: msg, fromUserId: req.user.id, toUserId: otherId });
    }

    const wallet = await dbGet('SELECT coins, is_premium, premium_tier FROM users WHERE id=?', [req.user.id]);
    res.status(201).json({
      message: msg,
      wallet: {
        coins: Number(wallet?.coins || 0),
        isPremium: Number(wallet?.is_premium || 0) === 1,
        premiumTier: wallet?.premium_tier || null
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Serverfehler' });
  }
});

// Bild im Chat senden (Upload) – kostet ebenfalls MESSAGE_COST_COINS
app.post('/api/messages/image', auth, upload.single('image'), async (req, res) => {
  try {
    const matchId = Number(req.body?.matchId);
    if (!matchId) return res.status(400).json({ message: 'matchId erforderlich' });
    if (!req.file) return res.status(400).json({ message: 'Kein Bild' });

    const m = await dbGet('SELECT * FROM matches WHERE id=?', [matchId]);
    if (!m) return res.status(404).json({ message: 'Match nicht gefunden' });
    if (m.user1_id !== req.user.id && m.user2_id !== req.user.id)
      return res.status(403).json({ message: 'Kein Zugriff auf diesen Chat' });

    const user = await dbGet('SELECT id, coins FROM users WHERE id=?', [req.user.id]);
    const currentCoins = Number(user?.coins || 0);
    if (currentCoins < MESSAGE_COST_COINS) {
      return res.status(402).json({
        message: `Nicht genug Herzfunken. Du brauchst ${MESSAGE_COST_COINS} pro Nachricht.`,
        needed: MESSAGE_COST_COINS,
        coins: currentCoins
      });
    }
    const upd = await dbRun(
      'UPDATE users SET coins = coins - ? WHERE id=? AND coins >= ?',
      [MESSAGE_COST_COINS, req.user.id, MESSAGE_COST_COINS]
    );
    if (!upd.changes) {
      const refreshed = await dbGet('SELECT coins FROM users WHERE id=?', [req.user.id]);
      return res.status(402).json({
        message: `Nicht genug Herzfunken. Du brauchst ${MESSAGE_COST_COINS} pro Nachricht.`,
        needed: MESSAGE_COST_COINS,
        coins: Number(refreshed?.coins || 0)
      });
    }

    const url = `/uploads/${req.file.filename}`;
    const msg = await saveMessageToDB({ matchId, senderId: req.user.id, text: '', imageUrl: url });
    io.to(`match_${matchId}`).emit('message', msg);
    const otherId = (m.user1_id === req.user.id) ? m.user2_id : m.user1_id;
    io.to(`user_${req.user.id}`).emit('message', { matchId, message: msg });
    io.to(`user_${otherId}`).emit('message', { matchId, message: msg });

    if (await matchShouldNotifyAdmins(matchId)) {
      io.to('admins').emit('managed_message', { matchId, message: msg, fromUserId: req.user.id, toUserId: otherId });
    }

    const wallet = await dbGet('SELECT coins, is_premium, premium_tier FROM users WHERE id=?', [req.user.id]);
    res.status(201).json({
      message: msg,
      wallet: {
        coins: Number(wallet?.coins || 0),
        isPremium: Number(wallet?.is_premium || 0) === 1,
        premiumTier: wallet?.premium_tier || null
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Serverfehler' });
  }
});

// Bot-Profil anpassen
app.get('/api/bot/status', auth, async (req, res) => {
  const bot = BOT_USER_ID ? safeUser(await dbGet('SELECT * FROM users WHERE id=?', [BOT_USER_ID])) : null;
  res.json({ botId: BOT_USER_ID, profile: bot, onlineUsers: onlineUsers.size });
});

app.put('/api/bot/profile', auth, async (req, res) => {
  if (!BOT_USER_ID) return res.status(404).json({ message: 'Bot nicht gefunden' });
  const { name, age, city, bio } = req.body;
  await dbRun('UPDATE users SET name=?,age=?,city=?,bio=? WHERE id=?', [name,age,city,bio,BOT_USER_ID]);
  res.json({ message: 'Bot-Profil aktualisiert ✓' });
});

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  const userId = socketNumericUserId(socket);
  const uidOk = userId > 0;
  if (uidOk) {
    socket.join(`user_${userId}`);
    onlineUsers.add(userId);
    db.run('UPDATE users SET is_online=1 WHERE id=?', [userId]);
    console.log(`🟢 User ${userId} online`);
  }
  /** Sofort (ohne DB): gleiche Regeln wie requireAdmin per JWT/ENV — vermeidet Race vor DB-Lookup. */
  if (uidOk) {
    if (ADMIN_USER_ID && userId === Number(ADMIN_USER_ID)) socket.join('admins');
    else {
      const jwtEmail = String(socket.user?.email || '').trim().toLowerCase();
      if (ADMIN_EMAIL && jwtEmail && jwtEmail === ADMIN_EMAIL) socket.join('admins');
    }
  }
  (async () => {
    try {
      if (socket.user && (await userHasAdminAccessPayload(socket.user))) socket.join('admins');
    } catch {}
  })();

  /** Expliziter Join nach Connect / Tab-Fokus — gleiche Prüfung wie HTTP-Admin. */
  socket.on('join_admins_if_allowed', (cb) => {
    (async () => {
      try {
        const ok = !!(socket.user && (await userHasAdminAccessPayload(socket.user)));
        if (ok) socket.join('admins');
        if (typeof cb === 'function') cb({ ok });
      } catch {
        if (typeof cb === 'function') cb({ ok: false });
      }
    })();
  });

  socket.on('join_match', matchId => socket.join(`match_${matchId}`));
  socket.on('typing', ({ matchId }) => socket.to(`match_${matchId}`).emit('typing', { userId }));
  socket.on('disconnect', () => {
    if (uidOk) {
      onlineUsers.delete(userId);
      db.run('UPDATE users SET is_online=0 WHERE id=?', [userId]);
      console.log(`🔴 User ${userId} offline`);
    }
  });
});

// ===== START =====
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`
❌ Port ${PORT} ist bereits belegt (alter Server noch aktiv?).
   PowerShell: netstat -ano | findstr :${PORT}
   Dann:       taskkill /PID <PID aus letzter Spalte> /F
`);
  } else {
    console.error('Server-Fehler:', err);
  }
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════╗
║   💕 Herzfunke Server läuft!         ║
║   Port ${PORT} (0.0.0.0)                ║
║   Daten: ${DB_PATH}
║   🤖 Bot-Integration: AKTIV          ║
╚══════════════════════════════════════╝`);
  console.log(`   Admin Team-Profil: GET+POST /api/admin/team-profile (GET = Ping ohne Token)`);
});
