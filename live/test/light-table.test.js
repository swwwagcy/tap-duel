// A light yellow table: the card is barely brighter than what it lies on, so the recognizer has to
// fall back from "brighter than the table" to "different from the table" to find it.
'use strict';
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const file of ['games.js', 'recognizer.js', 'demo-camera.js']) await page.addScriptTag({ path: path.join(__dirname, '..', 'public', file) });
  const result = await page.evaluate(() => {
    const camera = DemoCamera.source(1280, 720, { still: true, felt: '#f2e27a' });
    const empty = camera.place([]);
    const zone = { x: 400, y: 150, w: 300, h: 380 }, centre = { x: 550, y: 340 }, height = 260;
    const entries = Games.allCards().map(card => {
      const raws = [0, 1, 2].map(() => { const frame = camera.place([{ card, h: height, x: centre.x, y: centre.y }]); return Recognizer.describeRaw(frame, Recognizer.locate(frame, empty, zone)); });
      return { card, raw: Recognizer.averageRaw(raws) };
    });
    const model = Recognizer.buildModel(entries);
    let right = 0, wrongSure = 0, unsure = 0, light = 0;
    const tries = ['S9', 'H3', 'DK', 'C7', 'SA', 'HQ', 'D10', 'C2', 'S5', 'H8', 'DJ', 'C4'];
    tries.forEach((card, index) => {
      const probes = [0, 1, 2].map(() => { const frame = camera.place([{ card, h: height, x: centre.x + (index % 3 - 1) * 12, y: centre.y + (index % 2 ? 8 : -8), angle: (index % 5 - 2) * 0.02, flip: index % 2 === 1 }]); const found = Recognizer.locate(frame, empty, zone); if (found.lightTable) light++; return Recognizer.describeProbe(frame, found); });
      const reading = Recognizer.match(Recognizer.averageProbe(probes), model);
      if (!reading.sure) unsure++; else if (reading.card === card) right++; else wrongSure++;
    });
    return { right, unsure, wrongSure, light, total: tries.length };
  });
  console.log('light table: ' + JSON.stringify(result));
  assert.strictEqual(result.wrongSure, 0, 'no confident misread on a light table');
  assert.ok(result.light > 0, 'the light-table fallback was used');
  assert.ok(result.right >= result.total * 0.75, 'most cards read on a light table');
  await browser.close();
  console.log('light table ok');
})().catch(error => { console.error('FAILED: ' + error.message); process.exitCode = 1; });
