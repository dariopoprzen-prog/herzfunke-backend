// ===== HERZFUNKE BACKEND – MIT BOT INTEGRATION =====
// npm install express cors bcryptjs jsonwebtoken multer sqlite3 socket.io node-fetch

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
const { handleBotReply } = require('./bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'herzfunke-secret-aendern-in-produktion';
const PORT = process.env.PORT || 3000;
const MESSAGE_COST_COINS = Number(process.env.MESSAGE_COST_COINS || 10); // 10 Herzfunken = 1 Nachricht
const FREE_DAILY_SWIPES = Number(process.env.FREE_DAILY_SWIPES || 40); // Free-User Limit (Premium = unbegrenzt)
const ADMIN_USER_ID = Number(process.env.ADMIN_USER_ID || 0) || null;
const BOT_AUTOREPLY = String(process.env.BOT_AUTOREPLY || '').trim() === '1'; // default: AUS

let BOT_USER_ID = null;
const onlineUsers = new Set();

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

app.use(cors());
// Stripe Webhook braucht RAW Body (vor JSON Parser!)
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/uploads', express.static('uploads'));
app.use(express.static('.'));

// Payment-Return Pages (robust, unabhängig von express.static)
app.get(['/payment-success.html', '/payment-success.htm'], (req, res) => {
  res.sendFile(path.join(__dirname, 'payment-success.html'));
});
app.get(['/payment-cancel.html', '/payment-cancel.htm'], (req, res) => {
  res.sendFile(path.join(__dirname, 'payment-cancel.html'));
});

// Admin Page (robust, unabhängig von express.static)
app.get(['/admin', '/admin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ===== DATENBANK =====
const db = new sqlite3.Database('./herzfunke.db', err => {
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

async function requireAdmin(req, res, next) {
  try {
    if (ADMIN_USER_ID && Number(req.user?.id) === Number(ADMIN_USER_ID)) return next();
    const u = await dbGet('SELECT id, is_admin FROM users WHERE id=?', [req.user?.id]);
    if (Number(u?.is_admin || 0) === 1) return next();
    return res.status(403).json({ message: 'Admin erforderlich' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: 'Serverfehler' });
  }
}

function isAdminId(id) {
  return ADMIN_USER_ID && Number(id) === Number(ADMIN_USER_ID);
}

// ===== PAYMENTS =====
try {
  const paymentRoutes = require('./payment-routes');
  app.use('/api/payments', paymentRoutes(db, auth));
  console.log('💳 Payment-Routen: AKTIV');
} catch (err) {
  console.warn('⚠️  Payment-Routen nicht geladen:', err.message);
}

// ===== BOT FUNKTIONEN =====
async function saveMessageToDB({ matchId, senderId, text, isBot = false }) {
  const r = await dbRun('INSERT INTO messages (match_id, sender_id, text, is_bot) VALUES (?,?,?,?)',
    [matchId, senderId, text, isBot ? 1 : 0]);
  return await dbGet('SELECT * FROM messages WHERE id = ?', [r.lastID]);
}

async function triggerBotIfNeeded({ matchId, senderId, messageText }) {
  // Live: niemals automatisch schreiben, außer explizit aktiviert
  if (!BOT_AUTOREPLY) return;
  if (!BOT_USER_ID) return;
  const match = await dbGet('SELECT * FROM matches WHERE id = ?', [matchId]);
  if (!match) return;

  const otherId = match.user1_id === senderId ? match.user2_id : match.user1_id;

  // Nur antworten wenn der andere der Bot ist ODER offline ist
  const otherIsBot = otherId === BOT_USER_ID;
  const otherIsOffline = !onlineUsers.has(otherId);
  if (!otherIsBot && !otherIsOffline) return;

  const history = await dbAll(
    'SELECT * FROM messages WHERE match_id = ? ORDER BY created_at ASC LIMIT 20', [matchId]
  );
  const botProfile = await dbGet('SELECT * FROM users WHERE id = ?', [BOT_USER_ID]);
  const senderProfile = await dbGet('SELECT * FROM users WHERE id = ?', [senderId]);

  await handleBotReply({
    matchId, senderId, botUserId: BOT_USER_ID, messageText,
    history: history.map(m => ({ ...m, isBot: m.is_bot === 1 })),
    botProfile, senderProfile,
    saveMessage: saveMessageToDB,
    emitMessage: (room, msg) => io.to(room).emit('message', msg),
  });
}

// ===== UPLOAD =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
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
          'INSERT INTO users (name, age, city, email, password, bio, photo, interests, is_bot) VALUES (?,?,?,?,?,?,?,?,0)',
          [name, age, city, email, hash, bio, photo, JSON.stringify(interests)]
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
    const exists = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
    if (exists) return res.status(409).json({ message: 'E-Mail bereits registriert' });
    const hash = await bcrypt.hash(password, 12);
    const result = await dbRun('INSERT INTO users (name,age,email,password) VALUES (?,?,?,?)', [name,age,email,hash]);
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [result.lastID]);
    const token = jwt.sign({ id: user.id, email }, JWT_SECRET, { expiresIn: '30d' });
    // Auto-Match mit Bot
    if (BOT_USER_ID) {
      const u1 = Math.min(user.id, BOT_USER_ID), u2 = Math.max(user.id, BOT_USER_ID);
      await dbRun('INSERT OR IGNORE INTO matches (user1_id, user2_id) VALUES (?,?)', [u1, u2]);
      console.log(`🤖 ${user.name} wurde automatisch mit Bot gematched`);
    }
    res.status(201).json({ user: safeUser(user), token });
  } catch(err) { console.error(err); res.status(500).json({ message: 'Serverfehler' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await dbGet('SELECT * FROM users WHERE email=? AND is_bot=0', [email]);
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(401).json({ message: 'E-Mail oder Passwort falsch' });
    const token = jwt.sign({ id: user.id, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ user: safeUser(user), token });
  } catch { res.status(500).json({ message: 'Serverfehler' }); }
});

app.get('/api/profile', auth, async (req, res) => {
  res.json(safeUser(await dbGet('SELECT * FROM users WHERE id=?', [req.user.id])));
});

// ===== ADMIN =====
app.get('/api/admin/me', auth, requireAdmin, async (req, res) => {
  const u = await dbGet('SELECT id,name,email,is_admin,coins,is_premium,premium_tier FROM users WHERE id=?', [req.user.id]);
  res.json({ ok: true, user: u || null });
});

app.get('/api/admin/users', auth, requireAdmin, async (req, res) => {
  const rows = await dbAll(
    `SELECT id,name,age,city,email,photo,bio,interests,is_online,is_premium,premium_tier,is_managed,coins,created_at
     FROM users
     WHERE is_bot=0
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

app.post('/api/admin/users/:id/managed', auth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const managed = Number(req.body?.managed ? 1 : 0);
  if (!id) return res.status(400).json({ message: 'Ungültige ID' });
  await dbRun('UPDATE users SET is_managed=? WHERE id=? AND is_bot=0', [managed, id]);
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

app.post('/api/admin/message', auth, requireAdmin, async (req, res) => {
  const { userId, text } = req.body || {};
  const targetId = Number(userId);
  const msgText = String(text || '').trim();
  if (!targetId || !msgText) return res.status(400).json({ message: 'userId und text erforderlich' });

  const target = await dbGet('SELECT id FROM users WHERE id=? AND is_bot=0', [targetId]);
  if (!target) return res.status(404).json({ message: 'Nutzer nicht gefunden' });

  const u1 = Math.min(req.user.id, targetId);
  const u2 = Math.max(req.user.id, targetId);
  await dbRun('INSERT OR IGNORE INTO matches (user1_id, user2_id) VALUES (?,?)', [u1, u2]);

  const match = await dbGet('SELECT id FROM matches WHERE user1_id=? AND user2_id=?', [u1, u2]);
  if (!match) return res.status(500).json({ message: 'Match konnte nicht erstellt werden' });

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
  let isMatch = false;
  if (action === 'like' || action === 'super') {
    const theyLiked = await dbGet(
      "SELECT id FROM swipes WHERE swiper_id=? AND target_id=? AND action IN ('like','super')",
      [targetId, req.user.id]);
    if (theyLiked) {
      const u1=Math.min(req.user.id,targetId), u2=Math.max(req.user.id,targetId);
      await dbRun('INSERT OR IGNORE INTO matches (user1_id,user2_id) VALUES (?,?)', [u1,u2]);
      isMatch = true;
      io.to(`user_${targetId}`).emit('new_match', { userId: req.user.id });
    }
  }
  res.json({ isMatch });
});

app.get('/api/matches', auth, async (req, res) => {
  const id = req.user.id;
  const matches = await dbAll(`
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
    WHERE m.user1_id=? OR m.user2_id=?
    ORDER BY m.created_at DESC`, Array(9).fill(id));
  res.json(matches);
});

app.get('/api/messages/:matchId', auth, async (req, res) => {
  res.json(await dbAll('SELECT * FROM messages WHERE match_id=? ORDER BY created_at ASC', [req.params.matchId]));
});

app.post('/api/messages', auth, async (req, res) => {
  const { matchId, text } = req.body;
  if (!text?.trim()) return res.status(400).json({ message: 'Keine Nachricht' });
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

    const msg = await saveMessageToDB({ matchId, senderId: req.user.id, text: text.trim() });
    io.to(`match_${matchId}`).emit('message', msg);
    // Zusätzlich direkt an beide User-Räume (für Inbox/Popups ohne join_match)
    const otherId = (m.user1_id === req.user.id) ? m.user2_id : m.user1_id;
    io.to(`user_${req.user.id}`).emit('message', { matchId, message: msg });
    io.to(`user_${otherId}`).emit('message', { matchId, message: msg });

    // Wenn ein Profil betreut ist, Admin benachrichtigen (Popup/Inbox)
    const managed = await dbGet(
      'SELECT u1.is_managed AS m1, u2.is_managed AS m2 FROM matches mm JOIN users u1 ON mm.user1_id=u1.id JOIN users u2 ON mm.user2_id=u2.id WHERE mm.id=?',
      [matchId]
    );
    if (Number(managed?.m1 || 0) === 1 || Number(managed?.m2 || 0) === 1) {
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

    // Bot asynchron auslösen
    triggerBotIfNeeded({ matchId, senderId: req.user.id, messageText: text.trim() });
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
  const userId = Number(socket.user?.id || socket.handshake.auth.userId);
  if (userId) {
    socket.join(`user_${userId}`);
    onlineUsers.add(userId);
    db.run('UPDATE users SET is_online=1 WHERE id=?', [userId]);
    console.log(`🟢 User ${userId} online`);
  }
  // Admins joinen einen gemeinsamen Room für Popups/Inbox
  (async () => {
    try {
      if (!userId) return;
      if (isAdminId(userId)) { socket.join('admins'); return; }
      const u = await dbGet('SELECT is_admin FROM users WHERE id=?', [userId]);
      if (Number(u?.is_admin || 0) === 1) socket.join('admins');
    } catch {}
  })();
  socket.on('join_match', matchId => socket.join(`match_${matchId}`));
  socket.on('typing', ({ matchId }) => socket.to(`match_${matchId}`).emit('typing', { userId }));
  socket.on('disconnect', () => {
    if (userId) {
      onlineUsers.delete(userId);
      db.run('UPDATE users SET is_online=0 WHERE id=?', [userId]);
      console.log(`🔴 User ${userId} offline`);
    }
  });
});

// ===== START =====
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   💕 Herzfunke Server läuft!         ║
║   http://localhost:${PORT}              ║
║   🤖 Bot-Integration: AKTIV          ║
╚══════════════════════════════════════╝`);
});
