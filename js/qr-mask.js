/*
 * SuperNaidesuCardRevolution II (SNCR2) — qr-mask.js
 * ==================================================================
 * 実装指示書 §6「マスクパターン最適化（nayuki からそのまま移植）」の実装。
 *
 * ── 移植元 ──────────────────────────────────────────────────────
 *   nayuki/QR-Code-generator (MIT, Project Nayuki)
 *   typescript-javascript/qrcodegen.ts の
 *     applyMask() … 8 種のマスク式（x,y のみに依存）
 *     getPenaltyScore() … 4 種の「読み取りにくさ」ペナルティ
 *       (1) 連続同色ラン (N1)  (2) 2x2 同色ブロック (N2)
 *       (3) 疑似ファインダパターン (N3)  (4) 黒白比率の偏り (N4)
 *     finderPenaltyCountPatterns / TerminateAndCount / AddHistory
 *   をそのまま移植した。
 *
 * ── §6 の要点（指示書より）─────────────────────────────────────
 *   「8 種のマスクと各ペナルティは x,y 座標のみに依存する汎用ロジックで、
 *     長方形グリッドでもそのまま使える。全マスクを評価して最小スコアの
 *     ものを自動選択する仕組みをそのまま移植すること。」
 *
 * ── 長方形化で加えた最小限の一般化 ─────────────────────────────
 *   nayuki は正方形前提で「明るい境界」補正に this.size（1 辺長）を
 *   使っていた。長方形では走査中の軸長（行なら cols、列なら rows）を
 *   使う必要があるため、ペナルティ補助関数に軸長 `lineLen` を引数で
 *   渡す形に一般化した（マスク式そのものは 1 文字も変えていない）。
 *   黒白比率(N4)の total も size*size ではなく cols*rows を使う。
 *
 * ── グリッド表現（cardloader / 他 SNCR2 モジュールと共通）──────
 *   modules   … Uint8Array(cols*rows)  0=明(白) / 1=暗(黒)  row-major
 *   isFunction… Uint8Array(cols*rows)  1=機能モジュール(マスク対象外)
 *   index(x,y) = y*cols + x
 *
 * このファイルは DOM 非依存の純粋関数のみ。
 * ================================================================== */

