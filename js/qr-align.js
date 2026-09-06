/*
 * SuperNaidesuCardRevolution II (SNCR2) — qr-align.js
 * ==================================================================
 * 実装指示書 §3「アライメントパターンの長方形・大版拡張」の実装。
 *
 * ── 移植元 ──────────────────────────────────────────────────────
 *   nayuki/QR-Code-generator (MIT, Project Nayuki)
 *   typescript-javascript/qrcodegen.ts の
 *   getAlignmentPatternPositions() を長方形・大版向けに一般化した。
 *
 * ── nayuki 版の元式（正方形専用・version 依存）──────────────────
 *     const numAlign = floor(version / 7) + 2;
 *     const step = floor((version*8 + numAlign*3 + 5) / (numAlign*4 - 4)) * 2;
 *     let result = [6];
 *     for (let pos = size-7; result.length < numAlign; pos -= step)
 *         result.splice(1, 0, pos);
 *     return result;
 *   → 「1 辺あたりの座標リスト」を返し、正方形なので縦横で同じリストを使う。
 *
 * ── §3 の要件 ──────────────────────────────────────────────────
 *   1. 長方形 (cols ≠ rows) 対応：縦横で別々の座標リストを出す。
 *   2. 等間隔・6 の倍数付近へ寄せる基本ロジックは維持。
 *   3. 配置密度は旧 cardloader「四隅ファインダのみ」より確実に密に。
 *      → 中央部・周辺部のたわみ／帯状ノイズ補正能力を持たせるため
 *        アライメントパターンを積極的に増やす（§10 の検証仮説1に対応）。
 *
 * このファイルは DOM 非依存の純粋関数のみ。
 * ================================================================== */

