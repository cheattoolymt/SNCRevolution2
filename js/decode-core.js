/*
 * SuperNaidesuCardRevolution II (SNCR2) — decode-core.js
 * ==================================================================
 * 実装指示書 §9 の decode-core。旧 naidesu-cardloader の
 *   detectCorners / sampleGrid / decodeAnyMode（四隅ファインダ検出・
 *   射影変換サンプリング・全モード試し読み）を移植し、CardFormat(CF)
 *   への依存部分を SNCR2 の新 API（版ごとの cols×rows・qr-core の
 *   フォーマット/マスク/RS 復号）へ書き換えたもの（指示書 1-A の
 *   「decode-core.js は移植対象。CF 依存部分を新 API 向けに書き換える」）。
 *
 * ── 入力 ────────────────────────────────────────────────────────
 *   img = { data:Uint8ClampedArray(RGBA), width, height }
 *   （ブラウザは canvas.getImageData().data を、Node テストは合成画像を渡す）
 *
 * ── 処理の流れ ──────────────────────────────────────────────────
 *   1) detectCorners … 四隅ファインダを連結成分から検出 → データグリッド四隅
 *      （§2-0: スキャナ正面前提だが、旧 cardloader のホモグラフィで
 *        カメラ斜め撮影の保険も残す）。
 *   2) sampleModules … 版(cols×rows)ごとに射影変換 + 適応窓で 0/1 の
 *      「全モジュールグリッド」を得る（機能モジュール含む全セル）。
 *   3) decodeAnyVersion … 全版で試し読みし、フォーマット情報 + ヘッダ MAGIC が
 *      整合する版を採用 → CardFormat.decodePageModules で本文 RS 復号。
 *
 * ── 依存 ────────────────────────────────────────────────────────
 *   global.NaidesuGeometry (js/geometry.js)  … ホモグラフィ・適応窓（無改造流用）
 *   global.CardFormat       (js/card-format.js) … 版プロファイル・復号・大津法
 *
 * このファイルは DOM 非依存の純粋関数のみ。
 * ================================================================== */

