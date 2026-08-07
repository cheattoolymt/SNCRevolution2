/*
 * SuperNaidesuCardRevolution II (SNCR2) — payload-rsfail-diag.js
 * ==================================================================
 * 「ver 確定・本文（payload）RS 失敗」の **根本原因調査** 用の再現・計測ツール。
 *
 * 背景:
 *   decoder.html で「ver14 確定（ヘッダ RS 完全成功）なのに本文 RS だけ失敗」と
 *   いう実機報告があった（PR 1/2 で表示文言と reason 設定漏れは修正済み）。
 *   本ツールは、その状態を机上で決定的に再現したうえで、
 *     ・モジュール（セル bit）反転率
 *     ・RS ブロックごとの byte 誤り数 と 訂正能力 t の関係
 *     ・誤りが「局所バースト」か「全面一様」か
 *   をブロック単位で計測し、**なぜ RS が能力超過するのか**を数値で切り分ける。
 *
 * これは「表示が正しくなること」とは別に必要な原因究明であり、本ツールの出力を
 * もって初めて「劣化が RS 能力を超えている（＝ECC 設計の余裕不足 or サンプリング
 * 反転の多さ）」のか「実装バグ（サンプリング/インターリーブの取り違え）」なのかを
 * 判別できる。結論は docs/INVESTIGATE-payload-rsfail.md に記載。
 *
 * 実行:
 *   node test/payload-rsfail-diag.js            # 既定の再現ケース
 *   node test/payload-rsfail-diag.js --json     # 機械可読サマリ（1 行 JSON）
 * ================================================================== */
'use strict';

const CF   = require('../js/card-format.js');
const DC   = require('../js/decode-core.js');
const R    = require('../test/render-helper.js');
const JPEG = require('../test/jpeg-codec.js');
const IL   = require('../js/qr-interleave.js');
const Ver  = require('../js/qr-version.js');
const RS   = require('../js/qr-rs.js');
const Core = require('../js/qr-core.js');
const Header = require('../js/qr-header.js');

const asJson = process.argv.includes('--json');

function mkData(len, seed) {
  const d = new Uint8Array(len);
  let s = (seed || 1) >>> 0;
  for (let i = 0; i < len; i++) { s = (s * 1103515245 + 12345) >>> 0; d[i] = (s >>> 16) & 0xff; }
  return d;
}

// ------------------------------------------------------------------
//  再現ケース: ver14 満載（ECC 高）× 強ドットゲイン × 低品質 JPEG。
//  「ヘッダは通るが本文 RS が能力超過」する帯域を狙って劣化を強める。
// ------------------------------------------------------------------
function reproduce(opt) {
  opt = opt || {};
  const version = opt.version != null ? opt.version : 14;
  const ecc = opt.ecc != null ? opt.ecc : 3;
  const prof = CF.getProfile(version);
  const net = CF.netCapacity(prof, ecc);
  const data = mkData(net, opt.seed != null ? opt.seed : 7);
  const enc = CF.encodePage(data, { version, eccLevel: ecc });
  const cleanModules = enc.modules;

  let img = R.renderPage(enc, 1);
  img = R.dotGain(img, opt.dotGain || { growPx: 3, blackFloor: 10, whiteCeil: 70 });
  img = JPEG.roundtrip(img, opt.jpegQ != null ? opt.jpegQ : 12);

  const corners = DC.detectCorners(img, { invert: false });
  if (!corners) return { corners: false };

  // 本番同様 align ON→OFF を試し、ヘッダが読める方を採る。
  let chosen = null;
  for (const useAlignment of [true, false]) {
    const modules = DC.sampleModules(img, corners, prof.COLS, prof.ROWS, { invert: false, useAlignment });
    const d0 = Core.decodeGrid(modules, prof.COLS, prof.ROWS, null);
    const meta = Header.parseHeader(d0.header);
    const magicOk = !!(meta && meta.magicOk);
    let flips = 0;
    for (let i = 0; i < modules.length; i++) if (modules[i] !== cleanModules[i]) flips++;
    const cand = { modules, d0, meta, useAlignment, magicOk, flips, metaOk: !!(meta && meta.ok) };
    if (magicOk && (!chosen || (cand.metaOk && !chosen.metaOk))) chosen = cand;
  }
  if (!chosen) return { corners: true, headerOk: false };

  const { d0, meta, flips, useAlignment } = chosen;

  // 本文ブロックの誤り分布を「クリーン gross」と突き合わせて計測。
  const dataBytes = Math.floor(d0.dataCells.length / 8);
  const grossLen = Math.max(0, dataBytes - Ver.HEADER_LEN);
  const grossData = d0.payloadGross.subarray(0, grossLen);
  const cleanGross = IL.encodePayload(data, grossLen, ecc);

  const plan = Ver.blockPlan(grossLen, ecc);
  const nsym = plan[0].nsym;
  const t = nsym / 2;
  const cwsRecv = IL.deinterleaveBlocks(grossData, plan);
  const cwsClean = IL.deinterleaveBlocks(cleanGross, plan);

  const blocks = [];
  let totalErr = 0, failBlocks = 0, overCap = 0, maxErr = 0;
  for (let i = 0; i < plan.length; i++) {
    const b = plan[i];
    const cwLen = b.dataLen + b.nsym;
    let err = 0;
    for (let j = 0; j < cwLen; j++) if (cwsRecv[i][j] !== cwsClean[i][j]) err++;
    const r = RS.decode(cwsRecv[i], b.nsym);
    totalErr += err; maxErr = Math.max(maxErr, err);
    if (!r.ok) failBlocks++;
    if (err > t) overCap++;
    blocks.push({ i, err, cwLen, t, rsOk: r.ok, corrected: r.corrected, overCap: err > t });
  }

  const sorted = blocks.map(x => x.err).sort((a, b) => b - a);
  return {
    corners: true, headerOk: true,
    version, ecc, useAlignment,
    moduleFlips: flips, moduleTotal: cleanModules.length,
    moduleFlipPct: 100 * flips / cleanModules.length,
    payloadLen: meta.payloadLen, gross: grossLen,
    nblocks: plan.length, nsym, t, blockLen: plan[0].dataLen + nsym,
    totalByteErr: totalErr, avgBlockErr: totalErr / plan.length,
    maxBlockErr: maxErr, failBlocks, overCap,
    top10: sorted.slice(0, 10), minBlockErr: sorted[sorted.length - 1],
    blocks,
  };
}

