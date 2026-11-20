// Reading cards with no registration. Two real cards (cropped from a phone screenshot of a deck
// with a condensed typeface and teal diamonds) and synthetic decks in several typefaces and suit
// colours, placed with random offset, tilt and either way up. A confident wrong card is the one
// outcome that must never happen at the recommended size.
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { chromium } = require('playwright');
const PUBLIC = path.join(__dirname, '..', 'public');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const file of ['games.js', 'recognizer.js', 'demo-camera.js', 'ocr.js']) await page.addScriptTag({ path: path.join(PUBLIC, file) });
  let failed = false;

  const real = [['real-jack-diamonds.png', { cx: 254, cy: 373, w: 492, h: 722, angle: 0 }, 'DJ'], ['real-ten-diamonds.png', { cx: 230, cy: 349, w: 440, h: 682, angle: 0 }, 'D10']];
  for (const [file, card, expected] of real) {
    const source = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'fixtures', file)).toString('base64');
    const corner = await page.evaluate(async ([source, card]) => {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return CardOCR.readCorner(context.getImageData(0, 0, canvas.width, canvas.height), card, false);
    }, [source, card]);
    const clear = !corner.problem && Math.min(corner.rank.margin, corner.suit.margin) >= 0.3 && Math.min(corner.rank.score, corner.suit.score) >= 0.62;
    console.log(`real card ${file}: read ${corner.card || corner.problem}` + (corner.rank ? ` (rank ${corner.rank.score.toFixed(2)}/${corner.rank.margin.toFixed(2)}, suit ${corner.suit.score.toFixed(2)}/${corner.suit.margin.toFixed(2)})` : ''));
    if (corner.card !== expected || !clear) failed = true;
  }

  // The four aces photographed on a tan table, at four sizes: found, straightened and read whole.
  // (The centre artwork is blanked in the stored picture.) They used to fail three ways: the card
  // was mislocated where it lay in shade, the pale teal diamond was taken for paper, and the club
  // was read as a spade.
  {
    const source = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(__dirname, 'fixtures', 'real-aces.jpg')).toString('base64');
    for (const scale of [1, 0.75, 0.55, 0.4]) {
      const rows = await page.evaluate(async ([source, scale]) => {
        const image = new Image(); image.src = source; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const frame = context.getImageData(0, 0, canvas.width, canvas.height), W = canvas.width, H = canvas.height;
        const zones = { CA: [0.05, 0.12, 0.43, 0.42], DA: [0.47, 0.12, 0.43, 0.42], SA: [0.05, 0.55, 0.43, 0.43], HA: [0.47, 0.55, 0.43, 0.43] };
        return Object.keys(zones).map(card => {
          const z = zones[card], rect = { x: z[0] * W, y: z[1] * H, w: z[2] * W, h: z[3] * H };
          const at = ((Math.round(rect.y) + 3) * W + Math.round(rect.x) + 3) * 4;
          const found = Recognizer.locate(frame, { colour: [frame.data[at], frame.data[at + 1], frame.data[at + 2]] }, rect);
          const reading = found ? CardOCR.read(frame, found) : { card: null, sure: false };
          return { card, read: reading.card, sure: reading.sure, height: found ? Math.round(found.h) : 0 };
        });
      }, [source, scale]);
      const wrong = rows.filter(row => row.sure && row.read !== row.card), right = rows.filter(row => row.sure && row.read === row.card);
      console.log(`real aces at ${rows[0].height}px: ${right.length}/4 read` + (wrong.length ? ', WRONG ' + wrong.map(row => row.card + '→' + row.read).join(' ') : '') + (right.length < 4 ? ', left to the host: ' + rows.filter(row => !row.sure).map(row => row.card + (row.read ? '(' + row.read + '?)' : '')).join(' ') : ''));
      if (wrong.length || right.length < 3) failed = true;
    }
  }

  const decks = [
    ['standard', {}], ['teal diamonds', { palette: { D: '#11a99a' } }], ['four colours', { palette: { D: '#1f5fd0', C: '#1b8a3a' } }],
    ['serif index', { font: 'DejaVu Serif, Georgia, serif' }], ['monospace index', { font: 'DejaVu Sans Mono, monospace' }]
  ];
  for (const height of [200, 280]) for (const [name, options] of decks) {
    const summary = await page.evaluate(([height, options]) => {
      const camera = DemoCamera.source(1280, 720, Object.assign({ still: true }, options));
      const zone = { x: 380, y: 100, w: 400, h: 500 }; let seed = 7 + height;
      const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const summary = { right: 0, unsure: 0, wrong: [], total: 0 };
      Games.allCards().forEach(card => { for (let turn = 0; turn < 2; turn++) {
        const frame = camera.place([{ card, h: height, x: 580 + (random() - 0.5) * 60, y: 350 + (random() - 0.5) * 60, angle: (random() - 0.5) * 0.18, flip: turn === 1 }]);
        const found = Recognizer.locate(frame, { colour: [31, 94, 58] }, zone);
        const reading = found ? CardOCR.read(frame, found) : { sure: false };
        summary.total++;
        if (!reading.sure) summary.unsure++; else if (reading.card === card) summary.right++; else summary.wrong.push(card + '→' + reading.card);
      } });
      return summary;
    }, [height, options]);
    console.log(`${height}px ${name}: ${summary.right}/${summary.total} read, ${summary.unsure} left to the host, wrong but sure ${summary.wrong.length}` + (summary.wrong.length ? ' ' + summary.wrong.join(' ') : ''));
    if (summary.wrong.length || summary.right / summary.total < (height >= 280 ? 0.9 : 0.7)) failed = true;
  }
  await browser.close();
  if (failed) { console.log('FAILED'); process.exit(1); }
  console.log('ocr ok');
})();