(function (global, factory) {
  'use strict';
  const req = (typeof require !== 'undefined') ? require : null;
  const GEO = req ? req('./geometry.js')    : global.NaidesuGeometry;
  const CF  = req ? req('./card-format.js') : global.CardFormat;
  const Align = req ? req('./qr-align.js')  : global.SNCR2Align;
  const mod = factory(GEO, CF, Align);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  global.SNCR2DecodeCore = mod;
  global.NaidesuDecodeCore = mod; // 旧名の別名
})(typeof window !== 'undefined' ? window : globalThis, function (GEO, CF, Align) {
  'use strict';

  // ---- 画像アクセサ: {data,width,height} からグレースケール値 ----
  function grayAt(img, x, y) {
    const { data, width } = img;
    const p = (y * width + x) * 4;
    return data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
  }

  // ==================================================================
  //  四隅ファインダ検出（旧 cardloader findFinders をそのまま移植）
  // ==================================================================
  function findFinders(bin, w, h) {
    const labels = new Int32Array(w * h);
    let next = 1;
    const comps = [];
    const stack = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (bin[i] !== 1 || labels[i] !== 0) continue;
        const id = next++;
        let n = 0, sx = 0, sy = 0, minx = x, miny = y, maxx = x, maxy = y;
        stack.length = 0; stack.push(i); labels[i] = id;
        while (stack.length) {
          const p = stack.pop();
          const px = p % w, py = (p / w) | 0;
          n++; sx += px; sy += py;
          if (px < minx) minx = px; if (px > maxx) maxx = px;
          if (py < miny) miny = py; if (py > maxy) maxy = py;
          if (px > 0 && bin[p - 1] === 1 && labels[p - 1] === 0) { labels[p - 1] = id; stack.push(p - 1); }
          if (px < w - 1 && bin[p + 1] === 1 && labels[p + 1] === 0) { labels[p + 1] = id; stack.push(p + 1); }
          if (py > 0 && bin[p - w] === 1 && labels[p - w] === 0) { labels[p - w] = id; stack.push(p - w); }
          if (py < h - 1 && bin[p + w] === 1 && labels[p + w] === 0) { labels[p + w] = id; stack.push(p + w); }
        }
        comps.push({ n, cx: sx / n, cy: sy / n, minx, miny, maxx, maxy });
      }
    }
    if (comps.length < 4) return null;

    const area = w * h;
    const cand = comps.filter(c => {
      const bw = c.maxx - c.minx + 1, bh = c.maxy - c.miny + 1;
      const ar = bw / bh;
      const fill = c.n / (bw * bh);
      return c.n > area * 0.0004 && c.n < area * 0.06 && ar > 0.5 && ar < 2.0 && fill > 0.45;
    });
    const pool = cand.length >= 4 ? cand : comps;

    const cornersRef = [ { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h } ];
    const chosen = [];
    const used = new Set();
    for (const cr of cornersRef) {
      let best = null, bestD = Infinity, bestI = -1;
      pool.forEach((c, i) => {
        if (used.has(i)) return;
        const d = (c.cx - cr.x) ** 2 + (c.cy - cr.y) ** 2;
        if (d < bestD) { bestD = d; best = c; bestI = i; }
      });
      if (!best) return null;
      used.add(bestI);
      chosen.push({ x: best.cx, y: best.cy });
    }
    return chosen; // TL,TR,BR,BL のファインダ中心
  }

  // ファインダ中心 → データグリッド四隅（旧 cardloader finderToGrid 移植）
  function finderToGrid(fc) {
    const offX = CF.GAP + CF.FINDER / 2;
    const offY = CF.GAP + CF.FINDER / 2;
    const spanX = ((fc[1].x - fc[0].x) + (fc[2].x - fc[3].x)) / 2;
    const spanY = ((fc[3].y - fc[0].y) + (fc[2].y - fc[1].y)) / 2;
    const gridSpanFinderX = CF.GRID_W + 2 * offX;
    const gridSpanFinderY = CF.GRID_H + 2 * offY;
    const rx = spanX / gridSpanFinderX;
    const ry = spanY / gridSpanFinderY;
    const dx = offX * rx, dy = offY * ry;
    return [
      { x: fc[0].x + dx, y: fc[0].y + dy }, // TL
      { x: fc[1].x - dx, y: fc[1].y + dy }, // TR
      { x: fc[2].x - dx, y: fc[2].y - dy }, // BR
      { x: fc[3].x + dx, y: fc[3].y - dy }, // BL
    ];
  }

  // 自動検出（旧 cardloader detectCorners 移植）。opt.invert で白黒反転。
  function detectCorners(img, opt) {
    opt = opt || {};
    const w = img.width, h = img.height;
    const invert = !!opt.invert;
    const scale = Math.max(1, Math.round(Math.max(w, h) / 1400));
    const sw = Math.floor(w / scale), sh = Math.floor(h / scale);
    const gray = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        let g = grayAt(img, x * scale, y * scale);
        if (invert) g = 255 - g;
        gray[y * sw + x] = g;
      }
    }
    const thr = CF.otsuThreshold(gray);
    const bin = new Uint8Array(sw * sh);
    for (let i = 0; i < gray.length; i++) bin[i] = gray[i] <= thr ? 1 : 0;
    const found = findFinders(bin, sw, sh);
    if (!found) return null;
    return finderToGrid(found.map(p => ({ x: p.x * scale, y: p.y * scale })));
  }

  // ==================================================================
  //  §3/§10-1 の核: アライメントパターンによる局所歪み補正
  // ------------------------------------------------------------------
  //  旧 cardloader は「四隅ファインダのみ」で 1 枚の大域ホモグラフィを解く
  //  ため、紙の中央たわみ（バレル歪み）を補正できなかった。SNCR2 は §3 で
  //  各版に多数のアライメントパターン（5x5 同心マーカー）を配置しており、
  //  復号時にそれらの実位置を検出して「制御点メッシュ」を張ることで、
  //  中央部・周辺部の局所歪みを区分的に補正する（＝QR がやっていること）。
  //
  //  制御点 = 四隅データグリッド角 + 検出できたアライメント中心。
  //  各点は「グリッドセル座標 (gc,gr)」と「画像座標 (x,y)」の対応を持つ。
  //  セルのサンプリング位置は、その点を囲む 4 制御点の bilinear 補間で求める。
  // ==================================================================

  // アライメントパターン（5x5 同心マーカー）の理想テンプレート。
  //  ring 0=中央黒 / ring 1=白 / ring 2=黒（drawAlign と同一）。
  //  +1 が黒(暗)を、-1 が白(明)を期待することを表す相関重み。
  const ALIGN_TEMPLATE = (() => {
    const t = [];
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy)); // 0,1,2
        const dark = (ring === 0 || ring === 2);           // drawAlign と同じ
        t.push({ dx, dy, w: dark ? +1 : -1 });
      }
    return t;
  })();

  // アライメントパターン中心の局所リファイン（テンプレート相関）。
  //  predicted(画像座標)の周囲 ±win を 1px 刻みで走査し、5x5 同心テンプレートと
  //  最も相関の高い位置を中心とみなす。span は 1 セルの画像上サイズ(px)。
  //  相関では「黒であるべき画素の暗さ」-「白であるべき画素の暗さ」を足し込み、
  //  はっきりした同心構造ほど高スコアになる。見つからなければ null。
  function refineAlignment(img, predicted, span, invert) {
    const w = img.width, h = img.height;
    const cell = Math.max(1, (span.w + span.h) / 2);   // 1 セル ≒ px
    const win = Math.max(2, Math.round(cell * 1.6));    // 探索窓（±1.6 セル）
    // 暗さ(0..255, 大きいほど暗い) を返すアクセサ。範囲外は「白」扱い。
    const dark = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return invert ? 255 : 0;
      let v = grayAt(img, x | 0, y | 0);
      if (invert) v = 255 - v;
      return 255 - v; // 明度→暗さ
    };
    const cx0 = Math.round(predicted.x), cy0 = Math.round(predicted.y);
    // テンプレートを 1 点/セルで相関させると、パターン内部で score が「台地状」に
    // 平坦化する（各セルが一様塗りのため）。最大値を取る位置は台地の端に偏るので、
    // ①まず最大スコアを求め、②その最大付近（台地）に属する位置の重心を中心とする。
    let bestScore = -Infinity;
    const scores = new Float64Array((2 * win + 1) * (2 * win + 1));
    let k = 0;
    for (let dyc = -win; dyc <= win; dyc++) {
      for (let dxc = -win; dxc <= win; dxc++) {
        const cx = cx0 + dxc, cy = cy0 + dyc;
        let score = 0;
        for (const p of ALIGN_TEMPLATE) score += p.w * dark(cx + p.dx * cell, cy + p.dy * cell);
        scores[k++] = score;
        if (score > bestScore) bestScore = score;
      }
    }
    // 相関コントラストが弱い（=そこに同心マーカーが無い）場合は棄却。
    if (bestScore < 60) return null;
    // 台地重心（最大スコアの 92% 以上を「台地」とみなして平均）。
    const thr = bestScore * 0.92;
    let sx = 0, sy = 0, n = 0; k = 0;
    for (let dyc = -win; dyc <= win; dyc++) {
      for (let dxc = -win; dxc <= win; dxc++) {
        if (scores[k++] >= thr) { sx += cx0 + dxc; sy += cy0 + dyc; n++; }
      }
    }
    if (n === 0) return null;
    const fx = sx / n, fy = sy / n;

    // ---- 構造の厳密検証（データ領域の“偶然の相関”を弾く）----------------
    //  相関スコアだけでは、データ領域が同心マーカーに似た瞬間に誤検出する
    //  （ECC0 では 1 セル誤りも命取り）。求めた中心で「中央=暗 / 半径1セル
    //  リング=明 / 半径2セルリング=暗」という二値構造が実際に成立するかを、
    //  リングごとの平均コントラストで検証する。成立しなければ棄却。
    const D = (dx, dy) => dark(fx + dx * cell, fy + dy * cell);
    const center = D(0, 0);
    let ring1 = 0, ring2 = 0;
    // ring1（半径1セル）4 近傍、ring2（半径2セル）4 近傍。
    for (const [ux, uy] of [[1,0],[-1,0],[0,1],[0,-1]]) { ring1 += D(ux, uy); ring2 += D(ux * 2, uy * 2); }
    ring1 /= 4; ring2 /= 4;
    // 中央は明るいリングより十分暗く、外リングも明るいリングより十分暗いこと。
    //  しきい 40（255 階調）＝おおよそ二値化マージンの目安。
    if (!(center - ring1 > 40 && ring2 - ring1 > 40)) return null;

    return { x: fx, y: fy, score: bestScore };
  }

  // 制御点メッシュを張る。座標系は「正規化グリッド座標 u,v∈[0,1]」で統一する
  //  （u=0/1, v=0/1 がデータグリッド箱の四隅。セル (col,row) 中心は
  //   u=(col+0.5)/cols, v=(row+0.5)/rows）。これで角＝corners、内部＝
  //   アライメント中心を同じ座標系に載せられ、off-by-half を避けられる。
  // 返り値:
  //   { us, vs, pts }  us/vs=昇順の正規化座標軸, pts[j][i]=画像座標。
  //   角 4 点は corners(TL,TR,BR,BL)、内部格子点はアライメント検出値
  //   （検出できなければ大域ホモグラフィの予測値で埋める＝保険）。
  function buildControlMesh(img, corners, cols, rows, invert) {
    const { xs, ys } = Align.alignmentPositions(cols, rows);
    // アライメント中心 xs[i]（セル番号）→ 正規化 (xs[i]+0.5)/cols。
    const us = [0, ...xs.map(a => (a + 0.5) / cols), 1];
    const vs = [0, ...ys.map(a => (a + 0.5) / rows), 1];
    const H = GEO.computeHomography
      ? GEO.computeHomography(corners)
      : (GEO.makeCellMapper(corners, cols, rows).homography);
    // 大域ホモグラフィで正規化座標 (u,v) → 画像座標（アライメント予測に使う）。
    const predict = (u, v) => {
      if (H) return GEO.applyHomography(H, u, v);
      return GEO.bilinearMap(corners, u, v);
    };
    const span = GEO.makeCellMapper(corners, cols, rows).cellSpanPx();
    const cellPx = Math.max(1, (span.w + span.h) / 2);
    const iAlignFirst = 1, iAlignLast = us.length - 2;
    const jAlignFirst = 1, jAlignLast = vs.length - 2;

    // --- パス1: 各格子点の予測値を敷き、内部節点はアライメント検出を試みる ---
    //  検出できた節点は「予測からの乖離ベクトル (ddx,ddy)」を候補として持たせ、
    //  採否はパス2の外れ値除去でまとめて決める（1 点の誤検出でメッシュが
    //  破綻しないようにするため）。
    const pts = [];
    const cand = [];               // 採用候補の乖離量（外れ値判定用）
    for (let j = 0; j < vs.length; j++) {
      const rowPts = [];
      for (let i = 0; i < us.length; i++) {
        const u = us[i], v = vs[j];
        const onUedge = (i === 0 || i === us.length - 1);
        const onVedge = (j === 0 || j === vs.length - 1);
        if (onUedge && onVedge) {
          // 4 隅はファインダから求めた corners を使う（TL,TR,BR,BL）。
          const isL = (i === 0), isT = (j === 0);
          const cidx = isT ? (isL ? 0 : 1) : (isL ? 3 : 2);
          rowPts.push({ x: corners[cidx].x, y: corners[cidx].y, corner: true });
          continue;
        }
        const pred = predict(u, v);
        const cell = { x: pred.x, y: pred.y, predicted: true };
        rowPts.push(cell);
        // 3 隅のアライメント（TL/TR/BL）は §3/qr-align の規則でファインダと
        //  重なるため描画されていない。検出せず予測を使う。
        const undrawnCorner =
          (i === iAlignFirst && j === jAlignFirst) ||   // TL
          (i === iAlignLast  && j === jAlignFirst) ||   // TR
          (i === iAlignFirst && j === jAlignLast);      // BL
        if (onUedge || onVedge || undrawnCorner) continue;

        const ref = refineAlignment(img, pred, span, invert);
        if (!ref) continue;
        const ddx = ref.x - pred.x, ddy = ref.y - pred.y;
        const dev = Math.hypot(ddx, ddy);
        // 乖離の妥当帯域:
        //   下限 0.35 セル … これ未満は歪み無し（クリーン）。予測に委ねて
        //     ECC0 の境界セル反転を避ける（ON を OFF に劣化させない）。
        //   上限 1.5 セル  … たわみ・レンズ歪みは節点間で緩やかに変化するため、
        //     実位置が 1.5 セル以上跳ぶ“検出”はデータ領域の偶然の一致とみなす。
        if (dev > cellPx * 0.35 && dev < cellPx * 1.5) {
          cell._cand = { ddx, ddy, ref };
          cand.push({ ddx, ddy });
        }
      }
      pts.push(rowPts);
    }

    // --- パス2: 外れ値除去 --------------------------------------------
    //  真の歪みは空間的になめらか＝採用候補の乖離ベクトルは互いに近い。
    //  中央値ベクトルから大きく外れた候補（孤立した誤検出）は棄却し、
    //  予測値のまま残す。これでデータ領域が偶然マーカーに似た 1 点で
    //  メッシュが破綻するのを防ぐ（特に ECC0 での安全性）。
    let refined = 0;
    if (cand.length > 0) {
      const med = (arr) => { const a = arr.slice().sort((p, q) => p - q); return a[a.length >> 1]; };
      const mdx = med(cand.map(c => c.ddx));
      const mdy = med(cand.map(c => c.ddy));
      // 中央絶対偏差(MAD)ベースの許容半径。最低でも 0.5 セルは許す。
      const mad = med(cand.map(c => Math.hypot(c.ddx - mdx, c.ddy - mdy)));
      const tol = Math.max(cellPx * 0.5, mad * 3);
      for (const row of pts) {
        for (const cell of row) {
          if (!cell._cand) continue;
          const { ddx, ddy, ref } = cell._cand;
          delete cell._cand;
          if (Math.hypot(ddx - mdx, ddy - mdy) <= tol) {
            cell.x = ref.x; cell.y = ref.y; cell.predicted = false; refined++;
          }
        }
      }
    }
    return { us, vs, pts, cols, rows, span, refined,
             total: (us.length - 2) * (vs.length - 2) };
  }

  // メッシュ上の 1 セル中心 (col,row) → 画像座標。セル中心を正規化座標
  //  (u,v)=((col+0.5)/cols,(row+0.5)/rows) に直し、それを囲む格子区間の
  //  4 制御点で bilinear 補間する（区分的アフィン近似）。
  function meshMap(mesh, col, row) {
    const { us, vs, pts, cols, rows } = mesh;
    const u = (col + 0.5) / cols, v = (row + 0.5) / rows;
    let i = 0; while (i < us.length - 2 && us[i + 1] <= u) i++;
    let j = 0; while (j < vs.length - 2 && vs[j + 1] <= v) j++;
    const u0 = us[i], u1 = us[i + 1], v0 = vs[j], v1 = vs[j + 1];
    const tx = u1 > u0 ? (u - u0) / (u1 - u0) : 0;
    const ty = v1 > v0 ? (v - v0) / (v1 - v0) : 0;
    const p00 = pts[j][i], p10 = pts[j][i + 1], p01 = pts[j + 1][i], p11 = pts[j + 1][i + 1];
    const top = { x: p00.x + (p10.x - p00.x) * tx, y: p00.y + (p10.y - p00.y) * tx };
    const bot = { x: p01.x + (p11.x - p01.x) * tx, y: p01.y + (p11.y - p01.y) * tx };
    return { x: top.x + (bot.x - top.x) * ty, y: top.y + (bot.y - top.y) * ty };
  }

  // ==================================================================
  //  セルサンプリング → 「全モジュールグリッド」(0/1, cols*rows, row-major)
  // ------------------------------------------------------------------
  //  旧 cardloader sampleGrid を「機能モジュール含む全セル」を返すよう調整。
  //  §3/§10-1: 既定ではアライメントパターン制御点メッシュで局所補正して
  //  サンプリングする（opt.useAlignment=false で旧来の大域ホモグラフィのみ＝
  //  比較検証用）。§2-0: スキャナ正面なら補正はほぼ恒等写像に近い。
  // ==================================================================
  function sampleModules(img, corners, cols, rows, opt) {
    opt = opt || {};
    const invert = !!opt.invert;
    const useAlignment = opt.useAlignment !== false;   // 既定 true
    const w = img.width, h = img.height;
    const modules = new Uint8Array(cols * rows);

    // 大域ホモグラフィ（アライメント無効時・スパン推定・フォールバック用）。
    const mapper = GEO.makeCellMapper(corners, cols, rows);
    const span = mapper.cellSpanPx();
    const rad = GEO.samplingRadius(span);

    // §3: アライメント制御点メッシュ（有効かつ内部格子点がある場合のみ）。
    //  重要: 実際に「有意な歪み」を検出した節点が少ない（=クリーン／スキャナ
    //  正面、または数点の偶然の誤検出）場合は、メッシュの区分 bilinear 近似が
    //  射影変換と僅かにズレたり、refined 節点と predicted 節点が混在して局所的な
    //  折れ（不連続）を生み、ECC0 の境界セルを反転させることがある。
    //
    //  【バグ修正 §10-1】以前は `refined > 0` だけでメッシュへ切り替えていたが、
    //  クリーン画像でも 2/48 のような疎な誤検出が起き、その 2 点だけが動いた
    //  ジャギーなメッシュが大域ホモグラフィより悪化していた（ver4/ECC0 で
    //  54 セル反転 → ラウンドトリップ失敗）。真のたわみは多数の節点を一斉に
    //  動かす（実測: bulge で内部節点の 34〜77% が refined）のに対し、
    //  クリーン誤検出は数%以下に留まる。そこで「refined が内部節点の一定割合
    //  以上」を満たすときだけメッシュを採用し、それ未満は疎すぎて補間の信頼が
    //  持てない歪みとみなして大域ホモグラフィにフォールバックする。これにより
    //  「ON は OFF に劣化しない」（§10-1）を厳密に担保する。
    let mesh = null;
    if (useAlignment) {
      const m = buildControlMesh(img, corners, cols, rows, invert);
      // しきい割合 0.15 は実測に基づく: OFF が成功する軽微たわみ(k<=0.010)は
      //  refined<=2/35(<=6%)、OFF が失敗し ON で救うべき帯域(k>=0.014)は
      //  refined>=12/35(>=34%)。両者の谷（6%〜34%）に 15% を置くことで、
      //  クリーン誤検出を確実に弾きつつ本物のたわみは取りこぼさない。
      //  併せて最低 3 点は要求し、1〜2 点のみのメッシュ化を防ぐ。
      const enoughFrac  = m.total > 0 && (m.refined / m.total) >= 0.15;
      const enoughCount = m.refined >= 3;
      if (enoughFrac && enoughCount) mesh = m;
    }
    const mapCell = mesh
      ? (c, r) => meshMap(mesh, c, r)
      : (c, r) => mapper.map(c, r);

    // ================================================================
    //  §8/実機フィードバック: セル二値化の適応しきい化（ドットゲイン耐性）
    // ----------------------------------------------------------------
    //  以前は各セル平均を「固定しきい 128」で 0/1 判定していた。これは
    //  「局所の汚れ」には ECC で耐えられる一方、**全面均一膨張＝ドットゲイン**
    //  （インク/トナー滲み・濃いめ印刷・スキャナガンマ）に破綻する。盤面全域の
    //  黒が一律に太り輝度が暗側へ寄ると、白セルまで 128 を割って黒と誤判定し、
    //  一度に大量のセルが反転して ECC 能力を超えるためである。
    //
    //  対策は QR/文書二値化の定石に倣い、しきいを「画像内容から適応的に」決める:
    //   (A) 大域 Otsu … まずセル平均値のヒストグラムから大津法でしきいを取る。
    //       全面が一律に暗化しても黒山/白山ごと平行移動するので、しきいも一緒に
    //       ずれて追従する（固定 128 が追従できない点をここで吸収）。
    //   (B) 適応的局所しきい … 各セルの周囲 window 内のセル平均の局所平均から
    //       バイアス C を引いた値をしきいにする（Sauvola/adaptive-mean 系）。
    //       帯状ノイズや不均一な濃度ムラなど「場所ごとに濃さが違う」劣化に効く。
    //   両者を統合し、局所窓が黒/白どちらかに偏って情報が乏しいときは (A) の大域
    //   しきいへ寄せる。これで「均一ドットゲイン」「不均一ムラ」「クリーン」の
    //   いずれでも安定して二値化できる。
    // ================================================================

    // --- パス1: 各セル平均輝度を収集（まだ二値化しない）----------------
    const cellAvg = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pt = mapCell(c, r);
        let acc = 0, cnt = 0;
        for (let oy = -rad; oy <= rad; oy++) {
          for (let ox = -rad; ox <= rad; ox++) {
            const xx = Math.round(pt.x + ox), yy = Math.round(pt.y + oy);
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            let g = grayAt(img, xx, yy);
            if (invert) g = 255 - g;
            acc += g; cnt++;
          }
        }
        cellAvg[r * cols + c] = cnt ? acc / cnt : 255;
      }
    }

    // --- (A) 大域 Otsu しきい（セル平均のヒストグラムから）--------------
    const globalThr = otsuThresholdF(cellAvg);

    // --- (B) 適応的局所しきい: 各セル周囲 window 内のセル平均の局所平均 ---
    //  積分画像（summed-area table）で任意窓の局所平均を O(1) で引く。
    //  窓半径 winR は概ね ±(数セル)。密度が上がっても比率で決める。
    const winR = Math.max(2, Math.round(Math.min(cols, rows) / 12));
    const sat = new Float64Array((cols + 1) * (rows + 1));
    for (let r = 0; r < rows; r++) {
      let rowSum = 0;
      for (let c = 0; c < cols; c++) {
        rowSum += cellAvg[r * cols + c];
        sat[(r + 1) * (cols + 1) + (c + 1)] = sat[r * (cols + 1) + (c + 1)] + rowSum;
      }
    }
    const winMean = (c, r) => {
      const c0 = Math.max(0, c - winR), c1 = Math.min(cols - 1, c + winR);
      const r0 = Math.max(0, r - winR), r1 = Math.min(rows - 1, r + winR);
      const S = (rr, cc) => sat[rr * (cols + 1) + cc];
      const area = (c1 - c0 + 1) * (r1 - r0 + 1);
      const sum = S(r1 + 1, c1 + 1) - S(r0, c1 + 1) - S(r1 + 1, c0) + S(r0, c0);
      return sum / area;
    };

    // --- パス2: 統合しきいで二値化 ------------------------------------
    //  局所平均 lm から少しだけ暗側にバイアス（C）を引いた値を第一しきいに
    //  用いる。ただし局所窓が大域 Otsu から見て黒/白のどちらかに大きく偏る
    //  （＝情報が乏しい一様領域）ときは局所しきいが不安定なので、大域 Otsu へ
    //  寄せて誤反転を防ぐ。C は輝度スケールの数%相当（全面ドットゲインでは
    //  黒白コントラストが縮むため過大にしない）。
    const C = 6;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const avg = cellAvg[r * cols + c];
        const lm = winMean(c, r);
        // 局所しきい（暗いほど 1）。lm から C を引き、暗い側の判定に厳しめ。
        let thr = lm - C;
        // 局所窓が一様（大域 Otsu から大きく離れた lm）なら大域しきいへ寄せる。
        //  ブレンド係数 alpha は「局所平均が大域しきいからどれだけ離れているか」で
        //  決め、離れているほど大域 Otsu を優先する。
        const dev = Math.abs(lm - globalThr);
        const alpha = Math.min(1, dev / 64);          // 0(近い)→1(遠い)
        thr = thr * (1 - alpha) + globalThr * alpha;
        modules[r * cols + c] = avg < thr ? 1 : 0;
      }
    }
    modules.__meshRefined = mesh ? mesh.refined : 0;
    modules.__meshTotal = mesh ? mesh.total : 0;
    return modules;
  }

  // セル平均（Float32Array, 0..255）に対する大津法。CF.otsuThreshold は
  //  整数 gray 前提のため、ここでは連続値を 256bin に量子化して求める。
  //  返り値は「黒山と白山の中点」（CF.otsuThreshold と同じ思想）。
  function otsuThresholdF(vals) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < vals.length; i++) {
      let v = vals[i] | 0; if (v < 0) v = 0; else if (v > 255) v = 255;
      hist[v]++;
    }
    const total = vals.length;
    let sumAll = 0;
    for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let sumB = 0, wB = 0, maxVar = -1, mBstar = 0, mFstar = 255;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sumAll - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > maxVar) { maxVar = v; mBstar = mB; mFstar = mF; }
    }
    let mid = (mBstar + mFstar) / 2;
    if (!isFinite(mid)) mid = 128;
    if (mid < 5 || mid > 250) mid = 128;
    return mid;
  }

  // ==================================================================
  //  全版試し読み（旧 cardloader decodeAnyMode を新 API へ移植）
  // ------------------------------------------------------------------
  //  版ごとに cols×rows でサンプリングし、フォーマット情報 + ヘッダ MAGIC が
  //  整合する版を採用する。旧版は「モードごとにヘッダ行だけ試し読み」して
  //  高速化していたが、SNCR2 では版によってセル寸法（=サンプリング格子）が
  //  変わるため、版ごとに全面サンプリングして CF.decodePageModules に委ねる。
  //  返り値: { version, meta, data, ok, corrected, corners } / 失敗時 ok=false。
  // ==================================================================
  function decodeAnyVersion(img, opt) {
    opt = opt || {};
    // invert 両方を試す（黒地/白地どちらのスキャンでも動くように）。
    const inverts = opt.invert != null ? [!!opt.invert] : [false, true];
    let last = { ok: false, reason: 'not-detected' };
    for (const invert of inverts) {
      const corners = opt.corners || detectCorners(img, { invert });
      if (!corners) { last = { ok: false, reason: 'no-corners' }; continue; }
      for (const version of CF.VERSIONS) {
        const prof = CF.getProfile(version);
        const modules = sampleModules(img, corners, prof.COLS, prof.ROWS,
          { invert, useAlignment: opt.useAlignment });
        const r = CF.decodePageModules(modules, prof.COLS, prof.ROWS);
        if (r.meta && r.meta.magicOk) {
          // MAGIC 一致かつ自己申告 version がこの版と一致するものを最優先採用。
          if (r.meta.version === version && r.ok) {
            return Object.assign({ version, corners, invert }, r);
          }
          // MAGIC は合うが RS 未完（ヘッダだけ拾えた）→ 記録して継続。
          last = Object.assign({ version, corners, invert }, r);
        }
      }
    }
    return last;
  }

  return {
    grayAt,
    findFinders,
    finderToGrid,
    detectCorners,
    refineAlignment,
    buildControlMesh,
    meshMap,
    sampleModules,
    decodeAnyVersion,
  };
});
