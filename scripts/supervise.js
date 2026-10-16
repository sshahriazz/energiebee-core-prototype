// Keeps the server running unattended (npm run serve).
//
// - Starts src/server.js with the .env file.
// - Restarts it when it exits for any reason other than being asked to stop, waiting
//   1 s, 2 s, 4 s … up to 60 s between restarts; the wait resets once it has run for 5 minutes.
// - Every minute asks GET /api/status. Three failures in a row (the process is up but not
//   answering, e.g. stuck) and it is stopped and restarted.
// - Writes the server's output, with timestamps, to data/logs/server.log (and to this
//   terminal). The log is rotated at 10 MB, keeping three old files.
// - Ctrl+C or SIGTERM stops the server and then the supervisor.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDir = path.join(root, 'data', 'logs');
const logFile = path.join(logDir, 'server.log');
const port = Number(process.env.PORT) || readEnvPort() || 4100;
const HEALTH_EVERY_MS = 60_000;
const HEALTH_FAILS = 3;
const STABLE_MS = 5 * 60_000;
const MAX_LOG = 10 * 1024 * 1024;

fs.mkdirSync(logDir, { recursive: true });

function readEnvPort() {
  try { return Number(/^PORT=(\d+)/m.exec(fs.readFileSync(path.join(root, '.env'), 'utf8'))?.[1]) || null; } catch { return null; }
}

function rotate() {
  try {
    if (fs.statSync(logFile).size < MAX_LOG) return;
    for (let i = 2; i >= 1; i--) if (fs.existsSync(`${logFile}.${i}`)) fs.renameSync(`${logFile}.${i}`, `${logFile}.${i + 1}`);
    fs.renameSync(logFile, `${logFile}.1`);
  } catch { /* no log yet */ }
}

function log(line, from = 'supervisor') {
  const text = `${new Date().toISOString()} [${from}] ${line}\n`;
  process.stdout.write(text);
  rotate();
  fs.appendFileSync(logFile, text);
}

let child = null;
let stopping = false;
let backoff = 1000;
let startedAt = 0;
let healthFails = 0;

function start() {
  startedAt = Date.now();
  healthFails = 0;
  child = spawn(process.execPath, ['--env-file=.env', '--disable-warning=ExperimentalWarning', 'src/server.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  log(`server started (pid ${child.pid})`);
  for (const [stream, name] of [[child.stdout, 'server'], [child.stderr, 'server!']]) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) if (l.trim()) log(l, name);
    });
  }
  child.on('exit', (code, signal) => {
    const ranMs = Date.now() - startedAt;
    child = null;
    if (stopping) { log('server stopped'); process.exit(0); }
    if (ranMs >= STABLE_MS) backoff = 1000;
    log(`server exited (${signal ? `signal ${signal}` : `code ${code}`}) after ${Math.round(ranMs / 1000)} s; restarting in ${backoff / 1000} s`);
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  });
}

async function checkHealth() {
  if (!child || Date.now() - startedAt < HEALTH_EVERY_MS) return;   // give a fresh start time to come up
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    healthFails = 0;
  } catch (err) {
    healthFails++;
    log(`health check failed (${healthFails}/${HEALTH_FAILS}): ${err.message}`);
    if (healthFails >= HEALTH_FAILS && child) {
      log('server not answering; restarting it');
      child.kill('SIGKILL');
    }
  }
}

function stop(sig) {
  if (stopping) return;
  stopping = true;
  log(`${sig} received; stopping server`);
  if (!child) process.exit(0);
  child.kill('SIGTERM');
  setTimeout(() => { if (child) child.kill('SIGKILL'); }, 10_000).unref();
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
setInterval(checkHealth, HEALTH_EVERY_MS);
start();
