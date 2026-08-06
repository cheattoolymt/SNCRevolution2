/*
 * SuperNaidesuCardRevolution II (SNCR2) — qr-header.js
 * ==================================================================
 * 実装指示書 §7「ヘッダフォーマット（旧 cardloader を踏襲、モード ID 拡張のみ）」。
 *
 * ── 移植元 ──────────────────────────────────────────────────────
 *   naidesu-cardloader (MIT, cheattoolymt(nyan4))
 *   js/card-format.js の buildHeaderLogical / buildHeader /
 *   parseHeader / interpretLogical を踏襲した。
 *
 * ── §7 のバイトレイアウト（論理 12byte）────────────────────────
 *     [0..1]  MAGIC = 0x4E 0x43 ("NC" = Naidesu Card)
 *     [2]     version + eccLevel（後述のとおり新バージョン数に合わせ再設計）
 *     [3]     pageIndex   (0-based)
 *     [4]     totalPages
 *     [5..6]  このページの有効ペイロード長 (big-endian 16bit)
 *     [7..10] ファイル全体のバイト数 (big-endian 32bit)
 *     [11]    checksum = XOR of bytes[0..10]
 *   論理 12byte を RS(nsym=6) で保護 → 物理 18byte（§4-(e) と一致）。
 *
 * ── byte[2] の再設計（§7「modeId は bit 数を再設計してよい」に基づく）──
 *   旧 cardloader の byte[2] は version_tag(2bit) + modeId(4bit) + ecc(2bit)
 *   だった。旧 modeId は「1kb〜10kb の 10 段階サイズプロファイル」を指す
 *   4bit フィールドで、事実上「どのサイズの版か」を表していた。
 *
 *   SNCR2 では「サイズの選択」は §4 の独自バージョン番号
 *   (SNCR2Version.VERSIONS, 現在 14 版) がそのまま担う。したがって
 *   旧 modeId は SNCR2 の version と役割が重複する。冗長な二重管理を
 *   避けるため、byte[2] を次のとおり再設計する:
 *
 *       byte[2] = (version & 0x3F) | ((eccLevel & 0x03) << 6)
 *                  └ 下位 6bit: version (1..63)   └ 上位 2bit: eccLevel(0..3)
 *
 *   version に 6bit(=最大 63 版) を割り当てることで、指示書 §7 が懸念する
 *   「新バージョン数が旧 4bit(16) を超える場合」に将来まで余裕をもって
 *   対応できる（現行 14 版、上限 63 版まで拡張可）。ECC は従来どおり 2bit。
 *   MAGIC / pageIndex / totalPages / payloadLen / totalFileLen / checksum
 *   の各フィールドは旧 cardloader と完全に同一。
 *
 * ── 依存 ────────────────────────────────────────────────────────
 *   SNCR2RS (js/qr-rs.js) … ヘッダ専用 RS(nsym=6) 保護（nayuki 統一）
 *   （SNCR2Version の HEADER_* 定数と一致する値をここでも定義する）
 *
 * このファイルは DOM 非依存の純粋関数のみ。
 * ================================================================== */

