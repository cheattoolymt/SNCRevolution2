/*
 * SNCR2 §5〜§7 コアセルフテスト（Node 実行用）
 * ------------------------------------------------------------------
 * 実装指示書 §5〜§7 の移植コアが正しく動くかを検証する。
 *   - RS  : nayuki 移植 GF(256) の encode と、自前 RS 訂正 decode
 *   - §5  : インターリーブ／デインターリーブ + payload 符号化ラウンドトリップ
 *           ＋ バーストエラー分散（QR 方式の眼目）
 *   - §6  : 8 マスクの評価・最小スコア自動選択（長方形グリッド）
 *   - §7  : 論理 12byte ヘッダ + RS(nsym=6) 保護 18byte のラウンドトリップ
 *           ＋ 1〜3byte 誤りの訂正
 * 使い方: node test/core-selftest.js
 * 決定的にするため簡易 PRNG（seed 固定）を使う。
 * ================================================================== */
'use strict';

const RS = require('../js/qr-rs.js');
const Mask = require('../js/qr-mask.js');
const IL = require('../js/qr-interleave.js');
const Header = require('../js/qr-header.js');
const Ver = require('../js/qr-version.js');

let failures = 0;
function check(name, cond) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

// 決定的 PRNG（xorshift32）。テストの再現性のため。
let _seed = 0x1234abcd >>> 0;
function rnd() {
  _seed ^= _seed << 13; _seed >>>= 0;
  _seed ^= _seed >>> 17;
  _seed ^= _seed << 5;  _seed >>>= 0;
  return _seed / 0x100000000;
}
function randBytes(n) {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = Math.floor(rnd() * 256);
  return u;
}
function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function injectErrors(buf, nerr) {
  const out = Uint8Array.from(buf);
  const used = new Set();
  for (let e = 0; e < nerr && used.size < out.length; e++) {
    let p; do { p = Math.floor(rnd() * out.length); } while (used.has(p));
    used.add(p);
    out[p] ^= (1 + Math.floor(rnd() * 255));
  }
  return out;
}

// ==================================================================
console.log('==== RS (§1-B/§4): GF(256) encode=nayuki / decode=自前訂正 ====');
// nayuki reedSolomonMultiply と exp/log テーブル乗算の一致（体が同一の証明）。
(function () {
  let same = true;
  for (let a = 0; a < 256 && same; a++)
    for (let b = 0; b < 256; b++)
      if (RS.gfMul(a, b) !== RS.reedSolomonMultiply(a, b)) { same = false; break; }
  check('gfMul == nayuki reedSolomonMultiply（全 256x256）', same);
})();

(function () {
  // 各 nsym で「t=floor(nsym/2) 個までの誤りは必ず訂正」を確認。
  let pass = 0, total = 0;
  for (const nsym of [6, 26, 52, 76]) {
    const t = nsym >> 1;
    for (let trial = 0; trial < 400; trial++) {
      const dlen = 1 + Math.floor(rnd() * (255 - nsym));
      const data = randBytes(dlen);
      const cw = RS.encode(data, nsym);
      const nerr = Math.floor(rnd() * (t + 1)); // 0..t
      const bad = injectErrors(cw, nerr);
      const r = RS.decode(bad, nsym);
      total++;
      if (r.ok && eq(r.data, data)) pass++;
    }
  }
  check(`RS: t 個以下の誤りを全訂正 (${pass}/${total})`, pass === total);
})();

(function () {
  // 訂正能力超過は「誤った成功」を返さない（ok=false か、正しく訂正のみ）。
  let danger = 0;
  for (let trial = 0; trial < 400; trial++) {
    const nsym = 10, t = 5;
    const data = randBytes(60);
    const cw = RS.encode(data, nsym);
    const nerr = t + 1 + Math.floor(rnd() * 4);
    const bad = injectErrors(cw, nerr);
    const r = RS.decode(bad, nsym);
    if (r.ok && !eq(r.data, data)) danger++; // 誤データを ok=true で返した
  }
  check('RS: 能力超過でも誤データを ok=true で返さない', danger === 0);
})();

