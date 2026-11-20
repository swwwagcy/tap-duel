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

  // The two of clubs on a mat lit unevenly, with a white desk beside the mat. Framed tightly and
  // framed so widely that the desk is inside the frame: it was once taken for a face-down card,
  // because the desk was measured as part of the card.
  {
    const source = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(__dirname, 'fixtures', 'real-two-clubs.jpg')).toString('base64');
    for (const [name, zone] of [['framed closely', [0.2, 0.28, 0.55, 0.5]], ['frame includes the desk', [0.05, 0.25, 0.93, 0.55]]]) for (const scale of [1, 0.6]) {
      const reading = await page.evaluate(async ([source, scale, z]) => {
        const image = new Image(); image.src = source; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const frame = context.getImageData(0, 0, canvas.width, canvas.height), W = canvas.width, H = canvas.height;
        const rect = { x: z[0] * W, y: z[1] * H, w: z[2] * W, h: z[3] * H }, at = ((Math.round(rect.y) + 3) * W + Math.round(rect.x) + 3) * 4;
        const found = Recognizer.locate(frame, { colour: [frame.data[at], frame.data[at + 1], frame.data[at + 2]] }, rect);
        const result = found ? CardOCR.read(frame, found) : { card: null, sure: false };
        return { card: result.card, sure: result.sure, back: !!result.back, height: found ? Math.round(found.h) : 0 };
      }, [source, scale, zone]);
      console.log(`real two of clubs, ${name}, ${reading.height}px: ` + (reading.sure ? 'read ' + reading.card : reading.back ? 'taken for a BACK' : 'left to the host (' + reading.card + '?)'));
      if (reading.back || (reading.sure && reading.card !== 'C2') || (scale === 1 && !reading.sure)) failed = true;
    }
  }

  // Tables of other colours (52 cards each at 300px). White on white cannot work: there is no edge.
  for (const [name, felt, rgb, floor] of [['off-white', '#ece6d8', [236, 230, 216], 42], ['light grey', '#d4d4d4', [212, 212, 212], 46], ['mid grey', '#b0b0b0', [176, 176, 176], 48], ['tan', '#c9a15a', [201, 161, 90], 46], ['black', '#141414', [20, 20, 20], 46]]) {
    const summary = await page.evaluate(([felt, rgb]) => {
      const camera = DemoCamera.source(1280, 720, { still: true, felt }), zone = { x: 380, y: 100, w: 400, h: 500 }, summary = { right: 0, wrong: 0, other: 0 };
      Games.allCards().forEach((card, index) => {
        const frame = camera.place([{ card, h: 300, x: 580 + (index % 5 - 2) * 10, y: 350, angle: (index % 7 - 3) * 0.02, flip: index % 2 === 1 }]);
        const found = Recognizer.locate(frame, { colour: rgb }, zone), reading = found ? CardOCR.read(frame, found) : { sure: false };
        if (!reading.sure) summary.other++; else if (reading.card === card) summary.right++; else summary.wrong++;
      });
      return summary;
    }, [felt, rgb]);
    console.log(`${name} table: ${summary.right}/52 read, wrong but sure ${summary.wrong}`);
    if (summary.wrong || summary.right < floor) failed = true;
  }

  const decks = [
    ['standard', {}], ['teal diamonds', { palette: { D: '#11a99a' } }], ['four colours', { palette: { D: '#1f5fd0', C: '#1b8a3a' } }],
    ['serif index', { font: 'DejaVu Serif, Georgia, serif' }], ['monospace index', { font: 'DejaVu Sans Mono, monospace' }]
  ];
  const totals = { 200: 0, 280: 0 };
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
    totals[height] += summary.right;
    if (summary.wrong.length || summary.right / summary.total < (height >= 280 ? 0.9 : 0.7)) failed = true;
  }
  // Floors for the whole set (520 placements per size), a little under what the current reader
  // scores (450 and 518 on 2026-11-20). A change that helps one card but costs the rest fails here.
  console.log(`all decks: ${totals[200]}/520 at 200px, ${totals[280]}/520 at 280px`);
  if (totals[200] < 440 || totals[280] < 510) { console.log('below the floor for the whole set (440 and 510)'); failed = true; }
  await browser.close();
  if (failed) { console.log('FAILED'); process.exit(1); }
  console.log('ocr ok');
})();