(function (global, factory) {
  'use strict';
  const RS = (typeof require !== 'undefined') ? require('./qr-rs.js') : global.SNCR2RS;
  const mod = factory(RS);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  global.SNCR2Header = mod;
})(typeof window !== 'undefined' ? window : globalThis, function (RS) {
  'use strict';

  // §7 / §4-(e) と一致する定数。
  const MAGIC0 = 0x4e; // 'N'
  const MAGIC1 = 0x43; // 'C'
  const HEADER_DATA_LEN = 12; // 論理ヘッダ長
  const HEADER_NSYM = 6;      // ヘッダ専用 RS パリティ（最大 3byte 訂正）
  const HEADER_LEN = HEADER_DATA_LEN + HEADER_NSYM; // 物理 18byte

  const VERSION_MASK = 0x3f; // byte[2] 下位 6bit = version
  const ECC_SHIFT = 6;       // byte[2] 上位 2bit = eccLevel

  // ------------------------------------------------------------------
  //  論理ヘッダ(12byte)を組み立てる。checksum まで含めて返す。
  // ------------------------------------------------------------------
  function buildLogical(fields) {
    const {
      version = 1,
      eccLevel = 0,
      pageIndex = 0,
      totalPages = 1,
      payloadLen = 0,
      totalFileLen = 0,
    } = fields || {};

    const h = new Uint8Array(HEADER_DATA_LEN);
    h[0] = MAGIC0;
    h[1] = MAGIC1;
    // byte[2] = version(6bit) | eccLevel(2bit)
    h[2] = (version & VERSION_MASK) | ((eccLevel & 0x03) << ECC_SHIFT);
    h[3] = pageIndex & 0xff;
    h[4] = totalPages & 0xff;
    h[5] = (payloadLen >> 8) & 0xff;   // BE16 上位
    h[6] = payloadLen & 0xff;          // BE16 下位
    h[7] = (totalFileLen >>> 24) & 0xff; // BE32
    h[8] = (totalFileLen >>> 16) & 0xff;
    h[9] = (totalFileLen >>> 8) & 0xff;
    h[10] = totalFileLen & 0xff;
    let x = 0;
    for (let i = 0; i < 11; i++) x ^= h[i];
    h[11] = x; // checksum = XOR of bytes[0..10]
    return h;
  }

  // ------------------------------------------------------------------
  //  §7: 物理ヘッダ(18byte) = 論理 12byte を RS(nsym=6) で保護。
  //  → ヘッダは本体 payload の ECC レベルに依らず常に一定の強さで守られる
  //     （§4-(e) と同じ思想）。
  // ------------------------------------------------------------------
  function buildHeader(fields) {
    const logical = buildLogical(fields);
    return RS.encode(logical, HEADER_NSYM); // 18byte
  }

  // ------------------------------------------------------------------
  //  論理ヘッダ(12byte)を解釈してフィールドへ展開する。
  // ------------------------------------------------------------------
  function interpretLogical(h, checksumOk) {
    const verByte = h[2];
    return {
      magicOk: h[0] === MAGIC0 && h[1] === MAGIC1,
      version: verByte & VERSION_MASK,
      eccLevel: (verByte >> ECC_SHIFT) & 0x03,
      pageIndex: h[3],
      totalPages: h[4],
      payloadLen: (h[5] << 8) | h[6],
      // BE32 は 32bit 符号なし。h[7] は 2^24 倍で乗算し符号化を避ける。
      totalFileLen: (h[7] * 0x1000000) + (h[8] << 16) + (h[9] << 8) + h[10],
      checksumOk,
    };
  }

  // ------------------------------------------------------------------
  //  §7: 物理ヘッダ(18byte 以上)を RS 訂正して解釈する。
  //  返り値: interpretLogical(...) + { ok, corrected }
  //          読み取り不能（MAGIC 不一致かつ訂正失敗）なら null。
  // ------------------------------------------------------------------
  function parseHeader(bytes) {
    if (!bytes || bytes.length < HEADER_DATA_LEN) return null;

    // 物理 18byte が来ている場合は RS 訂正を試みる。
    if (bytes.length >= HEADER_LEN) {
      const cw = bytes.subarray(0, HEADER_LEN);
      const r = RS.decode(cw, HEADER_NSYM);
      const h = r.data;
      // checksum 検算。
      let x = 0;
      for (let i = 0; i < 11; i++) x ^= h[i];
      const csOk = x === h[11];
      const magicOk = h[0] === MAGIC0 && h[1] === MAGIC1;
      if (magicOk && (r.ok || csOk)) {
        const info = interpretLogical(h, csOk);
        info.ok = r.ok && csOk;
        info.corrected = r.corrected;
        return info;
      }
      // RS 訂正が破綻していても、生 12byte が偶然無傷なら救済（下へフォール）。
    }

    // RS なしの生 12byte として解釈（保険）。
    if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) return null;
    let x = 0;
    for (let i = 0; i < 11; i++) x ^= bytes[i];
    const csOk = x === bytes[11];
    const info = interpretLogical(bytes, csOk);
    info.ok = csOk;
    info.corrected = 0;
    return info;
  }

  return {
    // 定数
    MAGIC0, MAGIC1,
    HEADER_DATA_LEN, HEADER_NSYM, HEADER_LEN,
    VERSION_MASK, ECC_SHIFT,
    // 関数
    buildLogical,
    buildHeader,
    interpretLogical,
    parseHeader,
  };
});
