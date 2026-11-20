// Finding a card in a position: is something there, is it resting, and where exactly is it
// (centre, size, angle), judged against the table (a photo of it, or just its colour).
// Reading the card itself is ocr.js. Pure functions of pixel data.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Recognizer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CARD_ASPECT = 0.716;            // width / height of a poker-size card (63 x 88 mm)
  var SIGNATURE_W = 24, SIGNATURE_H = 32;
  var DEFAULTS = { presence: 0.10, stillness: 7 };

  function clampIndex(value, max) { return value < 0 ? 0 : value > max ? max : value; }
  function lumaAt(frame, x, y) {
    var index = (clampIndex(y | 0, frame.height - 1) * frame.width + clampIndex(x | 0, frame.width - 1)) * 4, data = frame.data;
    return 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
  }
  function rgbAt(frame, x, y, out) {
    if (frame.colour) { out[0] = frame.colour[0]; out[1] = frame.colour[1]; out[2] = frame.colour[2]; return out; }   // a plain table of one colour
    var index = (clampIndex(y | 0, frame.height - 1) * frame.width + clampIndex(x | 0, frame.width - 1)) * 4, data = frame.data;
    out[0] = data[index]; out[1] = data[index + 1]; out[2] = data[index + 2];
    return out;
  }

  // Average colour over a grid of cells covering rect (in frame pixels). 3x3 samples per cell.
  function sampleRGB(frame, rect, outW, outH) {
    var out = new Float32Array(outW * outH * 3), pixel = [0, 0, 0];
    var stepX = rect.w / outW, stepY = rect.h / outH;
    for (var oy = 0; oy < outH; oy++) for (var ox = 0; ox < outW; ox++) {
      var r = 0, g = 0, b = 0;
      for (var j = 0; j < 3; j++) for (var i = 0; i < 3; i++) {
        rgbAt(frame, rect.x + (ox + (i + 0.5) / 3) * stepX, rect.y + (oy + (j + 0.5) / 3) * stepY, pixel);
        r += pixel[0]; g += pixel[1]; b += pixel[2];
      }
      var at = (oy * outW + ox) * 3;
      out[at] = r / 9; out[at + 1] = g / 9; out[at + 2] = b / 9;
    }
    return out;
  }

  /* ---------------- presence and stillness ---------------- */

  function signature(frame, rect) { return sampleRGB(frame, rect, SIGNATURE_W, SIGNATURE_H); }
  // Share of cells that differ clearly from the empty table: how much of the zone is covered.
  function coverage(current, empty) {
    var covered = 0, cells = current.length / 3;
    for (var index = 0; index < current.length; index += 3) {
      var diff = Math.abs(current[index] - empty[index]) + Math.abs(current[index + 1] - empty[index + 1]) + Math.abs(current[index + 2] - empty[index + 2]);
      if (diff > 60) covered++;
    }
    return covered / cells;
  }
  // Mean change between two signatures of the same zone: small means nothing is moving.
  function motion(a, b) {
    var total = 0;
    for (var index = 0; index < a.length; index++) total += Math.abs(a[index] - b[index]);
    return total / a.length;
  }

  /* ---------------- finding the card inside a zone ---------------- */

  // Returns { cx, cy, w, h, angle } in frame pixels: centre, card width/height and the rotation of
  // the card's long side away from vertical (radians), or null when nothing card-shaped is there.
  // Works on the zone at full resolution and only on pixels brighter than the empty table, so the
  // card's shadow does not make it look bigger. The table has to be darker than the cards.
  function locate(frame, empty, rect) {
    var x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
    var x1 = Math.min(frame.width - 1, Math.ceil(rect.x + rect.w)), y1 = Math.min(frame.height - 1, Math.ceil(rect.y + rect.h));
    var W = x1 - x0 + 1, H = y1 - y0 + 1;
    if (W < 8 || H < 8) return null;
    // The card is whatever differs from the table, except the table's own shadow: a pixel that is
    // only darker than the table, by about the same share in every colour. (Judging by brightness
    // alone fails when part of a white card lies in shade on a light table.) Dark printing on the
    // card is nothing like a shadow, so the card comes out whole.
    var mask = new Uint8Array(W * H), columns = new Int32Array(W), rows = new Int32Array(H);
    var nowPixel = [0, 0, 0], emptyPixel = [0, 0, 0];
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      rgbAt(frame, x0 + x, y0 + y, nowPixel); rgbAt(empty, x0 + x, y0 + y, emptyPixel);
      var change = Math.abs(nowPixel[0] - emptyPixel[0]) + Math.abs(nowPixel[1] - emptyPixel[1]) + Math.abs(nowPixel[2] - emptyPixel[2]);
      if (change <= 45) continue;
      var r0 = (nowPixel[0] + 8) / (emptyPixel[0] + 8), r1 = (nowPixel[1] + 8) / (emptyPixel[1] + 8), r2 = (nowPixel[2] + 8) / (emptyPixel[2] + 8);
      var low = Math.min(r0, r1, r2), high = Math.max(r0, r1, r2);
      if (high <= 1.02 && low >= 0.4 && high - low < 0.14) continue;      // shadow on the table
      // On a clearly coloured table, a patch that is the table's own hue but lit more strongly is
      // still table (light falls unevenly across a mat). Not applied to grey, white or black tables,
      // where a white card is itself just a brighter version of the table.
      var tableMax = Math.max(emptyPixel[0], emptyPixel[1], emptyPixel[2]), tableMin = Math.min(emptyPixel[0], emptyPixel[1], emptyPixel[2]);
      if (tableMax > 60 && (tableMax - tableMin) / tableMax > 0.15 && high <= 1.6 && low >= 0.4 && high - low < 0.25) continue;
      mask[y * W + x] = 1; columns[x]++; rows[y]++;
    }
    // Other things in the frame also differ from the table (the edge of the mat, a hand, the next
    // card). Split what was found into separate pieces and keep the one that is most like a card:
    // big, compact, and not running out of the frame. Everything else is dropped.
    var lightTable = false, cell = Math.max(1, Math.ceil(Math.max(W, H) / 110));
    var gridW = Math.ceil(W / cell), gridH = Math.ceil(H / cell), grid = new Uint8Array(gridW * gridH), fill = new Uint16Array(gridW * gridH);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) if (mask[y * W + x]) fill[((y / cell) | 0) * gridW + ((x / cell) | 0)]++;
    for (var g = 0; g < grid.length; g++) grid[g] = fill[g] * 2 >= cell * cell ? 1 : 0;
    var labels = new Int32Array(gridW * gridH), pieces = [], stack = [];
    for (g = 0; g < grid.length; g++) {
      if (!grid[g] || labels[g]) continue;
      var piece = { id: pieces.length + 1, area: 0, x0: gridW, y0: gridH, x1: -1, y1: -1, edge: 0 };
      stack.push(g); labels[g] = piece.id;
      while (stack.length) {
        var here = stack.pop(), gx = here % gridW, gy = (here - gx) / gridW;
        piece.area++;
        if (gx < piece.x0) piece.x0 = gx; if (gx > piece.x1) piece.x1 = gx; if (gy < piece.y0) piece.y0 = gy; if (gy > piece.y1) piece.y1 = gy;
        if (gx === 0 || gy === 0 || gx === gridW - 1 || gy === gridH - 1) piece.edge++;
        if (gx > 0 && grid[here - 1] && !labels[here - 1]) { labels[here - 1] = piece.id; stack.push(here - 1); }
        if (gx < gridW - 1 && grid[here + 1] && !labels[here + 1]) { labels[here + 1] = piece.id; stack.push(here + 1); }
        if (gy > 0 && grid[here - gridW] && !labels[here - gridW]) { labels[here - gridW] = piece.id; stack.push(here - gridW); }
        if (gy < gridH - 1 && grid[here + gridW] && !labels[here + gridW]) { labels[here + gridW] = piece.id; stack.push(here + gridW); }
      }
      pieces.push(piece);
    }
    var chosen = null, bestScore = 0;
    pieces.forEach(function (candidate) {
      var boxArea = (candidate.x1 - candidate.x0 + 1) * (candidate.y1 - candidate.y0 + 1);
      if (candidate.area < grid.length * 0.03) return;
      var compact = candidate.area / boxArea;                                        // a card fills its own outline
      var outside = candidate.edge / (2 * (candidate.x1 - candidate.x0 + candidate.y1 - candidate.y0 + 2));   // share of its outline on the frame's edge
      var score = candidate.area * compact * (outside > 0.2 ? 0.25 : 1);
      if (score > bestScore) { bestScore = score; chosen = candidate; }
    });
    if (!chosen) return null;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      var gx2 = (x / cell) | 0, gy2 = (y / cell) | 0, keep = false;
      for (var ny = Math.max(0, gy2 - 1); ny <= Math.min(gridH - 1, gy2 + 1) && !keep; ny++) for (var nx = Math.max(0, gx2 - 1); nx <= Math.min(gridW - 1, gx2 + 1); nx++) if (labels[ny * gridW + nx] === chosen.id) { keep = true; break; }
      if (!keep) mask[y * W + x] = 0;
    }
    var spanX = [Math.max(0, (chosen.x0 - 1) * cell), Math.min(W - 1, (chosen.x1 + 2) * cell - 1)], spanY = [Math.max(0, (chosen.y0 - 1) * cell), Math.min(H - 1, (chosen.y1 + 2) * cell - 1)];
    var count = 0, sumX = 0, sumY = 0;
    for (y = spanY[0]; y <= spanY[1]; y++) for (x = spanX[0]; x <= spanX[1]; x++) if (mask[y * W + x]) { count++; sumX += x; sumY += y; }
    if (count < 60) return null;
    var meanX = sumX / count, meanY = sumY / count, xx = 0, yy = 0, xy = 0;
    for (y = spanY[0]; y <= spanY[1]; y++) for (x = spanX[0]; x <= spanX[1]; x++) if (mask[y * W + x]) {
      var dx = x - meanX, dy = y - meanY; xx += dx * dx; yy += dy * dy; xy += dx * dy;
    }
    var major = 0.5 * Math.atan2(2 * xy, xx - yy);     // angle of the long axis against the x axis
    var angle = major - Math.PI / 2;                     // long axis against vertical
    while (angle <= -Math.PI / 2) angle += Math.PI;
    while (angle > Math.PI / 2) angle -= Math.PI;
    // The print inside the card leaves holes in the mask, which pulls the moment angle off by a few
    // degrees. A rectangle projects most compactly onto its own axes, so search nearby angles for
    // the most compact projection, then measure the card along those axes where each profile is at
    // least half its peak.
    var points = [];
    for (y = spanY[0]; y <= spanY[1]; y++) for (x = spanX[0]; x <= spanX[1]; x++) if (mask[y * W + x]) points.push(x - meanX, y - meanY);
    var reach = Math.ceil(Math.sqrt(W * W + H * H));
    function project(theta) {
      var cosT = Math.cos(theta), sinT = Math.sin(theta);
      var across = new Int32Array(2 * reach + 1), along = new Int32Array(2 * reach + 1), compact = 0;
      for (var at = 0; at < points.length; at += 2) {
        across[Math.round(points[at] * cosT + points[at + 1] * sinT) + reach]++;
        along[Math.round(-points[at] * sinT + points[at + 1] * cosT) + reach]++;
      }
      for (var bin = 0; bin < across.length; bin++) compact += across[bin] * across[bin] + along[bin] * along[bin];
      return { across: across, along: along, compact: compact };
    }
    var best = null, step = Math.PI / 720;
    for (var turn = -20; turn <= 20; turn++) {
      var tried = project(angle + turn * step);
      if (!best || tried.compact > best.compact) { best = tried; best.angle = angle + turn * step; }
    }
    angle = best.angle;
    var cos = Math.cos(angle), sin = Math.sin(angle);
    var spanU = halfPeak(best.across), spanV = halfPeak(best.along);
    if (!spanU || !spanV) return null;
    var width = spanU[1] - spanU[0] + 1, height = spanV[1] - spanV[0] + 1;
    if (width / height > 1.2 || width / height < 0.45) {
      // Not card-shaped (a hand, two cards, a card on its side): fall back to the box and the aspect.
      var c = Math.abs(cos), s = Math.abs(sin), boxW = spanX[1] - spanX[0] + 1, boxH = spanY[1] - spanY[0] + 1;
      height = (boxW + boxH) / ((1 + CARD_ASPECT) * (c + s)); width = height * CARD_ASPECT;
      return { cx: x0 + meanX + 0.5, cy: y0 + meanY + 0.5, w: width, h: height, angle: angle, shaped: false, lightTable: lightTable };
    }
    var midU = (spanU[0] + spanU[1]) / 2 - reach, midV = (spanV[0] + spanV[1]) / 2 - reach;
    return { cx: x0 + meanX + 0.5 + midU * cos - midV * sin, cy: y0 + meanY + 0.5 + midU * sin + midV * cos, w: width, h: height, angle: angle, shaped: true, lightTable: lightTable };
  }
  function halfPeak(profile) {
    var peak = 0, index;
    for (index = 0; index < profile.length; index++) if (profile[index] > peak) peak = profile[index];
    if (peak < 3) return null;
    var first = -1, last = -1;
    for (index = 0; index < profile.length; index++) if (profile[index] >= peak / 2) { if (first < 0) first = index; last = index; }
    return [first, last];
  }
  // The widest stretch of rows/columns that are clearly covered, allowing one-cell gaps.
  function longestRun(counts) {
    var peak = 0;
    for (var index = 0; index < counts.length; index++) if (counts[index] > peak) peak = counts[index];
    if (peak < 4) return null;
    var limit = peak * 0.35, best = null, start = -1, gap = 0;
    for (index = 0; index <= counts.length; index++) {
      var on = index < counts.length && counts[index] >= limit;
      if (on) { if (start < 0) start = index; gap = 0; }
      else if (start >= 0) {
        gap++;
        if (gap > 1 || index === counts.length) {
          var end = index - gap;
          if (!best || end - start > best[1] - best[0]) best = [start, end];
          start = -1; gap = 0;
        }
      }
    }
    return best;
  }

  return { DEFAULTS: DEFAULTS, signature: signature, coverage: coverage, motion: motion, locate: locate };
});
