// End to end: starts the server, opens the viewer and host pages in a browser, and plays rounds.
// Rounds 1-3 feed cards through a scripted reader connection (exact cards, checks the money);
// round 4 uses the real reader page looking at a synthetic camera: with nothing registered, it
// must read the dealt cards by itself.
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');
const WebSocket = require('ws');
const http = require('http');
const { chromium } = require('playwright');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = 'http://127.0.0.1:' + PORT;
// Where the two positions are in a 1920 x 1080 camera picture, from the game's own layout.
const DUEL = require('../public/games.js').GAMES.duel.layout;
const centre = id => ({ x: (DUEL[id][0] + DUEL[id][2] / 2) * 1920, y: (DUEL[id][1] + DUEL[id][3] / 2) * 1080 });
const KEY = 'test-key-for-staff', READER_KEY = 'test-key-for-reader';
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
const clear = (socket, table, zones) => zones.forEach(zone => socket.send(JSON.stringify({ t: 'zone', table, zone, state: 'empty' })));
const card = (socket, table, zone, value) => socket.send(JSON.stringify({ t: 'zone', table, zone, state: 'card', card: value, score: 0.95, margin: 0.8, top: [{ card: value, score: 0.95 }] }));

(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), STAFF_KEY: KEY, READER_KEY: READER_KEY }), stdio: ['ignore', 'pipe', 'inherit'] });
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
  // Guard rails for a busy host: the button first says to look, then names what confirming will settle.
  await until(() => host.evaluate(() => document.querySelector('#steps li.now').dataset.step === 'confirm'), 'the progress strip reaches "confirm"');
  const looking = await host.evaluate(() => ({ text: document.getElementById('mainButton').textContent, off: document.getElementById('mainButton').disabled }));
  assert.ok(looking.off && looking.text === '請核對…', 'confirm pauses for a look once the cards are in: ' + JSON.stringify(looking));
  await until(() => host.evaluate(() => !document.getElementById('mainButton').disabled), 'confirm enabled');
  const ready = await host.evaluate(() => ({ button: document.getElementById('mainButton').textContent, guide: document.getElementById('guide').textContent }));
  assert.ok(/^確認：.*紅方/.test(ready.button), 'the button names the result it will settle: ' + ready.button);
  assert.ok(ready.guide.includes('♠K') && ready.guide.includes('♥9'), 'the guide lists the cards to check: ' + ready.guide);
  await host.click('#mainButton');
  await until(async () => (await points()) === 10100, 'duel payout 9700 + 400');
  const banner = await viewer.textContent('#banner');
  assert.ok(banner.includes('紅方勝') && banner.includes('+100'), 'banner: ' + banner);
  step('duel round: red wins, 300 in, 400 back, viewer shows 10,100 and the result banner');

  /* Old cards still on the table: the host is told, one press does not start, clearing does. */
  await until(() => host.evaluate(() => document.getElementById('guide').textContent.includes('請先收掉桌上的牌')), 'host told to clear the table');
  await host.click('#mainButton');
  await wait(400);
  assert.strictEqual(await host.evaluate(() => document.getElementById('phaseBox').dataset.phase), 'result', 'one press must not start a round over old cards');
  clear(reader, 'duel', ['R', 'U']);
  await until(() => host.evaluate(() => document.getElementById('mainButton').textContent === '開始新回合' && !document.getElementById('guide').textContent.includes('收掉')), 'host free to start once the table is clear');
  step('stale cards block the next round until the table is cleared');

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
  clear(reader, 'nine', ['U1', 'U2', 'U3', 'R1', 'R2', 'R3']);
  await until(() => host.evaluate(() => document.getElementById('mainButton').textContent === '開始新回合'), 'table clear after the nine round');
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
  clear(reader, 'nine', ['U1', 'U2', 'U3', 'R1', 'R2', 'R3']);
  step('manual correction wins over the camera; cancelling returns every point');
  /* Face-down cards: placed during the countdown, shown as backs, read once turned over. */
  await until(() => host.evaluate(() => document.getElementById('mainButton').textContent === '開始新回合'), 'can start the face-down round');
  await host.click('#mainButton');
  await until(() => host.evaluate(() => document.getElementById('phaseBox').dataset.phase === 'open'), 'face-down round open');
  const notesBefore = await host.evaluate(() => document.querySelectorAll('#notes .warn').length);
  reader.send(JSON.stringify({ t: 'zone', table: 'nine', zone: 'U1', state: 'back' }));
  await until(() => host.evaluate(() => document.querySelector('.zone[data-zone="U1"]').classList.contains('back')), 'host shows the face-down card');
  await until(() => viewer.evaluate(() => !!document.querySelector('[data-zone="U1"] .cardface.back')), 'viewer shows the face-down card');
  assert.strictEqual(await host.evaluate(() => document.querySelectorAll('#notes .warn').length), notesBefore, 'a face-down card before dealing is not a warning');
  await until(() => host.evaluate(() => document.getElementById('phaseBox').dataset.phase === 'dealing'), 'face-down round dealing', 12000);
  assert.strictEqual(await host.evaluate(() => document.getElementById('guide').textContent.includes('藍方 1')), true, 'a face-down card does not count as dealt');
  card(reader, 'nine', 'U1', 'SQ');
  await until(() => host.evaluate(() => document.querySelector('.zone[data-zone="U1"]').textContent.includes('Q')), 'turned-over card is read');
  await host.click('#voidButton'); await host.click('#voidButton');
  await until(() => host.evaluate(() => document.getElementById('phaseBox').dataset.phase === 'void'), 'face-down round cancelled');
  step('face-down card: shown as a back to host and viewer with no warning, read after it is turned over');
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
  await readerPage.goto(BASE + '/reader.html#key=' + READER_KEY);   // the reader's own key
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
  // The cards go down face-down first during the countdown; the reader must report them as backs.
  await readerPage.evaluate(([r, b]) => window.__fake.place([{ back: true, h: 420, x: r.x, y: r.y, angle: 0.03 }, { back: true, h: 420, x: b.x, y: b.y, angle: -0.04 }]), [centre('R'), centre('U')]);
  await until(() => host.evaluate(() => document.querySelectorAll('.zone.back').length === 2), 'reader page reports both face-down cards', 15000);
  // Zoom: the buttons change the picture the reader works on.
  const zoomBefore = await readerPage.textContent('#zoomText');
  await readerPage.click('#zoomIn'); await readerPage.click('#zoomIn');
  assert.notStrictEqual(await readerPage.textContent('#zoomText'), zoomBefore, 'zoom changes');
  await readerPage.click('#zoomOut'); await readerPage.click('#zoomOut');
  assert.strictEqual(await readerPage.textContent('#zoomText'), zoomBefore, 'zoom returns');
  await until(() => host.evaluate(() => document.getElementById('phaseBox').dataset.phase === 'dealing'), 'round 4 dealing', 12000);
  const red = centre('R'), blue = centre('U');
  await readerPage.evaluate(([r, b]) => window.__fake.place([{ card: 'S9', h: 420, x: r.x + 12, y: r.y - 8, angle: 0.06 }, { card: 'H3', h: 420, x: b.x - 10, y: b.y + 6, angle: -0.05, flip: true }]), [red, blue]);
  // Each zone must end either read by the camera as the true card, or flagged for the host. A
  // confident wrong card is the one outcome that is never acceptable.
  const truth = { R: 'S9', U: 'H3' };
  const readZones = () => host.evaluate(() => ['R', 'U'].map(zone => {
    const tile = document.querySelector('.zone[data-zone="' + zone + '"]');
    const face = tile.querySelector('.cardface');
    return { zone, text: tile.textContent, unsure: tile.classList.contains('unsure'), filled: !face.classList.contains('empty') && !face.classList.contains('back') };
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

  /* Table calibration for a slanted camera: drag a corner, the picture that is read changes
     shape; a crossed outline is refused; switching it off restores the camera picture. */
  const geometry = () => readerPage.evaluate(() => { const s = window.__readerState; return { width: s.width, height: s.height, quad: s.quad, frame: s.frame ? s.frame.width + 'x' + s.frame.height : null, mode: s.mode }; });
  const dragCorner = async (from, to) => {
    const box = await readerPage.locator('#overlay').boundingBox();
    await readerPage.mouse.move(box.x + from[0] * box.width, box.y + from[1] * box.height);
    await readerPage.mouse.down();
    await readerPage.mouse.move(box.x + to[0] * box.width, box.y + to[1] * box.height, { steps: 4 });
    await readerPage.mouse.up();
  };
  assert.deepStrictEqual([(await geometry()).width, (await geometry()).height, (await geometry()).quad], [1920, 1080, null], 'starts uncalibrated');
  await readerPage.click('#modeTabs button[data-mode="quad"]');
  await dragCorner([0.12, 0.14], [0.25, 0.3]);
  let after = await geometry();
  assert.ok(after.quad && Math.abs(after.quad[0][0] - 0.25) < 0.01 && Math.abs(after.quad[0][1] - 0.3) < 0.01, 'the dragged corner is stored');
  await dragCorner([0.25, 0.3], [0.99, 0.99]);
  assert.deepStrictEqual((await geometry()).quad, after.quad, 'a crossed outline is refused and the corners stay');
  await readerPage.click('#modeTabs button[data-mode="run"]');
  after = await until(async () => { const now = await geometry(); return now.frame && now.frame === now.width + 'x' + now.height && (now.width !== 1920 || now.height !== 1080) ? now : null; }, 'straightened frames flowing', 8000);
  assert.ok(await readerPage.evaluate(() => JSON.parse(localStorage.getItem('tdl-quad')).length === 4), 'calibration is kept on the device');
  await readerPage.click('#modeTabs button[data-mode="quad"]');
  await readerPage.click('#quadOff');
  await readerPage.click('#modeTabs button[data-mode="run"]');
  await until(async () => { const now = await geometry(); return now.frame === '1920x1080' && !now.quad; }, 'camera picture restored', 8000);
  step('table calibration: corner dragged (read picture became ' + after.width + 'x' + after.height + '), crossed outline refused, switched off again');

  await host.screenshot({ path: path.join(__dirname, 'shots', 'host.png') });
  await viewer.screenshot({ path: path.join(__dirname, 'shots', 'viewer.png'), fullPage: true });
  await readerPage.screenshot({ path: path.join(__dirname, 'shots', 'reader.png') });
  assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join(' | '));
  /* Test log and the code for joining: the host's drawer sums up the camera's work, the CSV has a
     row per position, and the QR code decodes to the viewer page's address. */
  {
    await host.click('#openDrawer');
    await until(() => host.evaluate(() => /已確認 \d+ 回合/.test(document.getElementById('logSummary').textContent)), 'log summary shown');
    const summary = await host.evaluate(() => document.getElementById('logSummary').textContent);
    const shown = await host.evaluate(() => ({ rows: document.querySelectorAll('#logTable tbody tr').length, text: document.getElementById('logTable').textContent }));
    assert.ok(shown.rows >= 4 && shown.text.includes('鏡頭讀對') && shown.text.includes('紅方'), 'the rounds are listed in the console: ' + shown.rows + ' rows');
    assert.ok(!shown.text.includes('[object'), 'every cell of the log shows a value');
    const csv = await host.evaluate(async () => {
      const rounds = await new Promise(resolve => { const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); socket.onopen = () => socket.send(JSON.stringify({ t: 'hello', role: 'host', key: JSON.parse(localStorage.getItem('tdl-staff-key')) })); socket.onmessage = event => { const message = JSON.parse(event.data); if (message.t === 'welcome') socket.send(JSON.stringify({ t: 'log', table: 'duel' })); if (message.t === 'log') { socket.close(); resolve(message.rounds); } }; });
      return { rows: window.__hostLog.csv(rounds).split('\r\n'), totals: window.__hostLog.totals(rounds) };
    });
    assert.ok(csv.rows.length >= 3 && csv.rows[0].startsWith('回合,遊戲,結束方式'), 'csv has a heading and rows: ' + csv.rows.length);
    assert.ok(csv.rows.some(row => /紅方,.*♠9|紅方,.*鏡頭|紅方/.test(row)), 'csv rows name the position');
    assert.ok(csv.totals.cards >= 2 && csv.totals.camera + csv.totals.corrected + csv.totals.unread === csv.totals.cards, 'totals add up: ' + JSON.stringify(csv.totals));
    const download = host.waitForEvent('download', { timeout: 8000 });
    await host.click('#logDownload');
    assert.ok(/^tap-duel-duel-\d+\.csv$/.test((await download).suggestedFilename()), 'the log downloads as a CSV file');
    // The QR code must really decode to the viewer page.
    const shot = await host.locator('#viewerQr').screenshot();
    const decoded = await host.evaluate(async bytes => {
      const image = new Image(); image.src = 'data:image/png;base64,' + bytes; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height);
      return { width: data.width, height: data.height, pixels: Array.from(data.data) };
    }, shot.toString('base64'));
    const found = require('jsqr')(Uint8ClampedArray.from(decoded.pixels), decoded.width, decoded.height);
    assert.ok(found && found.data === BASE + '/play.html', 'the QR code reads as the viewer address: ' + (found && found.data));
    assert.strictEqual(await host.evaluate(() => document.getElementById('viewerUrl').textContent), BASE + '/play.html');
    await host.click('#closeDrawer');
    step('test log: ' + summary + ' CSV downloads; QR code decodes to ' + found.data);
  }

  /* Security: headers on every file, the reader key does not open the host console, and wrong
     keys lock the address out (this runs last: it locks this machine's own address). */
  const headers = await new Promise((resolve, reject) => http.get(BASE + '/host.html', response => { response.resume(); resolve(response.headers); }).on('error', reject));
  assert.strictEqual(headers['x-content-type-options'], 'nosniff');
  assert.ok(/frame-ancestors 'self'/.test(headers['content-security-policy']) && /default-src 'self'/.test(headers['content-security-policy']));
  const signIn = (role, key) => new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://localhost:' + PORT + '/ws');
    socket.on('open', () => socket.send(JSON.stringify({ t: 'hello', role, key })));
    socket.on('message', raw => { const message = JSON.parse(raw); socket.close(); resolve(message); });
    socket.on('error', reject);
  });
  assert.deepStrictEqual(await signIn('host', READER_KEY), { t: 'denied', locked: false }, 'reader key refused for the host console');
  assert.strictEqual((await signIn('reader', READER_KEY)).t, 'welcome');
  assert.strictEqual((await signIn('reader', KEY)).t, 'welcome', 'the host key still opens the reader');
  const answers = [];
  for (let attempt = 0; attempt < 5; attempt++) answers.push((await signIn('host', 'guess-' + attempt)).locked);
  assert.deepStrictEqual(answers, [false, false, false, false, true], 'the fifth wrong key locks the address');
  assert.deepStrictEqual(await signIn('host', KEY), { t: 'denied', locked: true }, 'while locked, even the right key is refused');
  step('security: headers set, reader key cannot host, fifth wrong key locks the address');

  step('no page errors');
  console.log('e2e ok');
})().catch(error => { console.error('FAILED: ' + error.message); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});
