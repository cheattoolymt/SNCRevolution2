/*
 * SuperNaidesuCardRevolution II (SNCR2) — decode-message-selftest.js
 * ==================================================================
 * decoder.html の失敗メッセージが「実態」と一致することの回帰テスト。
 *
 * 背景（不具合）:
 *   decoder.html は復元失敗時に
 *       `page1: ${r.reason || ('ver' + r.version + ' 未確定')}`
 *   という文言を出していた。ところが decodeAnyVersion() は、
 *   ヘッダ RS が完全成功（meta.magicOk / meta.ok = true でバージョン・ECC・
 *   ページ情報まで確定）しつつ **本文（payload）側の RS 訂正だけが失敗** した
 *   状態で、戻り値に reason キーを **一度もセットしないまま** 返していた
 *   （last = Object.assign({version,corners,invert,useAlignment}, r) のみ）。
 *   その結果、
 *     ・バージョン不明（ヘッダ MAGIC すら不一致・完全な検出失敗）
 *     ・バージョン確定・本文復元だけ失敗（劣化が強すぎる）
 *   が **同じ「verX 未確定」文言** で表示され、利用者が原因を誤認していた
 *   （「ECC の問題ではなさそう」という誤解を生んだ）。
 *
 * 本テストが固定する契約:
 *   (1) decodeAnyVersion() は、ヘッダ確定・本文 RS 失敗の状態で
 *       reason === 'payload-rs-fail' を返し、meta.ok === true を保つ。
 *   (2) 完全な検出失敗（ヘッダ MAGIC すら不一致）では meta が無く、
 *       payload-rs-fail 以外の reason（not-detected / no-corners 等）になる。
 *   (3) 失敗文言生成 describeFailure() が上記 2 状態を **別々の文言** に
 *       写像し、(1) では「verX 確定・本文の誤り訂正に失敗」を、
 *       (2) では「ver 不明・検出失敗」を出す。
 *
 * describeFailure() は decoder.html（ブラウザ）で定義される関数だが、その
 * ロジックは本ファイル内に厳密に複製し、「decoder.html と同一の文言契約」を
 * Node 上で検証する（DOM 非依存・§8 準拠）。decoder.html 側を変更する際は
 * こちらも合わせて更新すること（両者の文言が一致することがこのテストの主眼）。
 *
 * 実行: node test/decode-message-selftest.js
 * ================================================================== */
'use strict';

const CF = require('../js/card-format.js');
const DC = require('../js/decode-core.js');
const R  = require('../test/render-helper.js');
const JPEG = require('../test/jpeg-codec.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('PASS  ' + msg); }
  else      { fail++; console.log('FAIL  ' + msg); }
}
function section(t) { console.log('\n==== ' + t + ' ===='); }

function mkData(len, seed) {
  const d = new Uint8Array(len);
  let s = (seed || 1) >>> 0;
  for (let i = 0; i < len; i++) { s = (s * 1103515245 + 12345) >>> 0; d[i] = (s >>> 16) & 0xff; }
  return d;
}

// ------------------------------------------------------------------
//  decoder.html の describeFailure() の厳密な複製（DOM 非依存）。
//  ★ decoder.html の同名関数と文言・分岐を完全に一致させること。
// ------------------------------------------------------------------
function describeFailure(r) {
  if (!r) return '検出に失敗しました（画像を解析できません）';
  const meta = r.meta;
  const headerConfirmed = !!(meta && (meta.magicOk || meta.ok));

  if (r.reason === 'no-corners') {
    return '四隅マーカーを検出できません（傾き・見切れ・低コントラストの可能性）';
  }

  if (headerConfirmed) {
    const ver = (meta && meta.version != null) ? meta.version
      : (r.version != null ? r.version : '?');
    if (!r.ok) {
      return `ver${ver} 確定・本文の誤り訂正に失敗（劣化が強すぎる可能性：`
        + `再スキャン／ECC 高で再作成をご検討ください）`;
    }
    return `ver${ver} 確定`;
  }

  if (r.reason && r.reason !== 'payload-rs-fail') {
    return `検出に失敗しました（${r.reason}）`;
  }
  return 'ver 不明・検出失敗（版ヘッダを認識できません）';
}

