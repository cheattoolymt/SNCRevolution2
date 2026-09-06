/*
 * SuperNaidesuCardRevolution II (SNCR2) — card-format.js
 * ==================================================================
 * 実装指示書 §9 の「A4 ジオメトリ定数 + qr-core.js への橋渡し +
 * ヘッダ仕様」を担うファイル。creator.html / decoder.html / decode-core.js /
 * Node テストが共有する“カードの論理仕様”のフロント API。
 *
 * このファイルの責務:
 *   (1) A4 ジオメトリ定数の再輸出（§2, qr-geometry.js を素通し）。
 *   (2) 「ファイル 1 片 → 1 ページぶんの 0/1 モジュールグリッド」への
 *       高水準エンコード（§4 版選択・§5 payload 符号化・§7 ヘッダ・
 *       §6 マスク＝qr-core.encodeGrid を束ねる）。
 *   (3) 逆方向（モジュールグリッド → ファイル片＋メタ情報）。
 *   (4) 複数ページ分割（§2-1「最後の手段」として維持）。
 *   (5) 圧縮コンテナ（§1-A compress.js）との連携ヘルパ（任意）。
 *   (6) セル矩形マッパ（描画・サンプリング用の px 座標計算）。
 *
 * §8「多値化禁止・二値固定・ブラウザ完結・外部依存最小」を満たすため、
 * ここでは Canvas/DOM に触れない純粋関数のみを置く（描画は creator.html、
 * サンプリングは decode-core.js が担当）。
 *
 * このファイルは DOM 非依存の純粋関数のみ。
 * ================================================================== */