// ==================================================================
console.log('\n==== §5 インターリーブ ====');
(function () {
  // 不均等ブロック長でも interleave->deinterleave が完全復元。
  const plan = [{ dataLen: 10, nsym: 6 }, { dataLen: 9, nsym: 6 }, { dataLen: 9, nsym: 6 }];
  const cws = plan.map(b => randBytes(b.dataLen + b.nsym));
  const inter = IL.interleaveBlocks(cws);
  const back = IL.deinterleaveBlocks(inter, plan);
  check('interleave/deinterleave 完全復元（不均等長）',
    back.length === cws.length && cws.every((c, i) => eq(back[i], c)));
  // 出力の並びが仕様どおり: cw[0][0],cw[1][0],cw[2][0],cw[0][1]...
  check('インターリーブ順=cw[b][col] 縦取り',
    inter[0] === cws[0][0] && inter[1] === cws[1][0] && inter[2] === cws[2][0] && inter[3] === cws[0][1]);
})();

(function () {
  // 全バージョン x 全 ECC で payload 符号化ラウンドトリップ（無誤り）。
  let pass = 0, total = 0;
  for (const v of Ver.VERSIONS) {
    for (const ecc of [0, 1, 2, 3]) {
      const gross = v.payloadGrossBytes;
      const net = Ver.netPayload(v.cols, v.rows, ecc);
      const data = randBytes(net);
      const enc = IL.encodePayload(data, gross, ecc);
      const dec = IL.decodePayload(enc, ecc, net);
      total++;
      if (dec.ok && eq(dec.data, data)) pass++;
    }
  }
  check(`payload 無誤りラウンドトリップ 全版x全ECC (${pass}/${total})`, pass === total);
})();

(function () {
  // §10 仮説: インターリーブによりバーストエラーがブロック間へ分散され、
  // 単一ブロックには収まらない大きな連続破損でも高 ECC で復元できる。
  const v = Ver.VERSIONS[Ver.VERSIONS.length - 1];
  const ecc = 3;
  const gross = v.payloadGrossBytes;
  const net = Ver.netPayload(v.cols, v.rows, ecc);
  const plan = Ver.blockPlan(gross, ecc);
  const nblocks = plan.length;
  const t = plan[0].nsym >> 1;
  const data = randBytes(net);
  const enc = IL.encodePayload(data, gross, ecc);
  // ブロック単体の訂正能力 t を大きく超える長さの連続破損。
  const burst = Math.min(enc.length - 1, Math.floor(t * nblocks * 0.8));
  const start = Math.floor(rnd() * (enc.length - burst));
  const bad = Uint8Array.from(enc);
  for (let i = 0; i < burst; i++) bad[start + i] ^= (1 + Math.floor(rnd() * 255));
  const dec = IL.decodePayload(bad, ecc, net);
  check(`バースト破損 ${burst}B を ${nblocks} ブロックへ分散復元 (単ブロック耐性 t=${t})`,
    dec.ok && eq(dec.data, data));
})();

