// Checks the shared rules: third-card decisions, outcomes and what each spot returns.
'use strict';
const assert = require('assert');
const Games = require('../public/games.js');
const nine = Games.GAMES.nine, duel = Games.GAMES.duel;
let count = 0;
function check(name, fn) { fn(); count += 1; console.log('ok  ' + name); }

check('duel outcome and returns', () => {
  const outcome = duel.outcome({ R: 'SK', U: 'H9' });
  assert.strictEqual(outcome.winner, 'R');
  assert.strictEqual(duel.returned('R', 100, outcome), 200);
  assert.strictEqual(duel.returned('U', 100, outcome), 0);
  const tie = duel.outcome({ R: 'S7', U: 'D7' });
  assert.strictEqual(tie.winner, 'T');
  assert.strictEqual(duel.returned('T', 100, tie), 900);
  assert.strictEqual(duel.returned('R', 100, tie), 50);
  assert.strictEqual(duel.returned('U', 55, tie), 27);
});

// Each case: the four starting cards, then what the rules must ask for next.
const cases = [
  ['natural 8 for blue stops everything', { U1: 'S8', R1: 'H2', U2: 'DK', R2: 'C3' }, ['U1', 'R1', 'U2', 'R2']],
  ['natural 9 for red stops everything', { U1: 'S2', R1: 'H4', U2: 'D3', R2: 'C5' }, ['U1', 'R1', 'U2', 'R2']],
  ['blue 6 stands, red 5 draws', { U1: 'S3', R1: 'H2', U2: 'D3', R2: 'C3' }, ['U1', 'R1', 'U2', 'R2', 'R3']],
  ['blue 7 stands, red 6 stands', { U1: 'S3', R1: 'H3', U2: 'D4', R2: 'C3' }, ['U1', 'R1', 'U2', 'R2']],
  ['blue 5 draws first', { U1: 'S2', R1: 'H3', U2: 'D3', R2: 'C3' }, ['U1', 'R1', 'U2', 'R2', 'U3']],
  ['blue 0 draws', { U1: 'SK', R1: 'H6', U2: 'DQ', R2: 'CK' }, ['U1', 'R1', 'U2', 'R2', 'U3']]
];
cases.forEach(([name, cards, expected]) => check('nine: ' + name, () => assert.deepStrictEqual(nine.required(cards), expected)));

// Red's third card after blue drew: [red total, blue third card, red draws?]
const table = [
  [2, 'S8', true], [3, 'S8', false], [3, 'S9', true], [4, 'S2', true], [4, 'S8', false], [4, 'SA', false],
  [5, 'S4', true], [5, 'S3', false], [5, 'S7', true], [6, 'S6', true], [6, 'S7', true], [6, 'S5', false], [7, 'S7', false]
];
// red total t from R1 + R2: use R1 = t (as a card) and R2 = K (0); t = 0 uses K + K.
const asCard = t => t === 0 ? 'HK' : 'H' + (t === 1 ? 'A' : String(t));
table.forEach(([redTotal, blueThird, draws]) => check('nine: red ' + redTotal + ' vs blue third ' + blueThird + ' -> ' + (draws ? 'draw' : 'stand'), () => {
  const cards = { U1: 'C2', U2: 'D3', R1: asCard(redTotal), R2: 'SK', U3: blueThird };   // blue starts on 5 so it draws
  assert.deepStrictEqual(nine.required(cards).includes('R3'), draws);
}));

check('nine outcome, pairs and returns', () => {
  const cards = { U1: 'S4', R1: 'H6', U2: 'D4', R2: 'C2' };   // blue 8 natural with a pair, red 8 natural
  assert.deepStrictEqual(nine.required(cards), ['U1', 'R1', 'U2', 'R2']);
  const outcome = nine.outcome(cards);
  assert.strictEqual(outcome.winner, 'tie');
  assert.strictEqual(outcome.bluePair, true);
  assert.strictEqual(nine.returned('blue', 100, outcome), 100);
  assert.strictEqual(nine.returned('tie', 100, outcome), 900);
  assert.strictEqual(nine.returned('bluePair', 100, outcome), 1200);
  assert.strictEqual(nine.returned('redPair', 100, outcome), 0);
  const red = nine.outcome({ U1: 'S2', R1: 'H9', U2: 'D3', R2: 'CK', U3: 'S2' });
  assert.strictEqual(red.winner, 'red');
  assert.strictEqual(nine.returned('red', 100, red), 195);
  assert.strictEqual(nine.returned('red', 15, red), 29);
});

check('checkComplete catches missing, extra and duplicate cards', () => {
  assert.strictEqual(Games.checkComplete(nine, { U1: 'S8', R1: 'H2', U2: 'DK', R2: 'C3' }).ok, true);
  assert.deepStrictEqual(Games.checkComplete(nine, { U1: 'S8', R1: 'H2', U2: 'DK', R2: 'C3', U3: 'S5' }).extra, ['U3']);
  assert.deepStrictEqual(Games.checkComplete(nine, { U1: 'S2', R1: 'H3', U2: 'D3', R2: 'C3' }).missing, ['U3']);
  assert.strictEqual(Games.checkComplete(duel, { R: 'S5', U: 'S5' }).duplicate, 'S5');
});
console.log(count + ' checks passed');
