// A deck whose diamonds are printed teal (like the real deck tested on 2026-11-20): the colour
// check must switch itself off instead of rejecting every diamond.
'use strict';
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const file of ['games.js', 'recognizer.js', 'demo-camera.js']) await page.addScriptTag({ path: path.join(__dirname, '..', 'public', file) });
  const result = await page.evaluate(() => {
    const camera = DemoCamera.source(1280, 720, { still: true, palette: { D: '#11a99a' } });
    const empty = camera.place([]);
    const zone = { x: 400, y: 150, w: 300, h: 380 }, centre = { x: 550, y: 340 }, height = 260;
    const entries = Games.allCards().map(card => {
      const raws = [0, 1, 2].map(() => { const frame = camera.place([{ card, h: height, x: centre.x, y: centre.y }]); return Recognizer.describeRaw(frame, Recognizer.locate(frame, empty, zone)); });
      return { card, raw: Recognizer.averageRaw(raws) };
    });
    const model = Recognizer.buildModel(entries);
    let right = 0, wrongSure = 0, unsure = 0;
    const tries = ['D9', 'D3', 'DK', 'D7', 'DA', 'D10', 'S9', 'H3', 'C7', 'HQ'];
    tries.forEach((card, index) => {
      const probes = [0, 1, 2].map(() => { const frame = camera.place([{ card, h: height, x: centre.x + (index % 3 - 1) * 10, y: centre.y, angle: (index % 5 - 2) * 0.02 }]); return Recognizer.describeProbe(frame, Recognizer.locate(frame, empty, zone)); });
      const reading = Recognizer.match(Recognizer.averageProbe(probes), model);
      if (!reading.sure) unsure++; else if (reading.card === card) right++; else wrongSure++;
    });
    return { colourCheck: !!model.colour, right, unsure, wrongSure, total: tries.length };
  });
  console.log('teal diamonds: ' + JSON.stringify(result));
  assert.strictEqual(result.colourCheck, false, 'colour check switches off for a deck with teal diamonds');
  assert.strictEqual(result.wrongSure, 0, 'no confident misread');
  assert.ok(result.right >= result.total * 0.7, 'diamonds are still read');
  await browser.close();
  console.log('colour deck ok');
})().catch(error => { console.error('FAILED: ' + error.message); process.exitCode = 1; });