(function (global, factory) {
  'use strict';
  const Geo = (typeof require !== 'undefined') ? require('./qr-geometry.js') : global.SNCR2Geometry;
  const mod = factory(Geo);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  global.SNCR2Align = mod;
})(typeof window !== 'undefined' ? window : globalThis, function (Geo) {
  'use strict';

  // ------------------------------------------------------------------
  // 1 軸ぶんのアライメント中心座標リストを生成する（汎用化の核）。
  //
  //   n         … その軸のセル数（cols または rows）
  //   density   … アライメント密度係数。おおよそ「この間隔(セル)ごとに
  //               1 本アライメント列を置きたい」という目標間隔。
  //               小さいほど密（＝歪み補正が強い）。§3 の「四隅のみより密」
  //               を満たすため、旧 QR より積極的に密へ寄せた既定値を使う。
  //
  // 返り値: 昇順の座標配列。両端は必ずファインダ側 6 と (n-7) を含む。
  //         nayuki 同様に「端 6 は固定、逆端から step で詰め、6 の倍数
  //         付近に寄るよう step を偶数化」する。
  //
  // 設計方針:
  //   - nayuki の step 式は version(=size) から本数を決めていたが、
  //     長方形では軸ごとに n が違うので、まず「本数 numAlign」を
  //     目標間隔 density から決め、その本数で等間隔化する。
  //   - こうすると cols 用・rows 用を完全に独立して計算できる。
  // ------------------------------------------------------------------
  function axisPositions(n, density) {
    // 小さすぎる軸にはアライメント不要（ファインダだけで足りる）。
    // 6 と n-7 が重なる/交差するほど小さい場合は空配列。
    if (n < 21) return [];

    // 目標間隔から必要な「区間数」を求め、本数 = 区間数 + 1。
    // density セルごとに 1 本 → 区間数 ≈ (有効幅) / density。
    const span = (n - 7) - 6;            // 端アライメント中心間の距離
    if (span <= 0) return [6];
    let numAlign = Math.round(span / density) + 1;
    // 最低でも両端 + 中央の 3 本は置く（中央部補正のため）。
    if (numAlign < 3) numAlign = 3;

    // nayuki を踏襲し、step は偶数（6 の倍数付近＝タイミングパターンと
    // 整合する偶数座標に寄せる）。逆端から等間隔に詰める。
    const step = Math.ceil(span / (numAlign - 1) / 2) * 2;

    const result = [6];
    for (let pos = n - 7; result.length < numAlign && pos > 6; pos -= step) {
      // 6 と重複・逆転しない範囲でのみ挿入。
      if (pos > 6) result.splice(1, 0, pos);
    }
    // step の丸めで末尾が 6 に潰れた場合の保険（両端は最低限保証）。
    if (result[result.length - 1] !== n - 7) {
      // 末尾に n-7 を必ず含める（昇順維持）。
      if (result.indexOf(n - 7) < 0) result.push(n - 7);
      result.sort((a, b) => a - b);
    }
    // 重複除去（step 丸めで同一値が入り得る）。
    return result.filter((v, i) => i === 0 || v !== result[i - 1]);
  }

  // ------------------------------------------------------------------
  // 長方形グリッド (cols x rows) 用の 2 軸アライメント座標を返す。
  //
  //   opts.density … 軸共通の目標間隔（セル）。省略時 DEFAULT_DENSITY。
  //   opts.densityX / opts.densityY … 軸別に上書きしたい場合。
  //
  // 返り値: { xs: number[], ys: number[] }
  //   xs … 列(x)方向のアライメント中心座標リスト
  //   ys … 行(y)方向のアライメント中心座標リスト
  //   実際のパターン中心は xs×ys の直積。四隅ファインダと重なる
  //   3 箇所（左上・右上・左下）は描画時に除外する（nayuki と同じ規則）。
  // ------------------------------------------------------------------
  //
  //   ── 既定密度の決め方（後方互換の要点）─────────────────────────
  //   opts が空の場合の既定は「その cols×rows の実寸セルから物理間隔
  //   TARGET_PITCH_MM を満たす density」（= densityForCellSize）。ただし
  //   **既存 ver1〜14 のレイアウトを 1bit も変えない**ため、既存版の
  //   cols に対しては従来の DEFAULT_DENSITY(=20) を返す互換テーブルを
  //   引く（LEGACY_COLS）。これにより既に印刷済みのカードは読めたまま、
  //   新規の拡張版（ver15 以降）だけがオーバーヘッド削減の恩恵を受ける。
  // ------------------------------------------------------------------

  // 既存 ver1〜14 の cols（この密度体系は凍結する＝後方互換）。
  const LEGACY_COLS = new Set([
    60, 77, 90, 108, 120, 132, 145, 160, 175, 190, 205, 220, 235, 250,
  ]);

  // cols×rows に対する既定 density（セル単位）を決める。
  function defaultDensityFor(cols, rows) {
    if (LEGACY_COLS.has(cols)) return DEFAULT_DENSITY;   // 既存版は従来どおり
    if (!Geo || !Geo.cellSize) return DEFAULT_DENSITY;
    const cell = Geo.cellSize(cols, rows);
    return densityForCellPx(Math.min(cell.cellWpx, cell.cellHpx));
  }

  function alignmentPositions(cols, rows, opts) {
    opts = opts || {};
    const def = defaultDensityFor(cols, rows);
    const dx = opts.densityX != null ? opts.densityX
             : opts.density  != null ? opts.density
             : def;
    const dy = opts.densityY != null ? opts.densityY
             : opts.density  != null ? opts.density
             : def;
    return {
      xs: axisPositions(cols, dx),
      ys: axisPositions(rows, dy),
    };
  }

  // xs×ys の直積から、四隅ファインダと衝突する 3 点を除いた
  // 「実際に描くアライメント中心」の配列を返す（nayuki の規則を踏襲）。
  //   除外: (xs[0],ys[0]) 左上 / (xs[last],ys[0]) 右上 / (xs[0],ys[last]) 左下
  function alignmentCenters(cols, rows, opts) {
    const { xs, ys } = alignmentPositions(cols, rows, opts);
    const nx = xs.length, ny = ys.length;
    const centers = [];
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const isTL = (i === 0 && j === 0);
        const isTR = (i === nx - 1 && j === 0);
        const isBL = (i === 0 && j === ny - 1);
        if (isTL || isTR || isBL) continue;
        centers.push({ x: xs[i], y: ys[j] });
      }
    }
    return centers;
  }

  // §3「四隅のみより確実に密に」を満たす既定間隔。
  // 旧 QR version40 は 177 セルに 7 本 → 約 26 セル間隔。
  // 本プロジェクトは 0.7mm 級・スキャナ前提で歪み補正を強めたいので、
  // より密な「約 20 セルごとに 1 本」を既定とする。
  const DEFAULT_DENSITY = 20;

  // ==================================================================
  //  §C オーバーヘッド削減: 「補間誤差一定」のアライメント密度
  // ------------------------------------------------------------------
  //  DEFAULT_DENSITY=20 は **セル数** での固定間隔なので、密度が上がるほど
  //  アライメント個数が二次的に増え、オーバーヘッドを押し上げる:
  //     ver1  (60列・3.04mm/セル):  12 個（ovh 13.1%）
  //     ver14 (250列・0.73mm/セル): 218 個（ovh 6.8%）
  //     ver20 (348列・0.52mm/セル): 429 個（ovh 6.5%）… 拡張版では特に重い
  //
  //  では何個必要なのか。復号側（decode-core.js）はアライメント中心を制御点に
  //  した **区分 bilinear メッシュ** で歪みを補正する。滑らかな歪み場 w に対する
  //  bilinear 補間の残差は、格子間隔 p を使って
  //        残差[px] ≈ (1/8) * |w''| * p_px²
  //  でスケールする。一方サンプリングが破綻するかは「残差が何セル分か」で決まる:
  //        残差[セル] = 残差[px] / cellPx  ∝  p_px² / cellPx
  //  よって **残差[セル] を版に依らず一定** に保つ条件は
  //        p_px ∝ sqrt(cellPx)   ⇔   p_cells = p_px/cellPx ∝ 1/sqrt(cellPx)
  //  となる。つまり密度が上がるほど間隔（セル単位）は **粗く** してよいが、
  //  粗くできるのは 1/sqrt に比例する分だけ、という中間的な法則になる
  //  （「セル一定」＝過剰、「物理間隔一定」＝高密度で不足、その間）。
  //
  //  基準点は e2e §10-1 で「内部アライメントが確かに効いている」ことを実証
  //  済みの ver10（190列・cellPx = 2152/190 ≈ 11.3px・density 20）に取る。
  //        density(cellPx) = 20 * sqrt(11.3 / cellPx)
  //  これで
  //   ・低密度版（ver1〜4）  … 20 → 11〜16 と **より密** になり歪み耐性は向上
  //   ・中密度版（ver10 付近）… 20 のまま（基準点なので不変）
  //   ・高密度版（ver15〜20）… 24〜27 と粗くなり、個数＝オーバーヘッドが減る
  //  となり、「補間残差[セル]は一定に保ったままオーバーヘッドだけ削る」。
  const REF_CELL_PX = 2152 / 190;   // ver10 の 1 セル px（基準点）
  const REF_DENSITY = 20;           // その版で実証済みの density（セル）
  // 安全側のクランプ。粗すぎ（>34 セル）は歪み補正が薄くなり、密すぎ（<10 セル）
  //  はアライメント同士が近接して 5x5 パターンが干渉するため。
  const DENSITY_MIN = 10;
  const DENSITY_MAX = 34;

  //  cellPx … 1 セルの画像上の px 数（= GRID_W/cols 相当）。
  //  返り値: セル数での density（axisPositions が使う単位）。
  function densityForCellPx(cellPx) {
    if (!(cellPx > 0)) return DEFAULT_DENSITY;
    const d = REF_DENSITY * Math.sqrt(REF_CELL_PX / cellPx);
    return Math.max(DENSITY_MIN, Math.min(DENSITY_MAX, Math.round(d)));
  }

  return {
    DEFAULT_DENSITY,
    REF_CELL_PX, REF_DENSITY, DENSITY_MIN, DENSITY_MAX,
    LEGACY_COLS,
    densityForCellPx,
    defaultDensityFor,
    axisPositions,
    alignmentPositions,
    alignmentCenters,
  };
});
