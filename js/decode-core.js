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
  //
  //  【実機フィードバック §10-6/§10-7: 強ぼかし＋ドットゲイン耐性】
  //  旧実装は棄却しきいを**絶対値**（相関 60・リングコントラスト 40）で
  //  持っていた。しかし実機の JPEG 強ぼかし＋ドットゲインでは盤面の
  //  ダイナミックレンジが圧縮され（黒白差が 255→80 程度に縮む）、同じ同心
  //  マーカーでも相関値・リングコントラストが一律に小さくなる。絶対しきいは
  //  この一律縮小に追従できず、「本物のアライメントを見落とす」（=内部
  //  アライメント検出の崩壊。四隅は無事なのにメッシュが張れない実機症状）。
  //  対策として、しきいを predicted 近傍の**実測ローカルコントラスト**で
  //  正規化した相対値に変える。あわせて中心推定をスコア重み付き重心
  //  （サブピクセル）にし、ぼかしで台地が広がっても中心が偏らないようにする。
  //  【実機フィードバック §10-8: 内部アライメント検出の探索窓不足】
  //  探索窓は既定 ±1.6 セルだが、中央たわみ（バレル歪み）では大域ホモグラフィ
  //  予測からの真の乖離が **3〜5 セル** に達する（ver14/k=0.010 実測: mean 3.06
  //  セル・max 5.20 セル）。固定 ±1.6 セルでは真の中心が窓外に出て 87% の
  //  アライメントが原理的に見つからず、四隅は正確なのに内部検出が崩壊する
  //  （＝ユーザ報告の level3 全版 MAGIC 不一致の正体）。そこで探索窓を
  //  呼び出し側から `opt.winCells` で可変にし、buildControlMesh の粗→密
  //  反復（まず広い窓でアンカーを拾い、近傍アンカーから予測を補正して狭い窓で
  //  残りを拾う）で高検出率を得られるようにする。
  function refineAlignment(img, predicted, span, invert, opt) {
    opt = opt || {};
    const w = img.width, h = img.height;
    const cell = Math.max(1, (span.w + span.h) / 2);   // 1 セル ≒ px
    const winCells = opt.winCells != null ? opt.winCells : 1.6;
    const win = Math.max(2, Math.round(cell * winCells)); // 探索窓（±winCells セル）
    // 暗さ(0..255, 大きいほど暗い) を返すアクセサ。範囲外は「白」扱い。
    //  ぼかしで 1px の量子化が効くため、サブピクセル位置は双一次で読む。
    const dark = (x, y) => {
      if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return invert ? 255 : 0;
      const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0;
      const gg = (xx, yy) => {
        let v = grayAt(img, xx, yy);
        return invert ? 255 - v : v;
      };
      const a = gg(x0, y0) * (1 - tx) + gg(x0 + 1, y0) * tx;
      const b = gg(x0, y0 + 1) * (1 - tx) + gg(x0 + 1, y0 + 1) * tx;
      const v = a * (1 - ty) + b * ty;
      return 255 - v; // 明度→暗さ
    };

    // ---- ローカルコントラスト推定（相対しきいの基準）--------------------
    //  predicted を中心に ±2.5 セルの暗さの min/max を取り、実効ダイナミック
    //  レンジ range=max-min を得る。ドットゲインで range が縮んでも、しきいを
    //  range 比で決めれば追従できる。range が極端に小さい（=情報が無い一様
    //  領域）ときのみ棄却する。
    let dMin = 255, dMax = 0;
    const probeR = Math.max(2, Math.round(cell * 2.5));
    for (let dy = -probeR; dy <= probeR; dy += Math.max(1, (cell / 2) | 0)) {
      for (let dx = -probeR; dx <= probeR; dx += Math.max(1, (cell / 2) | 0)) {
        const v = dark(predicted.x + dx, predicted.y + dy);
        if (v < dMin) dMin = v; if (v > dMax) dMax = v;
      }
    }
    const range = Math.max(1, dMax - dMin);
    if (range < 18) return null;   // 事実上コントラスト無し（真に一様な領域）

    const cx0 = Math.round(predicted.x), cy0 = Math.round(predicted.y);
    // テンプレートを 1 点/セルで相関させると、パターン内部で score が「台地状」に
    // 平坦化する（各セルが一様塗りのため）。最大値を取る位置は台地の端に偏るので、
    // ①まず最大スコアを求め、②その最大付近（台地）に属する位置をスコアで重み付け
    // した重心をサブピクセル中心とする（ぼかし・レンジ圧縮に強い）。
    let bestScore = -Infinity, worstScore = Infinity;
    const scores = new Float64Array((2 * win + 1) * (2 * win + 1));
    let k = 0;
    for (let dyc = -win; dyc <= win; dyc++) {
      for (let dxc = -win; dxc <= win; dxc++) {
        const cx = cx0 + dxc, cy = cy0 + dyc;
        let score = 0;
        for (const p of ALIGN_TEMPLATE) score += p.w * dark(cx + p.dx * cell, cy + p.dy * cell);
        scores[k++] = score;
        if (score > bestScore) bestScore = score;
        if (score < worstScore) worstScore = score;
      }
    }
    // 相関コントラストの相対しきい: テンプレートは 13 暗点・12 明点なので、
    //  理想の相関ピークは概ね range*13 のオーダー。実効レンジに対して十分な
    //  ピーク・コントラストが立たなければ棄却する（絶対値 60 の相対版）。
    const peakSpan = bestScore - worstScore;
    if (bestScore < range * 5 || peakSpan < range * 4) return null;
    // 台地（最大スコアの 90% 以上）をスコア重みで重心化＝サブピクセル中心。
    const thr = worstScore + (bestScore - worstScore) * 0.90;
    let sx = 0, sy = 0, sw = 0; k = 0;
    for (let dyc = -win; dyc <= win; dyc++) {
      for (let dxc = -win; dxc <= win; dxc++) {
        const sc = scores[k++];
        if (sc >= thr) {
          const wgt = sc - thr + 1e-6;
          sx += (cx0 + dxc) * wgt; sy += (cy0 + dyc) * wgt; sw += wgt;
        }
      }
    }
    if (sw === 0) return null;
    const fx = sx / sw, fy = sy / sw;

    // ---- 構造の厳密検証（データ領域の“偶然の相関”を弾く）----------------
    //  相関スコアだけでは、データ領域が同心マーカーに似た瞬間に誤検出する
    //  （ECC0 では 1 セル誤りも命取り）。求めた中心で「中央=暗 / 半径1セル
    //  リング=明 / 半径2セルリング=暗」という二値構造が実際に成立するかを、
    //  リングごとの平均コントラストで検証する。しきいは絶対値ではなく実効
    //  レンジ比（ドットゲインで縮んでも追従）で判定する。
    const D = (dx, dy) => dark(fx + dx * cell, fy + dy * cell);
    const center = D(0, 0);
    let ring1 = 0, ring2 = 0;
    // ring1（半径1セル）4 近傍、ring2（半径2セル）4 近傍。
    for (const [ux, uy] of [[1,0],[-1,0],[0,1],[0,-1]]) { ring1 += D(ux, uy); ring2 += D(ux * 2, uy * 2); }
    ring1 /= 4; ring2 /= 4;
    // 中央は明るいリングより十分暗く、外リングも明るいリングより十分暗いこと。
    //  マージンは実効レンジの 35%（=二値化マージンの目安の相対版）。
    const margin = range * 0.35;
    if (!(center - ring1 > margin && ring2 - ring1 > margin)) return null;

    // 診断・選別用の品質指標:
    //  peakRatio    = 相関ピーク・コントラスト / 実効レンジ（構造の“鋭さ”）
    //  ringMargin   = min(中央−明リング, 外リング−明リング) / range（同心性の強さ）
    const peakRatio = peakSpan / range;
    const ringMargin = Math.min(center - ring1, ring2 - ring1) / range;
    return { x: fx, y: fy, score: bestScore, range, peakRatio, ringMargin };
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

    // ==================================================================
    //  §10-8 内部アライメント検出の粗→密反復（探索窓不足バグの本命修正）
    // ------------------------------------------------------------------
    //  旧実装は「大域ホモグラフィ予測の周囲を固定 ±1.6 セルで 1 回だけ探索し、
    //  かつ乖離 1.5 セル以上は誤検出とみなして棄却」していた。しかし中央たわみ
    //  では真の乖離が 3〜5 セルに達するため、真のアライメントが窓外・棄却帯に
    //  出て 87% が原理的に見つからず、四隅は正確なのに内部メッシュが崩壊した。
    //
    //  新実装は QR/写真計測の定石＝「粗いアンカーから密へ伝播」する:
    //   パスA（粗アンカー）: 探索窓を **期待される最大歪み分だけ広げて**
    //     （±3.2 セル）、大域予測の周りから“確実に構造検証を通る”アライメントを
    //     まず数点拾う。窓が広いぶん誤検出も混じり得るが、後段の空間平滑性
    //     フィルタ（パス2）で除去する。
    //   パスB（密伝播・反復）: まだ見つかっていない節点それぞれについて、
    //     すでに見つかった近傍節点の「乖離ベクトル場」を距離重み付き補間して
    //     予測位置を補正し、その改善予測の周りを **狭い窓（±1.2 セル）** で
    //     探索する。近傍が確定するほど予測が正確になり、狭い窓でも高確率で
    //     当たる。新規検出が無くなるまで数回反復する。
    //  この「広い窓で種を蒔き、狭い窓で確実に増やす」構造で、たわみでも
    //  内部検出率が 14%→ほぼ全点に跳ね上がる。
    // ==================================================================
    const pts = [];
    for (let j = 0; j < vs.length; j++) {
      const rowPts = [];
      for (let i = 0; i < us.length; i++) {
        const u = us[i], v = vs[j];
        const onUedge = (i === 0 || i === us.length - 1);
        const onVedge = (j === 0 || j === vs.length - 1);
        if (onUedge && onVedge) {
          const isL = (i === 0), isT = (j === 0);
          const cidx = isT ? (isL ? 0 : 1) : (isL ? 3 : 2);
          rowPts.push({ x: corners[cidx].x, y: corners[cidx].y, corner: true, i, j });
          continue;
        }
        const pred = predict(u, v);
        rowPts.push({ x: pred.x, y: pred.y, predicted: true, i, j, u, v });
      }
      pts.push(rowPts);
    }

    // この節点が「描画されている内部アライメント」か（検出対象か）を判定。
    //  境界節点(u/v edge) と 3 隅の未描画アライメント(TL/TR/BL) は検出しない。
    const isDetectable = (i, j) => {
      const onUedge = (i === 0 || i === us.length - 1);
      const onVedge = (j === 0 || j === vs.length - 1);
      if (onUedge || onVedge) return false;
      const undrawnCorner =
        (i === iAlignFirst && j === jAlignFirst) ||   // TL
        (i === iAlignLast  && j === jAlignFirst) ||   // TR
        (i === iAlignFirst && j === jAlignLast);      // BL
      return !undrawnCorner;
    };

    // 検出済み節点（found=true）の乖離ベクトルから、任意節点 (i,j) の予測補正を
    //  距離重み付き（IDW）で推定する。found が無ければ大域予測をそのまま返す。
    const localPredict = (i, j) => {
      const base = predict(us[i], vs[j]);
      let wsum = 0, sx = 0, sy = 0, cnt = 0;
      for (const row of pts) {
        for (const cell of row) {
          if (!cell.found) continue;
          const p0 = predict(us[cell.i], vs[cell.j]);
          const ddx = cell.x - p0.x, ddy = cell.y - p0.y;
          const di = cell.i - i, dj = cell.j - j;
          const d2 = di * di + dj * dj;
          if (d2 === 0) continue;
          const wgt = 1 / (d2 * d2);   // 近傍を強く優先（IDW p=4 相当）
          sx += ddx * wgt; sy += ddy * wgt; wsum += wgt; cnt++;
        }
      }
      if (cnt === 0 || wsum === 0) return base;
      return { x: base.x + sx / wsum, y: base.y + sy / wsum };
    };

    // 1 節点の検出試行。winCells の窓で探索し、構造検証を通り、かつ予測
    //  （localPredict/大域予測）からの残差が maxDevCells 以内なら採用する。
    //  usePred=true は「近傍 found から補正した局所予測」を基準にする（伝播用）。
    const tryDetect = (cell, i, j, winCells, maxDevCells, usePred) => {
      const pred = usePred ? localPredict(i, j) : predict(us[i], vs[j]);
      const ref = refineAlignment(img, pred, span, invert, { winCells });
      if (!ref) return false;
      const dev = Math.hypot(ref.x - pred.x, ref.y - pred.y);
      if (dev > cellPx * maxDevCells) return false;   // 予測から遠すぎ＝誤検出
      cell.x = ref.x; cell.y = ref.y; cell.predicted = false; cell.found = true;
      cell.ref = ref;
      return true;
    };
    const countFound = () => {
      let n = 0; for (const row of pts) for (const c of row) if (c.found) n++; return n;
    };

    // 期待される最大歪み（セル単位）は密度に比例する（実測: 概ね cols/48）。
    //  探索窓・許容残差をこの density-adaptive なスケールで決めると、低密度版
    //  （ver1〜4）では旧来どおり狭く保って誤検出を避けつつ、高密度版（ver8〜14）
    //  では窓を必要なだけ広げて真のアライメントを取りこぼさない。
    const distScale = Math.max(cols, rows) / 48;         // ≒ 予想最大乖離(セル)
    const coarseWin = Math.min(3.4, Math.max(1.8, distScale * 0.9)); // 粗窓
    const coarseDev = Math.min(3.6, Math.max(1.7, distScale + 0.4)); // 粗許容残差

    // --- パスA: 粗シード（大域予測基準）--------------------------------
    //  まず大域予測の周りを density-adaptive な窓で探索し、種を蒔く。誤検出は
    //  後段の局所平滑性フィルタ（パス2）で落とす。窓が広い高密度版でも、種を
    //  蒔いたあとはパスBの局所予測で残差が締まる。
    for (let j = 0; j < vs.length; j++)
      for (let i = 0; i < us.length; i++)
        if (isDetectable(i, j)) tryDetect(pts[j][i], i, j, coarseWin, coarseDev, false);

    // --- パスB: 密伝播（狭い窓・近傍補正予測基準・反復）----------------
    //  近傍 found から補正した予測（localPredict）の周りを狭い窓 ±1.3 セルで
    //  探索し、残差 0.9 セル以内を採用。予測が近傍で補正されているので狭い窓
    //  でも当たり、かつ厳しい残差で誤検出を締める。新規が無くなるまで反復。
    for (let iter = 0; iter < 8; iter++) {
      let added = 0;
      for (let j = 0; j < vs.length; j++)
        for (let i = 0; i < us.length; i++) {
          const cell = pts[j][i];
          if (cell.found || !isDetectable(i, j)) continue;
          if (tryDetect(cell, i, j, 1.3, 0.9, true)) added++;
        }
      if (added === 0) break;
    }

    // 各 found 節点の「大域予測からの乖離ベクトル」を記録（外れ値判定に使う）。
    for (const row of pts)
      for (const cell of row)
        if (cell.found) {
          const p0 = predict(us[cell.i], vs[cell.j]);
          cell.ddx = cell.x - p0.x; cell.ddy = cell.y - p0.y;
        }

    // --- パス2: 局所平滑性による外れ値除去 ----------------------------
    //  【§10-8 の重要修正】旧実装は「全 found の乖離が単一の中央値ベクトル
    //  近傍にある」ことを仮定した大域中央値フィルタだった。これはクランプで
    //  乖離を <1.5 セルに抑えていた時代の前提であり、実際のバレル歪みでは
    //  乖離が位置ごとに 0〜5 セルへ連続変化する（中心小・周辺大・向きも様々）
    //  ため、正しい検出まで“中央値から遠い”として大量に棄却してしまう。
    //
    //  歪み場が保証するのは「大域的に一定」ではなく「**局所的に滑らか**」で
    //  ある。そこで各 found を、その **k 近傍 found の乖離の中央値** と比べ、
    //  近傍と食い違う（＝孤立した誤検出）ものだけを棄却する。近傍が乏しい
    //  （<3）節点は大域中央値でバックストップ判定する。これでバルジの連続的
    //  歪みは全面採用しつつ、データ領域の偶然一致は落とせる。
    //
    //  【実機フィードバック §10-1: バルジ k=0.018 の ON 単体劣化バグ】
    //  ver3/ecc3 の中央たわみ掃引（test/e2e §10-1）で、k=0.016(正常)→
    //  k=0.018(ON だけ flips 135 で失敗)→k=0.02(正常化) という**非単調な特異点**
    //  が判明した。原因を全 found 節点の「近傍中央値からの残差 / cellPx」で切り分け
    //  た結果、**ただ 1 つの内部アライメント節点（右上, cell≈(63,6)）の検出中心が
    //  ~0.8 セルずれる誤検出**で、その 1 点が区分 bilinear メッシュを引きつれて
    //  周囲 25×14 セルを反転させていた（k を上げると誤検出の乖離が偶然ピークに
    //  乗る非単調挙動）。
    //  実測（test/_k_toldist*.js）: 正当なバルジ warp 節点の残差は最悪でも
    //   ≤0.54 セル（ver8〜14/k≤0.024）に収まる一方、この誤検出だけが 0.78〜0.87
    //   セルへ突出していた。旧しきい tolNbr=cellPx*0.9 はこの外れ値を取りこぼして
    //   いた。しきいを cellPx*0.6 へ締めると、正当節点（≤0.54）は全て残しつつ
    //   誤検出だけを弾ける（0.54 と 0.78 の間に十分なマージンがある）。
    //  さらに棄却時の後始末を改善: 従来は「大域予測へ戻す（found 解除）」だった
    //   が、それだと周囲の warp を捨てて縁の外挿にも寄与しなくなる。代わりに
    //   **近傍中央値の乖離ベクトル (mdx,mdy) を予測へ足した局所平滑位置**へ
    //   スナップする（found のまま＝局所 warp を保持）。これで誤検出 1 点だけを
    //   周囲と滑らかに一致させ、区分メッシュの折れを解消する。
    let refined = 0;
    const foundCells = [];
    for (const row of pts) for (const cell of row) if (cell.found) foundCells.push(cell);
    if (foundCells.length > 0) {
      const med = (arr) => { const a = arr.slice().sort((p, q) => p - q); return a.length ? a[a.length >> 1] : 0; };
      const gdx = med(foundCells.map(c => c.ddx));
      const gdy = med(foundCells.map(c => c.ddy));
      const K = 5;                          // 近傍数
      const tolNbr = Math.max(cellPx * 0.6, 1);   // 近傍中央値との許容差（§10-1 で 0.9→0.6）
      const tolGlob = Math.max(cellPx * 2.5, 1);  // 近傍が乏しい時の大域許容差
      for (const cell of foundCells) {
        // 近傍 K 個（自分以外の found）を格子距離で選ぶ。
        const nbrs = foundCells
          .filter(o => o !== cell)
          .map(o => ({ o, d2: (o.i - cell.i) ** 2 + (o.j - cell.j) ** 2 }))
          .sort((a, b) => a.d2 - b.d2)
          .slice(0, K)
          .map(e => e.o);
        let mdx, mdy, tol, haveNbr;
        if (nbrs.length >= 3) {
          mdx = med(nbrs.map(o => o.ddx)); mdy = med(nbrs.map(o => o.ddy)); tol = tolNbr; haveNbr = true;
        } else {
          mdx = gdx; mdy = gdy; tol = tolGlob; haveNbr = false;
        }
        if (Math.hypot(cell.ddx - mdx, cell.ddy - mdy) <= tol) {
          cell.predicted = false; refined++;
        } else if (haveNbr) {
          // 外れ値だが近傍が十分ある: 近傍中央値の乖離へスナップ（局所 warp を保持）。
          //  大域予測へ丸めるより滑らかで、縁の外挿にも寄与し続ける。
          const p0 = predict(us[cell.i], vs[cell.j]);
          cell.x = p0.x + mdx; cell.y = p0.y + mdy;
          cell.ddx = mdx; cell.ddy = mdy;
          cell.predicted = false; refined++;
        } else {
          // 外れ値かつ近傍が乏しい: 信頼できる補正が作れないので大域予測へ戻す。
          const p0 = predict(us[cell.i], vs[cell.j]);
          cell.x = p0.x; cell.y = p0.y; cell.predicted = true; cell.found = false;
        }
        delete cell._cand;
      }
    }

    // --- パス3: 境界節点への歪み場の外挿（内部アライメント検出の“端まで延長”）---
    //  【実機フィードバック §10-7】バグの核心:
    //  内部（アライメント節点がある領域）は refined 節点で正しく補正されるが、
    //  最外アライメント列（セル 6 と n-7）より外側の**境界帯**（データ箱の縁〜
    //  最外アライメント）は、これまで「四隅 corners への大域予測」に丸めていた。
    //  中央たわみ（バレル歪み）ではこの境界帯こそ大域ホモグラフィが最も外れる
    //  ため、高密度版（ver14）では縁のセルが数%も反転し、内部は完璧なのに RS を
    //  超過していた（四隅は正確なのに“内部アライメント側で崩れる”実機症状の
    //  正体）。
    //
    //  対策: 境界節点 (u=0/1 または v=0/1) の位置を corners/大域予測へ丸めず、
    //  同じ行/列で内側にある 2 つの refined 節点の「予測からの乖離ベクトル」を
    //  線形外挿して与える。これで内部で観測した歪み場が縁まで滑らかに延長され、
    //  境界帯のサンプリングが実位置に追従する。外挿は refined 節点が 2 つ以上
    //  ある行/列でのみ行い（1 点以下なら大域予測のまま＝クリーン時の安全側）、
    //  外挿量は 2 セルにクランプして暴れを防ぐ。
    if (refined >= 3) {
      // node.u / node.v は正規化座標。乖離＝実位置 − 大域予測。
      const dev = (node) => {
        const p = predict(node.u, node.v);
        return { ddx: node.cell.x - p.x, ddy: node.cell.y - p.y };
      };
      // 1 本の節点列（行 or 列）について、内側 refined 2 点から両端を線形外挿。
      const extrap1D = (nodes) => {
        // t=その軸に沿う正規化座標（昇順）。ref=検出済み内部節点。
        const ref = nodes.filter(n => n.cell && n.cell.predicted === false && !n.cell.corner);
        if (ref.length < 2) return;
        const first = ref[0], second = ref[1];
        const last = ref[ref.length - 1], prev = ref[ref.length - 2];
        const d0 = dev(first), d1 = dev(second), dL = dev(last), dP = dev(prev);
        for (const n of nodes) {
          if (!n.cell || n.cell.corner) continue;
          if (n.cell.predicted === false) continue;         // 検出済みは触らない
          const isLowEnd  = n.t <= first.t;                 // 低い側の端／外側
          const isHighEnd = n.t >= last.t;                  // 高い側の端／外側
          if (!isLowEnd && !isHighEnd) continue;            // 内側の未検出は大域予測のまま
          let ex, ey;
          if (isLowEnd) {
            const denom = (second.t - first.t) || 1;
            const s = (n.t - first.t) / denom;              // s<=0（外挿）
            ex = d0.ddx + (d1.ddx - d0.ddx) * s;
            ey = d0.ddy + (d1.ddy - d0.ddy) * s;
          } else {
            const denom = (last.t - prev.t) || 1;
            const s = (n.t - last.t) / denom;               // s>=0（外挿）
            ex = dL.ddx + (dL.ddx - dP.ddx) * s;
            ey = dL.ddy + (dL.ddy - dP.ddy) * s;
          }
          // 外挿量を ±2 セルにクランプ（暴れ防止）。
          const mag = Math.hypot(ex, ey), lim = cellPx * 2;
          if (mag > lim) { ex *= lim / mag; ey *= lim / mag; }
          const p = predict(n.u, n.v);
          n.cell.x = p.x + ex; n.cell.y = p.y + ey; n.cell.extrapolated = true;
        }
      };

      // 各行 j（v 固定）: i=0..last の節点列を u 昇順で外挿。
      for (let j = 1; j < vs.length - 1; j++) {
        const nodes = [];
        for (let i = 0; i < us.length; i++) {
          nodes.push({ t: us[i], u: us[i], v: vs[j], cell: pts[j][i] });
        }
        extrap1D(nodes);
      }
      // 各列 i（u 固定）: j=0..last の節点列を v 昇順で外挿。
      for (let i = 1; i < us.length - 1; i++) {
        const nodes = [];
        for (let j = 0; j < vs.length; j++) {
          nodes.push({ t: vs[j], u: us[i], v: vs[j], cell: pts[j][i] });
        }
        extrap1D(nodes);
      }
    }

    // メッシュが大域ホモグラフィから離れている度合い（最大／中央値, セル単位）。
    //  §10-1 の安全ゲート用: 乖離が小さいなら大域ホモグラフィの方が滑らかで安全
    //  なので、sampleModules 側はメッシュを採用せず大域予測へフォールバックする。
    let maxDevCells = 0;
    const devs = [];
    for (const row of pts) for (const cell of row) {
      if (cell.predicted === false && !cell.corner) {
        const p0 = predict(us[cell.i], vs[cell.j]);
        const d = Math.hypot(cell.x - p0.x, cell.y - p0.y) / cellPx;
        devs.push(d); if (d > maxDevCells) maxDevCells = d;
      }
    }
    devs.sort((a, b) => a - b);
    const medDevCells = devs.length ? devs[devs.length >> 1] : 0;

    return { us, vs, pts, cols, rows, span, refined, maxDevCells, medDevCells,
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
      // §10-1 の安全ゲート（ON は OFF に劣化させない）。3 条件すべてを要求する:
      //  (1) 検出点が十分ある（refined>=3, かつ内部節点の 15% 以上）… 疎すぎる
      //      誤検出でメッシュを張らない（従来からの条件）。
      //  (2) 【§10-8 追加】メッシュが大域ホモグラフィから **有意に離れている**
      //      こと。旧実装は「検出率が高ければメッシュ採用」だったが、内部検出を
      //      強化した結果、軽微たわみでも検出率が高くなり、大域ホモグラフィが
      //      既に完璧な低密度版（ver3 等, 実測 flips=0）でも 86% 検出→メッシュ
      //      採用→区分 bilinear の微小折れで **74 セルも反転**する劣化を招いた。
      //      歪みが小さい（メッシュ中央値乖離 < 0.6 セル かつ 最大 < 1.2 セル）
      //      なら大域ホモグラフィの方が滑らかで安全なのでメッシュを採用しない。
      //      真のたわみは節点を大きく（>1.2 セル）動かすのでここで判別できる。
      const enoughFrac  = m.total > 0 && (m.refined / m.total) >= 0.15;
      const enoughCount = m.refined >= 3;
      // significantWarp のしきいは「同じ残差乖離でも高密度ほど多くのセルを
      //  反転させる」実測に基づく: 大域ホモグラフィで復元できる低密度版
      //  （ver1〜4, globalFlips=0）は残差中央値 <=0.31 セルに収まる一方、
      //  大域では大量反転する高密度版（ver8〜14, globalFlips=数千〜）は
      //  >=0.44 セル。境界の 0.40 で「大域で足りる/メッシュが要る」を分ける。
      //  なお decodeAnyVersion 側の「アライメント ON/OFF 二段試行」が最終
      //  安全網なので、この静的ゲートを外しても正しさは保たれる（速度最適化）。
      const significantWarp = (m.maxDevCells >= 1.2) || (m.medDevCells >= 0.40);
      if (enoughFrac && enoughCount && significantWarp) mesh = m;
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
    //  clusterMeans=[黒山平均, 白山平均] も受け取り、実効ダイナミックレンジ
    //  gRange=白山−黒山 を得る（パス2の“レンジ相対マージン”に使う）。
    const _otsu = otsuThresholdF(cellAvg, true);
    const globalThr = _otsu.mid;
    const gBlack = _otsu.mB, gWhite = _otsu.mF;
    const gRange = Math.max(1, gWhite - gBlack);

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
    //
    //  【実機フィードバック §10-9: 二値化先行→膨張ドットゲインの黒潰れバグ】
    //  実機の「先に二値化してから 4 近傍膨張」型ドットゲイン（自作 degrade.js
    //  方式）を render-helper.dotGainBinary で忠実再現して掃引したところ、
    //  高密度版（ver14, セル≒8.6px）で膨張 3 回（セル比 0.35）を掛けると
    //  **黒セルの 27.9% が“白”へ誤反転**して MAGIC 不一致で全滅していた
    //  （ver14/ecc0/growPx3: flips 25097/90000）。
    //  原因を実測で切り分けた結果:
    //   ・膨張後は盤面の約半分が黒に太り、白セルの平均が黒側へ大きく寄る
    //     （white-truth の cellAvg が [36.5, 110] へ潰れ、black-truth=30 と
    //      わずか 6.5 しか離れない region が生じる）。
    //   ・その region では 局所平均 lm≈35.9、globalThr≈37 となり、
    //     しきい thr = lm − C(=6) ≈ 29.9〜30.0 が **黒の実値 30.0 に一致**する。
    //   ・判定が厳密不等号 `avg < thr` だったため `30.0 < 30.0` が偽になり、
    //     真っ黒のセルが“白”と読まれていた（＝しきいが黒クラスタ上に着地して
    //     いた off-by-epsilon）。これがパス2の局所平滑性フィルタでもパス3の
    //     境界外挿でもない、**二値化しきいそのものの実バグ**である。
    //  対策: しきいを黒クラスタから確実に引き離すため、実効レンジ gRange の
    //   一定割合（MARGIN_FRAC）だけ「暗側（1=黒 と読む側）へ」広げた
    //   `avg < thr + margin` で判定する。margin は絶対値 C ではなくレンジ
    //   相対なので、ドットゲインでコントラストが 255→80 に縮んでも比例縮小して
    //   追従する。実測掃引（test/e2e-selftest §10-9）で MARGIN_FRAC=0.10 が
    //   ver14/ecc0/growPx3 の flips を 25097→24（＝復元成功）に激減させつつ、
    //   ecc3/growPx3（元々 flips=0）・低密度版・クリーンを退行させない最適値。
    //  なぜ黒側へ寄せてよいか: 二値化先行→膨張は物理的に「黒だけが太る」非対称
    //   劣化なので、境界の曖昧セルは白より黒である事前確率が高い。margin で
    //   暗側へ寄せるのはこの非対称性に沿った最尤側の補正であり、白セルが黒へ
    //   潰れる g≥4（情報消失域）を除けば白→黒の誤反転は増えない（実測）。
    const C = 6;
    const MARGIN_FRAC = 0.10;
    const margin = gRange * MARGIN_FRAC;
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
        // §10-9: しきいを黒クラスタから引き離すレンジ相対マージン（暗側へ拡張）。
        modules[r * cols + c] = avg < thr + margin ? 1 : 0;
      }
    }
    modules.__meshRefined = mesh ? mesh.refined : 0;
    modules.__meshTotal = mesh ? mesh.total : 0;
    return modules;
  }

  // セル平均（Float32Array, 0..255）に対する大津法。CF.otsuThreshold は
  //  整数 gray 前提のため、ここでは連続値を 256bin に量子化して求める。
  //  返り値は「黒山と白山の中点」（CF.otsuThreshold と同じ思想）。
  //  withClusters=true のときは {mid, mB, mF}（黒山平均・白山平均）を返す。
  //  §10-9 のレンジ相対マージンが実効ダイナミックレンジ mF−mB を要るため。
  function otsuThresholdF(vals, withClusters) {
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
    if (withClusters) {
      let mB = isFinite(mBstar) ? mBstar : 0;
      let mF = isFinite(mFstar) ? mFstar : 255;
      if (!(mF > mB)) { mB = 0; mF = 255; }   // 退化時は全域レンジで保険
      return { mid, mB, mF };
    }
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
    // 試し読みする版の集合。既定は全版（＝プロダクションの自動判別）。
    //  opt.versions を渡すと候補版を絞れる（テストや、版が既知の場面で
    //  全 14 版 × 全面サンプリングの重い試し読みを避けるための任意最適化。
    //  プロダクションの decoder.html は既定のまま＝全版自動判別を維持する）。
    let versions = CF.VERSIONS;
    if (opt.versions != null) {
      const want = Array.isArray(opt.versions) ? opt.versions : [opt.versions];
      const set = new Set(want);
      versions = CF.VERSIONS.filter(v => set.has(v));
      if (versions.length === 0) versions = CF.VERSIONS; // 不正指定は全版へ退避
    }
    // アライメント制御点メッシュを使うか。既定 true。
    //  【§10-1/§10-8 の最終安全網】opt.useAlignment を明示しない既定運用では、
    //  各版で「メッシュ ON」→（完全復号できなければ）「メッシュ OFF＝大域
    //  ホモグラフィ」の順に **両方** 試し、RS 完全復号できた方を採用する。
    //  これにより「ON が OFF に劣化しない」（§10-1）を、静的ゲートの当て推量に
    //  頼らず **決定的に保証** する（メッシュが偶然悪化する版でも大域で救済）。
    //  opt.useAlignment を明示した場合はその 1 モードのみ（比較検証用）。
    const alignModes = opt.useAlignment != null
      ? [opt.useAlignment]
      : [true, false];

    let last = { ok: false, reason: 'not-detected' };
    for (const invert of inverts) {
      const corners = opt.corners || detectCorners(img, { invert });
      if (!corners) { last = { ok: false, reason: 'no-corners' }; continue; }
      for (const version of versions) {
        const prof = CF.getProfile(version);
        for (const useAlignment of alignModes) {
          const modules = sampleModules(img, corners, prof.COLS, prof.ROWS,
            { invert, useAlignment });
          const r = CF.decodePageModules(modules, prof.COLS, prof.ROWS);
          if (r.meta && r.meta.magicOk) {
            // MAGIC 一致かつ自己申告 version がこの版と一致し RS 完全復号 → 即採用。
            if (r.meta.version === version && r.ok) {
              return Object.assign({ version, corners, invert, useAlignment }, r);
            }
            // MAGIC は合うが RS 未完（ヘッダだけ拾えた）→ 記録して継続。
            last = Object.assign({ version, corners, invert, useAlignment }, r);
          }
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
