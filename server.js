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

let BOT_USER_ID = null;
const onlineUsers = new Set();

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));
app.use(express.static('.'));

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

// ===== BOT FUNKTIONEN =====
async function saveMessageToDB({ matchId, senderId, text, isBot = false }) {
  const r = await dbRun('INSERT INTO messages (match_id, sender_id, text, is_bot) VALUES (?,?,?,?)',
    [matchId, senderId, text, isBot ? 1 : 0]);
  return await dbGet('SELECT * FROM messages WHERE id = ?', [r.lastID]);
}

async function triggerBotIfNeeded({ matchId, senderId, messageText }) {
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
    SELECT id,name,age,city,bio,photo,interests FROM users
    WHERE id!=? AND is_bot=0
    AND id NOT IN (SELECT target_id FROM swipes WHERE swiper_id=?)
    ORDER BY RANDOM() LIMIT 20`, [req.user.id, req.user.id]);
  res.json(profiles.map(p => ({ ...p, interests: JSON.parse(p.interests||'[]') })));
});

app.post('/api/swipe', auth, async (req, res) => {
  const { targetId, action } = req.body;
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
      CASE WHEN m.user1_id=? THEN u2.is_bot ELSE u1.is_bot END as is_bot,
      m.created_at
    FROM matches m
    JOIN users u1 ON m.user1_id=u1.id
    JOIN users u2 ON m.user2_id=u2.id
    WHERE m.user1_id=? OR m.user2_id=?
    ORDER BY m.created_at DESC`, Array(8).fill(id));
  res.json(matches);
});

app.get('/api/messages/:matchId', auth, async (req, res) => {
  res.json(await dbAll('SELECT * FROM messages WHERE match_id=? ORDER BY created_at ASC', [req.params.matchId]));
});

app.post('/api/messages', auth, async (req, res) => {
  const { matchId, text } = req.body;
  if (!text?.trim()) return res.status(400).json({ message: 'Keine Nachricht' });
  const msg = await saveMessageToDB({ matchId, senderId: req.user.id, text: text.trim() });
  io.to(`match_${matchId}`).emit('message', msg);
  res.status(201).json(msg);
  // Bot asynchron auslösen
  triggerBotIfNeeded({ matchId, senderId: req.user.id, messageText: text.trim() });
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
  const userId = Number(socket.handshake.auth.userId);
  if (userId) {
    socket.join(`user_${userId}`);
    onlineUsers.add(userId);
    db.run('UPDATE users SET is_online=1 WHERE id=?', [userId]);
    console.log(`🟢 User ${userId} online`);
  }
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
