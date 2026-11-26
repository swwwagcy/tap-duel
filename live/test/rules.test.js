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

// The engine takes messages from anyone who can open a connection.
const Engine = require('../public/engine.js');
let viewerKey = null;   // null: the viewer pages are open
function withEngine(fn) {
  const engine = Engine.createEngine({ staffKeyMatches: (key, role) => role === 'viewer' ? viewerKey === null || key === viewerKey : key === 'k' });
  const open = () => { const got = []; const connection = { deliver: (message) => got.push(message) }; engine.connect(connection); return { connection, got, say: (message) => engine.receive(connection, JSON.stringify(message)) }; };
  try { fn(engine, open); } finally { engine.stop(); }
}

check('table names every object has are not tables', () => withEngine((engine, open) => {
  ['constructor', '__proto__', 'toString', 'hasOwnProperty', '', null, 5, {}, ['duel']].forEach((name) => {
    const viewer = open(); viewer.say({ t: 'hello', role: 'viewer' });
    ['watch', 'pick', 'undo'].forEach((t) => viewer.say({ t, table: name, spot: 'R', amount: 10 }));
    const host = open(); host.say({ t: 'hello', role: 'host', key: 'k' });
    ['watch', 'open', 'void', 'confirm', 'setCard', 'settings'].forEach((t) => host.say({ t, table: name }));
    const reader = open(); reader.say({ t: 'hello', role: 'reader', key: 'k' });
    ['watch', 'zone', 'status', 'frame'].forEach((t) => reader.say({ t, table: name, zone: 'R', state: 'card', card: 'S5' }));
    [viewer, host, reader].forEach((who) => assert.strictEqual(who.got.filter((message) => message.t === 'table').length, 0));
  });
  assert.strictEqual(engine.tables.duel.phase, 'idle');
}));

check('nothing is shown before a role is set, and a wrong key sets none', () => withEngine((engine, open) => {
  const stranger = open();
  stranger.say({ t: 'watch', table: 'duel' });
  assert.deepStrictEqual(stranger.got.map((message) => message.t), ['error']);
  stranger.say({ t: 'hello', role: 'host', key: 'wrong' });
  stranger.say({ t: 'watch', table: 'duel' });
  stranger.say({ t: 'open', table: 'duel' });
  assert.strictEqual(stranger.got.filter((message) => message.t === 'table').length, 0);
  assert.strictEqual(engine.tables.duel.phase, 'idle');
}));

check('a viewer gets the viewer view, staff get the staff view', () => withEngine((engine, open) => {
  const viewer = open(); viewer.say({ t: 'hello', role: 'viewer' }); viewer.say({ t: 'watch', table: 'duel' });
  const seen = viewer.got.find((message) => message.t === 'table').table;
  ['settings', 'history', 'readerInfo', 'check'].forEach((key) => assert.ok(!(key in seen), key));
  const host = open(); host.say({ t: 'hello', role: 'host', key: 'k' }); host.say({ t: 'watch', table: 'duel' });
  assert.ok('history' in host.got.find((message) => message.t === 'table').table);
}));

