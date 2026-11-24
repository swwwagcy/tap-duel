// Draws the printable table mat for the two-card game ("duel") and writes it as SVG and PDF at
// real size. The camera's picture is a 16:9 rectangle on the mat; inside it the two card
// positions sit exactly where the reader's default layout expects them (games.js: duel.layout),
// so a camera lined up with the four corner marks needs no further adjusting.
//
//   node mat/build-mat.js            -> mat/duel-mat-{a4,a3,600x350}.{svg,pdf,png}
//   node mat/build-mat.js 龍 虎      -> the same with other words on the two sides (written to the
//                                       folder given as the third argument, default mat/)
'use strict';
const fs = require('fs');
const path = require('path');
const Games = require('../public/games.js');

const CARD = { w: 63, h: 88 };                       // a poker-size card, mm
// What the camera sees, mm (16:9), sized so that a card is 78% of its position's height.
const FRAME_H = CARD.h / 0.78 / layoutHeight(), FRAME = { w: FRAME_H * 16 / 9, h: FRAME_H };
function layoutHeight() { return Games.GAMES.duel.layout.R[3]; }
const layout = Games.GAMES.duel.layout;
const COLOUR = { mat: '#1f5e3a', faint: '#2a6c46', line: '#e9dfb6', red: '#e9584c', blue: '#4f8ff7', text: '#f3efdc', dim: '#b9c9bd' };
const FONT = "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', 'WenQuanYi Zen Hei', sans-serif";

