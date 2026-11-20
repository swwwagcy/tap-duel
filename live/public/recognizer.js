// Optical card recognition with no model and no library: each card position is compared with a
// photo of the empty table to find the card, the card is straightened and scaled to a fixed size,
// and it is compared with the 52 reference images taken of this deck on this table.
// Everything here is a pure function of pixel data, so it runs the same in the page and in tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Recognizer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CARD_ASPECT = 0.716;            // width / height of a poker-size card (63 x 88 mm)
  var FULL_W = 40, FULL_H = 56;       // whole card, compared coarsely
  // The top-left corner holds the index (rank and suit). Rank and suit are judged separately, each
  // with its own per-pixel weights learned from the 52 reference images: a pixel that differs
  // between ranks but not between suits of the same rank counts for the rank, and the other way
  // round for the suit. The card's edge looks the same on every card, so it gets no weight. This
  // works for any deck layout without telling it where the index is.
  var CORNER_BOX = [0.0, 0.0, 0.34, 0.36], CORNER_W = 32, CORNER_H = 47;
  var SHIFTS = [-0.02, -0.01, 0, 0.01, 0.02];
  var SIGNATURE_W = 24, SIGNATURE_H = 32;
  var DEFAULTS = { presence: 0.10, stillness: 7, minScore: 0.6, minMargin: 0.35 };

  function clampIndex(value, max) { return value < 0 ? 0 : value > max ? max : value; }
  function lumaAt(frame, x, y) {
    var index = (clampIndex(y | 0, frame.height - 1) * frame.width + clampIndex(x | 0, frame.width - 1)) * 4, data = frame.data;
    return 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
  }
  function rgbAt(frame, x, y, out) {
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
    var mask = new Uint8Array(W * H), columns = new Int32Array(W), rows = new Int32Array(H);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      if (lumaAt(frame, x0 + x, y0 + y) - lumaAt(empty, x0 + x, y0 + y) > 30) { mask[y * W + x] = 1; columns[x]++; rows[y]++; }
    }
    var spanX = longestRun(columns), spanY = longestRun(rows);
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
      return { cx: x0 + meanX + 0.5, cy: y0 + meanY + 0.5, w: width, h: height, angle: angle, shaped: false };
    }
    var midU = (spanU[0] + spanU[1]) / 2 - reach, midV = (spanV[0] + spanV[1]) / 2 - reach;
    return { cx: x0 + meanX + 0.5 + midU * cos - midV * sin, cy: y0 + meanY + 0.5 + midU * sin + midV * cos, w: width, h: height, angle: angle, shaped: true };
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

  /* ---------------- straightening and describing a card ---------------- */

  // Grey image of part of the card. (u0, v0)-(u1, v1) are fractions of the upright card;
  // flip turns the card 180 degrees first.
  function sampleCard(frame, card, flip, u0, v0, u1, v1, outW, outH) {
    var out = new Float32Array(outW * outH);
    var cos = Math.cos(card.angle), sin = Math.sin(card.angle), sign = flip ? -1 : 1;
    for (var oy = 0; oy < outH; oy++) for (var ox = 0; ox < outW; ox++) {
      var total = 0;
      for (var j = 0; j < 2; j++) for (var i = 0; i < 2; i++) {
        var u = u0 + (u1 - u0) * (ox + (i + 0.5) / 2) / outW, v = v0 + (v1 - v0) * (oy + (j + 0.5) / 2) / outH;
        var lx = sign * (u - 0.5) * card.w, ly = sign * (v - 0.5) * card.h;
        total += lumaAt(frame, card.cx + lx * cos - ly * sin, card.cy + lx * sin + ly * cos);
      }
      out[oy * outW + ox] = total / 4;
    }
    return out;
  }
  // Zero mean, unit length: comparing two of these with a dot product ignores brightness and contrast.
  function normalise(values) {
    var mean = 0, index;
    for (index = 0; index < values.length; index++) mean += values[index];
    mean /= values.length;
    var out = new Float32Array(values.length), norm = 0;
    for (index = 0; index < values.length; index++) { out[index] = values[index] - mean; norm += out[index] * out[index]; }
    norm = Math.sqrt(norm) || 1;
    for (index = 0; index < values.length; index++) out[index] /= norm;
    return out;
  }
  function dot(a, b) { var total = 0; for (var index = 0; index < a.length; index++) total += a[index] * b[index]; return total; }

  // How red the printing on the card is: positive for hearts and diamonds, near zero for black suits.
  function redness(frame, card) {
    var cos = Math.cos(card.angle), sin = Math.sin(card.angle), pixel = [0, 0, 0], samples = [];
    for (var j = 0; j < 28; j++) for (var i = 0; i < 20; i++) {
      var lx = ((i + 0.5) / 20 - 0.5) * card.w * 0.9, ly = ((j + 0.5) / 28 - 0.5) * card.h * 0.9;
      rgbAt(frame, card.cx + lx * cos - ly * sin, card.cy + lx * sin + ly * cos, pixel);
      samples.push([pixel[0], pixel[1], pixel[2], 0.299 * pixel[0] + 0.587 * pixel[1] + 0.114 * pixel[2]]);
    }
    var brightest = 0;
    samples.forEach(function (sample) { if (sample[3] > brightest) brightest = sample[3]; });
    var ink = samples.filter(function (sample) { return sample[3] < brightest * 0.7; });
    if (ink.length < 6) return 0;
    var total = 0;
    ink.forEach(function (sample) { total += (sample[0] - (sample[1] + sample[2]) / 2) / 255; });
    return total / ink.length;
  }

  // A light blur before comparing, so that half a pixel of misplacement does not change the shape.
  function blur(values, width, height) {
    var out = new Float32Array(values.length);
    for (var y = 0; y < height; y++) for (var x = 0; x < width; x++) {
      var total = 0, count = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        var weight = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
        total += values[yy * width + xx] * weight; count += weight;
      }
      out[y * width + x] = total / count;
    }
    return out;
  }
  function corner(frame, card, flip, du, dv) {
    return blur(sampleCard(frame, card, flip, CORNER_BOX[0] + du, CORNER_BOX[1] + dv, CORNER_BOX[2] + du, CORNER_BOX[3] + dv, CORNER_W, CORNER_H), CORNER_W, CORNER_H);
  }
  // Raw grey values of one card, as stored for a reference image (taken the way it was placed).
  function describeRaw(frame, card) {
    return { full: sampleCard(frame, card, false, 0, 0, 1, 1, FULL_W, FULL_H), corner: corner(frame, card, false, 0, 0), red: redness(frame, card) };
  }
  // The probe is described both ways up, and its corner is taken at small offsets so a card that
  // was located a little off-centre still lines up with its reference.
  function describeProbe(frame, card) {
    var views = [false, true].map(function (flip) {
      var corners = [];
      SHIFTS.forEach(function (du) { SHIFTS.forEach(function (dv) { corners.push(corner(frame, card, flip, du, dv)); }); });
      return { full: normalise(sampleCard(frame, card, flip, 0, 0, 1, 1, FULL_W, FULL_H)), corners: corners };
    });
    return { views: views, red: redness(frame, card) };
  }

  /* ---------------- learning which pixels matter ---------------- */

  // Fisher weight per pixel: spread between class averages over spread inside each class.
  function fisherWeights(images, classOf) {
    var length = images[0].length, groups = {}, overall = new Float64Array(length);
    images.forEach(function (image, index) {
      var key = classOf(index);
      if (!groups[key]) groups[key] = { sum: new Float64Array(length), count: 0, members: [] };
      for (var p = 0; p < length; p++) { groups[key].sum[p] += image[p]; overall[p] += image[p]; }
      groups[key].count++; groups[key].members.push(image);
    });
    for (var p = 0; p < length; p++) overall[p] /= images.length;
    var between = new Float64Array(length), within = new Float64Array(length), keys = Object.keys(groups);
    keys.forEach(function (key) {
      var group = groups[key];
      for (var p = 0; p < length; p++) {
        var mean = group.sum[p] / group.count, gap = mean - overall[p];
        between[p] += gap * gap;
        group.members.forEach(function (image) { var spread = image[p] - mean; within[p] += spread * spread; });
      }
    });
    var weights = new Float32Array(length), floor = 0, peak = 0;
    for (p = 0; p < length; p++) floor += within[p];
    floor = floor / length / images.length * 0.25 + 1e-9;
    for (p = 0; p < length; p++) {
      weights[p] = (between[p] / keys.length) / (within[p] / images.length + floor);
      if (weights[p] > peak) peak = weights[p];
    }
    for (p = 0; p < length; p++) weights[p] /= peak || 1;
    return weights;
  }
  // Weighted zero-mean unit-length vector, so a plain dot product is a weighted correlation.
  function weighted(values, weights) {
    var total = 0, mass = 0, index;
    for (index = 0; index < values.length; index++) { total += weights[index] * values[index]; mass += weights[index]; }
    var mean = total / (mass || 1), out = new Float32Array(values.length), norm = 0;
    for (index = 0; index < values.length; index++) { out[index] = Math.sqrt(weights[index]) * (values[index] - mean); norm += out[index] * out[index]; }
    norm = Math.sqrt(norm) || 1;
    for (index = 0; index < values.length; index++) out[index] /= norm;
    return out;
  }
  // Builds everything matching needs from the registered cards: [{ card, raw }].
  function buildModel(entries) {
    var uniform = new Float32Array(CORNER_W * CORNER_H).fill(1);
    var corners = entries.map(function (entry) { return normalise(entry.raw.corner); });
    var enough = entries.length >= 8;
    var rankWeights = enough ? fisherWeights(corners, function (index) { return entries[index].card.slice(1); }) : uniform;
    var suitWeights = enough ? fisherWeights(corners, function (index) { return entries[index].card[0]; }) : uniform;
    var templates = entries.map(function (entry, index) {
      return {
        card: entry.card, rank: entry.card.slice(1), suit: entry.card[0],
        full: normalise(entry.raw.full), cornerImage: corners[index],
        rankImage: weighted(corners[index], rankWeights), suitImage: weighted(corners[index], suitWeights),
        red: entry.raw.red, isRed: entry.card[0] === 'H' || entry.card[0] === 'D'
      };
    });
    return { templates: templates, rankWeights: rankWeights, suitWeights: suitWeights, colour: redThreshold(templates) };
  }

  /* ---------------- matching ---------------- */

  function redThreshold(templates) {
    var red = [], black = [];
    templates.forEach(function (template) { (template.isRed ? red : black).push(template.red); });
    if (!red.length || !black.length) return null;
    var average = function (list) { return list.reduce(function (a, b) { return a + b; }, 0) / list.length; };
    var redAverage = average(red), blackAverage = average(black);
    if (redAverage - blackAverage < 0.03) return null;      // colour does not separate the suits on this table
    return { cut: (redAverage + blackAverage) / 2, spread: (redAverage - blackAverage) / 2 };
  }

  // Best correlation of any of the shifted probe images with a reference, and which shift gave it.
  function bestOf(candidates, image) {
    var best = -1, at = 0;
    for (var index = 0; index < candidates.length; index++) { var value = dot(candidates[index], image); if (value > best) { best = value; at = index; } }
    return { score: best, at: at };
  }
  // Two references can look alike overall (spade and club, 5 and 6) and still differ in a few pixels.
  // This looks only along their difference: +1 means the probe is exactly the first, -1 the second.
  function separation(candidates, first, second) {
    var similarity = dot(first.image, second.image);
    if (similarity > 0.995) return 0;
    // Both references are compared at the offset that fits the leader best; letting the runner-up
    // pick its own offset would let it borrow a better fit from a misaligned view.
    var probe = candidates[first.at];
    return (dot(probe, first.image) - dot(probe, second.image)) / (1 - similarity);
  }
  // For one part (rank or suit): the best reference per class, sorted.
  function classify(candidates, templates, keyOf, imageOf, penalty) {
    var best = {};
    templates.forEach(function (template) {
      var found = bestOf(candidates, imageOf(template));
      var score = found.score - (penalty ? penalty(template) : 0);
      var key = keyOf(template);
      if (!best[key] || score > best[key].score) best[key] = { key: key, score: score, at: found.at, image: imageOf(template) };
    });
    return Object.keys(best).map(function (key) { return best[key]; }).sort(function (a, b) { return b.score - a.score; });
  }

  // Decides rank and suit separately. Sure only when each one clearly beats its runner-up on the
  // pixels where the two differ, the colour of the print agrees with the suit, and the whole card
  // also looks like the chosen card.
  function match(probe, model, options) {
    options = options || {};
    var minScore = options.minScore != null ? options.minScore : DEFAULTS.minScore;
    var minMargin = options.minMargin != null ? options.minMargin : DEFAULTS.minMargin;
    var templates = model.templates, colour = model.colour;
    if (!templates.length || !probe.views.length) return { card: null, score: 0, margin: 0, top: [], sure: false };
    var probeRed = null;
    if (colour) {
      var away = (probe.red - colour.cut) / colour.spread;
      if (away > 0.5) probeRed = true; else if (away < -0.5) probeRed = false;
    }
    var colourPenalty = probeRed === null ? null : function (template) { return probeRed !== template.isRed ? 0.2 : 0; };
    // A card carries its index twice, top-left and (upside down) bottom-right. Each corner is read on
    // its own, and the answer counts as sure only when both corners agree: two independent readings
    // of different pixels.
    var readings = probe.views.map(function (view) {
      var normalised = view.corners.map(normalise);
      var rankViews = normalised.map(function (image) { return weighted(image, model.rankWeights); });
      var suitViews = normalised.map(function (image) { return weighted(image, model.suitWeights); });
      var ranks = classify(rankViews, templates, function (t) { return t.rank; }, function (t) { return t.rankImage; }, null);
      var suits = classify(suitViews, templates, function (t) { return t.suit; }, function (t) { return t.suitImage; }, colourPenalty);
      return {
        view: view, ranks: ranks, suits: suits,
        card: suits[0].key + ranks[0].key,
        rankMargin: ranks[1] ? separation(rankViews, ranks[0], ranks[1]) : 1,
        suitMargin: suits[1] ? separation(suitViews, suits[0], suits[1]) : 1
      };
    });
    var lead = readings[0].ranks[0].score + readings[0].suits[0].score >= (readings[1] ? readings[1].ranks[0].score + readings[1].suits[0].score : -9) ? readings[0] : readings[1];
    var other = readings.length > 1 ? (lead === readings[0] ? readings[1] : readings[0]) : null;
    var agree = !other || other.card === lead.card;
    var chosen = { view: lead.view, ranks: lead.ranks, suits: lead.suits };
    var rank = chosen.ranks[0], suit = chosen.suits[0], card = suit.key + rank.key;
    var rankMargin = other && agree ? Math.min(lead.rankMargin, other.rankMargin) : lead.rankMargin;
    var suitMargin = other && agree ? Math.min(lead.suitMargin, other.suitMargin) : lead.suitMargin;
    var template = templates.find(function (t) { return t.card === card; });
    var full = template ? dot(chosen.view.full, template.full) : -1;
    var colourOk = probeRed === null || probeRed === (suit.key === 'H' || suit.key === 'D');
    var score = Math.min(rank.score, suit.score), margin = Math.min(rankMargin, suitMargin);
    var top = [{ card: card, score: score }];
    if (chosen.ranks[1]) top.push({ card: suit.key + chosen.ranks[1].key, score: Math.min(chosen.ranks[1].score, suit.score) });
    if (chosen.suits[1]) top.push({ card: chosen.suits[1].key + rank.key, score: Math.min(rank.score, chosen.suits[1].score) });
    top.sort(function (a, b) { return b.score - a.score; });
    return {
      card: card, score: score, margin: margin, rankMargin: rankMargin, suitMargin: suitMargin, full: full, top: top, agree: agree,
      other: other ? other.card : null,
      sure: agree && score >= minScore && margin >= minMargin && full >= 0.4 && colourOk
    };
  }

  // Registration takes a few frames of the same card and keeps their average: less sensor noise.
  function averageRaw(list) {
    var first = list[0], full = new Float32Array(first.full.length), cornerImage = new Float32Array(first.corner.length), red = 0;
    list.forEach(function (raw) {
      for (var index = 0; index < full.length; index++) full[index] += raw.full[index] / list.length;
      for (index = 0; index < cornerImage.length; index++) cornerImage[index] += raw.corner[index] / list.length;
      red += raw.red / list.length;
    });
    return { full: full, corner: cornerImage, red: red };
  }
  // Several frames of the same resting card, averaged view by view before matching: the card is
  // still, the sensor noise is not, so averaging keeps the card and drops the noise.
  function averageProbe(probes) {
    var count = probes.length, first = probes[0];
    return {
      red: probes.reduce(function (total, probe) { return total + probe.red; }, 0) / count,
      views: first.views.map(function (view, viewIndex) {
        var full = new Float32Array(view.full.length);
        var corners = view.corners.map(function (cornerImage) { return new Float32Array(cornerImage.length); });
        probes.forEach(function (probe) {
          var other = probe.views[viewIndex];
          for (var index = 0; index < full.length; index++) full[index] += other.full[index] / count;
          other.corners.forEach(function (cornerImage, at) { for (var index = 0; index < cornerImage.length; index++) corners[at][index] += cornerImage[index] / count; });
        });
        return { full: normalise(full), corners: corners };
      })
    };
  }
  // Raw grey values <-> compact text for storage.
  function encodeRaw(raw) {
    var bytes = new Uint8Array(raw.full.length + raw.corner.length);
    var index = 0;
    [raw.full, raw.corner].forEach(function (list) { list.forEach(function (value) { bytes[index++] = Math.max(0, Math.min(255, Math.round(value))); }); });
    var text = '';
    for (index = 0; index < bytes.length; index++) text += String.fromCharCode(bytes[index]);
    return { g: (typeof btoa === 'function' ? btoa(text) : Buffer.from(text, 'binary').toString('base64')), r: Math.round(raw.red * 1000) / 1000 };
  }
  function decodeRaw(stored) {
    var text = typeof atob === 'function' ? atob(stored.g) : Buffer.from(stored.g, 'base64').toString('binary');
    var lists = [new Float32Array(FULL_W * FULL_H), new Float32Array(CORNER_W * CORNER_H)], at = 0;
    lists.forEach(function (list) { for (var index = 0; index < list.length; index++) list[index] = text.charCodeAt(at++); });
    return { full: lists[0], corner: lists[1], red: stored.r };
  }

  return {
    DEFAULTS: DEFAULTS, FULL_W: FULL_W, FULL_H: FULL_H,
    signature: signature, coverage: coverage, motion: motion, locate: locate,
    describeRaw: describeRaw, buildModel: buildModel, describeProbe: describeProbe,
    match: match, averageRaw: averageRaw, averageProbe: averageProbe, redThreshold: redThreshold, encodeRaw: encodeRaw, decodeRaw: decodeRaw
  };
});