check('the presenter screen watches only; it sees totals and people per spot, the host also sees every pick', () => withEngine((engine, open) => {
  const host = open(); host.say({ t: 'hello', role: 'host', key: 'k' }); host.say({ t: 'watch', table: 'duel' });
  const stage = open(); stage.say({ t: 'hello', role: 'stage', key: 'k' }); stage.say({ t: 'watch', table: 'duel' });
  assert.strictEqual(stage.got[0].t, 'welcome');
  const wrong = open(); wrong.say({ t: 'hello', role: 'stage', key: 'nope' });
  assert.strictEqual(wrong.got[0].t, 'denied');
  host.say({ t: 'open', table: 'duel' });
  const one = open(); one.say({ t: 'hello', role: 'viewer', viewerId: 'one', name: '王小明' }); one.say({ t: 'watch', table: 'duel' });
  const two = open(); two.say({ t: 'hello', role: 'viewer', viewerId: 'two', name: 'Bo' });
  one.say({ t: 'pick', table: 'duel', spot: 'R', amount: 100 }); one.say({ t: 'pick', table: 'duel', spot: 'T', amount: 50 });
  two.say({ t: 'pick', table: 'duel', spot: 'R', amount: 500 });
  const tables = engine.tables.duel;
  stage.got.length = 0; host.got.length = 0; one.got.length = 0;
  stage.say({ t: 'watch', table: 'duel' }); host.say({ t: 'watch', table: 'duel' }); one.say({ t: 'watch', table: 'duel' });
  const onStage = stage.got.find((message) => message.t === 'table').table;
  assert.deepStrictEqual(onStage.spotPickers, { R: 2, T: 1 });
  assert.strictEqual(onStage.roundTotal, 650);
  ['players', 'feed', 'settings', 'history', 'readerInfo', 'check', 'watchers'].forEach((key) => assert.ok(!(key in onStage), 'stage sees no ' + key));
  const onHost = host.got.find((message) => message.t === 'table').table;
  assert.strictEqual(onHost.players[0].total, 500, 'largest first');
  assert.strictEqual(onHost.players[0].who, 'B*', 'names are masked');
  assert.strictEqual(onHost.players[1].who, '王*明');
  assert.deepStrictEqual(onHost.players[1].spots, { R: 100, T: 50 });
  assert.strictEqual(onHost.feed.length, 3);
  assert.strictEqual(onHost.watchers, 1, 'one viewer is watching this table');
  const onViewer = one.got.find((message) => message.t === 'table').table;
  ['players', 'feed', 'spotPickers', 'roundTotal', 'watchers'].forEach((key) => assert.ok(!(key in onViewer), 'viewer sees no ' + key));
  // The presenter screen cannot act.
  stage.say({ t: 'void', table: 'duel' }); stage.say({ t: 'close', table: 'duel' });
  assert.strictEqual(tables.phase, 'open');
  assert.ok(stage.got.some((message) => message.t === 'error'));
  // Near the per-spot limit is flagged for the host.
  tables.round.picks.get('two')[0].amount = 19000;
  host.got.length = 0; host.say({ t: 'watch', table: 'duel' });
  assert.strictEqual(host.got.find((message) => message.t === 'table').table.players[0].near, true);
}));

check('a reader cannot plant markup in a picture, and odd pictures are dropped', () => withEngine((engine, open) => {
  const host = open(); host.say({ t: 'hello', role: 'host', key: 'k' }); host.say({ t: 'watch', table: 'duel' });
  const reader = open(); reader.say({ t: 'hello', role: 'reader', key: 'k' });
  engine.tables.duel.phase = 'dealing'; engine.tables.duel.round = { no: 'T-1', picks: new Map(), cards: {}, warned: {}, outcome: null };
  const good = 'data:image/jpeg;base64,AAAA', evil = 'data:image/jpeg;base64,AAAA" onerror="alert(1)';
  reader.say({ t: 'zone', table: 'duel', zone: 'R', state: 'card', card: 'S5', shot: evil });
  assert.strictEqual(engine.tables.duel.round.cards.R.shot, null, 'a picture with anything but base64 in it is dropped');
  assert.strictEqual(engine.tables.duel.round.cards.R.card, 'S5', 'the card itself still counts');
  reader.say({ t: 'zone', table: 'duel', zone: 'U', state: 'card', card: 'H9', shot: good });
  assert.strictEqual(engine.tables.duel.round.cards.U.shot, good);
  reader.say({ t: 'frame', table: 'duel', image: evil });
  reader.say({ t: 'frame', table: 'duel', image: 'data:text/html;base64,AAAA' });
  assert.strictEqual(engine.tables.duel.frame, null);
  reader.say({ t: 'frame', table: 'duel', image: good });
  assert.strictEqual(engine.tables.duel.frame.image, good);
  // A reader is not a host: what a host may ask is not understood from a reader.
  reader.say({ t: 'confirm', table: 'duel' }); reader.say({ t: 'void', table: 'duel' }); reader.say({ t: 'setCard', table: 'duel', zone: 'R', card: 'SK' });
  assert.strictEqual(engine.tables.duel.phase, 'dealing');
  assert.strictEqual(engine.tables.duel.round.cards.R.card, 'S5');
}));

