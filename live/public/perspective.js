// A camera that looks at the table from the side sees it as a slanted four-sided shape. Given
// the four corners of a rectangle lying on the table, this redraws the picture as if taken from
// straight above, so everything after it (finding and reading cards) works on an upright table.
// Pure arithmetic, no camera model to enter: the shape of the rectangle is worked out from the
// four corners themselves.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Perspective = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The 3x3 mapping (row by row, nine numbers) that takes each of four points to its partner.
  function mapping(from, to) {
    var rows = [], index;
    for (index = 0; index < 4; index++) {
      var x = from[index][0], y = from[index][1], u = to[index][0], v = to[index][1];
      rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    // Gaussian elimination with partial pivoting on the 8x9 system.
    for (var col = 0; col < 8; col++) {
      var pivot = col;
      for (var row = col + 1; row < 8; row++) if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
      if (Math.abs(rows[pivot][col]) < 1e-12) return null;      // three corners in a line
      var keep = rows[col]; rows[col] = rows[pivot]; rows[pivot] = keep;
      for (row = 0; row < 8; row++) {
        if (row === col) continue;
        var factor = rows[row][col] / rows[col][col];
        if (factor) for (var k = col; k < 9; k++) rows[row][k] -= factor * rows[col][k];
      }
    }
    var h = [];
    for (index = 0; index < 8; index++) h.push(rows[index][8] / rows[index][index]);
    h.push(1);
    return h;
  }

  function apply(h, x, y) {
    var w = h[6] * x + h[7] * y + h[8];
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  }

  function distance(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  // Corners must go round the shape (top-left, top-right, bottom-right, bottom-left) without the
  // outline crossing itself or folding inward.
  function usable(quad) {
    var sign = 0;
    for (var index = 0; index < 4; index++) {
      var a = quad[index], b = quad[(index + 1) % 4], c = quad[(index + 2) % 4];
      var cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) < 1e-6) return false;
      if (sign && (cross > 0) !== (sign > 0)) return false;
      sign = cross;
    }
    return true;
  }

  // Width divided by height of the real rectangle whose corners appear at quad in a picture of
  // the given size. Uses the usual assumptions (the lens looks through the middle of the picture,
  // pixels are square). When the two pairs of sides are close to parallel in the picture there is
  // no slant to measure, and the shape in the picture is the answer.
  function aspect(quad, width, height) {
    var cx = width / 2, cy = height / 2;
    function hom(point) { return [point[0] - cx, point[1] - cy, 1]; }
    function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
    function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    var m1 = hom(quad[0]), m2 = hom(quad[1]), m3 = hom(quad[3]), m4 = hom(quad[2]);
    var flat = (distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / (distance(quad[0], quad[3]) + distance(quad[1], quad[2]));
    var k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3), k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
    var n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 - 1], n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 - 1];
    var scale = Math.max(width, height);
    var result = flat;
    if (Math.abs(n2[2]) > 1e-4 && Math.abs(n3[2]) > 1e-4) {
      // Both pairs of sides converge: the focal length follows from the corners.
      var f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
      if (f2 > 0.04 * scale * scale && f2 < 100 * scale * scale) {
        result = Math.sqrt((n2[0] * n2[0] + n2[1] * n2[1] + n2[2] * n2[2] * f2) / (n3[0] * n3[0] + n3[1] * n3[1] + n3[2] * n3[2] * f2));
      }
    } else if (Math.abs(n2[2]) > 1e-4 || Math.abs(n3[2]) > 1e-4) {
      // One pair converges (the camera tilts along one side of the rectangle, the common case of a
      // phone on a stand in front of the table). The focal length cannot be found from that alone;
      // a phone's main camera is close to 0.75 of the picture's longer side, which is used here.
      var f = 0.75 * scale, ff = f * f;
      result = Math.sqrt((n2[0] * n2[0] + n2[1] * n2[1] + n2[2] * n2[2] * ff) / (n3[0] * n3[0] + n3[1] * n3[1] + n3[2] * n3[2] * ff));
    }
    if (!isFinite(result) || result <= 0) result = flat;
    return Math.max(0.2, Math.min(5, result));
  }

  // Size of the straightened picture: as fine as the nearest (largest) side of the shape, so no
  // detail the camera caught is thrown away, within the given limits.
  function outputSize(quad, width, height, maxWidth, maxHeight) {
    var ratio = aspect(quad, width, height);
    var across = Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2]));
    var down = Math.max(distance(quad[0], quad[3]), distance(quad[1], quad[2]));
    var outWidth = Math.max(across, down * ratio), outHeight = outWidth / ratio;
    var shrink = Math.min(1, maxWidth / outWidth, maxHeight / outHeight);
    return { width: Math.max(16, Math.round(outWidth * shrink)), height: Math.max(16, Math.round(outHeight * shrink)), aspect: ratio };
  }

  // Fills out (an ImageData-like { width, height, data }) with the part of source inside quad,
  // straightened. Each output pixel is looked up in the source and blended from its four
  // neighbours.
  function warp(source, quad, out) {
    var W = out.width, H = out.height, sw = source.width, sh = source.height, sd = source.data, od = out.data;
    var h = mapping([[0, 0], [W, 0], [W, H], [0, H]], quad);
    if (!h) return false;
    var maxX = sw - 1.001, maxY = sh - 1.001, at = 0;
    for (var v = 0; v < H; v++) {
      var py = v + 0.5;
      var xn = h[1] * py + h[2] + h[0] * 0.5, yn = h[4] * py + h[5] + h[3] * 0.5, wn = h[7] * py + h[8] + h[6] * 0.5;
      for (var u = 0; u < W; u++) {
        var x = xn / wn - 0.5, y = yn / wn - 0.5;
        xn += h[0]; yn += h[3]; wn += h[6];
        if (x < 0) x = 0; else if (x > maxX) x = maxX;
        if (y < 0) y = 0; else if (y > maxY) y = maxY;
        var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
        var a = (y0 * sw + x0) * 4, b = a + 4, c = a + sw * 4, d = c + 4;
        var wa = (1 - fx) * (1 - fy), wb = fx * (1 - fy), wc = (1 - fx) * fy, wd = fx * fy;
        od[at] = sd[a] * wa + sd[b] * wb + sd[c] * wc + sd[d] * wd;
        od[at + 1] = sd[a + 1] * wa + sd[b + 1] * wb + sd[c + 1] * wc + sd[d + 1] * wd;
        od[at + 2] = sd[a + 2] * wa + sd[b + 2] * wb + sd[c + 2] * wc + sd[d + 2] * wd;
        od[at + 3] = 255;
        at += 4;
      }
    }
    return true;
  }

  return { mapping: mapping, apply: apply, usable: usable, aspect: aspect, outputSize: outputSize, warp: warp };
});
