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
 *   (c) ECC 段階（eccNsym = ratio*255 を偶数丸め）。当初 4 段階だったが
 *       §E で **8 段階** へ細分した（下記 ECC_LEVELS のコメントを参照）。
 *       レベル番号 0〜3 は旧 4 段階の wire 値のまま固定し、4〜7 を後付け
 *       しているので **番号順 ≠ 率順**。UI/掃引は eccLevelsByRatio() を使う。
 *   (d) RS ブロック割り（ブロック数先決め・均等割り・<=255B）
 *   (e) ヘッダ用ブロックの扱い（旧 cardloader 同様 nsym=6 で別保護 → §7）
 *
 * ── このファイルの位置づけ（他モジュールとの役割分担）──────────────
 *   ここが持つのは「版表の設計」と「容量計算に必要なオーバーヘッドの
 *   **近似モデル**」まで。実際のセル描画（drawFinder/drawAlign/タイミング/
 *   フォーマット bit の配置）は qr-core.js が担う。
 *
 *   ★ 重要: 容量には近似と実測の 2 系統がある。
 *     - ここの functionModuleCount() / rawDataBytes() … 版表を設計するための
 *       **近似**モデル。
 *     - qr-core.js の dataCapacityBytes() … buildFunctionGrid を実際に組んで
 *       機能モジュールを数える **実測**値。
 *   card-format.getProfile() が採用し、容量表示・ページ分割に効くのは
 *   **実測側**。近似モデルだけを直しても実際の容量は変わらない（逆も同様）。
 *   ※ かつてここには「§5 以降は後続コミットで実装する」と書かれていたが、
 *     当時の作業スコープを示す記述であり、§0〜§11 は現在すべて実装済み。
 *
 * 現行仕様は docs/FORMAT.md（§1-5 版表 / §3-3 ECC / §4-1 blockPlan）、
 * 役割分担の背景は docs/ARCHITECTURE.md §5-2 を参照。
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
  //
  // ── 標準ティア（ver1〜14）: 300dpi・セル >= 0.7mm ──────────────
  //   §2-1 の 0.7mm 下限を満たす範囲。最終版 ver14 で ~10KB グロス。
  //   この 14 版の cols/rows・アライメント密度・レイアウトは **凍結** する
  //   （既に印刷済みのカードを読めなくしないため）。
  const VERSION_COLS_STD = [
    60, 77, 90, 108, 120, 132, 145, 160, 175, 190,
    205, 220, 235, 250,
  ];

  // ── 拡張ティア（ver15〜20）: 600dpi 推奨・セル >= 0.50mm ────────
  //   容量目標を 15〜20KB へ引き上げるための追加版。同じ箱（2152×3096px）を
  //   さらに細分するので 0.7mm を割るが、Geo.MIN_CELL_EXT_MM(0.50mm) を硬い
  //   下限とし、印刷/スキャンを 600dpi 以上にする前提で「セル当たり画素数」は
  //   300dpi/0.7mm（8.27px）より **多く** 確保する（qr-geometry.js の議論参照）。
  //   さらに §C のアライメント物理間隔一定化でオーバーヘッドが 6.8%→約 3〜4%
  //   に下がるので、セル数増加ぶんがほぼ丸ごと容量になる。
  //
  //   目標（ECC 高・約 30% で）:
  //     ver15 (265x381): グロス ≈ 11.8KB  → 素の指示どおりの試算どおり
  //     ver16 (280x403): グロス ≈ 13.4KB
  //     ver17 (296x426): グロス ≈ 15.0KB → **ECC 高でも 10KB 超**
  //     ver18 (312x449): グロス ≈ 16.7KB
  //     ver19 (330x475): グロス ≈ 18.7KB → **ECC 低で 15KB 超**
  //     ver20 (348x501): グロス ≈ 20.8KB → **ECC なしで 20KB 到達**
  const VERSION_COLS_EXT = [
    265, 280, 296, 312, 330, 348,
  ];

  const VERSION_COLS = VERSION_COLS_STD.concat(VERSION_COLS_EXT);

  // 標準ティアの版数（この境界より大きい version は拡張ティア）。
  const STD_VERSION_COUNT = VERSION_COLS_STD.length; // 14

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

    // フォーマット情報（ECC レベル+マスク）2 コピー = 30 セル + dark module 1。
    const format = 31;

    // §C オーバーヘッド削減: 「バージョン情報 bit」領域を廃止した。
    //  以前はここに QR 準拠の 2x18=36 セルを見込んでいたが、SNCR2 は
    //  そもそも版数専用 bit を **盤面に置いていない**（qr-core.buildFunctionGrid
    //  は予約していない）。版数は §7 ヘッダ byte[2] の 6bit と、復号側の
    //  「全版試し読み（cols×rows が合う版を採用）」で確定するため、盤面に
    //  重複して持つ必要がない。モデルだけが実体より 36 セル悲観的だったので、
    //  実装に合わせて削除する（＝実測との誤差が縮み、容量表が正確になる）。
    const fn = finder + timing + alignment + format;
    return { total, finder, timing, alignment, format, versionInfo: 0, functionModules: fn };
  }

  // 生データセル数（＝機能モジュールを除いた、データ+ECC に使えるセル数）。
  // 8 で割った floor が「グロス符号語バイト数（RS ブロックに割り振る前）」。
  function rawDataBytes(cols, rows) {
    const fm = functionModuleCount(cols, rows);
    const rawModules = fm.total - fm.functionModules;
    return Math.max(0, Math.floor(rawModules / 8));
  }

  // ==================================================================
  // §4-(c) ECC レベル（旧 cardloader 踏襲 → §E で 8 段階へ細分）
  // ------------------------------------------------------------------
  //   当初は 4 段階: なし / 低≈10% / 中≈20% / 高≈30%（旧 cardloader 踏襲）。
  //   現在は §E で 8 段階（なし/5/10/15/20/25/30/40%）。下記 ECC_LEVELS が正。
  //   1 ブロックあたりのパリティ nsym = round(255*ratio) を偶数へ丸め。
  //   実測値: none=0 / vlow=14 / low=26 / lomed=38 / med=52 / medhi=64 /
  //           high=78 / max=102（docs/FORMAT.md §3-3 の表と同じ）。
  // ==================================================================
  //   ── §E ECC 率の可変化・細分化 ─────────────────────────────────
  //   従来は 4 段階（なし/10%/20%/30%）しかなく、刻みが粗いため
  //     ・「なし」と「低(10%)」の間が飛びすぎる（スキャナ前提なら 5% で足りる
  //       場面が多いのに、10% 払うか 0% で無保護かの二択だった）
  //     ・高密度版で「30% では足りないが選べない」上限もあった
  //   という無駄・不足があった。そこで 5% 刻み + 40% を加えた 8 段階へ拡張する。
  //
  //   ★ 重要（後方互換）: level 0..3 の意味（なし/10%/20%/30%）は **一切変えない**。
  //     既存カードのヘッダ byte[2] 上位 2bit はそのまま正しく解釈できる。
  //     追加分は 4..7 に「後付け」する（並び順は率の昇順ではないが、互換優先）。
  //     UI では ratio でソートして表示するのでユーザ体験上の不整合はない。
  const BLOCK_N = 255; // GF(256) 上のブロック長上限
  const ECC_LEVELS = {
    // --- 従来の 4 段階（wire 互換のため番号固定）---
    0: { key: 'none', label: 'なし',         ratio: 0.00 },
    1: { key: 'low',  label: '低(約10%)',    ratio: 0.10 },
    2: { key: 'med',  label: '中(約20%)',    ratio: 0.20 },
    3: { key: 'high', label: '高(約30%)',    ratio: 0.30 },
    // --- §E 追加の細粒度レベル（ヘッダ v2 が必要）---
    4: { key: 'vlow', label: '極低(約5%)',   ratio: 0.05 },
    5: { key: 'lomed',label: '低中(約15%)',  ratio: 0.15 },
    6: { key: 'medhi',label: '中高(約25%)',  ratio: 0.25 },
    7: { key: 'max',  label: '最大(約40%)',  ratio: 0.40 },
  };
  // 従来ヘッダ（byte[2] の 2bit）で表現できる ECC レベルの上限。
  //  これを超えるレベルはヘッダ v2（qr-header.js の MAGIC "ND"）が必要。
  const ECC_LEGACY_MAX = 3;

  function eccNsym(eccLevel) {
    const lv = ECC_LEVELS[eccLevel] || ECC_LEVELS[0];
    if (lv.ratio <= 0) return 0;
    let n = Math.round(BLOCK_N * lv.ratio);
    if (n % 2) n++;
    return n;
  }

  // ECC レベルを「率の昇順」で並べたリスト（UI 表示用）。
  function eccLevelsByRatio() {
    return Object.keys(ECC_LEVELS)
      .map(k => Object.assign({ level: +k }, ECC_LEVELS[k]))
      .sort((a, b) => a.ratio - b.ratio);
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
    const version = index + 1;              // 1-based（旧 QR と同じ流儀）
    const extended = version > STD_VERSION_COUNT;
    // 各 ECC レベル（8 段階）での正味容量。key でも level 番号でも引ける。
    const net = {};
    for (const k of Object.keys(ECC_LEVELS)) {
      net[ECC_LEVELS[k].key] = netPayload(cols, rows, +k);
    }
    return {
      version,
      cols, rows,
      // ティア情報（拡張版は 600dpi 推奨・0.50mm 下限）。
      extended,
      tier: extended ? 'ext' : 'std',
      cellWmm: cell.cellWmm, cellHmm: cell.cellHmm, minCellMm: cell.minCellMm,
      meetsMinCell: cell.minCellMm >= Geo.MIN_CELL_MM - 1e-9,
      meetsMinCellExt: cell.minCellMm >= Geo.MIN_CELL_EXT_MM - 1e-9,
      // その版で「1 セル 8px 以上」を確保するのに必要な印刷/スキャン dpi。
      requiredDpi: Geo.requiredDpi(cols, rows, 8),
      totalCells: fm.total,
      functionModules: fm.functionModules,
      overheadPct,
      rawDataBytes: rawDataBytes(cols, rows),
      headerLen: HEADER_LEN,
      payloadGrossBytes: gross,
      alignCount: Align.alignmentCenters(cols, rows).length,
      alignDensity: Align.defaultDensityFor(cols, rows),
      net,
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
    const key = (ECC_LEVELS[eccLevel] || ECC_LEVELS[0]).key;
    for (const v of VERSIONS) {
      if (v.net[key] >= netBytes) return v;
    }
    return VERSIONS[VERSIONS.length - 1];
  }

  return {
    // 定数
    BLOCK_N, ECC_LEVELS, ECC_LEGACY_MAX,
    HEADER_DATA_LEN, HEADER_NSYM, HEADER_LEN,
    VERSION_COLS, VERSION_COLS_STD, VERSION_COLS_EXT, STD_VERSION_COUNT,
    // モデル関数
    makeVersionCols,
    functionModuleCount,
    rawDataBytes,
    eccNsym,
    eccLevelsByRatio,
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
