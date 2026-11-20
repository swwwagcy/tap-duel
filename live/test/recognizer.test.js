// Draws a felt table and 52 cards in a headless browser, registers every card once (like the
// reader's calibration), then drops cards into a zone with random offset, tilt, upside-down
// placement, lighting and noise, and counts how often the recognizer is right, unsure or wrong.
// "Wrong but sure" is the number that matters: those would reach the host as a confident misread.
'use strict';
const path = require('path');
const { chromium } = require('playwright');

const TRIALS_PER_CARD = Number(process.env.TRIALS || 4);
// The reader asks for cards at least 120 px tall in its working image (phone 30-40 cm above the
// table, 1280 px wide). Those sizes must never be confidently wrong; smaller ones are reported only.
const CARD_HEIGHTS = (process.env.HEIGHTS || '90,130,160').split(',').map(Number);
const REQUIRED_FROM = 120;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addScriptTag({ path: path.join(__dirname, '..', 'public', 'recognizer.js') });
  await page.addScriptTag({ path: path.join(__dirname, 'synthetic.js') });
  let failed = false;
  for (const height of CARD_HEIGHTS) {
    const summary = await page.evaluate(([height, trials]) => runSyntheticTrial(height, trials), [height, TRIALS_PER_CARD]);
    console.log(`card height ${height}px: ${summary.total} placements, right & sure ${summary.rightSure}, unsure ${summary.unsure}, wrong but sure ${summary.wrongSure}, not found ${summary.notFound}, avg ${summary.ms.toFixed(1)} ms`);
    if (summary.unregistered.length) console.log('  could not register: ' + summary.unregistered.join(', '));
    if (summary.mistakes.length) console.log('  wrong but sure: ' + summary.mistakes.slice(0, 10).join(', '));
    if (summary.unsureCards.length) console.log('  unsure: ' + summary.unsureCards.slice(0, 12).join(', '));
    if (height >= REQUIRED_FROM && (summary.wrongSure > 0 || summary.rightSure / summary.total < 0.8)) failed = true;
    if (height < REQUIRED_FROM) console.log('  (below the recommended size: reported, not required)');
  }
  await browser.close();
  if (failed) { console.log('FAILED: at a recommended card size, a confident misread or fewer than 80% recognised with confidence'); process.exit(1); }
  console.log('recognizer ok');
})();
