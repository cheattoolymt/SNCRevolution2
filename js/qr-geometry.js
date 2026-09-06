/*
 * SuperNaidesuCardRevolution II (SNCR2) — qr-geometry.js
 * ==================================================================
 * 実装指示書 §2「物理レイアウト仕様」の実装。
 *
 * 旧 naidesu-cardloader (MIT, cheattoolymt(nyan4)) の
 * A4 ジオメトリ定数を「そのまま踏襲」する（指示書 1-A / §2）。
 * ここで定義する「データグリッドの箱」2152 x 3096px は
 * 全独自バージョン共通で固定。各バージョンは、この同じ長方形を
 * cols x rows に細分するだけ（正方形に切り詰めて余白を無駄にしない）。
 *
 * このファイルは DOM 非依存の純粋定数・純粋関数のみ。
 * ブラウザ(window.SNCR2Geometry) と Node(module.exports) の両対応。
 *
 * ── 対象範囲（このコミットで実装するのは §0〜§4 のみ）──────────────
 *   §5 インターリーブ / §6 マスク最適化 / §7 ヘッダ確定仕様 /
 *   §8-11（禁止事項確認・成果物一式・検証・ライセンス全文）は保留。
 * ================================================================== */

(function (global, factory) {
  'use strict';
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  global.SNCR2Geometry = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // ---- 用紙 A4 / 300dpi -------------------------------------------
  // 旧 cardloader と同一。KB は 1024 倍(=KiB)基準に統一（指示書 §2-1）。
  const DPI = 300;
  const PAGE_W = 2480; // px (= 8.2677 inch * 300dpi)
  const PAGE_H = 3508; // px (= 11.6929 inch * 300dpi)

  // ---- レイアウト定数(px) 旧 cardloader からそのまま踏襲 ----------
  //   QUIET  50px = 4.23mm  端余白（家庭用プリンタの印刷可能領域に収まる安全余白）
  //   FINDER 90px = 7.6mm   四隅マーカー（位置検出）
  //   GAP    24px = 2.0mm   ファインダ〜データグリッドの隙間
  //   FOOTER 84px = 7.1mm   箱直下の人間可読フッタ用
  const QUIET = 50;
  const FINDER = 90;
  const GAP = 24;
  const FOOTER = 84;

  // ---- 全バージョン共通のデータグリッド矩形(px) -------------------
  //   GRID_X = GRID_Y = QUIET + FINDER + GAP = 164
  //   GRID_W = PAGE_W - 2*GRID_X            = 2152 (= 182.2mm)
  //   GRID_H = PAGE_H - GRID_Y - GRID_X - FOOTER = 3096 (= 262.1mm)
  const GRID_X = QUIET + FINDER + GAP;               // 164
  const GRID_Y = QUIET + FINDER + GAP;               // 164
  const GRID_W = PAGE_W - 2 * GRID_X;                // 2152
  const GRID_H = PAGE_H - GRID_Y - GRID_X - FOOTER;  // 3096

  // px -> mm 変換（1 inch = 25.4mm）
  const MM_PER_PX = 25.4 / DPI;
  function pxToMm(px) { return px * MM_PER_PX; }

  // 指示書 §2-1「セルサイズは 0.7mm 以上を下限とする」の判定閾値。
  // これ未満へは踏み込まない（力技での縮小禁止）。
  const MIN_CELL_MM = 0.7;

  // ---- 拡張版（ver15 以降）用の下限 --------------------------------
  //  §2-1 の 0.7mm は「300dpi 印刷・300dpi スキャン」を暗黙の前提にした
  //  実用下限である（0.7mm = 8.27px/セル）。容量目標を 10KB から 15〜20KB へ
  //  引き上げるには、同じ箱（2152×3096px 固定）をさらに細分するしかないため、
  //  0.7mm を割る密度が必要になる。
  //
  //  そこで下限を「1 段階」だけ緩めた拡張ティアを設ける。ただし力技の縮小に
  //  しないため、次の条件をセットで課す（これが 0.7mm 下限の実質的な代替）:
  //    (1) 印刷解像度を 600dpi 以上にする（creator の DPI 倍率＝renderScale）。
  //        0.52mm セルでも 600dpi なら 12.4px/セルとなり、300dpi での 0.7mm
  //        （8.27px/セル）より **むしろ高精細** に印刷できる。
  //    (2) 読み取りも 600dpi スキャンを推奨（等倍・正面・平面固定）。
  //    (3) UI 上で「拡張密度（要 600dpi）」であることを明示する。
  //  つまり拡張ティアは「セルを小さくして無理を通す」のではなく、
  //  「印刷/読取解像度を上げてセル当たり画素数を確保したうえで小さくする」。
  //
  //  MIN_CELL_EXT_MM = 0.50mm は 600dpi で 11.8px/セルに相当し、300dpi の
  //  0.7mm（8.27px/セル）より余裕がある。これを拡張ティアの硬い下限とする。
  const MIN_CELL_EXT_MM = 0.50;

  // 拡張ティアで推奨する印刷/スキャン解像度（dpi）。
  const EXT_RECOMMENDED_DPI = 600;

  // ---- 四隅ファインダ中心座標（全バージョン共通・旧 cardloader 踏襲）
  // §2-0: スキャナ前提だが、旧 cardloader の四隅検出ロジックを活かすため
  //       ファインダ位置は据え置き。中央部・周辺部の歪み補正は §3 の
  //       アライメントパターンで別途強化する。
  function finderCenters() {
    const half = FINDER / 2;
    return {
      tl: { x: GRID_X - GAP - half,          y: GRID_Y - GAP - half },
      tr: { x: GRID_X + GRID_W + GAP + half, y: GRID_Y - GAP - half },
      br: { x: GRID_X + GRID_W + GAP + half, y: GRID_Y + GRID_H + GAP + half },
      bl: { x: GRID_X - GAP - half,          y: GRID_Y + GRID_H + GAP + half },
    };
  }

  // ---- あるバージョンの cols x rows から、セル寸法を求める ---------
  // 「箱」は固定なので、cols/rows が増えるほどセルは小さくなる。
  function cellSize(cols, rows) {
    return {
      cellWpx: GRID_W / cols,
      cellHpx: GRID_H / rows,
      cellWmm: pxToMm(GRID_W / cols),
      cellHmm: pxToMm(GRID_H / rows),
      // 実用下限判定は「短辺」で行う（正方形に近いほど min≈max）。
      minCellMm: Math.min(pxToMm(GRID_W / cols), pxToMm(GRID_H / rows)),
    };
  }

  // cols x rows が 0.7mm 下限を満たすか（§2-1 の実用ライン下限）。
  function meetsMinCell(cols, rows) {
    return cellSize(cols, rows).minCellMm >= MIN_CELL_MM - 1e-9;
  }

  // cols x rows が拡張ティアの下限（0.50mm・600dpi 前提）を満たすか。
  function meetsMinCellExt(cols, rows) {
    return cellSize(cols, rows).minCellMm >= MIN_CELL_EXT_MM - 1e-9;
  }

  // ある cols x rows が要求する最小印刷/スキャン解像度(dpi)。
  //  「1 セルあたり最低 minPxPerCell 画素」を確保するのに必要な dpi を返す。
  //  300dpi・0.7mm セル（= 8.27px/セル）を基準の実用ラインとみなし既定 8。
  //  実際の印刷機・スキャナは 300 の整数倍が扱いやすいので 300 刻みへ切り上げる。
  function requiredDpi(cols, rows, minPxPerCell) {
    const need = minPxPerCell != null ? minPxPerCell : 8;
    const minMm = cellSize(cols, rows).minCellMm;
    const dpi = need * 25.4 / minMm;   // minMm*dpi/25.4 >= need
    return Math.max(DPI, Math.ceil(dpi / 300) * 300);
  }

  // 箱のアスペクト比（縦長）。長方形バージョン体系設計の基準。
  //   GRID_H / GRID_W = 3096 / 2152 ≈ 1.4387
  const GRID_ASPECT = GRID_H / GRID_W;

  return {
    DPI, PAGE_W, PAGE_H,
    QUIET, FINDER, GAP, FOOTER,
    GRID_X, GRID_Y, GRID_W, GRID_H,
    GRID_ASPECT,
    MM_PER_PX, MIN_CELL_MM,
    MIN_CELL_EXT_MM, EXT_RECOMMENDED_DPI,
    pxToMm,
    finderCenters,
    cellSize,
    meetsMinCell,
    meetsMinCellExt,
    requiredDpi,
  };
});
