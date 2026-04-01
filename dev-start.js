const { spawn, execSync } = require('child_process');
const path = require('path');

try {
  require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
} catch {}

const PORT = String(process.env.PORT || '3000');
const BASE = `http://localhost:${PORT}`;

/** Windows: Prozess beenden, der auf diesem Port lauscht (verhindert EADDRINUSE). Mit HF_KILL_PORT=0 abschalten. */
function freePortIfNeeded() {
  if (process.env.HF_KILL_PORT === '0') return;
  if (process.platform !== 'win32') return;
  try {
    const out = execSync(`netstat -ano | findstr ":${PORT}"`, { encoding: 'utf8' });
    const pids = new Set();
    const listenAddr = new RegExp(`0\\.0\\.0\\.0:${PORT}|\\[::\\]:${PORT}`);
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (!listenAddr.test(line)) continue;
      const m = line.match(/\s(\d+)\s*$/);
      if (m) pids.add(m[1]);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
        console.log(`🔧 Port ${PORT}: alter Prozess ${pid} beendet.`);
      } catch {}
    }
  } catch {
    /* Port frei */
  }
}

function openUrl(url) {
  // Windows: use cmd start
  spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
}

freePortIfNeeded();

// start server
// Kein PORT erzwingen – server.js lädt dieselbe .env (STRIPE_SECRET_KEY, PORT, …)
const server = spawn(process.execPath, ['server.js'], {
  stdio: 'inherit',
  env: { ...process.env },
});

// open both pages after a short delay
setTimeout(() => {
  openUrl(`${BASE}/`);
  openUrl(`${BASE}/admin`);
}, 1200);

server.on('exit', (code) => process.exit(code ?? 0));