(function (global, factory) {
  'use strict';
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  global.SNCR2Mask = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // nayuki のペナルティ定数（そのまま）。
  const PENALTY_N1 = 3;  // 連続同色ラン (5 個で +3、以降 1 個ごと +1)
  const PENALTY_N2 = 3;  // 2x2 同色ブロック
  const PENALTY_N3 = 40; // 疑似ファインダ (1:1:3:1:1 パターン)
  const PENALTY_N4 = 10; // 黒白比率の偏り (5% 刻み)

  const NUM_MASKS = 8;

  const idx = (x, y, cols) => y * cols + x;

  // ------------------------------------------------------------------
  //  §6: マスク式（nayuki applyMask() の switch をそのまま）。
  //   invert=true のセルだけ色反転する。x,y のみに依存。
  // ------------------------------------------------------------------
  function maskCondition(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
      default: throw new Error('Mask value out of range');
    }
  }

  // マスクを適用（XOR なので同じ mask で 2 回呼ぶと元に戻る＝nayuki と同じ）。
  // isFunction のセルには適用しない（データ領域のみ反転）。
  function applyMask(modules, isFunction, cols, rows, mask) {
    if (mask < 0 || mask >= NUM_MASKS) throw new RangeError('Mask value out of range');
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = idx(x, y, cols);
        if (!isFunction[i] && maskCondition(mask, x, y)) {
          modules[i] ^= 1;
        }
      }
    }
  }

  // ------------------------------------------------------------------
  //  疑似ファインダ検出補助（nayuki finderPenalty* をそのまま移植）。
  //  唯一の一般化: 「明るい境界」加算に使う長さ size を、走査軸の長さ
  //  lineLen（行=cols / 列=rows）へ差し替えた。
  // ------------------------------------------------------------------
  function finderPenaltyCountPatterns(runHistory) {
    const n = runHistory[1];
    const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 &&
                 runHistory[4] === n && runHistory[5] === n;
    return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
         + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
  }

  function finderPenaltyAddHistory(currentRunLength, runHistory, lineLen) {
    if (runHistory[0] === 0) currentRunLength += lineLen; // 先頭ランに明境界を加算
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  }

  function finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory, lineLen) {
    if (currentRunColor) { // 暗ランの終端処理
      finderPenaltyAddHistory(currentRunLength, runHistory, lineLen);
      currentRunLength = 0;
    }
    currentRunLength += lineLen; // 末尾に明境界を加算
    finderPenaltyAddHistory(currentRunLength, runHistory, lineLen);
    return finderPenaltyCountPatterns(runHistory);
  }

  // ------------------------------------------------------------------
  //  §6: ペナルティスコア（nayuki getPenaltyScore() をそのまま移植）。
  //   長方形化のため size→cols/rows、total→cols*rows に一般化。
  // ------------------------------------------------------------------
  function getPenaltyScore(modules, cols, rows) {
    let result = 0;

    // (N1/N3) 行方向: 連続同色ラン + 疑似ファインダ。
    for (let y = 0; y < rows; y++) {
      let runColor = 0, runX = 0;
      let runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < cols; x++) {
        const c = modules[idx(x, y, cols)];
        if (c === runColor) {
          runX++;
          if (runX === 5) result += PENALTY_N1;
          else if (runX > 5) result++;
        } else {
          finderPenaltyAddHistory(runX, runHistory, cols);
          if (!runColor) result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = c;
          runX = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runX, runHistory, cols) * PENALTY_N3;
    }

    // (N1/N3) 列方向。
    for (let x = 0; x < cols; x++) {
      let runColor = 0, runY = 0;
      let runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < rows; y++) {
        const c = modules[idx(x, y, cols)];
        if (c === runColor) {
          runY++;
          if (runY === 5) result += PENALTY_N1;
          else if (runY > 5) result++;
        } else {
          finderPenaltyAddHistory(runY, runHistory, rows);
          if (!runColor) result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = c;
          runY = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runY, runHistory, rows) * PENALTY_N3;
    }

    // (N2) 2x2 同色ブロック。
    for (let y = 0; y < rows - 1; y++) {
      for (let x = 0; x < cols - 1; x++) {
        const color = modules[idx(x, y, cols)];
        if (color === modules[idx(x + 1, y, cols)] &&
            color === modules[idx(x, y + 1, cols)] &&
            color === modules[idx(x + 1, y + 1, cols)]) {
          result += PENALTY_N2;
        }
      }
    }

    // (N4) 黒白比率の偏り。
    let dark = 0;
    for (let i = 0; i < modules.length; i++) dark += modules[i] ? 1 : 0;
    const total = cols * rows;
    // 45-5k% <= dark/total <= 55+5k% を満たす最小の整数 k>=0。
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;

    return result;
  }

  // ------------------------------------------------------------------
  //  §6: 全 8 マスクを評価し、最小ペナルティのマスクを自動選択する
  //   （nayuki の「最良マスク自動選択」をそのまま移植）。
  //
  //   modules は「マスク未適用」の状態で渡すこと。選ばれたマスクを
  //   適用した最終グリッドと、そのマスク番号・スコアを返す。
  //   isFunction のセルはマスク・スコア評価対象外（データ領域のみ）。
  //
  //   返り値: { mask, penalty, modules }（modules は選択マスク適用済み）
  // ------------------------------------------------------------------
  function chooseBestMask(modulesIn, isFunction, cols, rows) {
    let best = { mask: 0, penalty: Infinity, modules: null };
    for (let m = 0; m < NUM_MASKS; m++) {
      // 各候補は元グリッドの複製に適用して評価（相互干渉を避ける）。
      const trial = Uint8Array.from(modulesIn);
      applyMask(trial, isFunction, cols, rows, m);
      const penalty = getPenaltyScore(trial, cols, rows);
      if (penalty < best.penalty) {
        best = { mask: m, penalty, modules: trial };
      }
    }
    return best;
  }

  return {
    NUM_MASKS,
    PENALTY_N1, PENALTY_N2, PENALTY_N3, PENALTY_N4,
    maskCondition,
    applyMask,
    getPenaltyScore,
    finderPenaltyCountPatterns,
    finderPenaltyAddHistory,
    finderPenaltyTerminateAndCount,
    chooseBestMask,
  };
});
