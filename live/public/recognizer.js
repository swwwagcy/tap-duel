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
    // Two masks in one pass: pixels brighter than the empty table (ignores the card's shadow), and
    // pixels that differ from it in any way. The second is the fallback for a light table, where a
    // white card is barely brighter than what it lies on.
    var bright = new Uint8Array(W * H), any = new Uint8Array(W * H);
    var brightColumns = new Int32Array(W), brightRows = new Int32Array(H), anyColumns = new Int32Array(W), anyRows = new Int32Array(H);
    var nowPixel = [0, 0, 0], emptyPixel = [0, 0, 0];
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      rgbAt(frame, x0 + x, y0 + y, nowPixel); rgbAt(empty, x0 + x, y0 + y, emptyPixel);
      var lift = (0.299 * (nowPixel[0] - emptyPixel[0]) + 0.587 * (nowPixel[1] - emptyPixel[1]) + 0.114 * (nowPixel[2] - emptyPixel[2]));
      var change = Math.abs(nowPixel[0] - emptyPixel[0]) + Math.abs(nowPixel[1] - emptyPixel[1]) + Math.abs(nowPixel[2] - emptyPixel[2]);
      if (lift > 30) { bright[y * W + x] = 1; brightColumns[x]++; brightRows[y]++; }
      if (change > 60) { any[y * W + x] = 1; anyColumns[x]++; anyRows[y]++; }
    }
    var brightCount = 0, anyCount = 0;
    for (var cell = 0; cell < bright.length; cell++) { brightCount += bright[cell]; anyCount += any[cell]; }
    var mask = bright, spanX = longestRun(brightColumns), spanY = longestRun(brightRows), lightTable = false;
    // On a light table only part of the card clears the brightness bar; when far fewer pixels are
    // brighter than are different, the brighter set is a fragment of the card, not the card.
    if (!spanX || !spanY || (spanX[1] - spanX[0]) * (spanY[1] - spanY[0]) < 60 || brightCount < anyCount * 0.6) {
      mask = any; spanX = longestRun(anyColumns); spanY = longestRun(anyRows); lightTable = true;
    }
    if (!spanX || !spanY) return null;
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
