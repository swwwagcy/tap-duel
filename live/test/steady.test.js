// A card that has been read must stay read while the light changes and things pass over it, and
// must still give way when the card itself is taken away or swapped. The real reader page looks
// at a synthetic table through a "lens" this test controls: overall brightness, a shadow moving
// across, and a hand covering part of the card.
'use strict';
const path = require('path');
const http = require('http');
const fs = require('fs');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15000) {
  const started = Date.now();
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() - started > timeout) throw new Error('Timed out waiting for: ' + label); await wait(100); }
}
const server = http.createServer((request, response) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(request.url, 'http://x').pathname));
  if (!file.startsWith(ROOT)) { response.writeHead(403); response.end(); return; }
  fs.readFile(file, (error, data) => { if (error) { response.writeHead(404); response.end(); return; } response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); response.end(data); });
});

(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  const BASE = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE + '/reader.html?demo&table=duel');
  await until(() => page.evaluate(() => document.querySelectorAll('#tableTabs button').length === 2), 'reader tabs');

  // The table (a DemoCamera scene) seen through a lens: brightness, a moving shadow, a hand.
  await page.evaluate(() => {
    const table = DemoCamera.source(1920, 1080, { still: true });
    const view = document.createElement('canvas'); view.width = 1920; view.height = 1080;
    const context = view.getContext('2d');
    const lens = { gain: 1, shadow: null, hand: null };
    setInterval(() => {
      context.filter = 'brightness(' + lens.gain + ')';
      context.drawImage(table.canvas, 0, 0);
      context.filter = 'none';
      if (lens.shadow) { context.fillStyle = 'rgba(0,0,0,' + lens.shadow.alpha + ')'; context.fillRect(lens.shadow.x, 0, lens.shadow.w, 1080); }
      if (lens.hand) { context.fillStyle = '#c99a7a'; context.beginPath(); context.ellipse(lens.hand.x, lens.hand.y, lens.hand.rx, lens.hand.ry, 0.3, 0, Math.PI * 2); context.fill(); }
    }, 40);
    window.__table = table; window.__lens = lens; window.__readerSource = view;
    // Every state the red position goes through, so a brief wrong state is not missed.
    window.__seen = [];
    setInterval(() => {
      const zone = window.__readerState.zoneState.R; if (!zone) return;
      const now = zone.status + (zone.status === 'card' && zone.result ? ':' + zone.result.card : '');
      if (window.__seen[window.__seen.length - 1] !== now) window.__seen.push(now);
    }, 30);
  });
  await page.click('#startCamera');
  await until(() => page.evaluate(() => !!window.__readerState.frame), 'frames flowing');

  const red = { x: (0.14 + 0.15) * 1920, y: 0.5 * 1080 };
  const place = cards => page.evaluate(([cards, red]) => window.__table.place(cards.map(card => Object.assign({ h: 420, x: red.x + 8, y: red.y - 6, angle: 0.04 }, card))), [cards, red]);
  const status = () => page.evaluate(() => { const zone = window.__readerState.zoneState.R; return zone.status + (zone.status === 'card' && zone.result ? ':' + zone.result.card : ''); });
  const lens = change => page.evaluate(change => Object.assign(window.__lens, change), change);
  const sweep = async (set, from, to, ms) => { const steps = Math.round(ms / 50); for (let step = 0; step <= steps; step++) { await lens(set(from + (to - from) * step / steps)); await wait(50); } };
  const resetSeen = () => page.evaluate(() => { window.__seen = [window.__seen[window.__seen.length - 1]]; });
  const seen = () => page.evaluate(() => window.__seen.slice());
  let failed = false;
  const check = async (name, disturb) => {
    await resetSeen();
    await disturb();
    await wait(2500);                                    // time to settle afterwards
    const states = await seen(), last = await status();
    const steady = states.every(state => state === 'card:S9') && last === 'card:S9';
    console.log((steady ? 'ok  ' : 'BAD ') + name + (steady ? '' : ': went through ' + states.join(' → ')));
    if (!steady) failed = true;
  };

  await place([{ card: 'S9' }]);
  await until(async () => (await status()) === 'card:S9', 'the nine of spades is read');
  await wait(600);

  await check('light fades to 60% and comes back', async () => { await sweep(g => ({ gain: g }), 1, 0.6, 1500); await sweep(g => ({ gain: g }), 0.6, 1, 1500); });
  await check('light rises to 125% and comes back', async () => { await sweep(g => ({ gain: g }), 1, 1.25, 1200); await sweep(g => ({ gain: g }), 1.25, 1, 1200); });
  await check('light steps down at once (the camera re-exposing)', async () => { await lens({ gain: 0.75 }); await wait(1500); await lens({ gain: 1 }); });
  await check('light flickers for three seconds', async () => { for (let turn = 0; turn < 20; turn++) { await lens({ gain: turn % 2 ? 1.1 : 0.88 }); await wait(150); } await lens({ gain: 1 }); });
  await check('a shadow sweeps across the card twice', async () => {
    for (let pass = 0; pass < 2; pass++) await sweep(x => ({ shadow: { x, w: 260, alpha: 0.4 } }), red.x - 600, red.x + 400, 1600);
    await lens({ shadow: null });
  });
  await check('a shadow rests on half the card for two seconds', async () => { await lens({ shadow: { x: red.x - 10, w: 400, alpha: 0.35 } }); await wait(2000); await lens({ shadow: null }); });
  await check('a hand passes over the card', async () => { await sweep(x => ({ hand: { x, y: red.y + 40, rx: 150, ry: 110 } }), red.x - 500, red.x + 500, 1400); await lens({ hand: null }); });
  await check('a hand rests on the lower half of the card, then leaves', async () => { await lens({ hand: { x: red.x + 20, y: red.y + 150, rx: 190, ry: 130 } }); await wait(2000); await lens({ hand: null }); });

  // The other half: a real change must still get through.
  const change = async (name, act, accept, timeout) => {
    await act();
    let last = '';
    try { await until(async () => { last = await status(); return accept(last); }, name, timeout); console.log('ok  ' + name + ' (now ' + last + ')'); }
    catch (error) { console.log('BAD ' + name + ': still ' + last); failed = true; }
  };
  await change('the card is swapped for another: the old reading does not stay', () => place([{ card: 'H3' }]), now => now === 'card:H3' || now === 'unsure', 12000);
  await place([{ card: 'S9' }]);
  await until(async () => (await status()) === 'card:S9', 'the nine of spades is read again');
  await change('under a hand, swapped for the same rank in another suit: the old reading does not stay', async () => {
    await lens({ hand: { x: red.x, y: red.y, rx: 230, ry: 270 } }); await wait(500); await place([{ card: 'C9' }]); await wait(400); await lens({ hand: null });
  }, now => now === 'card:C9' || now === 'unsure', 12000);
  await place([]);
  await until(async () => (await status()) === 'empty', 'cleared');
  await place([{ card: 'S9' }]);
  await until(async () => (await status()) === 'card:S9', 'the nine of spades is read once more');
  await change('the card is turned face down: the old reading does not stay', () => place([{ back: true }]), now => now === 'back' || now === 'unsure', 12000);
  await place([{ card: 'S9' }]);
  await until(async () => (await status()) === 'card:S9', 'the nine of spades is read a third time');
  await change('the card is taken away: the position empties', () => place([]), now => now === 'empty', 6000);
  await place([{ card: 'S9' }]);
  await until(async () => (await status()) === 'card:S9', 'the nine of spades is read a fourth time');
  await change('a hand covers the card and takes it away: the position empties', async () => {
    await lens({ hand: { x: red.x, y: red.y, rx: 220, ry: 260 } }); await wait(600); await place([]); await wait(500); await lens({ hand: null });
  }, now => now === 'empty', 8000);

  if (errors.length) { console.log('page errors: ' + errors.join(' | ')); failed = true; }
  await browser.close(); server.close();
  if (failed) { console.log('FAILED'); process.exit(1); }
  console.log('steady ok');
})().catch(error => { console.error(error); process.exit(1); });