// ==================================================================
//  ケースA: ヘッダ確定・本文 RS だけ失敗（dotgain_only 相当の再現）
// ------------------------------------------------------------------
//  §10-7 の「ドットゲイン単独 × ver14 満載 × 本物 JPEG（RS 訂正超過）」を
//  さらに強めて、ヘッダ RS は通るが本文 RS が能力超過する劣化を再現する。
//  ここで decodeAnyVersion() が reason='payload-rs-fail' を返し、
//  かつ meta.ok=true（ヘッダ確定）であることを検証する。
// ==================================================================
section('A: ver14 確定・本文RS失敗（dotgain 相当）で reason=payload-rs-fail');
{
  const prof = CF.getProfile(14);
  const net = CF.netCapacity(prof, 3);      // ECC 高で満載（本文を厳しくする）
  const data = mkData(net, 7);
  const enc = CF.encodePage(data, { version: 14, eccLevel: 3 });

  // ヘッダは通るが本文 RS が能力超過する強めのドットゲイン + 低品質 JPEG。
  //  （§10-7 の q40〜25 は本文まで復元できてしまうため、実機で破綻した
  //   「ヘッダは読めるのに本文が読めない」帯域を狙って更に厳しくする。）
  let img = R.renderPage(enc, 1);
  img = R.dotGain(img, { growPx: 3, blackFloor: 10, whiteCeil: 70 });
  img = JPEG.roundtrip(img, 12);

  const r = DC.decodeAnyVersion(img, { versions: [14], invert: false });

  console.log(`  ok=${!!r.ok} meta.magicOk=${r.meta && r.meta.magicOk} ` +
    `meta.ok=${r.meta && r.meta.ok} reason=${r.reason} version=${r.version}`);

  ok(r.ok === false, 'A-1 本文RS失敗なので全体 ok=false');
  ok(!!(r.meta && r.meta.magicOk), 'A-2 ヘッダ MAGIC は一致（meta.magicOk=true）');
  ok(!!(r.meta && r.meta.ok), 'A-3 ヘッダ RS 完全成功（meta.ok=true, バージョン確定）');
  ok(r.reason === 'payload-rs-fail',
    "A-4 reason='payload-rs-fail' が明示的にセットされている（設定漏れの回帰）");
  ok(r.version === 14, 'A-5 バージョンは 14 に確定している');

  const msg = describeFailure(r);
  console.log('  message =>', msg);
  ok(/ver14 確定/.test(msg) && /本文の誤り訂正に失敗/.test(msg),
    'A-6 文言が「ver14 確定・本文の誤り訂正に失敗」と表示される');
  ok(!/未確定/.test(msg) && !/ver 不明/.test(msg),
    'A-7 文言に「未確定」「ver 不明」が含まれない（バージョン不明との混同を防ぐ）');
}

// ==================================================================
//  ケースB: 完全な検出失敗（ヘッダ MAGIC すら不一致）
// ------------------------------------------------------------------
//  真っ白（コンテンツ無し）の画像を与えると四隅すら検出できない、または
//  ヘッダ MAGIC が一致しない。meta が無く、reason は payload-rs-fail に
//  ならないことを検証する。
// ==================================================================
section('B: バージョン不明（検出失敗）で reason≠payload-rs-fail');
{
  // 2152x3096 相当の真っ白画像（コンテンツ無し）。
  const W = 400, H = 560;   // 小さめでも「検出不能」であることは変わらない
  const white = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  for (let i = 0; i < W * H; i++) {
    white.data[i * 4] = white.data[i * 4 + 1] = white.data[i * 4 + 2] = 255;
    white.data[i * 4 + 3] = 255;
  }
  const r = DC.decodeAnyVersion(white, { versions: [14], invert: false });
  console.log(`  ok=${!!r.ok} meta=${r.meta ? 'present' : 'null'} reason=${r.reason}`);

  ok(r.ok === false, 'B-1 検出失敗なので ok=false');
  ok(!r.meta || !r.meta.magicOk, 'B-2 ヘッダ確定していない（meta 無し or magicOk=false）');
  ok(r.reason !== 'payload-rs-fail',
    "B-3 reason は payload-rs-fail ではない（本文RS失敗と混同しない）");

  const msg = describeFailure(r);
  console.log('  message =>', msg);
  ok(/ver 不明|四隅マーカー|検出に失敗/.test(msg),
    'B-4 文言が「ver 不明・検出失敗」系（バージョン確定文言ではない）');
  ok(!/確定・本文の誤り訂正に失敗/.test(msg),
    'B-5 文言に「確定・本文の誤り訂正に失敗」が含まれない');
}

// ==================================================================
//  ケースC: describeFailure() の分岐網羅（合成 result での単体検証）
// ------------------------------------------------------------------
//  実画像を通さずに、describeFailure() の写像そのものを直接検証する。
//  修正方針で列挙された 3 分類を明示的にカバーする。
// ==================================================================
section('C: describeFailure() 分岐網羅（合成 result）');
{
  // reason なし かつ meta 無し → ver 不明・検出失敗
  ok(/ver 不明/.test(describeFailure({ ok: false, meta: null, version: undefined })),
    'C-1 meta 無し → ver 不明・検出失敗');

  // reason なし かつ meta.ok=true かつ r.ok=false → verX 確定・本文失敗
  const c2 = describeFailure({ ok: false, version: 14,
    meta: { magicOk: true, ok: true, version: 14 } });
  ok(/ver14 確定/.test(c2) && /本文の誤り訂正に失敗/.test(c2),
    'C-2 meta.ok=true & r.ok=false → verX 確定・本文の誤り訂正に失敗');

  // reason='payload-rs-fail' でも meta.ok=true なら同じく「確定・本文失敗」
  const c2b = describeFailure({ ok: false, version: 14, reason: 'payload-rs-fail',
    meta: { magicOk: true, ok: true, version: 14 } });
  ok(/ver14 確定/.test(c2b) && /本文の誤り訂正に失敗/.test(c2b),
    'C-2b reason=payload-rs-fail & meta.ok=true → verX 確定・本文失敗');

  // reason='no-corners' → 四隅マーカーを検出できません
  ok(/四隅マーカー/.test(describeFailure({ ok: false, reason: 'no-corners', meta: null })),
    'C-3 reason=no-corners → 四隅マーカーを検出できません');

  // null → 明示的な検出失敗文言
  ok(/検出に失敗/.test(describeFailure(null)), 'C-4 null → 検出に失敗しました');
}

// ==================================================================
console.log(`\n==== 結果: ${fail === 0 ? 'ALL PASS' : (fail + ' FAIL')} (pass=${pass}, fail=${fail}) ====`);
if (fail !== 0) process.exit(1);
