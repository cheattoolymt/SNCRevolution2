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
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  global.SNCR2Align = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {
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
  function alignmentPositions(cols, rows, opts) {
    opts = opts || {};
    const dx = opts.densityX != null ? opts.densityX
             : opts.density  != null ? opts.density
             : DEFAULT_DENSITY;
    const dy = opts.densityY != null ? opts.densityY
             : opts.density  != null ? opts.density
             : DEFAULT_DENSITY;
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

  return {
    DEFAULT_DENSITY,
    axisPositions,
    alignmentPositions,
    alignmentCenters,
  };
});