check('demo viewers cannot be impersonated, and remembered viewers have a limit', () => {
  const engine = Engine.createEngine({ bots: 2, viewerLimit: 6 });
  try {
    const open = () => { const got = []; const connection = { deliver: (message) => got.push(message) }; engine.connect(connection); return { connection, got, say: (message) => engine.receive(connection, JSON.stringify(message)) }; };
    const thief = open(); thief.say({ t: 'hello', role: 'viewer', viewerId: 'bot-0' });
    assert.notStrictEqual(thief.got.find((message) => message.t === 'me').id, 'bot-0');
    const stays = open(); stays.say({ t: 'hello', role: 'viewer', viewerId: 'keeper' });
    for (let index = 0; index < 40; index++) { const passing = open(); passing.say({ t: 'hello', role: 'viewer', viewerId: 'passer-' + index }); engine.disconnect(passing.connection); }
    assert.ok(engine.viewers.size <= 6, 'viewers remembered: ' + engine.viewers.size);
    assert.ok(engine.viewers.has('keeper') && engine.viewers.has('bot-0') && engine.viewers.has('bot-1'), 'connected viewers and demo viewers are kept');
  } finally { engine.stop(); }
});

check('sign-ins and round actions are written to the audit trail, a locked sign-in says so', () => {
  const trail = [];
  const engine = Engine.createEngine({ staffKeyMatches: (key, role) => key === 'locked-out' ? 'locked' : role === 'viewer' || key === 'k' || (role === 'reader' && key === 'r'), audit: (entry) => trail.push(entry) });
  try {
    const open = () => { const got = []; const connection = { address: '203.0.113.9', deliver: (message) => got.push(message) }; engine.connect(connection); return { got, say: (message) => engine.receive(connection, JSON.stringify(message)) }; };
    const wrong = open(); wrong.say({ t: 'hello', role: 'host', key: 'nope' });
    assert.deepStrictEqual(wrong.got, [{ t: 'denied', locked: false }]);
    const locked = open(); locked.say({ t: 'hello', role: 'host', key: 'locked-out' });
    assert.deepStrictEqual(locked.got, [{ t: 'denied', locked: true }]);
    const readerAsHost = open(); readerAsHost.say({ t: 'hello', role: 'host', key: 'r' });
    assert.strictEqual(readerAsHost.got[0].t, 'denied', 'the reader key does not open the host console');
    const reader = open(); reader.say({ t: 'hello', role: 'reader', key: 'r' });
    assert.strictEqual(reader.got[0].t, 'welcome');
    const host = open(); host.say({ t: 'hello', role: 'host', key: 'k' }); host.say({ t: 'open', table: 'duel' }); host.say({ t: 'void', table: 'duel' });
    assert.deepStrictEqual(trail.map((entry) => entry.action), ['sign-in refused', 'sign-in refused', 'sign-in refused', 'sign-in', 'sign-in', 'open', 'void']);
    assert.ok(trail.every((entry) => entry.by === '203.0.113.9'));
    assert.ok(!JSON.stringify(trail).includes('nope') && !JSON.stringify(trail).includes('"k"'), 'keys are never written to the trail');
  } finally { engine.stop(); }
});

