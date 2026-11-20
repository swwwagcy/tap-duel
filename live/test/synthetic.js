// Synthetic table and cards for recognizer tests (runs in the browser).
(function () {
  var SUITS = ['S', 'H', 'D', 'C'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  var W = 640, H = 360;
  var seed = 12345;
  function random() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  function between(a, b) { return a + (b - a) * random(); }

  var drawCard = window.DemoCamera.drawCard;   // load public/demo-camera.js first

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








  window.SyntheticSource = function (width, height) { return window.DemoCamera.source(width, height); };

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