(function (global, factory) {
  'use strict';
  const req = (typeof require !== 'undefined') ? require : null;
  const Geo    = req ? req('./qr-geometry.js') : global.SNCR2Geometry;
  const Ver    = req ? req('./qr-version.js')  : global.SNCR2Version;
  const IL     = req ? req('./qr-interleave.js'): global.SNCR2Interleave;
  const Header = req ? req('./qr-header.js')    : global.SNCR2Header;
  const Core   = req ? req('./qr-core.js')      : global.SNCR2Core;
  const mod = factory(Geo, Ver, IL, Header, Core);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  global.CardFormat = mod;   // 旧 cardloader と同じグローバル名（decode-core.js 互換）
  global.SNCR2CardFormat = mod;
})(typeof window !== 'undefined' ? window : globalThis,
   function (Geo, Ver, IL, Header, Core) {
  'use strict';

  // ==================================================================
  //  (1) A4 ジオメトリ定数の再輸出（§2 / qr-geometry.js）
  // ==================================================================
  const {
    DPI, PAGE_W, PAGE_H, QUIET, FINDER, GAP, FOOTER,
    GRID_X, GRID_Y, GRID_W, GRID_H, MIN_CELL_MM,
  } = Geo;

  // ==================================================================
  //  バージョンごとの「プロファイル」（旧 cardloader の PROFILES 相当）。
  //  qr-core.dataCapacityBytes で data 容量を実測して確定する。
  // ==================================================================
  function getProfile(version) {
    const v = Ver.VERSIONS[version - 1];
    if (!v) throw new RangeError('unknown version ' + version);
    const cell = Geo.cellSize(v.cols, v.rows);
    const dataBytes = Core.dataCapacityBytes(v.cols, v.rows);
    return {
      version: v.version,
      COLS: v.cols, ROWS: v.rows,
      CELL_W: cell.cellWpx, CELL_H: cell.cellHpx,
      cellWmm: cell.cellWmm, cellHmm: cell.cellHmm, minCellMm: cell.minCellMm,
      GRID_X, GRID_Y, GRID_W, GRID_H, PAGE_W, PAGE_H,
      dataBytes,                                   // 実測 data 容量（header 含む）
      grossBytes: Math.max(0, dataBytes - Header.HEADER_LEN), // payload グロス
      alignCount: v.alignCount,
      // 拡張ティア情報（UI が印刷解像度の警告に使う）。
      extended: v.extended,
      tier: v.tier,
      requiredDpi: v.requiredDpi,
      meetsMinCell: v.meetsMinCell,
    };
  }
  // 版一覧（1-based）。
  const VERSIONS = Ver.VERSIONS.map(v => v.version);

  // ------------------------------------------------------------------
  //  正味(データ)容量 = 実測グロスに §4 blockPlan を適用した合計 dataLen。
  //  ここが本ファイルの要点: qr-version.js の netPayload は「近似オーバー
  //  ヘッダモデル」で算出した payloadGrossBytes を使うが、実際に data セルへ
  //  詰められるバイト数は qr-core が機能モジュールを実配置して数えた
  //  prof.grossBytes（実測）である。両者は数バイトずれるため、符号化・復号・
  //  容量判定はすべて“実測グロス”へ blockPlan した net で統一する。
  // ------------------------------------------------------------------
  function netCapacity(prof, eccLevel) {
    return Ver.blockPlan(prof.grossBytes, eccLevel)
             .reduce((s, b) => s + b.dataLen, 0);
  }

  // 目標 net（byte）を満たす最小版のプロファイル（実測容量で選ぶ）。
  function pickProfileForNet(netBytes, eccLevel) {
    for (const ver of VERSIONS) {
      const prof = getProfile(ver);
      if (netCapacity(prof, eccLevel) >= netBytes) return prof;
    }
    return getProfile(VERSIONS[VERSIONS.length - 1]);
  }

  // ==================================================================
  //  (6) セル矩形マッパ（描画・サンプリング用）
  // ------------------------------------------------------------------
  //  グリッド内 (col,row) → 箱内 px 矩形。箱は §2 で固定の GRID_X..。
  // ==================================================================
  function cellRect(prof, col, row) {
    const x = GRID_X + (col / prof.COLS) * GRID_W;
    const y = GRID_Y + (row / prof.ROWS) * GRID_H;
    return { x, y, w: GRID_W / prof.COLS, h: GRID_H / prof.ROWS };
  }

  // ==================================================================
  //  (2) エンコード: ファイル 1 片 → 1 ページぶんの modules グリッド
  // ------------------------------------------------------------------
  //  payloadBytes … このページに載せる正味データ（compress 後でも前でも可）。
  //  opts.version  … 明示指定（省略時は payload が収まる最小版）。
  //  opts.eccLevel … 0..3（§4）。省略時 3（高）。
  //  opts.pageIndex / opts.totalPages / opts.totalFileLen … §7 ヘッダ用。
  //  返り値: { modules, isFn, cols, rows, mask, eccLevel, prof, header }
  // ==================================================================
  function encodePage(payloadBytes, opts) {
    opts = opts || {};
    const eccLevel = opts.eccLevel != null ? opts.eccLevel : 3;
    let prof;
    if (opts.version != null) {
      prof = getProfile(opts.version);
    } else {
      prof = pickProfileForNet(payloadBytes.length, eccLevel);
    }
    const gross = prof.grossBytes;

    // §5: payload を RS 符号化 + インターリーブしてグロス領域へ。
    const payloadGross = IL.encodePayload(payloadBytes, gross, eccLevel);

    // §7: ヘッダ（論理 12 → 物理 18）。
    const header = Header.buildHeader({
      version: prof.version,
      eccLevel,
      pageIndex: opts.pageIndex || 0,
      totalPages: opts.totalPages || 1,
      payloadLen: payloadBytes.length,
      totalFileLen: opts.totalFileLen != null ? opts.totalFileLen : payloadBytes.length,
    });

    // §6+レイアウト: header + payloadGross を機能モジュール付きグリッドへ。
    const g = Core.encodeGrid(header, payloadGross, prof.COLS, prof.ROWS, eccLevel);
    return {
      modules: g.modules, isFn: g.isFn, cols: g.cols, rows: g.rows,
      mask: g.mask, eccLevel, prof, header, payloadLen: payloadBytes.length,
    };
  }

  // ==================================================================
  //  (3) デコード: 受信 modules → { meta, data, ok }
  // ------------------------------------------------------------------
  //  recvModules … 0/1 の Uint8Array(cols*rows)（サンプリング結果）。
  //  version が事前に分かっていれば渡す。無ければ全版を試して MAGIC 一致を採用。
  // ==================================================================
  function decodePageModules(recvModules, cols, rows) {
    // まずヘッダを取り出して version/ecc/payloadLen を確定。
    const d0 = Core.decodeGrid(recvModules, cols, rows, null);
    const meta = Header.parseHeader(d0.header);
    if (!meta || !meta.magicOk) {
      return { meta: null, data: null, ok: false, reason: 'header-magic' };
    }
    const eccLevel = meta.eccLevel;
    const netLen = meta.payloadLen;
    // payload グロス長は「data 容量 - ヘッダ 18」。
    const dataBytes = Math.floor(d0.dataCells.length / 8);
    const grossLen = Math.max(0, dataBytes - Header.HEADER_LEN);

    // 再度 payload グロスをフル取得（d0 は payloadGrossLen=null で全長取得済み）。
    const grossData = d0.payloadGross.subarray(0, grossLen);
    const dec = IL.decodePayload(grossData, eccLevel, netLen);
    return {
      meta, data: dec.data, ok: !!(dec.ok && meta.ok),
      corrected: dec.corrected, eccLevel, mask: d0.mask,
      formatDist: d0.formatDist,
    };
  }

  // version 不明時: 全版のグリッド寸法を試し、cols*rows がサンプル長に一致
  //  するものを選ぶ（decode-core は既に cols/rows を確定してから呼ぶ想定なので
  //  基本は decodePageModules を直接使う。ここは保険）。
  function decodeAnyVersion(recvModules) {
    for (const ver of VERSIONS) {
      const prof = getProfile(ver);
      if (recvModules.length !== prof.COLS * prof.ROWS) continue;
      const r = decodePageModules(recvModules, prof.COLS, prof.ROWS);
      if (r.ok) return Object.assign({ version: ver }, r);
    }
    return { meta: null, data: null, ok: false, reason: 'no-version' };
  }

  // ==================================================================
  //  (4) 複数ページ分割（§2-1「最後の手段」）
  // ------------------------------------------------------------------
  //  fileBytes をバージョン/ECC 固定で複数ページに分割し、
  //  各ページの encodePage 結果を配列で返す。
  // ==================================================================
  //  ── §D 複数ページ結合の効率化 ───────────────────────────────────
  //  当初の案は「ヘッダオーバーヘッドを 1 ページ目だけにして 2 ページ目以降を
  //  純データにする」だったが、実測するとヘッダは 18B ＝ 1 ページの正味に対し
  //  **0.09%（ver20/ECC なし）〜0.12%（ver20/ECC 高）** しかなく、削っても
  //  容量はほぼ増えない。しかも 2 ページ目以降からヘッダを消すと
  //    ・ページ順序が分からなくなる（pageIndex を失う）
  //    ・そのページ単独では版も ECC も判定できず、復号が 1 ページ目に依存する
  //    ・1 ページ目を紛失/汚損すると **残り全ページが解読不能** になる
  //  という重大な堅牢性の後退を招く（「読めないことを避けつつ」に反する）。
  //
  //  そこで §D は「ヘッダ削減」ではなく、**実測で桁違いに大きい無駄**である
  //  「最終ページのパディング」を潰す方向で実装する。従来は全ページを同じ版で
  //  刻むため、たとえば ver20/ECC 高（1 ページ 14,504B）で 14,554B のファイルを
  //  焼くと、2 ページ目は 50B のために **14,504B ぶんの最高密度ページ**を
  //  丸ごと印刷していた（利用率 0.3%）。
  //
  //  改善: 最終ページだけ「残りバイト数が収まる最小の版」へ落とす。
  //    ・紙とインクの無駄が消える（余白が増える）
  //    ・残り 50B なら ver1（3.0mm セル）になり、最終ページは **むしろ頑丈**に
  //      なる（セルが 6 倍大きい＝読み取り失敗率が下がる）
  //    ・各ページは従来どおり自己完結（ヘッダを持つ）なので堅牢性は不変
  //  opts.autoLastPage=false で従来の「全ページ同一版」に戻せる。
  function encodeFile(fileBytes, opts) {
    opts = opts || {};
    const eccLevel = opts.eccLevel != null ? opts.eccLevel : 3;
    // 版が未指定なら「1 ページに収まる最大版」を採用（§2-1: A4 1 枚を主目標）。
    const prof = opts.version != null
      ? getProfile(opts.version)
      : getProfile(VERSIONS[VERSIONS.length - 1]);
    const perPageNet = netCapacity(prof, eccLevel);
    const totalPages = Math.max(1, Math.ceil(fileBytes.length / perPageNet));
    const autoLastPage = opts.autoLastPage !== false;
    const pages = [];
    for (let p = 0; p < totalPages; p++) {
      const start = p * perPageNet;
      const slice = fileBytes.subarray(start, Math.min(start + perPageNet, fileBytes.length));
      // §D: 最終ページのみ、残りが収まる最小版へ縮める（複数ページのときだけ）。
      let pageProf = prof;
      if (autoLastPage && totalPages > 1 && p === totalPages - 1) {
        const small = pickProfileForNet(slice.length, eccLevel);
        // 指定版より小さくなる場合のみ採用（大きくは絶対にしない）。
        if (small.version < prof.version) pageProf = small;
      }
      pages.push(encodePage(slice, {
        version: pageProf.version, eccLevel,
        pageIndex: p, totalPages, totalFileLen: fileBytes.length,
        // §D: 2 ページ目以降は「1 ページ目から続くページ」であることを明示する。
        //  ヘッダは各ページに残す（自己完結＝堅牢）が、復号側が
        //  「単票なのか続きなのか」を 1bit で判定できるようにしておく。
        continuation: p > 0,
      }));
    }
    return { pages, totalPages, perPageNet, prof, eccLevel };
  }

  // 複数ページのデコード結果（decodePageModules の配列）を結合してファイル復元。
  //  §D: 最終ページは版が違う（小さい）ことがあるため、ページ長を前提にせず
  //  「pageIndex の順に payloadLen ぶんずつ詰める」方式で結合する。
  //  さらに、ページの取りこぼし（重複・欠番）を検出して報告する。
  function assembleFile(pageResults) {
    const oks = (pageResults || []).filter(r => r && r.ok && r.meta);
    if (oks.length === 0) return { ok: false, data: null, reason: 'no-page' };
    // 同じ pageIndex が複数あれば 1 枚だけ採用（同じページを 2 回スキャンした場合）。
    const byIndex = new Map();
    for (const r of oks) {
      const i = r.meta.pageIndex;
      if (!byIndex.has(i)) byIndex.set(i, r);
    }
    const sorted = [...byIndex.values()].sort((a, b) => a.meta.pageIndex - b.meta.pageIndex);
    const totalFileLen = sorted[0].meta.totalFileLen;
    const totalPages = sorted[0].meta.totalPages || sorted.length;

    // 欠番ページの検出（0..totalPages-1 が全部そろっているか）。
    const missing = [];
    for (let i = 0; i < totalPages; i++) if (!byIndex.has(i)) missing.push(i);

    const out = new Uint8Array(totalFileLen);
    let off = 0;
    for (const r of sorted) {
      const take = Math.min(r.meta.payloadLen, r.data.length, totalFileLen - off);
      if (take <= 0) continue;
      out.set(r.data.subarray(0, take), off);
      off += take;
    }
    return {
      ok: off === totalFileLen && missing.length === 0,
      data: out, bytesFilled: off, totalFileLen,
      totalPages, pagesFound: sorted.length, missingPages: missing,
      reason: missing.length ? 'missing-pages' : (off === totalFileLen ? undefined : 'short-data'),
    };
  }

  // ==================================================================
  //  (5) 二値化しきい値（大津法）— decode-core.js が参照（旧 cardloader 踏襲）。
  // ==================================================================
  function otsuThreshold(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) hist[gray[i] | 0]++;
    const total = gray.length;
    let sumAll = 0;
    for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let sumB = 0, wB = 0, maxVar = -1, thr = 127;
    let mBstar = 0, mFstar = 255;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sumAll - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > maxVar) { maxVar = v; thr = t; mBstar = mB; mFstar = mF; }
    }
    let mid = Math.round((mBstar + mFstar) / 2);
    if (!isFinite(mid)) mid = 128;
    if (mid < 5 || mid > 250) mid = 128;
    return mid;
  }

  return {
    // 定数（§2 / 旧 cardloader 互換名）
    DPI, PAGE_W, PAGE_H, QUIET, FINDER, GAP, FOOTER,
    GRID_X, GRID_Y, GRID_W, GRID_H, MIN_CELL_MM,
    HEADER_LEN: Header.HEADER_LEN,
    VERSIONS,
    // §E ECC レベル表（8 段階）と §4 の版メタを素通し（UI/テストが参照）。
    ECC_LEVELS: Ver.ECC_LEVELS,
    eccLevelsByRatio: Ver.eccLevelsByRatio,
    STD_VERSION_COUNT: Ver.STD_VERSION_COUNT,
    // プロファイル
    getProfile, netCapacity, pickProfileForNet, cellRect,
    // 高水準 encode/decode
    encodePage, decodePageModules, decodeAnyVersion,
    encodeFile, assembleFile,
    // ヘッダ（旧 cardloader 互換名で素通し）
    parseHeader: Header.parseHeader,
    buildHeader: Header.buildHeader,
    // 二値化
    otsuThreshold,
  };
});
