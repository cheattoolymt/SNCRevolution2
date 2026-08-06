/*
 * SuperNaidesuCardRevolution II (SNCR2) — qr-core.js
 * ==================================================================
 * 実装指示書 §9「成果物ファイル構成」の中核。§1-B / §3 / §6 の QR コアを
 * 一本化し、「独自バージョンの長方形グリッドに、QR 風の機能モジュール
 * （ファインダ・タイミング・アライメント・フォーマット情報）を配置し、
 * 残りのセルへデータ bit を敷き詰めてマスク最適化する」までを担う。
 *
 * これまで §2〜§7 で作った純粋モジュール群:
 *   qr-geometry.js  (§2)  … A4 の箱・セル寸法
 *   qr-align.js     (§3)  … 長方形アライメント座標（軸独立）
 *   qr-version.js   (§4)  … cols×rows 表・RS ブロック割り・ECC・ヘッダ別保護
 *   qr-rs.js        (§1-B) … GF(256) encode(nayuki)/decode(自前訂正)
 *   qr-interleave.js(§5)  … RS 符号化 + インターリーブ
 *   qr-mask.js      (§6)  … 8 マスク評価・最小スコア自動選択
 *   qr-header.js    (§7)  … 論理 12byte + RS(6) = 物理 18byte
 * を、この qr-core.js が「1 枚のビットマップ（modules 配列）」へ束ねる。
 *
 * ── グリッド表現（全 SNCR2 モジュール共通）────────────────────
 *   modules    … Uint8Array(cols*rows)  0=明(白) / 1=暗(黒)  row-major
 *   isFunction … Uint8Array(cols*rows)  1=機能モジュール（マスク/データ対象外）
 *   index(x,y) = y*cols + x
 *
 * ── 機能モジュールの配置（QR 準拠を長方形へ移植）──────────────
 *   ・ファインダ 7x7（+セパレータ 1）を 3 隅（TL/TR/BL）へ。右下は無し。
 *   ・フォーマット情報 (eccLevel 2bit + mask 3bit = 5bit → BCH で 15bit)
 *     を TL ファインダ周囲に 2 コピー配置（QR と同じ冗長配置）。
 *   ・タイミングパターン: 6 行目 / 6 列目に白黒交互ライン。
 *   ・アライメントパターン 5x5 を §3 の xs×ys 直積へ（四隅衝突は除外）。
 *
 * ── データ充填順 ────────────────────────────────────────────
 *   本プロジェクトはスキャナ前提（§2-0）で射影補正済みグリッドを走査
 *   するため、QR のジグザグ縦走査に厳密に合わせる必要はない。実装の
 *   単純さ・デバッグしやすさ（§8「改造しやすさ最優先」）を優先し、
 *   「機能モジュール以外を row-major（左上→右下）順」に data セルとして
 *   列挙し、そこへ header(18B) → payload グロスの bit を MSB first で詰める。
 *   §5 のインターリーブがバースト分散を担うので、充填順自体は単純でよい。
 *
 * このファイルは DOM 非依存の純粋関数のみ。
 * ================================================================== */

