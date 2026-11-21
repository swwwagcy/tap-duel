// Tap Duel Live server: serves the pages and carries WebSocket messages to the game engine
// (public/engine.js), which holds every table, every viewer's points and the round state.
// State lives in memory, so run it as a single instance (see README).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Engine = require('./public/engine.js');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STAFF_KEY = process.env.STAFF_KEY || crypto.randomBytes(8).toString('hex');
if (!process.env.STAFF_KEY) console.log('STAFF_KEY is not set; this run uses the generated key: ' + STAFF_KEY);
else if (STAFF_KEY.length < 12) console.log('STAFF_KEY is shorter than 12 characters; a longer one is harder to guess.');
// Optional second key for the card reader only. A reader signed in with it cannot act as host.
// The host key still opens the reader, so one key for both keeps working.
const READER_KEY = process.env.READER_KEY || '';
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 1200;
const MESSAGES_PER_SECOND = 60;      // per connection; the reader sends about 10

function same(given, key) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(key);
  return !!key && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Wrong keys are counted per address. After FAILURES_ALLOWED within the window, that address is
// refused outright (even with the right key) until the lock runs out, so a key cannot be guessed
// by trying many.
const FAILURES_ALLOWED = Number(process.env.FAILURES_ALLOWED) || 5, FAILURE_WINDOW_MS = 10 * 60 * 1000, LOCK_MS = 10 * 60 * 1000;
const failures = new Map();          // address -> { times: [ms], lockedUntil }
function keyVerdict(given, role, connection) {
  const address = connection && connection.address || 'unknown', now = Date.now();
  let entry = failures.get(address);
  if (entry && entry.lockedUntil > now) return 'locked';
  if (same(given, STAFF_KEY) || (role === 'reader' && same(given, READER_KEY))) { failures.delete(address); return true; }
  if (!entry) { entry = { times: [], lockedUntil: 0 }; failures.set(address, entry); }
  entry.times = entry.times.filter(function (time) { return now - time < FAILURE_WINDOW_MS; });
  entry.times.push(now);
  if (entry.times.length >= FAILURES_ALLOWED) { entry.lockedUntil = now + LOCK_MS; entry.times = []; return 'locked'; }
  return false;
}
setInterval(function () {
  const now = Date.now();
  failures.forEach(function (entry, address) { if (entry.lockedUntil < now && !entry.times.some(function (time) { return now - time < FAILURE_WINDOW_MS; })) failures.delete(address); });
}, 60000).unref();

const engine = Engine.createEngine({
  staffKeyMatches: keyVerdict,
  // One line per sign-in attempt and per action that changes a round, for the service's log.
  audit: function (entry) { console.log('audit ' + JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry))); },
  newId: function () { return crypto.randomUUID(); },
  bots: Number(process.env.DEMO_VIEWERS) || 0
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// Sent with every page and file. Pages may only load their own files and talk to this server;
// other sites cannot put these pages in a frame.
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
};

// The caller's address. Behind Cloud Run the last entry of X-Forwarded-For is the one Google
// adds; earlier entries come from the caller and cannot be trusted.
function addressOf(request) {
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').map(function (part) { return part.trim(); }).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : (request.socket.remoteAddress || 'unknown');
}

const server = http.createServer(function (request, response) {
  Object.keys(HEADERS).forEach(function (name) { response.setHeader(name, HEADERS[name]); });
  const url = new URL(request.url, 'http://localhost');
  // Not /healthz: Cloud Run reserves paths ending in z and answers them itself with a Google 404.
  if (url.pathname === '/health') { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('ok'); return; }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (full.indexOf(PUBLIC_DIR) !== 0) { response.writeHead(403); response.end(); return; }
  fs.readFile(full, function (error, data) {
    if (error) { response.writeHead(404, { 'Content-Type': 'text/plain' }); response.end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(data);
  });
});

const wss = new WebSocketServer({ server: server, path: '/ws', maxPayload: 600 * 1024 });

wss.on('connection', function (socket, request) {
  if (wss.clients.size > MAX_CONNECTIONS) { socket.close(1013, 'full'); return; }
  const connection = { address: addressOf(request), deliver: function (message) { if (socket.readyState === 1) socket.send(JSON.stringify(message)); } };
  let second = 0, count = 0;
  engine.connect(connection);
  socket.isAlive = true;
  socket.on('pong', function () { socket.isAlive = true; });
  socket.on('close', function () { engine.disconnect(connection); });
  // One bad message must not take the server, and every table's state with it, down.
  socket.on('message', function (raw) {
    // Far more messages than any page sends: drop the connection.
    const now = Math.floor(Date.now() / 1000);
    if (now !== second) { second = now; count = 0; }
    if (++count > MESSAGES_PER_SECOND) { socket.terminate(); return; }
    try { engine.receive(connection, raw.toString()); }
    catch (error) { console.error('Message dropped: ' + (error && error.stack || error)); }
  });
});

// Keep idle connections alive through Cloud Run and proxies, and drop dead ones.
setInterval(function () {
  wss.clients.forEach(function (socket) {
    if (!socket.isAlive) { socket.terminate(); return; }
    socket.isAlive = false;
    try { socket.ping(); } catch (error) { /* closing */ }
  });
}, 25000);

server.listen(PORT, function () { console.log('Tap Duel Live listening on ' + PORT); });

module.exports = { server: server, engine: engine };
