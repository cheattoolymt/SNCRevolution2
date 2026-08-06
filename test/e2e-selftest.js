/*
 * SuperNaidesuCardRevolution II (SNCR2) — e2e-selftest.js
 * ==================================================================
 * 実装指示書 §10「検証すべき仮説」の end-to-end 検証テスト。
 *
 * これまでの 2 本（design-selftest / core-selftest）は「純粋関数の
 * ユニット検証」だったが、本テストは
 *
 *     encodePage → renderPage(A4/300dpi ピクセル画像) →
 *     劣化シミュレーション(傾き/ぼかし/中央たわみ/帯状ノイズ/汚れ) →
 *     decode-core（四隅検出 + §3 アライメント制御点メッシュ + サンプリング）→
 *     decodePageModules（§5 RS 訂正）
 *
 * という「印刷→スキャン→復元」の 1 サイクルまるごとを回し、元バイト列と
 * 一致するか（ラウンドトリップ成功率）を測る。合成画像・劣化は
 * test/render-helper.js（決定的 PRNG）で再現性を担保している。
 *
 * ── 検証する仮説（sncr.md §10）──────────────────────────────────
 *  §10-1  アライメントパターンを使うと「中央部のたわみ（バレル歪み）」への
 *         復元成功率が上がるか。→ decode-core を useAlignment=true / false で
 *         切り替えて同一劣化画像を復号し、ON が OFF に少なくとも劣らず、
 *         かつ「OFF が落ちるが ON は通る」ケースが存在することを示す。
 *  §10-2  同一セルサイズ・同一 ECC で、実運用に近い複合劣化
 *         （JPEG 近似ぼかし + 傾き + 汚れ）でも復元できるか。
 *  §10-3  クリーン画像で全版 x 全 ECC がラウンドトリップし、
 *         「A4 1 枚 10KB 前後」の到達版が復元できるか（複数ページ結合含む）。
 *
 * §8「多値化禁止・二値固定・ブラウザ完結」を守るため、テストも DOM/Canvas に
 * 触れず、Node の生ピクセルバッファのみで完結する。
 *
 * 実行: node test/e2e-selftest.js
 * ================================================================== */
'use strict';

const CF = require('../js/card-format.js');
const DC = require('../js/decode-core.js');
const R  = require('../test/render-helper.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('PASS  ' + msg); }
  else      { fail++; console.log('FAIL  ' + msg); }
}
function section(t) { console.log('\n==== ' + t + ' ===='); }

// ---- テストデータ（決定的な擬似ランダム列）--------------------------
function mkData(len, seed) {
  const d = new Uint8Array(len);
  let s = (seed || 1) >>> 0;
  for (let i = 0; i < len; i++) { s = (s * 1103515245 + 12345) >>> 0; d[i] = (s >>> 16) & 0xff; }
  return d;
}

// ---- 1 サイクル: encode → render → (degrade) → decode → 一致判定 -----
//  返り値: { ok, match, corrected, version }
function roundtrip(version, ecc, data, degrade, useAlignment) {
  const enc = CF.encodePage(data, { version, eccLevel: ecc });
  let img = R.renderPage(enc, 1);            // フル A4/300dpi（一致検証は等倍で）
  if (degrade) img = degrade(img);
  const r = DC.decodeAnyVersion(img, { useAlignment });
  let match = !!(r.ok && r.data && r.data.length >= data.length);
  if (match) for (let i = 0; i < data.length; i++) if (r.data[i] !== data[i]) { match = false; break; }
  return { ok: !!r.ok, match, corrected: r.corrected || 0, version: r.version };
}

// ==================================================================
//  §10-3  クリーン・ラウンドトリップ（全版 × 全 ECC）
// ==================================================================
section('§10-3 クリーン: 全版 × 全 ECC ラウンドトリップ');
{
  let all = true, n = 0;
  for (const v of CF.VERSIONS) {
    const prof = CF.getProfile(v);
    for (let ecc = 0; ecc <= 3; ecc++) {
      const net = CF.netCapacity(prof, ecc);
      // ヘッダ 18B を除いた正味の半分程度を載せる（余裕を持って検証）。
      const len = Math.max(16, Math.floor(net * 0.5));
      const data = mkData(len, v * 10 + ecc);
      const res = roundtrip(v, ecc, data, null, true);
      n++;
      if (!res.match) { all = false; console.log(`  MISS ver${v} ecc${ecc} len${len}: ok=${res.ok} corr=${res.corrected}`); }
    }
  }
  ok(all, `クリーン全版×全ECC ラウンドトリップ (${n} 通り)`);
}