function mat(size, words) {
  const W = size.w, H = size.h, fx = (W - FRAME.w) / 2, fy = size.frameTop;
  const zone = id => { const z = layout[id]; return { x: fx + z[0] * FRAME.w, y: fy + z[1] * FRAME.h, w: z[2] * FRAME.w, h: z[3] * FRAME.h }; };
  const out = [];
  const add = text => out.push(text);
  add(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`);
  add(`<rect width="${W}" height="${H}" fill="${COLOUR.mat}"/>`);
  // The camera's picture: a bright corner mark at each corner, well away from the card positions.
  const corner = (x, y, dx, dy) => `<path d="M${x + dx * 14} ${y}H${x}V${y + dy * 14}" fill="none" stroke="${COLOUR.line}" stroke-width="1.6" stroke-linecap="round"/>`;
  add(corner(fx, fy, 1, 1) + corner(fx + FRAME.w, fy, -1, 1) + corner(fx, fy + FRAME.h, 1, -1) + corner(fx + FRAME.w, fy + FRAME.h, -1, -1));
  add(`<text x="${W / 2}" y="${fy - 2.5}" text-anchor="middle" font-size="${(size.text * 0.8).toFixed(1)}" fill="${COLOUR.dim}">▲ 這一邊是讀牌器畫面的上方　手機橫放，畫面四個角對準四個角標</text>`);
  [['R', COLOUR.red, words[0]], ['U', COLOUR.blue, words[1]]].forEach(([id, colour, word]) => {
    const z = zone(id), cx = z.x + z.w / 2, cy = z.y + z.h / 2;
    // A coloured border outside the area the reader looks at (the position plus 8% all round),
    // so the rim it measures the mat's colour from stays plain.
    const m = 0.13;
    add(`<rect x="${(z.x - z.w * m).toFixed(2)}" y="${(z.y - z.h * m).toFixed(2)}" width="${(z.w * (1 + 2 * m)).toFixed(2)}" height="${(z.h * (1 + 2 * m)).toFixed(2)}" rx="6" fill="none" stroke="${colour}" stroke-width="1.8"/>`);
    // Where the card goes: four small corner ticks in a tone close to the mat's, for the eye only.
    const hw = CARD.w / 2 + 1.5, hh = CARD.h / 2 + 1.5, t = 9;
    const tick = (sx, sy) => `<path d="M${cx + sx * hw} ${cy + sy * (hh - t)}V${cy + sy * hh}H${cx + sx * (hw - t)}" fill="none" stroke="${COLOUR.faint}" stroke-width="0.9"/>`;
    add(tick(-1, -1) + tick(1, -1) + tick(-1, 1) + tick(1, 1));
  });
  // Each name sits right above its own position, like a heading, outside the camera's picture.
  // Nothing has to be matched up by colour or by arrow, so it reads the same printed in black
  // and white.
  [['R', words[0], COLOUR.red], ['U', words[1], COLOUR.blue]].forEach(([id, word, colour]) => {
    const z = zone(id), cx = z.x + z.w / 2, height = Math.min(size.label, (z.w * 1.15) / word.length);
    // A plate in the side's colour as wide as the position's border, with the name in near-white:
    // the name stays light on dark whether the sheet is printed in colour or in black and white.
    const plateW = z.w * (size.plate || 1.26), plateH = height * 1.14, base = fy - size.labelGap;
    add(`<rect x="${(cx - plateW / 2).toFixed(2)}" y="${(base - height * 0.93).toFixed(2)}" width="${plateW.toFixed(2)}" height="${plateH.toFixed(2)}" rx="${(height * 0.12).toFixed(1)}" fill="${colour}"/>`);
    add(`<text x="${cx.toFixed(2)}" y="${base.toFixed(2)}" text-anchor="middle" font-size="${height.toFixed(1)}" font-weight="700" fill="#fffaf0" stroke="#fffaf0" stroke-width="${(height * 0.03).toFixed(2)}" stroke-linejoin="round">${word}</text>`);
  });
  add(`<line x1="${fx + FRAME.w / 2}" y1="${fy + FRAME.h * 0.2}" x2="${fx + FRAME.w / 2}" y2="${fy + FRAME.h * 0.8}" stroke="${COLOUR.faint}" stroke-width="0.9"/>`);
  // What the host has to remember. On the large sheets it runs along the host's side; on A4
  // there is no room below, so it sits between the two names.
  const steps = ['① 牌正面朝上，放進框裡', '② 手離開，等主持台出現這張牌', '③ 確認後，把兩張牌都收走'];
  if (size.stripGap) {
    const by = fy + FRAME.h + size.stripGap;
    steps.forEach((text, index) => add(`<text x="${(W * (index * 2 + 1) / 6).toFixed(1)}" y="${by}" text-anchor="middle" font-size="${size.text}" fill="${COLOUR.text}">${text}</text>`));
    add(`<text x="${W / 2}" y="${by + size.text * 1.7}" text-anchor="middle" font-size="${(size.text * 0.74).toFixed(1)}" fill="${COLOUR.dim}">主持人坐這一側　｜　四個角標圍起來的範圍裡只放這一局的兩張牌，牌堆與用過的牌放在外面</text>`);
  } else {
    const top = fy - size.labelGap - size.label * 0.86;
    steps.concat(['框裡只放這一局的兩張牌']).forEach((text, index) => add(`<text x="${W / 2}" y="${(top + size.text * (1 + index * 1.55)).toFixed(2)}" text-anchor="middle" font-size="${size.text}" fill="${index < 3 ? COLOUR.text : COLOUR.dim}">${text}</text>`));
  }
  add('</svg>');
  return out.join('\n');
}

const SIZES = {
  // label: height of the two names, mm; labelGap: from their baseline down to the camera's picture.
  // plate: width of the name's plate as a share of the position's width (narrow on A4, where the reminders sit between the two).
  a4: { w: 297, h: 210, frameTop: 44.5, label: 31, labelGap: 10.5, plate: 0.74, text: 4.2 },
  a3: { w: 420, h: 297, frameTop: 96, label: 68, labelGap: 23.5, stripGap: 26, text: 6.2 },
  '600x350': { w: 600, h: 350, frameTop: 132, label: 96, labelGap: 29.5, stripGap: 30, text: 6.6 }
};

async function main() {
  const words = [process.argv[2] || '紅', process.argv[3] || '藍'];
  const outDir = path.resolve(process.argv[4] || __dirname);
  const suffix = process.argv[2] ? '-custom' : '';
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  for (const name of Object.keys(SIZES)) {
    const size = SIZES[name], svg = mat(size, words), base = path.join(outDir, 'duel-mat-' + name + suffix);
    fs.writeFileSync(base + '.svg', svg);
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${size.w}mm ${size.h}mm;margin:0}html,body{margin:0}svg{display:block}</style></head><body>${svg}</body></html>`);
    await page.pdf({ path: base + '.pdf', width: size.w + 'mm', height: size.h + 'mm', printBackground: true, pageRanges: '1' });
    // A preview picture of the whole mat (the PDF is the file to print from).
    await page.setViewportSize({ width: 1500, height: Math.round(1500 * size.h / size.w) });
    await page.addStyleTag({ content: 'svg{width:100vw;height:100vh}' });
    await page.screenshot({ path: base + '.png' });
    await page.close();
    console.log('wrote ' + path.relative(process.cwd(), base) + '.{svg,pdf,png}  ' + size.w + ' x ' + size.h + ' mm');
  }
  await browser.close();
}
module.exports = { mat, SIZES, FRAME, CARD };
if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });
