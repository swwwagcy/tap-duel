// Synthetic table and cards for recognizer tests (runs in the browser).
(function () {
  var SUITS = ['S', 'H', 'D', 'C'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  var W = 640, H = 360;
  var seed = 12345;
  function random() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  function between(a, b) { return a + (b - a) * random(); }

  // Pip positions (fractions of the pip area) for 2-10.
  var PIPS = {
    2: [[0.5, 0], [0.5, 1]], 3: [[0.5, 0], [0.5, 0.5], [0.5, 1]],
    4: [[0, 0], [1, 0], [0, 1], [1, 1]], 5: [[0, 0], [1, 0], [0.5, 0.5], [0, 1], [1, 1]],
    6: [[0, 0], [1, 0], [0, 0.5], [1, 0.5], [0, 1], [1, 1]],
    7: [[0, 0], [1, 0], [0.5, 0.25], [0, 0.5], [1, 0.5], [0, 1], [1, 1]],
    8: [[0, 0], [1, 0], [0.5, 0.25], [0, 0.5], [1, 0.5], [0.5, 0.75], [0, 1], [1, 1]],
    9: [[0, 0], [1, 0], [0, 0.33], [1, 0.33], [0.5, 0.5], [0, 0.67], [1, 0.67], [0, 1], [1, 1]],
    10: [[0, 0], [1, 0], [0.5, 0.17], [0, 0.33], [1, 0.33], [0, 0.67], [1, 0.67], [0.5, 0.83], [0, 1], [1, 1]]
  };

  function drawCard(ctx, card, cw, ch) {
    var suit = card[0], rank = card.slice(1), red = suit === 'H' || suit === 'D';
    var ink = red ? '#c8102e' : '#111';
    ctx.fillStyle = '#f7f7f2';
    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = Math.max(1, cw * 0.015);
    var r = cw * 0.08;
    ctx.beginPath();
    ctx.moveTo(-cw / 2 + r, -ch / 2); ctx.lineTo(cw / 2 - r, -ch / 2); ctx.quadraticCurveTo(cw / 2, -ch / 2, cw / 2, -ch / 2 + r);
    ctx.lineTo(cw / 2, ch / 2 - r); ctx.quadraticCurveTo(cw / 2, ch / 2, cw / 2 - r, ch / 2);
    ctx.lineTo(-cw / 2 + r, ch / 2); ctx.quadraticCurveTo(-cw / 2, ch / 2, -cw / 2, ch / 2 - r);
    ctx.lineTo(-cw / 2, -ch / 2 + r); ctx.quadraticCurveTo(-cw / 2, -ch / 2, -cw / 2 + r, -ch / 2);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    function index() {
      ctx.font = 'bold ' + Math.round(ch * 0.15) + 'px Arial, sans-serif';
      ctx.fillText(rank, -cw / 2 + cw * 0.13, -ch / 2 + ch * 0.1);
      ctx.font = Math.round(ch * 0.12) + 'px Arial, sans-serif';
      ctx.fillText(SYMBOL[suit], -cw / 2 + cw * 0.13, -ch / 2 + ch * 0.22);
    }
    index();
    ctx.save(); ctx.rotate(Math.PI); index(); ctx.restore();
    if (rank === 'J' || rank === 'Q' || rank === 'K') {
      ctx.fillStyle = red ? '#f3d7a0' : '#cfe0f5';
      ctx.fillRect(-cw * 0.28, -ch * 0.32, cw * 0.56, ch * 0.64);
      ctx.strokeStyle = ink; ctx.strokeRect(-cw * 0.28, -ch * 0.32, cw * 0.56, ch * 0.64);
      ctx.fillStyle = ink; ctx.font = 'bold ' + Math.round(ch * 0.34) + 'px Georgia, serif';
      ctx.fillText(rank, 0, -ch * 0.02);
      ctx.font = Math.round(ch * 0.14) + 'px Arial, sans-serif';
      ctx.fillText(SYMBOL[suit], 0, ch * 0.2);
    } else if (rank === 'A') {
      ctx.font = Math.round(ch * 0.42) + 'px Arial, sans-serif';
      ctx.fillText(SYMBOL[suit], 0, 0);
    } else {
      var pips = PIPS[Number(rank)];
      ctx.font = Math.round(ch * 0.14) + 'px Arial, sans-serif';
      pips.forEach(function (pip) {
        var x = (pip[0] - 0.5) * cw * 0.42, y = (pip[1] - 0.5) * ch * 0.62;
        ctx.save(); ctx.translate(x, y); if (pip[1] > 0.5) ctx.rotate(Math.PI); ctx.fillText(SYMBOL[suit], 0, 0); ctx.restore();
      });
    }
  }

  var felt = null;
  function feltCanvas() {
    if (felt) return felt;
    felt = document.createElement('canvas'); felt.width = W; felt.height = H;
    var ctx = felt.getContext('2d');
    ctx.fillStyle = '#1f5e3a'; ctx.fillRect(0, 0, W, H);
    var image = ctx.getImageData(0, 0, W, H);
    for (var index = 0; index < image.data.length; index += 4) {
      var grain = (random() - 0.5) * 14;
      image.data[index] += grain; image.data[index + 1] += grain; image.data[index + 2] += grain;
    }
    ctx.putImageData(image, 0, 0);
    return felt;
  }

  // One camera frame: the felt, optionally a card, then lighting and sensor noise.
  function frame(placement, light) {
    var canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(feltCanvas(), 0, 0);
    if (placement) {
      ctx.save();
      ctx.translate(placement.x, placement.y); ctx.rotate(placement.angle + (placement.flip ? Math.PI : 0));
      ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
      drawCard(ctx, placement.card, placement.h * 0.716, placement.h);
      ctx.restore();
    }
    var image = ctx.getImageData(0, 0, W, H);
    for (var index = 0; index < image.data.length; index += 4) {
      var x = (index / 4) % W;
      var gain = light.gain * (1 + light.slope * (x / W - 0.5));
      var noise = (random() - 0.5) * 2 * light.noise;
      for (var c = 0; c < 3; c++) image.data[index + c] = image.data[index + c] * gain + noise;
    }
    return image;
  }








  // A fake camera for the reader page: a felt of any size with cards on it and fresh sensor noise
  // on every refresh, so the reader sees what it would see from a phone above a table.
  window.SyntheticSource = function (width, height) {
    var canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    var context = canvas.getContext('2d');
    var base = document.createElement('canvas'); base.width = width; base.height = height;
    var baseContext = base.getContext('2d');
    baseContext.fillStyle = '#1f5e3a'; baseContext.fillRect(0, 0, width, height);
    var grain = baseContext.getImageData(0, 0, width, height);
    for (var index = 0; index < grain.data.length; index += 4) { var g = (random() - 0.5) * 14; grain.data[index] += g; grain.data[index + 1] += g; grain.data[index + 2] += g; }
    baseContext.putImageData(grain, 0, 0);
    var placed = [];
    function redraw() {
      context.drawImage(base, 0, 0);
      placed.forEach(function (p) {
        context.save(); context.translate(p.x, p.y); context.rotate((p.angle || 0) + (p.flip ? Math.PI : 0));
        context.shadowColor = 'rgba(0,0,0,0.35)'; context.shadowBlur = 4; context.shadowOffsetY = 2;
        drawCard(context, p.card, p.h * 0.716, p.h);
        context.restore();
      });
      var image = context.getImageData(0, 0, width, height);
      for (var index = 0; index < image.data.length; index += 4) { var n = (random() - 0.5) * 6; image.data[index] += n; image.data[index + 1] += n; image.data[index + 2] += n; }
      context.putImageData(image, 0, 0);
    }
    redraw();
    setInterval(redraw, 120);
    return { canvas: canvas, place: function (list) { placed = list; redraw(); } };
  };
  window.runSyntheticTrial = function (height, trials, calm) {
    seed = 12345 + height;
    var zone = { x: 260, y: 70, w: Math.round(height * 1.5), h: Math.round(height * 1.6) };
    var steady = { gain: 1, slope: 0, noise: 3 };
    var empty = frame(null, steady);
    var templates = [];
    var summary = { total: 0, rightSure: 0, unsure: 0, wrongSure: 0, notFound: 0, mistakes: [], unsureCards: [], unregistered: [], samples: [], ms: 0 };
    var cards = [];
    SUITS.forEach(function (suit) { RANKS.forEach(function (rank) { cards.push(suit + rank); }); });
    cards.forEach(function (card) {
      var placed = { card: card, h: height, x: zone.x + zone.w / 2 + between(-4, 4), y: zone.y + zone.h / 2 + between(-4, 4), angle: between(-0.03, 0.03), flip: false };
      var raws = [0, 1, 2].map(function () { var shot = frame(placed, steady); return Recognizer.describeRaw(shot, Recognizer.locate(shot, empty, zone)); });
      templates.push({ card: card, raw: Recognizer.decodeRaw(Recognizer.encodeRaw(Recognizer.averageRaw(raws))) });
    });
    var model = Recognizer.buildModel(templates);
    var started = performance.now();
    cards.forEach(function (card) {
      for (var trial = 0; trial < trials; trial++) {
        var slackX = (zone.w - height * 0.716) / 2 - 3, slackY = (zone.h - height) / 2 - 3;
        var k = calm == null ? 1 : calm;
        var placement = { card: card, h: height * (1 + k * between(-0.03, 0.03)), x: zone.x + zone.w / 2 + k * between(-slackX, slackX), y: zone.y + zone.h / 2 + k * between(-slackY, slackY), angle: k * between(-0.09, 0.09), flip: random() < 0.5 };
        var light = { gain: 1 + k * between(-0.15, 0.12), slope: k * between(-0.15, 0.15), noise: 3 + k * between(-1, 5) };
        summary.total++;
        var results = [], lost = false;
        for (var still = 0; still < (window.FRAMES || 3); still++) {
          var shot = frame(placement, light);
          var found = Recognizer.locate(shot, empty, zone);
          if (!found) { lost = true; break; }
          results.push(Recognizer.describeProbe(shot, found));
        }
        if (lost) { summary.notFound++; continue; }
        var result = Recognizer.match(Recognizer.averageProbe(results), model);
        summary.samples.push([result.card === card ? 1 : 0, result.score, result.margin, result.margin, 0, card, result.card, placement.flip, +(placement.angle*57.3).toFixed(1)]);
        if (!result.sure) { summary.unsure++; summary.unsureCards.push(card + '→' + result.card + '(' + result.score.toFixed(2) + '/' + result.margin.toFixed(2) + ')'); }
        else if (result.card === card) summary.rightSure++;
        else { summary.wrongSure++; summary.mistakes.push(card + '→' + result.card); }
      }
    });
    summary.ms = (performance.now() - started) / summary.total;
    return summary;
  };
})();