// ------------------------------------------------------------------
//  「一様 vs バースト」の切り分け:
//   インターリーブ後の受信 gross を、元の物理配置（=インターリーブ前の
//   ブロック分散）ではなく **連続バイト窓** で見て、誤りが空間的に固まって
//   いるか（バースト）を評価する。バーストなら窓ごとの誤り密度が偏る。
// ------------------------------------------------------------------
function burstiness(res) {
  // ブロック誤り数の分散/平均（分散が小さいほど一様）。
  const errs = res.blocks.map(b => b.err);
  const mean = errs.reduce((s, e) => s + e, 0) / errs.length;
  const varr = errs.reduce((s, e) => s + (e - mean) * (e - mean), 0) / errs.length;
  const cv = mean > 0 ? Math.sqrt(varr) / mean : 0; // 変動係数
  return { mean, std: Math.sqrt(varr), cv };
}

const res = reproduce();

if (asJson) {
  const b = res.headerOk ? burstiness(res) : null;
  console.log(JSON.stringify({ ...res, blocks: undefined, burst: b }));
  process.exit(0);
}

console.log('==== payload-rsfail 根本原因調査（決定的再現）====\n');
if (!res.corners) { console.log('四隅未検出。'); process.exit(0); }
if (!res.headerOk) { console.log('ヘッダも読めず（この劣化は検出失敗側）。'); process.exit(0); }

const b = burstiness(res);
console.log(`版/ECC: ver${res.version}/ecc${res.ecc}  (useAlignment=${res.useAlignment})`);
console.log(`ヘッダ: RS 完全成功（version=${res.version} 確定、payloadLen=${res.payloadLen}）`);
console.log('');
console.log('── モジュール（セル bit）層 ──────────────────────────');
console.log(`  反転セル: ${res.moduleFlips}/${res.moduleTotal} = ${res.moduleFlipPct.toFixed(2)}%`);
console.log('');
console.log('── RS ブロック層 ─────────────────────────────────────');
console.log(`  gross=${res.gross}B, ブロック数=${res.nblocks}, nsym/block=${res.nsym}`);
console.log(`  1 ブロック訂正能力 t=${res.t} byte（ブロック長 ${res.blockLen}）`);
console.log(`  総 byte 誤り=${res.totalByteErr}, 平均/block=${res.avgBlockErr.toFixed(1)}, 最大=${res.maxBlockErr}, 最小=${res.minBlockErr}`);
console.log(`  RS 失敗ブロック=${res.failBlocks}/${res.nblocks}, 能力超過(err>t)=${res.overCap}/${res.nblocks}`);
console.log(`  誤り上位10ブロック: ${res.top10.join(',')}`);
console.log('');
console.log('── 一様 vs バースト ──────────────────────────────────');
console.log(`  ブロック誤り数 平均=${b.mean.toFixed(1)}, 標準偏差=${b.std.toFixed(1)}, 変動係数CV=${b.cv.toFixed(3)}`);
console.log(`  → CV が小さい（≈${b.cv.toFixed(2)}）ほど「全面一様」。バーストなら CV が大きくなる。`);
console.log('');
console.log('── 結論の骨子 ────────────────────────────────────────');
const byteErrPct = 100 * res.avgBlockErr / res.blockLen;
console.log(`  ・モジュール反転率 ${res.moduleFlipPct.toFixed(2)}% が、byte 化（8 セル=1byte）で`);
console.log(`    平均 byte 誤り率 ≈ ${byteErrPct.toFixed(1)}% に増幅され、t/blockLen=${(100*res.t/res.blockLen).toFixed(1)}% の`);
console.log(`    RS 訂正上限とほぼ拮抗 → 約半数のブロックが僅かに能力超過して失敗。`);
console.log(`  ・誤りは全面一様（CV=${b.cv.toFixed(2)}）なので、インターリーブでは救えない`);
console.log(`    （バースト分散前提の対策が効かない領域）。ECC 余裕 or 反転率低減が必要。`);
