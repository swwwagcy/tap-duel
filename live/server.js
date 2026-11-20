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
const STAFF_KEY = process.env.STAFF_KEY || crypto.randomBytes(4).toString('hex');
if (!process.env.STAFF_KEY) console.log('STAFF_KEY is not set; this run uses the generated key: ' + STAFF_KEY);

const engine = Engine.createEngine({
  staffKeyMatches: function (given) {
    const a = Buffer.from(String(given || '')), b = Buffer.from(STAFF_KEY);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },
  newId: function () { return crypto.randomUUID(); },
  bots: Number(process.env.DEMO_VIEWERS) || 0
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const server = http.createServer(function (request, response) {
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

wss.on('connection', function (socket) {
  const connection = { deliver: function (message) { if (socket.readyState === 1) socket.send(JSON.stringify(message)); } };
  engine.connect(connection);
  socket.isAlive = true;
  socket.on('pong', function () { socket.isAlive = true; });
  socket.on('close', function () { engine.disconnect(connection); });
  // One bad message must not take the server, and every table's state with it, down.
  socket.on('message', function (raw) {
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
