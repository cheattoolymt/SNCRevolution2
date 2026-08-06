/*
 * SuperNaidesuCardRevolution II (SNCR2) — qr-version.js
 * ==================================================================
 * 実装指示書 §4「RS ブロック表の新規設計」＋ §2-1「容量目標」の実装。
 *
 * ISO/IEC 18004 の version 1〜40 の ECC 表は実測ベースで数式化されて
 * いないため、「version 41 相当以降」に相当する本プロジェクトの独自
 * 長方形バージョンには『正解』が存在しない。よって §4 の指示どおり、
 * 旧 cardloader の blockPlan 方式（ブロック数を先に決め、グロス容量を
 * ブロック間で均等割り＝端数を捨てない）を土台に独自設計する。
 *
 * ── 依存 ────────────────────────────────────────────────────────
 *   SNCR2Geometry (js/qr-geometry.js) … 固定の箱 2152x3096・0.7mm 下限
 *   SNCR2Align    (js/qr-align.js)     … §3 の長方形アライメント座標
 *
 * ── このファイルが決める §4 のパラメータ ────────────────────────
 *   (a) 独自バージョン番号ごとの cols x rows（長方形・箱にフィット）
 *   (b) 各バージョンの物理オーバーヘッド（ファインダ/タイミング/
 *       アライメント/フォーマット情報）を数える → 生データセル数
 *   (c) ECC 4 段階（なし/低≈10%/中≈20%/高≈30%）: eccNsym = ratio*255 を偶数丸め
 *   (d) RS ブロック割り（ブロック数先決め・均等割り・<=255B）
 *   (e) ヘッダ用ブロックの扱い（旧 cardloader 同様 nsym=6 で別保護 → §7）
 *
 * ── 本コミットのスコープ ────────────────────────────────────────
 *   §0〜§4 の設計＋純粋関数のみ。実際のセル描画（drawFinder/Align/
 *   タイミング/フォーマット bit の配置）と §5 インターリーブ・
 *   §6 マスク・§7 ヘッダ確定 bit レイアウトは後続コミットで実装する。
 *   ここでは「容量計算に必要なオーバーヘッドのセル数モデル」までを固める。
 * ================================================================== */