check('staff are told what confirming would settle; viewers are not', () => withEngine((engine, open) => {
  const host = open(); host.say({ t: 'hello', role: 'host', key: 'k' }); host.say({ t: 'watch', table: 'duel' });
  const viewer = open(); viewer.say({ t: 'hello', role: 'viewer' }); viewer.say({ t: 'watch', table: 'duel' });
  engine.tables.duel.phase = 'dealing'; engine.tables.duel.round = { no: 'T-2', picks: new Map(), cards: {}, warned: {}, outcome: null };
  host.say({ t: 'setCard', table: 'duel', zone: 'R', card: 'SK' });
  const last = (who) => who.got.filter((message) => message.t === 'table').pop().table;
  assert.strictEqual(last(host).preview, null, 'no preview until the cards are complete');
  host.say({ t: 'setCard', table: 'duel', zone: 'U', card: 'H9' });
  assert.ok(/紅方/.test(last(host).preview), 'preview names the winner: ' + last(host).preview);
  assert.ok(!('preview' in last(viewer)), 'viewers get no preview');
}));

check('the test log records what the camera read and where the host stepped in', () => withEngine((engine, open) => {
  const host = open(); host.say({ t: 'hello', role: 'host', key: 'k' }); host.say({ t: 'watch', table: 'nine' });
  const reader = open(); reader.say({ t: 'hello', role: 'reader', key: 'k' });
  host.say({ t: 'open', table: 'nine' });
  engine.tables.nine.phase = 'dealing';
  const see = (zone, state, card) => reader.say({ t: 'zone', table: 'nine', zone, state, card, score: 0.9, margin: 0.5, top: [{ card: card || 'S5', score: 0.7 }] });
  see('U1', 'card', 'S8');                       // read and kept
  see('R1', 'card', 'H2');                       // read wrongly, the host corrects it
  host.say({ t: 'setCard', table: 'nine', zone: 'R1', card: 'H3' });
  see('U2', 'unsure');                           // not read, the host picks
  host.say({ t: 'setCard', table: 'nine', zone: 'U2', card: 'DK' });
  see('R2', 'card', 'C3');
  host.say({ t: 'confirm', table: 'nine' });
  host.say({ t: 'log', table: 'nine' });
  const rounds = host.got.filter((message) => message.t === 'log').pop().rounds;
  assert.strictEqual(rounds.length, 1);
  const zones = rounds[0].zones;
  assert.deepStrictEqual([zones.U1.finalBy, zones.U1.corrected, zones.U1.unread], ['camera', false, false]);
  assert.deepStrictEqual([zones.R1.final, zones.R1.finalBy, zones.R1.corrected, zones.R1.cameraFirst.card], ['H3', 'host', true, 'H2']);
  assert.deepStrictEqual([zones.U2.final, zones.U2.finalBy, zones.U2.corrected, zones.U2.unread], ['DK', 'host', false, true]);
  assert.strictEqual(rounds[0].ended, 'confirmed');
  const viewer = open(); viewer.say({ t: 'hello', role: 'viewer' }); viewer.say({ t: 'log', table: 'nine' });
  assert.strictEqual(viewer.got.filter((message) => message.t === 'log').length, 0, 'viewers cannot fetch the log');
  reader.say({ t: 'log', table: 'nine' });
  assert.strictEqual(reader.got.filter((message) => message.t === 'log').length, 0, 'nor can the reader');
}));

// With a stream delay, viewers must not be ahead of the video: no card faces while dealing, and
// the result only once the delay has passed. Points are settled at once on the server all the same.
check('with a viewers key set, a viewer without it gets nothing; the host is handed the key for its QR code', () => {
  viewerKey = 'v';
  try {
    withEngine((engine, open) => {
      const outsider = open(); outsider.say({ t: 'hello', role: 'viewer' }); outsider.say({ t: 'watch', table: 'duel' }); outsider.say({ t: 'pick', table: 'duel', spot: 'R', amount: 100 });
      assert.deepStrictEqual(outsider.got.map((message) => message.t), ['denied', 'error', 'error']);
      const wrong = open(); wrong.say({ t: 'hello', role: 'viewer', key: 'k' });
      assert.strictEqual(wrong.got[0].t, 'denied');
      const viewer = open(); viewer.say({ t: 'hello', role: 'viewer', key: 'v' }); viewer.say({ t: 'watch', table: 'duel' });
      assert.ok(viewer.got.some((message) => message.t === 'table'));
      assert.strictEqual(viewer.got[0].viewerKey, undefined, 'a viewer is not told the key');
    });
    const engine = Engine.createEngine({ staffKeyMatches: () => true, viewerKey: 'v' });
    try {
      const got = []; const connection = { deliver: (message) => got.push(message) }; engine.connect(connection);
      engine.receive(connection, JSON.stringify({ t: 'hello', role: 'host', key: 'k' }));
      assert.strictEqual(got[0].viewerKey, 'v');
      const reader = []; const second = { deliver: (message) => reader.push(message) }; engine.connect(second);
      engine.receive(second, JSON.stringify({ t: 'hello', role: 'reader', key: 'k' }));
      assert.strictEqual(reader[0].viewerKey, undefined, 'the reader is not handed it');
    } finally { engine.stop(); }
  } finally { viewerKey = null; }
});