// ==================================================================
console.log('\n==== §6 マスク最適化（長方形グリッド）====');
(function () {
  const cols = 60, rows = 86; // 最小版相当の長方形
  const modules = new Uint8Array(cols * rows);
  const isFn = new Uint8Array(cols * rows);
  for (let i = 0; i < modules.length; i++) modules[i] = rnd() < 0.5 ? 1 : 0;
  // ダミー機能モジュール（四隅ファインダ相当のブロック）。
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) isFn[y * cols + x] = 1;

  // applyMask は XOR なので 2 回で元に戻る（involution）。
  const twice = Uint8Array.from(modules);
  Mask.applyMask(twice, isFn, cols, rows, 5);
  Mask.applyMask(twice, isFn, cols, rows, 5);
  check('applyMask は involution（2 回で復元）', eq(twice, modules));

  // 機能モジュールは決して変化しない。
  const once = Uint8Array.from(modules);
  Mask.applyMask(once, isFn, cols, rows, 3);
  let fnUntouched = true;
  for (let i = 0; i < isFn.length; i++) if (isFn[i] && once[i] !== modules[i]) fnUntouched = false;
  check('機能モジュールはマスク対象外', fnUntouched);

  // 全 8 マスクのペナルティは非負。
  let allNonNeg = true;
  for (let m = 0; m < 8; m++) {
    const tt = Uint8Array.from(modules);
    Mask.applyMask(tt, isFn, cols, rows, m);
    if (Mask.getPenaltyScore(tt, cols, rows) < 0) allNonNeg = false;
  }
  check('全マスクのペナルティ >= 0', allNonNeg);

  // 自動選択: mask ∈ [0,7]、返る penalty が最小である。
  const best = Mask.chooseBestMask(modules, isFn, cols, rows);
  let isMin = true;
  for (let m = 0; m < 8; m++) {
    const tt = Uint8Array.from(modules);
    Mask.applyMask(tt, isFn, cols, rows, m);
    if (Mask.getPenaltyScore(tt, cols, rows) < best.penalty) isMin = false;
  }
  check(`chooseBestMask は最小スコア（mask=${best.mask}, penalty=${best.penalty}）`,
    best.mask >= 0 && best.mask < 8 && isMin);

  // デコード側: 選ばれたマスクを再適用すると元グリッドへ戻る。
  const restored = Uint8Array.from(best.modules);
  Mask.applyMask(restored, isFn, cols, rows, best.mask);
  check('選択マスクの再適用で元グリッド復元', eq(restored, modules));
})();

// ==================================================================
console.log('\n==== §7 ヘッダフォーマット ====');
(function () {
  // レイアウト定数（§7 と一致）。
  check('MAGIC = 0x4E 0x43 ("NC")', Header.MAGIC0 === 0x4e && Header.MAGIC1 === 0x43);
  check('論理 12 + RS 6 = 物理 18', Header.HEADER_DATA_LEN === 12 && Header.HEADER_NSYM === 6 && Header.HEADER_LEN === 18);

  const f = { version: 2, eccLevel: 1, pageIndex: 3, totalPages: 7, payloadLen: 12345, totalFileLen: 0xABCDEF12 };
  const log = Header.buildLogical(f);
  check('byte[0..1]=NC', log[0] === 0x4e && log[1] === 0x43);
  check('byte[2] = version(6bit)|ecc(2bit)', log[2] === ((f.version & 0x3f) | ((f.eccLevel & 3) << 6)));
  check('byte[5..6] = payloadLen BE16', log[5] === ((12345 >> 8) & 0xff) && log[6] === (12345 & 0xff));
  check('byte[7..10] = totalFileLen BE32',
    log[7] === 0xAB && log[8] === 0xCD && log[9] === 0xEF && log[10] === 0x12);
  let x = 0; for (let i = 0; i < 11; i++) x ^= log[i];
  check('byte[11] = XOR of [0..10]', log[11] === x);

  const hdr = Header.buildHeader(f);
  check('buildHeader は 18byte', hdr.length === 18);
})();

(function () {
  // 無誤りラウンドトリップ（フィールド全域）。
  let pass = 0, total = 0;
  for (let t = 0; t < 2000; t++) {
    const f = {
      version: 1 + Math.floor(rnd() * 63),
      eccLevel: Math.floor(rnd() * 4),
      pageIndex: Math.floor(rnd() * 256),
      totalPages: 1 + Math.floor(rnd() * 255),
      payloadLen: Math.floor(rnd() * 65536),
      totalFileLen: Math.floor(rnd() * 0xFFFFFFFF),
    };
    const info = Header.parseHeader(Header.buildHeader(f));
    total++;
    if (info && info.ok && info.version === f.version && info.eccLevel === f.eccLevel &&
        info.pageIndex === f.pageIndex && info.totalPages === f.totalPages &&
        info.payloadLen === f.payloadLen && info.totalFileLen === f.totalFileLen) pass++;
  }
  check(`ヘッダ 無誤りラウンドトリップ (${pass}/${total})`, pass === total);
})();