(function (global, factory) {
  'use strict';
  const Geo = (typeof require !== 'undefined') ? require('./qr-geometry.js') : global.SNCR2Geometry;
  const Align = (typeof require !== 'undefined') ? require('./qr-align.js') : global.SNCR2Align;
  const mod = factory(Geo, Align);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  global.SNCR2Version = mod;
})(typeof window !== 'undefined' ? window : globalThis, function (Geo, Align) {
  'use strict';

  // ==================================================================
  // §4-(a) 独自バージョン番号 -> cols x rows
  // ------------------------------------------------------------------
  //   箱 GRID_W x GRID_H = 2152 x 3096（縦横比 ≈ 1.4387）。
  //   セルをほぼ正方形に保ちながら箱を敷き詰めるには
  //     rows ≈ cols * (GRID_H/GRID_W)
  //   を満たす cols/rows を選ぶ。cols を段階的に増やして版を作る。
  //
  //   下限は 0.7mm（§2-1）。最高密度でも 0.7mm を割らないよう cols 上限を決める。
  //     GRID_W=2152px, 0.7mm=8.268px → cols_max = floor(2152/8.268) ≈ 260
  //   目標グロス 10KB(=10240B) を満たす版まで用意する（§2-1「A4 1 枚で 10KB」）。
  // ==================================================================
  function makeVersionCols(cols) {
    // セルを正方形に保つ理想 rows。四捨五入で最も正方形に近い整数へ。
    const rows = Math.round(cols * Geo.GRID_ASPECT);
    return { cols, rows };
  }

  // バージョン表: cols を等差で増やす。旧 cardloader の 10 段階
  // (77x109 〜 239x344) を包含しつつ、より細かい刻みで版を用意する。
  // すべて 0.7mm 下限を満たす範囲。最終版で ~10KB グロスに到達させる。
  const VERSION_COLS = [
    60, 77, 90, 108, 120, 132, 145, 160, 175, 190,
    205, 220, 235, 250,
  ];

  // ==================================================================
  // §4-(b) 物理オーバーヘッドのセル数モデル
  // ------------------------------------------------------------------
  //   QR と同じ機能モジュールを長方形へ移植した前提で数える:
  //     - 四隅ファインダ 3 個（右下は無し）: 各 8x8 の占有 + セパレータ
  //       （nayuki は 9x9 相当。ここでは実測に合わせ finder 1 個 = 8*8=64 に
  //         セパレータ込みで 9*9-領域外はみ出しを考慮し 64 と近似）。
  //     - タイミングパターン: 6 行目/6 列目の 1 ライン（重複分を控除）。
  //     - アライメントパターン: §3 の xs×ys 直積から四隅衝突 3 点を除いた
  //       個数 * 5x5=25 セル。
  //     - フォーマット情報: QR と同じ 2 コピー = 約 31 セル（固定近似）。
  //   nayuki の getNumRawDataModules と同じ「機能モジュールを引いた残り」
  //   の考え方を、長方形・独自アライメント本数に一般化したもの。
  // ==================================================================
  function functionModuleCount(cols, rows) {
    const total = cols * rows;

    // 3 個のファインダ + セパレータ。1 個あたり 9x9 の占有を近似。
    // （左上・右上・左下。右下はアライメントで代替＝QR と同じ。）
    const finder = 3 * 9 * 9; // 243

    // タイミングパターン: 横 1 ライン(cols) + 縦 1 ライン(rows)。
    // ファインダ内に入る両端 8+8 セルは finder に計上済みなので控除。
    const timing = (cols - 16) + (rows - 16);

    // §3 のアライメント本数。四隅衝突 3 点は除外済みの個数。
    const aln = Align.alignmentCenters(cols, rows).length;
    // 5x5 だが、外周アライメントの一部はタイミング/ファインダと重なるため
    // 平均実効 24 セル/個として近似（nayuki の 25 から重なり分を控除）。
    const alignment = aln * 24;

    // フォーマット情報（ECC レベル+マスク）2 コピー。QR 準拠の固定近似。
    const format = 31;

    // バージョン情報 bit（QR は version>=7 で 2x18）。独自版でも
    // 大版の版数識別に同等の領域を確保する（固定近似 36）。
    const versionInfo = 36;

    const fn = finder + timing + alignment + format + versionInfo;
    return { total, finder, timing, alignment, format, versionInfo, functionModules: fn };
  }

  // 生データセル数（＝機能モジュールを除いた、データ+ECC に使えるセル数）。
  // 8 で割った floor が「グロス符号語バイト数（RS ブロックに割り振る前）」。
  function rawDataBytes(cols, rows) {
    const fm = functionModuleCount(cols, rows);
    const rawModules = fm.total - fm.functionModules;
    return Math.max(0, Math.floor(rawModules / 8));
  }

  // ==================================================================
  // §4-(c) ECC レベル（旧 cardloader 踏襲）
  // ------------------------------------------------------------------
  //   4 段階: なし / 低≈10% / 中≈20% / 高≈30%。
  //   1 ブロックあたりのパリティ nsym = round(255*ratio) を偶数へ丸め。
  // ==================================================================
  const BLOCK_N = 255; // GF(256) 上のブロック長上限
  const ECC_LEVELS = {
    0: { key: 'none', label: 'なし',        ratio: 0.00 },
    1: { key: 'low',  label: '低(約10%)',   ratio: 0.10 },
    2: { key: 'med',  label: '中(約20%)',   ratio: 0.20 },
    3: { key: 'high', label: '高(約30%)',   ratio: 0.30 },
  };
  function eccNsym(eccLevel) {
    const lv = ECC_LEVELS[eccLevel] || ECC_LEVELS[0];
    if (lv.ratio <= 0) return 0;
    let n = Math.round(BLOCK_N * lv.ratio);
    if (n % 2) n++;
    return n;
  }

  // ==================================================================
  // §4-(d) RS ブロック割り（旧 cardloader blockPlan をそのまま踏襲）
  // ------------------------------------------------------------------
  //   ブロック数を先に決め、グロスをブロック間でできるだけ均等割り。
  //   端数バイトを切り捨てない。ブロック符号語長 <= 255。
  //   返り値: [{ dataLen, nsym }...]（各ブロックの正味長とパリティ長）
  // ==================================================================
  function blockPlan(grossBytes, eccLevel) {
    const nsym = eccNsym(eccLevel);
    if (nsym === 0) return [{ dataLen: grossBytes, nsym: 0 }];
    const nblocks = Math.max(1, Math.ceil(grossBytes / BLOCK_N));
    const plan = [];
    const base = Math.floor(grossBytes / nblocks);
    const extra = grossBytes - base * nblocks; // 先頭 extra 個が +1 byte
    for (let i = 0; i < nblocks; i++) {
      const cwLen = base + (i < extra ? 1 : 0);
      const dLen = cwLen - nsym;
      plan.push({ dataLen: Math.max(0, dLen), nsym });
    }
    return plan;
  }

  // ==================================================================
  // §4-(e) ヘッダ用ブロックの扱い（旧 cardloader 踏襲・§7 と整合）
  // ------------------------------------------------------------------
  //   論理ヘッダ 12byte を専用 RS(nsym=6) で 18byte に保護し、
  //   payload 本体とは別ブロックとして先頭に確保する。
  //   → ヘッダは本体の ECC レベルに依らず常に一定の強さで守られる。
  // ==================================================================
  const HEADER_DATA_LEN = 12; // §7 論理ヘッダ
  const HEADER_NSYM = 6;      // ヘッダ専用 RS パリティ（最大 3byte 誤り訂正）
  const HEADER_LEN = HEADER_DATA_LEN + HEADER_NSYM; // 18

  // グロスからヘッダ 18byte を差し引いた残りが payload グロス。
  function payloadGrossBytes(cols, rows) {
    return Math.max(0, rawDataBytes(cols, rows) - HEADER_LEN);
  }

  // あるバージョン・ECC レベルの「正味(データ)容量」。
  function netPayload(cols, rows, eccLevel) {
    const G = payloadGrossBytes(cols, rows);
    return blockPlan(G, eccLevel).reduce((s, b) => s + b.dataLen, 0);
  }

  // ==================================================================
  // バージョン表の構築（メタ情報つき）
  // ==================================================================
  function buildVersion(index) {
    const { cols, rows } = makeVersionCols(VERSION_COLS[index]);
    const cell = Geo.cellSize(cols, rows);
    const fm = functionModuleCount(cols, rows);
    const gross = payloadGrossBytes(cols, rows);
    const overheadPct = fm.functionModules / fm.total;
    return {
      version: index + 1, // 1-based（旧 QR と同じ流儀）
      cols, rows,
      cellWmm: cell.cellWmm, cellHmm: cell.cellHmm, minCellMm: cell.minCellMm,
      meetsMinCell: cell.minCellMm >= Geo.MIN_CELL_MM - 1e-9,
      totalCells: fm.total,
      functionModules: fm.functionModules,
      overheadPct,
      rawDataBytes: rawDataBytes(cols, rows),
      headerLen: HEADER_LEN,
      payloadGrossBytes: gross,
      alignCount: Align.alignmentCenters(cols, rows).length,
      // 各 ECC レベルでの正味容量（KiB=1024 基準）。
      net: {
        none: netPayload(cols, rows, 0),
        low:  netPayload(cols, rows, 1),
        med:  netPayload(cols, rows, 2),
        high: netPayload(cols, rows, 3),
      },
    };
  }

  const VERSIONS = VERSION_COLS.map((_, i) => buildVersion(i));

  // 目標グロス（byte）を満たす最小バージョンを選ぶ。無ければ最大版。
  function pickVersionForGross(targetGrossBytes) {
    for (const v of VERSIONS) {
      if (v.payloadGrossBytes + HEADER_LEN >= targetGrossBytes) return v;
    }
    return VERSIONS[VERSIONS.length - 1];
  }

  // 正味 netBytes を ECC レベル eccLevel で収める最小バージョン。
  function pickVersionForNet(netBytes, eccLevel) {
    const key = (ECC_LEVELS[eccLevel] || ECC_LEVELS[0]).key === 'none' ? 'none'
              : ECC_LEVELS[eccLevel].key;
    for (const v of VERSIONS) {
      if (v.net[key] >= netBytes) return v;
    }
    return VERSIONS[VERSIONS.length - 1];
  }

  return {
    // 定数
    BLOCK_N, ECC_LEVELS,
    HEADER_DATA_LEN, HEADER_NSYM, HEADER_LEN,
    VERSION_COLS,
    // モデル関数
    makeVersionCols,
    functionModuleCount,
    rawDataBytes,
    eccNsym,
    blockPlan,
    payloadGrossBytes,
    netPayload,
    // バージョン表
    VERSIONS,
    buildVersion,
    pickVersionForGross,
    pickVersionForNet,
  };
});