// ==================================================================
//  §10-3  「A4 1 枚 10KB 前後」到達版の復元 + 複数ページ結合
// ==================================================================
section('§10-3 最大版 ≈10KB 復元 + 複数ページ結合');
{
  const maxV = CF.VERSIONS[CF.VERSIONS.length - 1];
  const prof = CF.getProfile(maxV);
  const net = CF.netCapacity(prof, 3);          // ECC 高（推奨運用）
  const data = mkData(net, 999);
  const res = roundtrip(maxV, 3, data, null, true);
  ok(res.match, `最大版 ver${maxV} ECC高 で正味 ${net}B を 1 枚ラウンドトリップ`);

  // 複数ページ: net の 1.7 倍を投入 → 2 ページに分割・結合して復元。
  const bigLen = Math.floor(net * 1.7);
  const big = mkData(bigLen, 1234);
  const { pages, totalPages } = CF.encodeFile(big, { version: maxV, eccLevel: 3 });
  ok(totalPages >= 2, `${bigLen}B は複数ページに分割される (pages=${totalPages})`);
  const pageResults = [];
  for (let p = 0; p < pages.length; p++) {
    const img = R.renderPage(pages[p], 1);
    const r = DC.decodeAnyVersion(img, { useAlignment: true });
    pageResults.push(r);
  }
  const asm = CF.assembleFile(pageResults);
  let assembledMatch = asm.ok && asm.data && asm.data.length === bigLen;
  if (assembledMatch) for (let i = 0; i < bigLen; i++) if (asm.data[i] !== big[i]) { assembledMatch = false; break; }
  ok(assembledMatch, `複数ページ (${totalPages}) を結合して ${bigLen}B を完全復元`);
}

// ==================================================================
//  §10-1  アライメントパターンによる中央たわみ耐性（ON vs OFF）
// ------------------------------------------------------------------
//  同一の劣化画像を useAlignment=true/false で復号し比較する。
//  ・ON は OFF に「劣らない」（成功していたものが失敗に転じない）。
//  ・「OFF は失敗するが ON は成功する」ケースが 1 つ以上存在する
//    （＝アライメントが確かに歪み補正に効いている証拠）。
// ==================================================================
section('§10-1 中央たわみ（バレル歪み）耐性: アライメント ON vs OFF');
{
  // ver3（セル ≒ 2mm・中密度）は、たわみ 0.02 で「四隅のみ」だと崩れるが
  // アライメント制御点メッシュがあれば復元できる、という差が出る帯域。
  const version = 3, ecc = 3;
  const data = mkData(400, 42);
  let onNeverWorse = true, existsOnlyOn = false, cases = 0;
  for (const k of [0.006, 0.010, 0.014, 0.018, 0.020, 0.024]) {
    const degrade = (img) => R.warpCenterBulge(img, k);
    const on  = roundtrip(version, ecc, data, degrade, true);
    const off = roundtrip(version, ecc, data, degrade, false);
    cases++;
    console.log(`  bulge k=${k}: ON match=${on.match?1:0}(corr=${on.corrected})  OFF match=${off.match?1:0}(corr=${off.corrected})`);
    if (off.match && !on.match) onNeverWorse = false;   // ON が OFF より悪化＝NG
    if (on.match && !off.match) existsOnlyOn = true;     // アライメントが効いた証拠
  }
  ok(onNeverWorse, `アライメント ON は OFF に劣化しない (${cases} 段階)`);
  ok(existsOnlyOn, `「OFF は失敗するが ON は成功する」たわみ帯域が存在（§10-1 仮説を支持）`);
}

// ==================================================================
//  §10-2  実運用に近い複合劣化での復元
// ------------------------------------------------------------------
//  JPEG の主効果（ブロック平滑化＋量子化ノイズ）をぼかし＋加算ノイズで近似し、
//  微小な傾き・汚れ斑点・帯状ノイズを重畳する（render-helper のコメント参照）。
//  ECC 高（≈30%）＋アライメントメッシュで、中密度版が復元できることを確認。
// ==================================================================
section('§10-2 複合劣化（JPEG近似ぼかし+傾き+帯ノイズ+汚れ）での復元');
{
  const version = 2, ecc = 3;                 // セル ≒ 2.4mm・ECC 高
  const data = mkData(300, 77);
  const degrade = (img) =>
    R.addNoise(
      R.blur(R.rotate(img, 0.5), 1),          // 傾き 0.5° → JPEG 近似ぼかし r=1
      { bandAmp: 22, qNoise: 18, spots: 12 }, // 帯状ノイズ・量子化ノイズ・汚れ 12 個
      2024);
  const res = roundtrip(version, ecc, data, degrade, true);
  ok(res.match, `複合劣化 ver${version} ECC高 で ${data.length}B を復元 (corr=${res.corrected})`);

  // 傾きのみ（スキャナで起こりうる範囲）を数段階。
  let rotAll = true;
  for (const deg of [0.2, 0.5, 0.8, 1.2]) {
    const r = roundtrip(3, 3, mkData(380, 88), (img) => R.rotate(img, deg), true);
    if (!r.match) { rotAll = false; console.log(`  MISS rotate ${deg}deg: ok=${r.ok} corr=${r.corrected}`); }
  }
  ok(rotAll, `微小傾き 0.2〜1.2° を全て復元（スキャナ想定レンジ）`);
}

// ==================================================================
//  まとめ
// ==================================================================
console.log(`\n==== 結果: ${fail === 0 ? 'ALL PASS' : (fail + ' FAIL')} (pass=${pass}, fail=${fail}) ====`);
if (fail !== 0) process.exit(1);
