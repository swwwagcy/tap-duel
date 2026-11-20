// Demo camera: draws a felt table with playing cards and fresh sensor noise, so the reader can be
// tried with no phone and no deck. Also used by the automated tests.
(function (root) {
  'use strict';
  var SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  var seed = 98765;
  function random() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

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

  // palette (optional): ink colour per suit, e.g. { D: '#11a99a' } for a deck with teal diamonds.
  // font (optional): typeface of the index and court letters.
  function drawCard(ctx, card, cw, ch, palette, font) {
    font = font || 'Arial, sans-serif';
    var suit = card[0], rank = card.slice(1), red = suit === 'H' || suit === 'D';
    var ink = (palette && palette[suit]) || (red ? '#c8102e' : '#111');
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
      ctx.font = 'bold ' + Math.round(ch * 0.15) + 'px ' + font;
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

  // A canvas of any size with cards on it; place() swaps the cards, refresh adds new noise.
  function source(width, height, options) {
    options = options || {};
    var canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    var context = canvas.getContext('2d', { willReadFrequently: true });
    var base = document.createElement('canvas'); base.width = width; base.height = height;
    var baseContext = base.getContext('2d');
    baseContext.fillStyle = options.felt || '#1f5e3a'; baseContext.fillRect(0, 0, width, height);
    var grain = baseContext.getImageData(0, 0, width, height);
    for (var index = 0; index < grain.data.length; index += 4) { var g = (random() - 0.5) * 14; grain.data[index] += g; grain.data[index + 1] += g; grain.data[index + 2] += g; }
    baseContext.putImageData(grain, 0, 0);
    var placed = [];
    function redraw() {
      context.drawImage(base, 0, 0);
      placed.forEach(function (p) {
        context.save(); context.translate(p.x, p.y); context.rotate((p.angle || 0) + (p.flip ? Math.PI : 0));
        context.shadowColor = 'rgba(0,0,0,0.35)'; context.shadowBlur = 4; context.shadowOffsetY = 2;
        drawCard(context, p.card, p.h * 0.716, p.h, options.palette, options.font);
        context.restore();
      });
      var image = context.getImageData(0, 0, width, height);
      for (var index = 0; index < image.data.length; index += 4) { var n = (random() - 0.5) * 6; image.data[index] += n; image.data[index + 1] += n; image.data[index + 2] += n; }
      context.putImageData(image, 0, 0);
      return image;
    }
    redraw();
    var timer = options.still ? null : setInterval(redraw, 120);
    return {
      canvas: canvas,
      place: function (list) { placed = list.slice(); return redraw(); },
      placed: function () { return placed.slice(); },
      snapshot: redraw,
      stop: function () { if (timer) clearInterval(timer); }
    };
  }

  root.DemoCamera = { drawCard: drawCard, source: source };
})(typeof self !== 'undefined' ? self : this);
