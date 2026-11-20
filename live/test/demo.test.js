// Demo mode with no game server at all: public/ is served as plain static files (like GitHub
// Pages). The overview page must run full rounds of both games with the simulated camera dealing,
// and two standalone tabs must share one table through the shared worker.
'use strict';
const path = require('path');
const http = require('http');
const fs = require('fs');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 20000) {
  const started = Date.now();
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() - started > timeout) throw new Error('Timed out waiting for: ' + label); await wait(150); }
}
const step = text => console.log('ok  ' + text);

const server = http.createServer((request, response) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(request.url, 'http://x').pathname));
  if (!file.startsWith(ROOT)) { response.writeHead(403); response.end(); return; }
  fs.readFile(file, (error, data) => { if (error) { response.writeHead(404); response.end(); return; } response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); response.end(data); });
});

async function playRound(page, table, spot) {
  const frame = name => page.frame({ url: new RegExp(name + '\\.html') });
  const host = frame('host'), viewer = frame('play'), reader = frame('reader');
  await until(() => reader.evaluate(() => window.__readerState && !!window.__readerState.frame), table + ': reader camera running', 40000);
  await until(() => host.evaluate(() => document.querySelector('.zone') && !document.getElementById('mainButton').disabled), table + ': host ready');
  const before = await viewer.evaluate(() => Number(document.getElementById('points').textContent.replace(/,/g, '')));
  await host.click('#mainButton');
  await until(() => viewer.evaluate(s => !document.querySelector('.spot[data-spot="' + s + '"]').disabled, spot), table + ': viewer can choose');
  await viewer.click('.chip[data-chip="100"]');
  await viewer.click('.spot[data-spot="' + spot + '"]');
  await until(async () => (await host.evaluate(() => Number(document.querySelector('.totals').textContent.match(/(\d+) 人/)[1]))) >= 2, table + ': demo viewers joined', 15000);
  await until(() => host.evaluate(() => document.getElementById('phaseBox').dataset.phase === 'dealing'), table + ': dealing', 20000);
  // The simulated camera deals; anything it cannot read confidently is picked by hand.
  let manual = 0;
  await until(async () => {
    const state = await host.evaluate(() => ({
      ok: !document.getElementById('mainButton').disabled,
      unsure: Array.from(document.querySelectorAll('.zone.unsure')).map(tile => tile.dataset.zone)
    }));
    if (state.ok) return true;
    for (const zone of state.unsure) {
      const truth = await reader.evaluate(z => window.__readerState.dealt[z], zone);
      if (!truth) continue;
      await host.click('.zone[data-zone="' + zone + '"]');
      await host.click('#pickerSuits button[data-suit="' + truth[0] + '"]');
      await host.click('#pickerRanks button[data-rank="' + truth.slice(1) + '"]');
      manual++;
    }
    return false;
  }, table + ': all cards in', 40000);
  // Every card the camera filled in must be the card that was dealt.
  const check = await host.evaluate(() => Array.from(document.querySelectorAll('.zone')).map(tile => ({ zone: tile.dataset.zone, text: tile.textContent })));
  const dealt = await reader.evaluate(() => window.__readerState.dealt);
  Object.keys(dealt).forEach(zone => {
    const tile = check.find(item => item.zone === zone);
    assert.ok(tile.text.includes(dealt[zone].slice(1)), table + ': ' + zone + ' shows ' + tile.text + ' but ' + dealt[zone] + ' was dealt');
  });
  await host.click('#mainButton');
  await until(() => host.evaluate(() => document.getElementById('phaseBox').dataset.phase === 'result'), table + ': settled');
  await until(() => viewer.evaluate(() => document.getElementById('banner').textContent.includes('投入 100')), table + ': viewer result banner');
  const after = await viewer.evaluate(() => Number(document.getElementById('points').textContent.replace(/,/g, '')));
  const liveShown = await viewer.evaluate(() => !document.getElementById('live').hidden);
  assert.ok(liveShown, table + ': viewer shows the simulated table picture');
  step(table + ': round settled (' + Object.keys(dealt).length + ' cards dealt, ' + manual + ' picked by hand, points ' + before + ' -> ' + after + ')');
}

(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(base + '/demo.html');
    await playRound(page, 'duel', 'R');
    await page.screenshot({ path: path.join(__dirname, 'shots', 'demo-duel.png') });
    await page.click('#gameTabs button[data-table="nine"]');
    await wait(500);
    await playRound(page, 'nine', 'blue');
    await page.screenshot({ path: path.join(__dirname, 'shots', 'demo-nine.png') });

    // Two standalone tabs of the same browser share one table through the shared worker.
    const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
    const host = await context.newPage(), viewer = await context.newPage();
    [host, viewer].forEach(tab => tab.on('pageerror', error => errors.push(error.message)));
    await host.goto(base + '/host.html?demo'); await viewer.goto(base + '/play.html?demo');
    await until(() => host.evaluate(() => !!document.querySelector('.zone') && !document.getElementById('mainButton').disabled), 'standalone host ready');
    await host.click('#mainButton');
    await until(() => viewer.evaluate(() => document.getElementById('phase').dataset.phase === 'open'), 'standalone viewer sees the round the other tab opened');
    assert.ok(await host.evaluate(() => !!document.querySelector('.demotag')), 'demo tag shown on standalone pages');
    step('standalone tabs share one table through the shared worker');

    assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join(' | '));
    step('no page errors');
    console.log('demo ok');
  } catch (error) {
    console.error('FAILED: ' + error.message); process.exitCode = 1;
  } finally {
    await browser.close(); server.close();
  }
})();
