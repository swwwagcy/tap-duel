// Draws the printable table mat for the two-card game ("duel") and writes it as SVG and PDF at
// real size. The camera's picture is a 16:9 rectangle on the mat; inside it the two card
// positions sit exactly where the reader's default layout expects them (games.js: duel.layout),
// so a camera lined up with the four corner marks needs no further adjusting.
//
//   node mat/build-mat.js            -> mat/duel-mat-600x350.{svg,pdf} and mat/duel-mat-a3.{svg,pdf}
//   node mat/build-mat.js 龍 虎      -> the same with other words on the two sides (written to the
//                                       folder given as the third argument, default mat/)
'use strict';
const fs = require('fs');
const path = require('path');
const Games = require('../public/games.js');

const CARD = { w: 63, h: 88 };                       // a poker-size card, mm
const FRAME = { w: 358.4, h: 201.6 };                // what the camera sees, mm (16:9); a card is 78% of its position's height
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
  add(`<text x="${W / 2}" y="${fy - 5}" text-anchor="middle" font-size="5" fill="${COLOUR.dim}">▲ 讀牌器畫面的上方　畫面四個角對準四個角標，手機橫放</text>`);
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
    add(`<text x="${cx}" y="${(z.y - z.h * m - 6.5).toFixed(2)}" text-anchor="middle" font-size="14" font-weight="700" fill="${colour}">${word}</text>`);
  });
  const gap = fx + FRAME.w / 2;
  add(`<line x1="${gap}" y1="${fy + FRAME.h * 0.3}" x2="${gap}" y2="${fy + FRAME.h * 0.7}" stroke="${COLOUR.faint}" stroke-width="0.9"/>`);
  // Outside the camera's picture: where the deck and the used cards go, so they are never read.
  if (size.spots) {
    const spot = (x, label, note) => {
      const y = fy + (FRAME.h - CARD.h) / 2;
      return `<rect x="${x}" y="${y}" width="${CARD.w}" height="${CARD.h}" rx="4" fill="none" stroke="${COLOUR.dim}" stroke-width="0.9" stroke-dasharray="3 2.5"/>` +
        `<text x="${x + CARD.w / 2}" y="${y + CARD.h / 2 + 3}" text-anchor="middle" font-size="9" font-weight="700" fill="${COLOUR.text}">${label}</text>` +
        `<text x="${x + CARD.w / 2}" y="${y + CARD.h + 8}" text-anchor="middle" font-size="4.6" fill="${COLOUR.dim}">${note}</text>`;
    };
    add(spot((fx - CARD.w) / 2, '牌堆', '還沒發的牌'));
    add(spot(fx + FRAME.w + (fx - CARD.w) / 2, '收牌', '用過的牌放這裡'));
  }
  // The host's side: the three things to remember.
  const by = fy + FRAME.h + size.stripGap;
  const steps = size.spots
    ? ['① 牌正面朝上，放進框裡', '② 手離開，等主持台出現這張牌', '③ 確認後，兩張牌都收到「收牌」']
    : ['① 牌正面朝上，放進框裡', '② 手離開，等主持台出現這張牌', '③ 確認後，把牌收到墊子外面'];
  steps.forEach((text, index) => add(`<text x="${(W * (index * 2 + 1) / 6).toFixed(1)}" y="${by}" text-anchor="middle" font-size="6.2" fill="${COLOUR.text}">${text}</text>`));
  add(`<text x="${W / 2}" y="${by + 11}" text-anchor="middle" font-size="4.6" fill="${COLOUR.dim}">主持人坐這一側　｜　框裡只放這一局的牌，其他東西不要放進四個角標圍起來的範圍</text>`);
  add('</svg>');
  return out.join('\n');
}

const SIZES = {
  '600x350': { w: 600, h: 350, frameTop: 46, stripGap: 38, spots: true },
  a3: { w: 420, h: 297, frameTop: 34, stripGap: 30, spots: false }
};

async function main() {
  const words = [process.argv[2] || '紅方', process.argv[3] || '藍方'];
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
