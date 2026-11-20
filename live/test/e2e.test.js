// End to end: starts the server, opens the viewer and host pages in a browser, and plays rounds.
// Rounds 1-3 feed cards through a scripted reader connection (exact cards, checks the money);
// round 4 uses the real reader page looking at a synthetic camera: with nothing registered, it
// must read the dealt cards by itself.
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');
const WebSocket = require('ws');
const { chromium } = require('playwright');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = 'http://127.0.0.1:' + PORT;
const KEY = 'test-key';
let server, browser;

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function until(fn, label, timeout = 15000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for: ' + label);
    await wait(100);
  }
}
function step(text) { console.log('ok  ' + text); }

function scriptedReader() {
  return new Promise(resolve => {
    const socket = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    socket.on('open', () => socket.send(JSON.stringify({ t: 'hello', role: 'reader', key: KEY })));
    socket.on('message', raw => { if (JSON.parse(raw).t === 'welcome') resolve(socket); });
  });
}
const card = (socket, table, zone, value) => socket.send(JSON.stringify({ t: 'zone', table, zone, state: 'card', card: value, score: 0.95, margin: 0.8, top: [{ card: value, score: 0.95 }] }));

(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), STAFF_KEY: KEY }), stdio: ['ignore', 'pipe', 'inherit'] });
  await until(async () => { try { return (await fetch(BASE + '/health')).ok; } catch (error) { return false; } }, 'server start');
  step('server started');

  // A fake webcam, so the reader's real camera path (getUserMedia) is exercised too.
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const host = await (await browser.newContext({ viewport: { width: 1180, height: 820 } })).newPage();
  const viewer = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errors = [];
  [host, viewer].forEach(page => page.on('pageerror', error => errors.push(error.message)));

  await host.goto(BASE + '/host.html#key=' + KEY);
  await viewer.goto(BASE + '/play.html');
  await until(() => viewer.evaluate(() => document.getElementById('points').textContent === '10,000'), 'viewer points');
  await until(() => host.evaluate(() => document.querySelectorAll('.zone').length === 2), 'host zones');
  step('host and viewer pages loaded (viewer starts with 10,000)');

  const points = () => viewer.evaluate(() => Number(document.getElementById('points').textContent.replace(/,/g, '')));
  const setFast = async () => {
    await host.click('#openDrawer');
    await host.fill('#setOpen', '5'); await host.dispatchEvent('#setOpen', 'change');
    await host.fill('#setWait', '0'); await host.dispatchEvent('#setWait', 'change');
    await host.click('#closeDrawer');
  };
  const reader = await scriptedReader();

  /* Round 1: duel, red wins. */
  await setFast();
  await host.click('#mainButton');
  await until(() => viewer.evaluate(() => !document.querySelector('.spot[data-spot="R"]').disabled), 'viewer can pick');
  await viewer.click('.chip[data-chip="100"]');
  await viewer.click('.spot[data-spot="R"]'); await viewer.click('.spot[data-spot="R"]'); await viewer.click('.spot[data-spot="T"]');
  await until(async () => (await points()) === 9700, 'points after picks');
  await until(() => host.evaluate(() => document.getElementById('phaseBox').dataset.phase === 'dealing'), 'dealing', 12000);
  assert.strictEqual(await host.evaluate(() => document.getElementById('mainButton').disabled), true, 'confirm must wait for both cards');
  card(reader, 'duel', 'R', 'SK');
  card(reader, 'duel', 'U', 'H9');
  await until(() => host.evaluate(() => !document.getElementById('mainButton').disabled), 'confirm enabled');
  await host.click('#mainButton');
  await until(async () => (await points()) === 10100, 'duel payout 9700 + 400');
  const banner = await viewer.textContent('#banner');
  assert.ok(banner.includes('紅方勝') && banner.includes('+100'), 'banner: ' + banner);
  step('duel round: red wins, 300 in, 400 back, viewer shows 10,100 and the result banner');

  /* Round 2: nine, blue draws a third card, tie. */
  await host.click('#tableTabs button[data-table="nine"]');
  await viewer.click('#tableTabs button[data-table="nine"]');
  await until(() => host.evaluate(() => document.querySelectorAll('.zone').length === 6), 'nine zones');
  await setFast();
  await host.click('#mainButton');
  await until(() => viewer.evaluate(() => !document.querySelector('.spot[data-spot="blue"]').disabled), 'viewer can pick on nine');
  await viewer.click('.spot[data-spot="blue"]'); await viewer.click('.spot[data-spot="tie"]');
  await until(async () => (await points()) === 9900, 'points after nine picks');
  await until(() => host.evaluate(() => document.getElementById('phaseBox').dataset.phase === 'dealing'), 'nine dealing', 12000);
  card(reader, 'nine', 'U1', 'S2'); card(reader, 'nine', 'R1', 'H3'); card(reader, 'nine', 'U2', 'D3'); card(reader, 'nine', 'R2', 'C3');
  await until(() => host.evaluate(() => document.getElementById('guide').textContent.includes('藍方 3')), 'guide asks for blue third card');
  card(reader, 'nine', 'R3', 'C9');   // not called for: must be refused
  await wait(300);
  assert.strictEqual(await host.evaluate(() => document.querySelector('.zone[data-zone="R3"] .cardface').classList.contains('empty')), true, 'red third card must be refused');
  card(reader, 'nine', 'U3', 'SA');   // blue 6, red 6 stands
  await until(() => host.evaluate(() => !document.getElementById('mainButton').disabled), 'nine confirm enabled');
  await host.click('#mainButton');
  await until(async () => (await points()) === 10900, 'nine payout: blue pushed 100 + tie 900');
  step('nine round: third-card prompt, extra card refused, tie pays 9x and blue is returned (10,900)');

  /* Round 3: host corrects a card by hand, then cancels the round: everything is returned. */
  await host.click('#mainButton');
  await until(() => viewer.evaluate(() => !document.querySelector('.spot[data-spot="red"]').disabled), 'round 3 open');
  await viewer.click('.chip[data-chip="500"]'); await viewer.click('.spot[data-spot="red"]');
  await until(async () => (await points()) === 10400, 'points after 500');
  await until(() => host.evaluate(() => document.getElementById('phaseBox').dataset.phase === 'dealing'), 'round 3 dealing', 12000);
  await host.click('.zone[data-zone="U1"]');
  await host.click('#pickerSuits button[data-suit="H"]'); await host.click('#pickerRanks button[data-rank="7"]');
  await until(() => host.evaluate(() => document.querySelector('.zone[data-zone="U1"] .tag').textContent === '手動'), 'manual card shown');
  card(reader, 'nine', 'U1', 'S4');   // the camera must not overwrite the host's choice
  await wait(300);
  assert.ok((await host.textContent('.zone[data-zone="U1"] .cardface')).includes('7'), 'manual card kept');
  await host.click('#voidButton'); await host.click('#voidButton');
  await until(async () => (await points()) === 10900, 'cancel returns the 500');
  step('manual correction wins over the camera; cancelling returns every point');
  reader.close();

  /* The real camera path: start the (fake) webcam; frames must flow with no further setup. */
  const cameraContext = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  await cameraContext.grantPermissions(['camera']);
  const cameraPage = await cameraContext.newPage();
  cameraPage.on('pageerror', error => errors.push(error.message));
  await cameraPage.goto(BASE + '/reader.html#key=' + KEY);
  await until(() => cameraPage.evaluate(() => document.querySelectorAll('#tableTabs button').length === 2), 'camera reader tabs');
  await cameraPage.click('#startCamera');
  await until(() => cameraPage.evaluate(() => !!window.__readerState.frame && window.__readerState.width > 0 && window.__readerState.ticks.length > 3), 'camera frames flowing', 10000);
  assert.strictEqual(await cameraPage.locator('#captureEmpty, [data-mode="deck"]').count(), 0, 'no empty-table or deck step in the reader');
  await cameraContext.close();
  step('real camera path: webcam starts and frames flow, with no empty-table or deck step');

  /* Round 4: the real reader page reads cards from a synthetic camera, with nothing registered. */
  const readerPage = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  readerPage.on('pageerror', error => errors.push(error.message));
  await readerPage.goto(BASE + '/reader.html#key=' + KEY);
  await readerPage.evaluate(() => { window.__fake = DemoCamera.source(1920, 1080); window.__readerSource = window.__fake.canvas; });
  await until(() => readerPage.evaluate(() => document.querySelectorAll('#tableTabs button').length === 2), 'reader tabs');
  await readerPage.click('#tableTabs button[data-table="duel"]');
  await readerPage.click('#startCamera');
  await wait(500);

  await host.click('#tableTabs button[data-table="duel"]');
  await viewer.click('#tableTabs button[data-table="duel"]');
  await until(() => host.evaluate(() => document.querySelectorAll('.zone').length === 2), 'back to duel');
  await host.click('#mainButton');
  await until(() => viewer.evaluate(() => !document.querySelector('.spot[data-spot="U"]').disabled), 'round 4 open');
  await viewer.click('.chip[data-chip="100"]'); await viewer.click('.spot[data-spot="U"]');
  await until(() => host.evaluate(() => document.getElementById('phaseBox').dataset.phase === 'dealing'), 'round 4 dealing', 12000);
  const red = { x: (0.14 + 0.15) * 1920, y: (0.22 + 0.28) * 1080 }, blue = { x: (0.56 + 0.15) * 1920, y: (0.22 + 0.28) * 1080 };
  await readerPage.evaluate(([r, b]) => window.__fake.place([{ card: 'S9', h: 420, x: r.x + 12, y: r.y - 8, angle: 0.06 }, { card: 'H3', h: 420, x: b.x - 10, y: b.y + 6, angle: -0.05, flip: true }]), [red, blue]);
  // Each zone must end either read by the camera as the true card, or flagged for the host. A
  // confident wrong card is the one outcome that is never acceptable.
  const truth = { R: 'S9', U: 'H3' };
  const readZones = () => host.evaluate(() => ['R', 'U'].map(zone => {
    const tile = document.querySelector('.zone[data-zone="' + zone + '"]');
    return { zone, text: tile.textContent, unsure: tile.classList.contains('unsure'), filled: !tile.querySelector('.cardface').classList.contains('empty') };
  }));
  const zones = await until(async () => { const list = await readZones(); return list.every(item => item.filled || item.unsure) ? list : null; }, 'both zones read or flagged', 20000);
  let optical = 0;
  for (const item of zones) {
    const label = truth[item.zone].slice(1) ;
    if (item.filled) {
      assert.ok(item.text.includes(label) && item.text.includes('光學'), 'camera card must be the true card: ' + item.zone + ' ' + item.text);
      optical++;
    } else {
      await host.click('.zone[data-zone="' + item.zone + '"]');
      await host.click('#pickerSuits button[data-suit="' + truth[item.zone][0] + '"]');
      await host.click('#pickerRanks button[data-rank="' + label + '"]');
    }
  }
  assert.ok(optical >= 1, 'at least one card read by the camera');
  await until(() => host.evaluate(() => !document.getElementById('mainButton').disabled), 'confirm enabled after reading');
  step('reader page: ' + optical + ' of 2 cards read by camera (tilted ♠9, upside-down ♥3), ' + (2 - optical) + ' flagged and picked by hand, none wrong');
  const liveShown = await viewer.evaluate(() => !document.getElementById('live').hidden && document.getElementById('live').src.startsWith('data:image/jpeg'));
  assert.ok(liveShown, 'viewer shows the table picture from the reader');
  await host.click('#mainButton');
  await until(async () => (await points()) === 10800, 'blue (3) loses to red (9): 10,900 - 100');
  step('viewer saw the live table picture; round settled (10,800)');

  await host.screenshot({ path: path.join(__dirname, 'shots', 'host.png') });
  await viewer.screenshot({ path: path.join(__dirname, 'shots', 'viewer.png'), fullPage: true });
  await readerPage.screenshot({ path: path.join(__dirname, 'shots', 'reader.png') });
  assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join(' | '));
  step('no page errors');
  console.log('e2e ok');
})().catch(error => { console.error('FAILED: ' + error.message); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});
