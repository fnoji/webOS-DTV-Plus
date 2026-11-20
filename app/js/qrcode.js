/* -*- coding: utf-8 -*-
 * qrcode.js - ISO/IEC 18004 準拠 軽量ローカル QR コード SVG 生成器 (Byte mode / ECC-L / Ver 1〜10)
 * 外部通信ゼロ・LG webOS Chromium 53 (ES5) 完全互換
 */
(function (global) {
  'use strict';

  // Version 1..10 (ECC Level L) 仕様テーブル:
  // [totalCodewords, ecPerBlock, numBlocksGroup1, dataCwGroup1, numBlocksGroup2, dataCwGroup2]
  var VER_SPECS = [
    null,
    [26, 7, 1, 19, 0, 0],     // V1  (21x21, max 17 bytes)
    [44, 10, 1, 34, 0, 0],    // V2  (25x25, max 32 bytes)
    [70, 15, 1, 55, 0, 0],    // V3  (29x29, max 53 bytes)
    [100, 20, 1, 80, 0, 0],   // V4  (33x33, max 78 bytes)
    [134, 26, 1, 108, 0, 0],  // V5  (37x37, max 106 bytes)
    [172, 18, 2, 68, 0, 0],   // V6  (41x41, max 134 bytes)
    [196, 20, 2, 78, 0, 0],   // V7  (45x45, max 154 bytes)
    [242, 24, 2, 97, 0, 0],   // V8  (49x49, max 192 bytes)
    [292, 30, 2, 116, 0, 0],  // V9  (53x53, max 230 bytes)
    [346, 18, 2, 68, 2, 69]   // V10 (57x57, max 271 bytes)
  ];

  // Version 2..10 アライメントパターン中心座標
  var ALIGN_POS = [
    [],
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50]
  ];

  // Version 7..10 バージョン情報ビット列 (18bit BCH)
  var VERSION_BITS = {
    7: 0x07C94,
    8: 0x085BC,
    9: 0x09A99,
    10: 0x0A4D3
  };

  // ECC-L (01) + Mask (0..7) フォーマット情報 (15bit BCH + XOR 0x5412)
  var FORMAT_BITS_L = [
    0x77C4, 0x72F3, 0x7DAA, 0x789D,
    0x662F, 0x6318, 0x6C41, 0x6976
  ];

  // GF(256) (原始多項式 0x11D) テーブル構築
  var GF_EXP = new Array(512);
  var GF_LOG = new Array(256);
  (function initGalois() {
    var x = 1;
    var i;
    for (i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (i = 255; i < 512; i++) {
      GF_EXP[i] = GF_EXP[i - 255];
    }
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function rsGeneratorPoly(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1);
      var k;
      for (k = 0; k < next.length; k++) next[k] = 0;
      var factor = GF_EXP[i];
      for (k = 0; k < poly.length; k++) {
        next[k] ^= poly[k];
        next[k + 1] ^= gfMul(poly[k], factor);
      }
      poly = next;
    }
    return poly;
  }

  function rsComputeRemainder(data, ecLen) {
    var gen = rsGeneratorPoly(ecLen);
    var rem = new Array(ecLen);
    var i, j;
    for (i = 0; i < ecLen; i++) rem[i] = 0;
    for (i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem[0];
      for (j = 0; j < ecLen - 1; j++) rem[j] = rem[j + 1];
      rem[ecLen - 1] = 0;
      if (factor !== 0) {
        for (j = 0; j < ecLen; j++) {
          rem[j] ^= gfMul(gen[j + 1], factor);
        }
      }
    }
    return rem;
  }

  function toUtf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6));
        out.push(0x80 | (c & 0x3F));
      } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
        out.push(0xF0 | (cp >> 18));
        out.push(0x80 | ((cp >> 12) & 0x3F));
        out.push(0x80 | ((cp >> 6) & 0x3F));
        out.push(0x80 | (cp & 0x3F));
      } else {
        out.push(0xE0 | (c >> 12));
        out.push(0x80 | ((c >> 6) & 0x3F));
        out.push(0x80 | (c & 0x3F));
      }
    }
    return out;
  }

  function chooseVersion(byteLen) {
    for (var v = 1; v < VER_SPECS.length; v++) {
      var sp = VER_SPECS[v];
      var dataCap = sp[2] * sp[3] + sp[4] * sp[5];
      var countBits = (v <= 9) ? 8 : 16;
      var neededBits = 4 + countBits + byteLen * 8;
      if (neededBits <= dataCap * 8) return v;
    }
    return -1;
  }

  function buildFinalCodewords(bytes, version) {
    var sp = VER_SPECS[version];
    var ecLen = sp[1];
    var g1Count = sp[2], g1Len = sp[3];
    var g2Count = sp[4], g2Len = sp[5];
    var totalDataCw = g1Count * g1Len + g2Count * g2Len;

    var bits = [];
    function pushBits(val, len) {
      for (var i = len - 1; i >= 0; i--) {
        bits.push((val >>> i) & 1);
      }
    }

    // Byte mode indicator (0100)
    pushBits(4, 4);
    pushBits(bytes.length, version <= 9 ? 8 : 16);
    var i;
    for (i = 0; i < bytes.length; i++) {
      pushBits(bytes[i], 8);
    }
    // Terminator (up to 4 zero bits)
    var maxBits = totalDataCw * 8;
    var termLen = Math.min(4, maxBits - bits.length);
    pushBits(0, termLen);
    // Pad to byte boundary
    while (bits.length % 8 !== 0) bits.push(0);

    var dataCw = [];
    for (i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      dataCw.push(b);
    }
    var padBytes = [0xEC, 0x11];
    var pIdx = 0;
    while (dataCw.length < totalDataCw) {
      dataCw.push(padBytes[pIdx]);
      pIdx ^= 1;
    }

    // Split into RS blocks
    var dataBlocks = [];
    var ecBlocks = [];
    var offset = 0;
    var bIdx;
    for (bIdx = 0; bIdx < g1Count; bIdx++) {
      var blk1 = dataCw.slice(offset, offset + g1Len);
      offset += g1Len;
      dataBlocks.push(blk1);
      ecBlocks.push(rsComputeRemainder(blk1, ecLen));
    }
    for (bIdx = 0; bIdx < g2Count; bIdx++) {
      var blk2 = dataCw.slice(offset, offset + g2Len);
      offset += g2Len;
      dataBlocks.push(blk2);
      ecBlocks.push(rsComputeRemainder(blk2, ecLen));
    }

    // Interleave data codewords + EC codewords
    var out = [];
    var maxDataLen = Math.max(g1Len, g2Len);
    for (i = 0; i < maxDataLen; i++) {
      for (bIdx = 0; bIdx < dataBlocks.length; bIdx++) {
        if (i < dataBlocks[bIdx].length) out.push(dataBlocks[bIdx][i]);
      }
    }
    for (i = 0; i < ecLen; i++) {
      for (bIdx = 0; bIdx < ecBlocks.length; bIdx++) {
        out.push(ecBlocks[bIdx][i]);
      }
    }
    return out;
  }

  function createEmptyGrid(size) {
    var g = new Array(size);
    for (var r = 0; r < size; r++) {
      g[r] = new Array(size);
      for (var c = 0; c < size; c++) g[r][c] = -1;
    }
    return g;
  }

  function placeFinder(grid, func, row, col) {
    var size = grid.length;
    for (var dr = -1; dr <= 7; dr++) {
      for (var dc = -1; dc <= 7; dc++) {
        var r = row + dr, c = col + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        var dark = (
          (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
          (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
          (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)
        );
        grid[r][c] = dark ? 1 : 0;
        func[r][c] = 1;
      }
    }
  }

  function placeAlignment(grid, func, centerR, centerC) {
    for (var dr = -2; dr <= 2; dr++) {
      for (var dc = -2; dc <= 2; dc++) {
        var r = centerR + dr, c = centerC + dc;
        var dark = (Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        grid[r][c] = dark ? 1 : 0;
        func[r][c] = 1;
      }
    }
  }

  function applyFormatInfo(grid, maskId) {
    var size = grid.length;
    var bits = FORMAT_BITS_L[maskId];
    var i;
    for (i = 0; i <= 5; i++) grid[8][i] = (bits >>> (14 - i)) & 1;
    grid[8][7] = (bits >>> 8) & 1;
    grid[8][8] = (bits >>> 7) & 1;
    grid[7][8] = (bits >>> 6) & 1;
    for (i = 0; i <= 5; i++) grid[5 - i][8] = (bits >>> (5 - i)) & 1;

    for (i = 0; i <= 6; i++) grid[size - 1 - i][8] = (bits >>> (14 - i)) & 1;
    for (i = 0; i <= 7; i++) grid[8][size - 8 + i] = (bits >>> (7 - i)) & 1;
  }

  function applyVersionInfo(grid, func, version) {
    var vbits = VERSION_BITS[version];
    if (!vbits) return;
    var size = grid.length;
    for (var i = 0; i < 18; i++) {
      var bit = (vbits >>> i) & 1;
      var a = Math.floor(i / 3);
      var b = size - 11 + (i % 3);
      grid[a][b] = bit;
      func[a][b] = 1;
      grid[b][a] = bit;
      func[b][a] = 1;
    }
  }

  function maskBit(maskId, r, c) {
    if (maskId === 0) return ((r + c) % 2) === 0;
    if (maskId === 1) return (r % 2) === 0;
    if (maskId === 2) return (c % 3) === 0;
    if (maskId === 3) return ((r + c) % 3) === 0;
    if (maskId === 4) return ((Math.floor(r / 2) + Math.floor(c / 3)) % 2) === 0;
    if (maskId === 5) return (((r * c) % 2) + ((r * c) % 3)) === 0;
    if (maskId === 6) return ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0;
    return ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0;
  }

  function calcPenalty(grid) {
    var size = grid.length;
    var penalty = 0;
    var r, c, run, prev;
    // Rule 1: horizontal & vertical runs
    for (r = 0; r < size; r++) {
      run = 1; prev = grid[r][0];
      for (c = 1; c < size; c++) {
        if (grid[r][c] === prev) {
          run++;
        } else {
          if (run >= 5) penalty += 3 + (run - 5);
          prev = grid[r][c]; run = 1;
        }
      }
      if (run >= 5) penalty += 3 + (run - 5);
    }
    for (c = 0; c < size; c++) {
      run = 1; prev = grid[0][c];
      for (r = 1; r < size; r++) {
        if (grid[r][c] === prev) {
          run++;
        } else {
          if (run >= 5) penalty += 3 + (run - 5);
          prev = grid[r][c]; run = 1;
        }
      }
      if (run >= 5) penalty += 3 + (run - 5);
    }
    // Rule 2: 2x2 blocks
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = grid[r][c];
        if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) {
          penalty += 3;
        }
      }
    }
    // Rule 4: dark/light balance
    var dark = 0;
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        if (grid[r][c] === 1) dark++;
      }
    }
    var pct = Math.abs(Math.floor((dark * 100) / (size * size)) - 50);
    penalty += Math.floor(pct / 5) * 10;
    return penalty;
  }

  function encodeMatrix(text) {
    var bytes = toUtf8Bytes(String(text || ''));
    var version = chooseVersion(bytes.length);
    if (version < 1) return null;

    var size = version * 4 + 17;
    var baseGrid = createEmptyGrid(size);
    var func = createEmptyGrid(size);
    var r, c;
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) func[r][c] = 0;
    }

    // Finder patterns + separators
    placeFinder(baseGrid, func, 0, 0);
    placeFinder(baseGrid, func, 0, size - 7);
    placeFinder(baseGrid, func, size - 7, 0);

    // Alignment patterns
    var pos = ALIGN_POS[version];
    for (r = 0; r < pos.length; r++) {
      for (c = 0; c < pos.length; c++) {
        var ar = pos[r], ac = pos[c];
        if (func[ar][ac]) continue;
        placeAlignment(baseGrid, func, ar, ac);
      }
    }

    // Timing patterns
    for (var t = 8; t < size - 8; t++) {
      var bit = (t % 2 === 0) ? 1 : 0;
      if (!func[6][t]) { baseGrid[6][t] = bit; func[6][t] = 1; }
      if (!func[t][6]) { baseGrid[t][6] = bit; func[t][6] = 1; }
    }

    // Dark module
    baseGrid[size - 8][8] = 1;
    func[size - 8][8] = 1;

    // Reserve format info areas
    for (var fi = 0; fi < 9; fi++) {
      if (!func[8][fi]) { baseGrid[8][fi] = 0; func[8][fi] = 1; }
      if (!func[fi][8]) { baseGrid[fi][8] = 0; func[fi][8] = 1; }
    }
    for (var fj = 0; fj < 8; fj++) {
      if (!func[8][size - 1 - fj]) { baseGrid[8][size - 1 - fj] = 0; func[8][size - 1 - fj] = 1; }
      if (!func[size - 1 - fj][8]) { baseGrid[size - 1 - fj][8] = 0; func[size - 1 - fj][8] = 1; }
    }

    // Version info (Ver >= 7)
    applyVersionInfo(baseGrid, func, version);

    // Place data bits in zigzag
    var codewords = buildFinalCodewords(bytes, version);
    var bitIdx = 0;
    var totalBits = codewords.length * 8;
    var up = true;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        var row = up ? (size - 1 - vert) : vert;
        for (var dx = 0; dx < 2; dx++) {
          var col = right - dx;
          if (func[row][col]) continue;
          var dbit = 0;
          if (bitIdx < totalBits) {
            dbit = (codewords[bitIdx >> 3] >>> (7 - (bitIdx & 7))) & 1;
            bitIdx++;
          }
          baseGrid[row][col] = dbit;
        }
      }
      up = !up;
    }

    // Evaluate masks 0..7 and pick lowest penalty
    var bestGrid = null;
    var bestPenalty = 1e9;
    for (var m = 0; m < 8; m++) {
      var cand = createEmptyGrid(size);
      for (r = 0; r < size; r++) {
        for (c = 0; c < size; c++) {
          cand[r][c] = func[r][c] ? baseGrid[r][c] : (baseGrid[r][c] ^ (maskBit(m, r, c) ? 1 : 0));
        }
      }
      applyFormatInfo(cand, m);
      var pen = calcPenalty(cand);
      if (pen < bestPenalty) {
        bestPenalty = pen;
        bestGrid = cand;
      }
    }
    return bestGrid;
  }

  function createSvgString(text, sizePx) {
    var mat = encodeMatrix(text);
    if (!mat) return '';
    var n = mat.length;
    var quiet = 4;
    var total = n + quiet * 2;
    var px = sizePx || 152;
    var parts = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px +
      '" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges">',
      '<rect width="' + total + '" height="' + total + '" fill="#ffffff"/>',
      '<path fill="#000000" d="'
    ];
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (mat[r][c] === 1) {
          parts.push('M' + (c + quiet) + ',' + (r + quiet) + 'h1v1h-1z');
        }
      }
    }
    parts.push('"/></svg>');
    return parts.join('');
  }

  global.QrCodeSvg = {
    encodeMatrix: encodeMatrix,
    createSvgString: createSvgString
  };
})(window);