const delayed = (async () => {
  const engine = Engine.createEngine({ staffKeyMatches: (key, role) => role === 'viewer' || key === 'k', tableSettings: { streamDelay: 0.4 } });
  try {
    const open = () => { const got = []; const connection = { deliver: (message) => got.push(JSON.parse(JSON.stringify(message))) }; engine.connect(connection); return { got, say: (message) => engine.receive(connection, JSON.stringify(message)) }; };
    const last = (who) => who.got.filter((message) => message.t === 'table').pop().table;
    const host = open(); host.say({ t: 'hello', role: 'host', key: 'k' }); host.say({ t: 'watch', table: 'duel' });
    const viewer = open(); viewer.say({ t: 'hello', role: 'viewer', viewerId: 'late-viewer' }); viewer.say({ t: 'watch', table: 'duel' });
    host.say({ t: 'open', table: 'duel' });
    viewer.say({ t: 'pick', table: 'duel', spot: 'R', amount: 100 });
    engine.tables.duel.phase = 'dealing';
    host.say({ t: 'setCard', table: 'duel', zone: 'R', card: 'SK' }); host.say({ t: 'setCard', table: 'duel', zone: 'U', card: 'H9' });
    assert.deepStrictEqual(last(viewer).cards, { R: { card: null, back: true }, U: { card: null, back: true } }, 'no card faces for viewers while dealing');
    assert.strictEqual(last(host).cards.R.card, 'SK', 'staff see the cards');
    host.say({ t: 'confirm', table: 'duel' });
    assert.strictEqual(last(host).phase, 'result');
    assert.strictEqual(engine.viewers.get('late-viewer').points, 10100, 'points are settled at once');
    const early = last(viewer);
    assert.ok(early.phase === 'dealing' && early.outcome === null && early.cards.R.card === null && early.road.length === 0, 'the result is held back from viewers');
    assert.strictEqual(viewer.got.filter((message) => message.t === 'result').length, 0, 'no result message yet');
    assert.strictEqual(viewer.got.filter((message) => message.t === 'me').pop().points, 9900, 'the viewer still sees the points from before the result');
    host.say({ t: 'open', table: 'duel' });
    assert.ok(/觀眾端還沒看到/.test(host.got.filter((message) => message.t === 'error').pop().text), 'the next round cannot start before viewers have seen this one');
    await new Promise((resolve) => setTimeout(resolve, 550));
    const shown = last(viewer);
    assert.ok(shown.phase === 'result' && shown.cards.R.card === 'SK' && shown.road.length === 1 && shown.outcome, 'after the delay viewers get the cards and the result');
    assert.strictEqual(viewer.got.filter((message) => message.t === 'result').length, 1);
    assert.strictEqual(viewer.got.filter((message) => message.t === 'me').pop().points, 10100);
    count += 1; console.log('ok  with a stream delay, viewers get card faces and the result only after it');
  } finally { engine.stop(); }
})();

delayed.then(() => console.log(count + ' checks passed'), (error) => { console.error(error); process.exit(1); });