(function (global, factory) {
  'use strict';
  const req = (typeof require !== 'undefined') ? require : null;
  const Geo   = req ? req('./qr-geometry.js')  : global.SNCR2Geometry;
  const Align = req ? req('./qr-align.js')      : global.SNCR2Align;
  const Ver   = req ? req('./qr-version.js')    : global.SNCR2Version;
  const RS    = req ? req('./qr-rs.js')         : global.SNCR2RS;
  const IL    = req ? req('./qr-interleave.js') : global.SNCR2Interleave;
  const Mask  = req ? req('./qr-mask.js')       : global.SNCR2Mask;
  const Header= req ? req('./qr-header.js')     : global.SNCR2Header;
  const mod = factory(Geo, Align, Ver, RS, IL, Mask, Header);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  global.SNCR2Core = mod;
})(typeof window !== 'undefined' ? window : globalThis,
   function (Geo, Align, Ver, RS, IL, Mask, Header) {
  'use strict';

  const idx = (x, y, cols) => y * cols + x;

  // ==================================================================
  //  機能モジュール配置
  // ------------------------------------------------------------------
  //  グリッド（cols×rows）に modules(0/1) と isFunction(0/1) を書き込む。
  //  data 領域はまだ 0 のまま（後から fillData で埋める）。
  // ==================================================================

  // 1 個のファインダ（7x7 の同心正方形 + 1 セルのセパレータ）を左上原点
  //  (ox,oy) に描く。QR と同じ図形（外周黒・内側白・中央 3x3 黒）。
  function drawFinder(modules, isFn, cols, rows, ox, oy) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx, y = oy + dy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        const i = idx(x, y, cols);
        isFn[i] = 1;
        // セパレータ（-1 と 7 の枠）は白。
        if (dx === -1 || dx === 7 || dy === -1 || dy === 7) { modules[i] = 0; continue; }
        // 7x7 本体: 外周(0/6) 黒、その内(1..5)は白、中央 3x3(2..4) 黒。
        const onBorder = (dx === 0 || dx === 6 || dy === 0 || dy === 6);
        const inCenter = (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
        modules[i] = (onBorder || inCenter) ? 1 : 0;
      }
    }
  }

  // 1 個のアライメントパターン 5x5（外周黒・内側白・中央 1 黒）を中心
  //  (cx,cy) に描く。QR と同じ図形。
  function drawAlign(modules, isFn, cols, rows, cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        const i = idx(x, y, cols);
        // 既にファインダ/タイミング等の機能モジュールなら侵さない。
        if (isFn[i]) continue;
        isFn[i] = 1;
        const ring = Math.max(Math.abs(dx), Math.abs(dy)); // 0=中央,1,2
        modules[i] = (ring === 0 || ring === 2) ? 1 : 0;
      }
    }
  }

  // フォーマット情報 15bit を生成（QR の BCH(15,5) と同じ生成多項式）。
  //  data5 = (eccLevel<<3) | mask  → 5bit、生成多項式 0x537、マスク 0x5412。
  const FORMAT_GEN = 0x537;
  const FORMAT_MASK = 0x5412;
  function formatBits(eccLevel, mask) {
    const data = ((eccLevel & 3) << 3) | (mask & 7);   // 5bit
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) * FORMAT_GEN);
    const bits = ((data << 10) | rem) ^ FORMAT_MASK;    // 15bit
    return bits & 0x7fff;
  }
  // 逆: 15bit 読み値から最小ハミング距離のフォーマットを復元。
  function decodeFormat(raw15) {
    let best = -1, bestDist = 99, bestData = 0;
    for (let d = 0; d < 32; d++) {
      const cand = formatBits((d >> 3) & 3, d & 7);
      let x = cand ^ (raw15 & 0x7fff), dist = 0;
      while (x) { dist += x & 1; x >>= 1; }
      if (dist < bestDist) { bestDist = dist; best = cand; bestData = d; }
    }
    return { eccLevel: (bestData >> 3) & 3, mask: bestData & 7, dist: bestDist };
  }

  // フォーマット bit を TL ファインダ周囲へ 2 コピー配置する（QR 準拠）。
  //  読み書き位置を関数化して encode/decode で共有する。
  function formatCells(cols, rows) {
    // コピー1: TL ファインダ右横(縦) + 下(横) の L 字（QR と同じ 15 セル）。
    // コピー2: TR/BL 側の対称位置。長方形でも座標式は QR と同一で成立する。
    const c1 = [];
    // 縦成分 (x=8, y=0..8 のうち timing=6 を除く) と 横成分 (y=8, x=8..0)。
    for (let y = 0; y <= 8; y++) if (y !== 6) c1.push({ x: 8, y });
    for (let x = 7; x >= 0; x--) if (x !== 6) c1.push({ x, y: 8 });
    // 15 セルに整える（QR の並びに合わせ先頭 15 個）。
    const copy1 = c1.slice(0, 15);
    const copy2 = [];
    // 横成分（BL 側 y=8 は使わず、TR: y=0..? / BL: x=0）— QR の第2コピー位置。
    for (let x = cols - 1; x >= cols - 8; x--) copy2.push({ x, y: 8 });
    for (let y = rows - 7; y <= rows - 1; y++) copy2.push({ x: 8, y });
    return { copy1, copy2: copy2.slice(0, 15) };
  }

  // グリッドの機能モジュールを敷く。返り値 { modules, isFn }。
  //  eccLevel/mask はフォーマット情報のためだけに必要（mask は後で確定するので
  //  ここでは仮置き。decode 側は読み取ったフォーマットを使う）。
  function buildFunctionGrid(cols, rows) {
    const modules = new Uint8Array(cols * rows);
    const isFn = new Uint8Array(cols * rows);

    // ファインダ 3 隅（TL/TR/BL）。右下はアライメントで代替（QR と同じ）。
    drawFinder(modules, isFn, cols, rows, 0, 0);
    drawFinder(modules, isFn, cols, rows, cols - 7, 0);
    drawFinder(modules, isFn, cols, rows, 0, rows - 7);

    // タイミングパターン（6 行目 / 6 列目、白黒交互）。ファインダ内は除外。
    for (let x = 8; x < cols - 8; x++) {
      const i = idx(x, 6, cols);
      if (!isFn[i]) { isFn[i] = 1; modules[i] = (x % 2 === 0) ? 1 : 0; }
    }
    for (let y = 8; y < rows - 8; y++) {
      const i = idx(6, y, cols);
      if (!isFn[i]) { isFn[i] = 1; modules[i] = (y % 2 === 0) ? 1 : 0; }
    }

    // フォーマット情報領域を機能モジュールとして予約（値は後で書く）。
    const fmt = formatCells(cols, rows);
    for (const c of fmt.copy1.concat(fmt.copy2)) {
      const i = idx(c.x, c.y, cols);
      isFn[i] = 1; // 値は placeFormat で確定
    }
    // TL ファインダの右下角に「常時黒」1 セル（QR の dark module 相当）。
    {
      const i = idx(8, rows - 8, cols);
      if (i >= 0 && i < modules.length) { isFn[i] = 1; modules[i] = 1; }
    }

    // アライメントパターン（§3 の中心配列）。
    const centers = Align.alignmentCenters(cols, rows);
    for (const c of centers) drawAlign(modules, isFn, cols, rows, c.x, c.y);

    return { modules, isFn, formatCells: fmt };
  }

  // フォーマット bit を 2 コピー書き込む。
  function placeFormat(modules, cols, rows, fmt, eccLevel, mask) {
    const bits = formatBits(eccLevel, mask);
    const write = (arr) => {
      for (let k = 0; k < arr.length; k++) {
        const b = (bits >> (14 - k)) & 1; // MSB first
        modules[idx(arr[k].x, arr[k].y, cols)] = b;
      }
    };
    write(fmt.copy1);
    write(fmt.copy2);
  }

  // フォーマット bit を 2 コピー読み、BCH 訂正して {eccLevel,mask} を返す。
  function readFormat(modules, cols, rows, fmt) {
    const read = (arr) => {
      let v = 0;
      for (let k = 0; k < arr.length; k++) v = (v << 1) | (modules[idx(arr[k].x, arr[k].y, cols)] & 1);
      return v & 0x7fff;
    };
    const a = decodeFormat(read(fmt.copy1));
    const b = decodeFormat(read(fmt.copy2));
    // 距離が小さい方（より確からしい方）を採用。
    return (a.dist <= b.dist) ? a : b;
  }

  // ==================================================================
  //  データセル列挙（機能モジュール以外を row-major で列挙）
  // ==================================================================
  function dataCellList(isFn, cols, rows) {
    const cells = [];
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const i = idx(x, y, cols);
        if (!isFn[i]) cells.push(i);
      }
    return cells;
  }

  // このバージョンで「実際に data セルに使える bit 数 / byte 数」。
  //  qr-version.js のオーバーヘッド“近似”とは別に、ここで実測して確定する。
  function dataCapacityBytes(cols, rows) {
    const { isFn } = buildFunctionGrid(cols, rows);
    let n = 0;
    for (let i = 0; i < isFn.length; i++) if (!isFn[i]) n++;
    return Math.floor(n / 8);
  }

  // ==================================================================
  //  エンコード: header(18B) + payloadGross(bytes) → マスク済み modules
  // ------------------------------------------------------------------
  //  返り値: { modules, cols, rows, mask, eccLevel, dataCells }
  // ==================================================================
  function encodeGrid(headerBytes, payloadGross, cols, rows, eccLevel) {
    const { modules, isFn, formatCells: fmt } = buildFunctionGrid(cols, rows);
    const dataCells = dataCellList(isFn, cols, rows);

    // header + payloadGross を MSB-first bit 列に。
    const bitAt = (bytes, bitIndex) => {
      const byte = bytes[bitIndex >> 3];
      return (byte >> (7 - (bitIndex & 7))) & 1;
    };
    const headerBits = headerBytes.length * 8;
    for (let n = 0; n < dataCells.length; n++) {
      let bit = 0;
      if (n < headerBits) {
        bit = bitAt(headerBytes, n);
      } else {
        const pb = n - headerBits;
        if (pb < payloadGross.length * 8) bit = bitAt(payloadGross, pb);
      }
      modules[dataCells[n]] = bit;
    }

    // §6 マスク自動選択（data 領域のみ評価）。
    const best = Mask.chooseBestMask(modules, isFn, cols, rows);
    // 選ばれたマスクとフォーマット（eccLevel）を確定描画。
    placeFormat(best.modules, cols, rows, fmt, eccLevel, best.mask);

    return {
      modules: best.modules, isFn, cols, rows,
      mask: best.mask, eccLevel, penalty: best.penalty,
      dataCells, formatCells: fmt,
    };
  }

  // ==================================================================
  //  デコード: 受信 modules(0/1) → header(18B) + payloadGross(bytes)
  // ------------------------------------------------------------------
  //  1) 機能モジュール地図を再構成（cols/rows が分かれば決定的）。
  //  2) フォーマット情報から eccLevel/mask を復元。
  //  3) デマスク（同じマスクを再適用）。
  //  4) data セルから header/payload bit を取り出す。
  //  返り値: { header, payloadGross, eccLevel, mask, dataCells }
  // ==================================================================
  function decodeGrid(recvModules, cols, rows, payloadGrossLen) {
    const { isFn, formatCells: fmt } = buildFunctionGrid(cols, rows);
    const dataCells = dataCellList(isFn, cols, rows);

    // フォーマット情報（デマスク前の値でよい: フォーマット領域は非マスク）。
    const f = readFormat(recvModules, cols, rows, fmt);

    // デマスク。
    const demasked = Uint8Array.from(recvModules);
    Mask.applyMask(demasked, isFn, cols, rows, f.mask);

    // data bit を取り出す。
    const HEADER_LEN = Header.HEADER_LEN; // 18
    const totalBits = dataCells.length;
    const header = new Uint8Array(HEADER_LEN);
    const payloadGross = new Uint8Array(payloadGrossLen != null
      ? payloadGrossLen
      : Math.max(0, Math.floor(totalBits / 8) - HEADER_LEN));

    const setBit = (bytes, bitIndex, bit) => {
      if ((bitIndex >> 3) < bytes.length) bytes[bitIndex >> 3] |= (bit & 1) << (7 - (bitIndex & 7));
    };
    const headerBits = HEADER_LEN * 8;
    for (let n = 0; n < dataCells.length; n++) {
      const bit = demasked[dataCells[n]] & 1;
      if (n < headerBits) setBit(header, n, bit);
      else setBit(payloadGross, n - headerBits, bit);
    }
    return { header, payloadGross, eccLevel: f.eccLevel, mask: f.mask, formatDist: f.dist, dataCells };
  }

  return {
    // 機能モジュール
    drawFinder, drawAlign, buildFunctionGrid,
    formatBits, decodeFormat, formatCells, placeFormat, readFormat,
    // データセル
    dataCellList, dataCapacityBytes,
    // 高水準
    encodeGrid, decodeGrid,
    idx,
  };
});