(function () {
  // 1〜3byte 誤り（RS nsym=6 → t=3）を必ず訂正。
  let pass = 0, total = 0;
  for (let t = 0; t < 2000; t++) {
    const f = { version: 14, eccLevel: 3, pageIndex: 5, totalPages: 10, payloadLen: 9999, totalFileLen: 1234567 };
    const nerr = 1 + Math.floor(rnd() * 3); // 1..3
    const bad = injectErrors(Header.buildHeader(f), nerr);
    const info = Header.parseHeader(bad);
    total++;
    if (info && info.ok && info.version === 14 && info.eccLevel === 3 &&
        info.payloadLen === 9999 && info.totalFileLen === 1234567) pass++;
  }
  check(`ヘッダ 1〜3byte 誤りを全訂正 (${pass}/${total})`, pass === total);
})();

// ==================================================================
console.log('\n==== §5+§6+§7 統合: 1 ページぶんの符号化→復号 ====');
(function () {
  // 実利用に近い流れ: ファイル片 → payload 符号化(§5) → グリッド化 →
  // マスク(§6) → デマスク → payload 復号(§5)、ヘッダは別保護(§7)。
  const v = Ver.VERSIONS[9]; // 中位版
  const ecc = 2;
  const net = Ver.netPayload(v.cols, v.rows, ecc);
  const gross = v.payloadGrossBytes;
  const file = randBytes(net);

  // §7 ヘッダ
  const hdr = Header.buildHeader({
    version: v.version, eccLevel: ecc, pageIndex: 0, totalPages: 1,
    payloadLen: net, totalFileLen: net,
  });
  // §5 payload
  const grossData = IL.encodePayload(file, gross, ecc);

  // ヘッダ 18B + payload グロスを 0/1 ビットグリッドへ（row-major, MSB first）。
  const cols = v.cols, rows = v.rows;
  const modules = new Uint8Array(cols * rows);
  const isFn = new Uint8Array(cols * rows);
  // 先頭 9x9 を機能モジュール（ファインダ）に見立てて data 領域から除外。
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) isFn[y * cols + x] = 1;

  // data セル位置リスト（機能モジュール以外）を作り、そこへビットを詰める。
  const dataCells = [];
  for (let i = 0; i < modules.length; i++) if (!isFn[i]) dataCells.push(i);
  const bitStream = [];
  const pushBytes = (bytes) => {
    for (const b of bytes) for (let k = 7; k >= 0; k--) bitStream.push((b >> k) & 1);
  };
  pushBytes(hdr);
  pushBytes(grossData);
  const nbits = Math.min(bitStream.length, dataCells.length);
  for (let i = 0; i < nbits; i++) modules[dataCells[i]] = bitStream[i];

  // §6 マスク選択・適用。
  const best = Mask.chooseBestMask(modules, isFn, cols, rows);

  // ---- 復号側 ----
  // デマスク（同じマスクを再適用）。
  const recv = Uint8Array.from(best.modules);
  Mask.applyMask(recv, isFn, cols, rows, best.mask);
  // data セルからビット→バイト復元。
  const outBits = dataCells.map(i => recv[i]);
  const readBytes = (offBits, nBytes) => {
    const out = new Uint8Array(nBytes);
    for (let i = 0; i < nBytes; i++) {
      let b = 0;
      for (let k = 0; k < 8; k++) b = (b << 1) | (outBits[offBits + i * 8 + k] & 1);
      out[i] = b;
    }
    return out;
  };
  const hdrBack = readBytes(0, 18);
  const info = Header.parseHeader(hdrBack);
  const grossBack = readBytes(18 * 8, gross);
  const dec = IL.decodePayload(grossBack, info ? info.eccLevel : ecc, info ? info.payloadLen : net);

  check('統合: ヘッダ復元 OK', info && info.ok && info.version === v.version && info.payloadLen === net);
  check('統合: payload 復元 OK', dec.ok && eq(dec.data, file));
})();

console.log(`\n==== 結果: ${failures === 0 ? 'ALL PASS' : failures + ' FAIL'} ====`);
process.exit(failures === 0 ? 0 : 1);
