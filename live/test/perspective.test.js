// Reading cards when the camera looks at the table from the side. A top-down table (the same
// synthetic cards as ocr.test.js) is photographed by a simulated camera tilted 0 to 45 degrees,
// straightened from the four corners of the table as a person would mark them, and read.
// The picture the simulated camera takes is 1920x1080 at every angle, so the loss of detail on a
// slanted table is real. 0 degrees through the same steps is the baseline to compare against.
'use strict';
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
const Perspective = require('../public/perspective.js');
const PUBLIC = path.join(__dirname, '..', 'public');

// Arithmetic first: the rectangle's shape must come back from its corners alone.
(function () {
  function project(tilt, pan, f, W, H, d) {
    const ct = Math.cos(tilt), st = Math.sin(tilt), cp = Math.cos(pan), sp = Math.sin(pan);
    return [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]].map(([X, Y]) => {
      const x1 = X * cp - Y * sp, y1 = X * sp + Y * cp;
      const z = d - y1 * st;
      return [960 + f * x1 / z, 540 + f * y1 * ct / z];
    });
  }
  // Lenses from a wide phone camera to a narrow one. Turned a little as well as tilted, the lens
  // is worked out from the corners; tilted only, a typical phone lens is assumed, so the answer
  // drifts when the real lens differs (cards end up a little stretched, which reading tolerates).
  let turned = 0, straight = 0;
  for (const f of [1100, 1440, 2000]) for (const tilt of [10, 20, 30, 45, 55]) for (const pan of [0, 8, 20]) for (const ratio of [16 / 9, 1.3, 0.8]) {
    const W = 1000, H = W / ratio;
    const quad = project(tilt * Math.PI / 180, pan * Math.PI / 180, f, W, H, 2600);
    const error = Math.abs(Perspective.aspect(quad, 1920, 1080) / ratio - 1);
    if (pan) turned = Math.max(turned, error); else straight = Math.max(straight, error);
  }
  console.log('rectangle shape from its corners: worst error ' + (turned * 100).toFixed(1) + '% when also turned, ' + (straight * 100).toFixed(1) + '% when only tilted (lens assumed)');
  assert.ok(turned < 0.02, 'shape recovered when both pairs of sides converge');
  assert.ok(straight < 0.25, 'shape within a quarter when only tilted and the lens is not the assumed one');
  assert.strictEqual(Perspective.usable([[0, 0], [10, 0], [10, 10], [0, 10]]), true);
  assert.strictEqual(Perspective.usable([[0, 0], [10, 10], [10, 0], [0, 10]]), false, 'a crossed outline is refused');
  const h = Perspective.mapping([[0, 0], [100, 0], [100, 50], [0, 50]], [[10, 20], [90, 25], [80, 70], [15, 60]]);
  const corner = Perspective.apply(h, 100, 50);
  assert.ok(Math.abs(corner[0] - 80) < 1e-6 && Math.abs(corner[1] - 70) < 1e-6);
})();

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const file of ['games.js', 'recognizer.js', 'demo-camera.js', 'ocr.js', 'perspective.js']) await page.addScriptTag({ path: path.join(PUBLIC, file) });
  let failed = false;
  const results = {};
  const floors = { 'duel 0°': 50, 'duel 15°': 50, 'duel 30°': 50, 'duel 45°': 48 };
  const runs = [];
  for (const [gameId, RW] of [['duel', 1920], ['nine', 1920], ['nine', 2560]]) for (const tilt of [0, 15, 30, 45]) for (const jitter of tilt >= 30 && RW === 1920 ? [0, 6] : [0]) runs.push([gameId, RW, tilt, jitter, 0.75]);
  // A wider and a narrower lens than the one assumed when the camera is only tilted.
  for (const lens of [0.57, 1.04]) runs.push(['duel', 1920, 45, 0, lens]);
  for (const [gameId, RW, tilt, jitter, lens] of runs) {
    const summary = await page.evaluate(([gameId, tilt, jitter, RW, lens]) => {
      const TW = 1920, TH = 1080, RH = RW * 9 / 16, f = lens * RW;
      const layout = Games.GAMES[gameId].layout, zoneIds = Object.keys(layout);
      const camera = DemoCamera.source(TW, TH, { still: true });
      let seed = 11 + tilt + jitter + zoneIds.length; const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      // The simulated camera: tilted back by `tilt` from straight down, far enough that the near
      // side of the table fills 92% of the picture's width and the whole table is in view.
      const angle = tilt * Math.PI / 180, ct = Math.cos(angle), st = Math.sin(angle);
      let d = f * TW / (0.92 * RW) + (TH / 2) * st;
      const shot = (X, Y) => { const z = d - Y * st; return [RW / 2 + f * X / z, RH / 2 + f * Y * ct / z]; };
      for (let grow = 0; grow < 200; grow++) { const top = shot(0, -TH / 2)[1], bottom = shot(0, TH / 2)[1]; if (top > RH * 0.03 && bottom < RH * 0.97) break; d *= 1.02; }
      const corners = [shot(-TW / 2, -TH / 2), shot(TW / 2, -TH / 2), shot(TW / 2, TH / 2), shot(-TW / 2, TH / 2)];
      // Picture pixel -> table pixel, to draw what the camera sees.
      const toTable = Perspective.mapping(corners, [[0, 0], [TW, 0], [TW, TH], [0, TH]]);
      const tableCorners = [[0, 0], [RW, 0], [RW, RH], [0, RH]].map(p => Perspective.apply(toTable, p[0], p[1]));
      const raw = { width: RW, height: RH, data: new Uint8ClampedArray(RW * RH * 4) };
      const summary = { right: 0, unsure: 0, wrong: [], total: 0, height: 0, size: '', aspect: 0, ms: 0 };
      const cards = Games.allCards(); let next = 0;
      const rounds = Math.ceil(52 / zoneIds.length);
      for (let round = 0; round < rounds; round++) {
        const dealt = {};
        const placed = zoneIds.map(zoneId => {
          const z = layout[zoneId], rect = { x: z[0] * TW, y: z[1] * TH, w: z[2] * TW, h: z[3] * TH };
          const card = cards[next++ % 52]; dealt[zoneId] = card;
          return { card, h: Math.min(rect.h * 0.78, rect.w * 0.78 / 0.716), x: rect.x + rect.w / 2 + (random() - 0.5) * rect.w * 0.1, y: rect.y + rect.h / 2 + (random() - 0.5) * rect.h * 0.08, angle: (random() - 0.5) * 0.14, flip: random() < 0.5 };
        });
        const table = camera.place(placed);
        Perspective.warp(table, tableCorners, raw);                      // what the tilted camera sees
        // Where a person would put the four handles: the table's corners, give or take a few pixels.
        const quad = corners.map(p => [p[0] + (random() - 0.5) * 2 * jitter, p[1] + (random() - 0.5) * 2 * jitter]);
        const size = Perspective.outputSize(quad, RW, RH, 1920, 1920);
        const flat = { width: size.width, height: size.height, data: new Uint8ClampedArray(size.width * size.height * 4) };
        const began = performance.now();
        Perspective.warp(raw, quad, flat);
        summary.ms = Math.max(summary.ms, performance.now() - began);
        summary.size = size.width + 'x' + size.height; summary.aspect = size.aspect;
        zoneIds.forEach(zoneId => {
          const z = layout[zoneId], m = 0.08;
          const rect = { x: (z[0] - z[2] * m) * flat.width, y: (z[1] - z[3] * m) * flat.height, w: z[2] * (1 + 2 * m) * flat.width, h: z[3] * (1 + 2 * m) * flat.height };
          rect.x = Math.max(0, rect.x); rect.y = Math.max(0, rect.y); rect.w = Math.min(flat.width - rect.x, rect.w); rect.h = Math.min(flat.height - rect.y, rect.h);
          const at = ((Math.round(rect.y) + 3) * flat.width + Math.round(rect.x) + 3) * 4;
          const found = Recognizer.locate(flat, { colour: [flat.data[at], flat.data[at + 1], flat.data[at + 2]] }, rect);
          const reading = found ? CardOCR.read(flat, found) : { sure: false };
          summary.total++;
          if (found) summary.height = Math.round(found.h);
          if (!reading.sure) summary.unsure++; else if (reading.card === dealt[zoneId]) summary.right++; else summary.wrong.push(dealt[zoneId] + '→' + reading.card);
        });
      }
      return summary;
    }, [gameId, tilt, jitter, RW, lens]);
    const name = gameId + ' ' + tilt + '°' + (RW !== 1920 ? ' with a ' + RW + 'px camera picture' : '') + (lens !== 0.75 ? ' with a ' + (lens < 0.75 ? 'wider' : 'narrower') + ' lens (' + lens + ')' : '') + (jitter ? ' (corners off by up to ' + jitter + 'px)' : '');
    results[name] = summary;
    console.log(`${name}: ${summary.right}/${summary.total} read, ${summary.unsure} left to the host, wrong but sure ${summary.wrong.length}` + (summary.wrong.length ? ' ' + summary.wrong.join(' ') : '') + ` | straightened ${summary.size}, card about ${summary.height}px, ${Math.round(summary.ms)} ms`);
    if (summary.wrong.length) failed = true;
    if (floors[name] && summary.right < floors[name]) { console.log('  below the floor of ' + floors[name]); failed = true; }
  }
  await browser.close();
  if (failed) { console.log('FAILED'); process.exit(1); }
  console.log('perspective ok');
})();
