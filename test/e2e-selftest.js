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
 *  §10-4  【実機フィードバック】全面均一劣化（ドットゲイン）への耐性。
 *         局所汚れ(spots)には ECC で耐えるが、盤面全体が一律に太る/沈む
 *         ドットゲインは固定しきい 128 の二値化を破綻させる（白セルまで黒判定）。
 *         適応しきい化（大域 Otsu + 局所適応）で復元できることを確認する。
 *  §10-5  【実機フィードバック】複合劣化の段階検証（level1〜3）。
 *         単一劣化要因が各々通っても、複合すると閾値が破綻し得る。特に
 *         level3（たわみ + 回転 1.3° + 強めぼかし + ドットゲイン）は
 *         実機で失敗が判明したパターン。段階的に重畳して閾値耐性を検証する。
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
const JPEG = require('../test/jpeg-codec.js');

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
//  version は既知（テストが encode に使った版）なので、試し読みを当該版に
//  絞って高速化する（decodeAnyVersion の opt.versions＝任意最適化。
//  プロダクション decoder.html は既定＝全版自動判別のまま）。全 14 版 ×
//  全面サンプリングを毎回回すと ver13/14 では 1 デコード数秒に達し、e2e が
//  タイムアウトするため。自動判別そのものの検証は core/§10-3 が担う。
//  useAlignment: true / false で単一モード。'auto'（または未指定）で
//    プロダクション既定（メッシュ ON→OFF の二段試行）を測る。
function roundtrip(version, ecc, data, degrade, useAlignment) {
  const enc = CF.encodePage(data, { version, eccLevel: ecc });
  let img = R.renderPage(enc, 1);            // フル A4/300dpi（一致検証は等倍で）
  if (degrade) img = degrade(img);
  // 'auto' は opt.useAlignment を渡さない＝decodeAnyVersion の既定 [true,false] 二段。
  //  レンダは常に非反転（白地・黒セル）なので invert:false を明示して試し読みを半減。
  const opt = { versions: [version], invert: false };
  if (useAlignment === true || useAlignment === false) opt.useAlignment = useAlignment;
  const r = DC.decodeAnyVersion(img, opt);
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
    const r = DC.decodeAnyVersion(img, { useAlignment: true, versions: [maxV], invert: false });
    pageResults.push(r);
  }
  const asm = CF.assembleFile(pageResults);
  let assembledMatch = asm.ok && asm.data && asm.data.length === bigLen;
  if (assembledMatch) for (let i = 0; i < bigLen; i++) if (asm.data[i] !== big[i]) { assembledMatch = false; break; }
  ok(assembledMatch, `複数ページ (${totalPages}) を結合して ${bigLen}B を完全復元`);
}

// ==================================================================
//  §10-1  アライメントパターンによる中央たわみ耐性（ON 単体精度 + auto vs OFF）
// ------------------------------------------------------------------
//  同一の劣化画像を useAlignment=true/false で復号し比較する。
//  ・ON 単体（内部アライメントメッシュ）は OFF（四隅のみ）に「劣らない」
//    ＝サンプリング後モジュールの真値との反転数 flips が ON ≤ OFF。
//  ・実機既定（auto=ON→OFF 二段）は OFF 単独に劣化しない（成功が失敗に転じない）。
//  ・「OFF は失敗するが ON は成功する」ケースが存在する（＝アライメントが確かに
//    歪み補正に効いている証拠）。
// ==================================================================
section('§10-1 中央たわみ（バレル歪み）耐性: ON 単体精度 + auto vs OFF');

// サンプリング後モジュールと真値の反転数（flips）を直接測る。§10-1 は「ECC で
//  救えたか（match）」だけでなく、その手前の **サンプリング精度そのもの**（flips）
//  を固定する。ON 単体の精度が OFF 以下であることを k の細かい掃引で保証する。
function bulgeFlips(version, ecc, data, k, useAlignment) {
  const enc = CF.encodePage(data, { version, eccLevel: ecc });
  const img = R.warpCenterBulge(R.renderPage(enc, 1), k);
  const corners = DC.detectCorners(img, { invert: false });
  if (!corners) return { flips: -1, refined: 0, total: 0 };
  const prof = CF.getProfile(version);
  const mods = DC.sampleModules(img, corners, prof.COLS, prof.ROWS,
    { invert: false, useAlignment });
  let f = 0;
  for (let i = 0; i < enc.modules.length; i++) if (mods[i] !== enc.modules[i]) f++;
  return { flips: f, refined: mods.__meshRefined || 0, total: mods.__meshTotal || 0 };
}

{
  // ver3（セル ≒ 2mm・中密度）は、たわみ 0.018 以上で「四隅のみ」だと崩れるが
  //  アライメント制御点メッシュがあれば復元できる帯域。
  //
  // 【実機フィードバック §10-1: k=0.018 の ON 単体劣化バグ修正を固定】
  //  以前この帯域は「ON 単体がメッシュの区分 bilinear で OFF より悪化し得る」
  //  として auto 経路（ON→OFF 二段）でしか '劣化しない' を保証していなかった。
  //  原因は右上内部アライメント 1 点（cell≈(63,6)）の ~0.8 セル誤検出が周囲
  //  25×14 セルを反転させる特異点で、k=0.016(正常)→0.018(異常)→0.02(正常化)
  //  という非単調挙動を示した（test/_k_sweep.js で再現、flips ON=135 > OFF=59）。
  //  decode-core パス2 の局所平滑性しきいを cellPx*0.9→*0.6 に締め、外れ値は
  //  近傍中央値の乖離へスナップする修正で解消。**ON 単体でも全 k で flips ON≤OFF**
  //  になったので、ここでその ON 単体精度そのものを固定する（test/_k_sweep.js と
  //  同じ 0.002 刻み掃引を e2e に正式反映）。
  const version = 3, ecc = 3;
  const data = mkData(400, 42);

  // (1) ON 単体精度: 0.002 刻みの細かい掃引で「flips ON ≤ flips OFF」を全 k で要求。
  //  これが §10-1 の核心（旧テストが固定していなかった ON 単体の精度）。
  let onNeverWorse = true, kCases = 0, kBad = '';
  for (let k = 0.006; k <= 0.0261; k += 0.002) {
    k = Math.round(k * 1000) / 1000;
    const on  = bulgeFlips(version, ecc, data, k, true);
    const off = bulgeFlips(version, ecc, data, k, false);
    kCases++;
    console.log(`  bulge k=${k}: ON flips=${on.flips}(mesh=${on.refined}/${on.total})  OFF flips=${off.flips}`);
    if (on.flips > off.flips) { onNeverWorse = false; kBad += ` k=${k}(ON${on.flips}>OFF${off.flips})`; }
  }
  ok(onNeverWorse,
     `ON 単体（内部メッシュ）は OFF（四隅のみ）に劣化しない: 全 k で flips ON≤OFF (${kCases} 段階)${kBad ? ' 違反:' + kBad : ''}`);

  // (1b) 特異点 k=0.018 の回帰ピン留め: かつて ON flips=135・match 失敗だった
  //  ピンポイント特異点が、ON 単体でも flips=0（完全一致）に直っていること。
  {
    const on018 = bulgeFlips(version, ecc, data, 0.018, true);
    ok(on018.flips === 0,
       `特異点 k=0.018 の ON 単体劣化バグが解消（ON flips=${on018.flips}, 期待 0）`);
  }

  // (2) 実機既定（auto=ON→OFF 二段）は OFF 単独に劣化しない（match ベース）。
  let autoNeverWorse = true, cases = 0;
  for (const k of [0.006, 0.010, 0.014, 0.018, 0.020, 0.024]) {
    const degrade = (img) => R.warpCenterBulge(img, k);
    const auto = roundtrip(version, ecc, data, degrade, 'auto');   // 実機既定（ON→OFF二段）
    const off  = roundtrip(version, ecc, data, degrade, false);    // 単一 OFF（四隅のみ）
    cases++;
    console.log(`  bulge k=${k}: auto match=${auto.match?1:0}(corr=${auto.corrected})  OFF match=${off.match?1:0}(corr=${off.corrected})`);
    if (off.match && !auto.match) autoNeverWorse = false;  // 実機既定が OFF 単独より悪化＝NG
  }
  ok(autoNeverWorse, `実機既定(auto=ON→OFF二段)は OFF 単独に劣化しない (${cases} 段階)`);

  // アライメントが確かに効いている証拠は、たわみが最も効く **高密度版** で
  //  「単一 ON は復元・単一 OFF は破綻」を示すのが最も明瞭（中密度 ver3 の
  //  バルジ帯域は偶発的で不安定なため、ここでは高密度 level3 で決定的に示す）。
  //  高密度満載サンプリングは重いので 1 版（ver10）で代表。
  {
    const v = 10;
    const prof = CF.getProfile(v);
    const d = mkData(Math.min(CF.netCapacity(prof, 3), 300), 424);
    const level3 = (img) => R.dotGain(
      R.blur(R.rotate(R.warpCenterBulge(img, 0.010), 1.3), 2),
      { growPx: 1, blackFloor: 35, whiteCeil: 115, bias: -8 });
    const on  = roundtrip(v, 3, d, level3, true);
    const off = roundtrip(v, 3, d, level3, false);
    console.log(`  high-density ver${v} level3: ON match=${on.match?1:0}(corr=${on.corrected})  OFF match=${off.match?1:0}(corr=${off.corrected})`);
    ok(on.match && !off.match,
       `高密度 ver${v} level3 で「OFF(四隅のみ)は破綻・ON(内部アライメント)は成功」＝§10-1 仮説を決定的に支持`);
  }
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
//  §10-4  全面均一劣化（ドットゲイン）への耐性
// ------------------------------------------------------------------
//  実機検証で判明: 局所劣化（汚れ）には強いが、全面一律の劣化（ドットゲイン
//  ＝インク/トナー滲みで盤面全体の黒が太り、白背景まで沈む）に弱かった。
//  原因は「固定しきい 128」でのセル二値化。白背景の輝度が 128 を割ると
//  全白セルが黒と誤判定され、一度に半数近いセルが反転して ECC 能力を超える。
//  対策として適応しきい化（大域 Otsu + 局所適応、decode-core.js sampleModules）
//  を導入した。ここでは「白背景が 128 を大きく下回るほど暗化した」全面
//  ドットゲインでも復元できること、および段階的に強めても破綻しないことを
//  確認する（＝固定しきいなら flips≈49% で確実に失敗する条件）。
// ==================================================================
section('§10-4 全面均一劣化（ドットゲイン）への適応しきい耐性');
{
  const version = 2, ecc = 3;
  const data = mkData(300, 4040);
  // (a) 白背景が固定しきい 128 を大きく下回る「全面暗化」ドットゲイン。
  //     blackFloor=30(黒の浮き) / whiteCeil=110(白の沈み) → 白まで <128。
  //     固定しきいなら白セル全滅だが、適応しきいはヒストグラム平行移動に追従。
  const uniform = (img) => R.dotGain(img, { growPx: 1, blackFloor: 30, whiteCeil: 110 });
  const rU = roundtrip(version, ecc, data, uniform, true);
  ok(rU.match, `全面暗化ドットゲイン(白→110<128) ver${version} ECC高 を復元 (corr=${rU.corrected})`);

  // (b) 膨張量・暗化量を段階的に強めても復元できること（閾値の追従性）。
  let dgAll = true;
  const grid = [
    { growPx: 0, blackFloor: 40, whiteCeil: 120 },
    { growPx: 1, blackFloor: 30, whiteCeil: 105 },
    { growPx: 2, blackFloor: 20, whiteCeil: 100 },
    { growPx: 1, blackFloor: 45, whiteCeil: 115, bias: -12 },
  ];
  for (const g of grid) {
    const r = roundtrip(version, ecc, data, (img) => R.dotGain(img, g), true);
    if (!r.match) { dgAll = false; console.log(`  MISS dotGain ${JSON.stringify(g)}: ok=${r.ok} corr=${r.corrected}`); }
  }
  ok(dgAll, `ドットゲイン強度 4 段階（膨張×暗化）を全て復元（適応しきいの追従性）`);
}

// ==================================================================
//  §10-5  複合劣化の段階検証（level1 → level2 → level3）
// ------------------------------------------------------------------
//  実機フィードバック: 単一劣化要因のテスト（傾きのみ・ぼかしのみ・ドット
//  ゲインのみ 等）は各々通っていても、複合劣化での閾値検証が不足していた。
//  とくに level3（たわみ + 回転 1.3° + 強めぼかし + ドットゲインの複合）で
//  失敗が判明したため、劣化要因を段階的に重畳する複合パターンを追加する。
//   level1: 回転 + 軽ぼかし（従来の単純劣化相当）
//   level2: level1 + 中央たわみ（アライメントメッシュが効く帯域）
//   level3: level2 の回転を 1.3° に強化 + 強めぼかし + 全面ドットゲイン
//           （＝実機で破綻した複合。固定しきいなら白セル全滅で確実に失敗）
//  すべて ECC 高（推奨運用）で復元できることを検証する。
// ==================================================================
section('§10-5 複合劣化の段階検証（level1→level2→level3、実機破綻パターン）');
{
  const version = 3, ecc = 3;                 // 中密度・ECC 高
  const data = mkData(360, 5050);

  // level1: 回転 0.8° + 軽ぼかし r=1
  const level1 = (img) => R.blur(R.rotate(img, 0.8), 1);
  const r1 = roundtrip(version, ecc, data, level1, true);
  ok(r1.match, `level1（回転0.8°+軽ぼかし）を復元 (corr=${r1.corrected})`);

  // level2: level1 + 中央たわみ k=0.010
  const level2 = (img) => R.blur(R.rotate(R.warpCenterBulge(img, 0.010), 0.8), 1);
  const r2 = roundtrip(version, ecc, data, level2, true);
  ok(r2.match, `level2（level1+中央たわみ k=0.010）を復元 (corr=${r2.corrected})`);

  // level3: たわみ + 回転 1.3° + 強めぼかし r=2 + 全面ドットゲイン（白→115<128）
  //  ＝実機で失敗が判明した複合。適応しきい + アライメントメッシュで復元する。
  const level3 = (img) => R.dotGain(
    R.blur(R.rotate(R.warpCenterBulge(img, 0.010), 1.3), 2),
    { growPx: 1, blackFloor: 35, whiteCeil: 115, bias: -8 });
  const r3 = roundtrip(version, ecc, data, level3, true);
  ok(r3.match, `level3（たわみ+回転1.3°+強めぼかし+ドットゲイン）を復元 (corr=${r3.corrected})`);

  // level3 の複数版での安定性（単一版の偶然ではないことを担保）。
  let l3All = true;
  for (const v of [1, 2, 4]) {
    const d = mkData(180, v * 31 + 3);
    const l3 = (img) => R.dotGain(
      R.blur(R.rotate(R.warpCenterBulge(img, 0.010), 1.3), 2),
      { growPx: 1, blackFloor: 35, whiteCeil: 115, bias: -8 });
    const r = roundtrip(v, 3, d, l3, true);
    if (!r.match) { l3All = false; console.log(`  MISS level3 ver${v}: ok=${r.ok} corr=${r.corrected}`); }
  }
  ok(l3All, `level3 複合劣化を複数版（ver1/2/4）でも復元（複合閾値の一般性）`);
}

// ==================================================================
//  §10-6  本物の canvas JPEG エンコードを経由した複合劣化（実機忠実化）
// ------------------------------------------------------------------
//  【実機フィードバック】これまでの複合劣化（§10-2/§10-5）は JPEG を
//  「ぼかし＋加算ノイズ」で *近似* していた。しかし実機（decoder.html は
//  canvas を JPEG 保存・再読込したり、スキャナ/カメラが JPEG を吐く）で効く
//  本当の劣化は **8×8 ブロック DCT 量子化ノイズ（ブロック段差・リンギング）**
//  であり、近似ぼかしはこれを再現しないため、とくに 0.7mm 級高密度版
//  （ver14, セル ≒ JPEG ブロックと同程度）で実機の厳しさを過小評価していた
//  （机上では通るが実機で RS 訂正超過）。
//
//  対策として本節は **実際の canvas 相当 JPEG エンコード（quality 指定）を
//  経由した画像**でラウンドトリップする（jpeg-js があれば本物のベースライン
//  JPEG 往復。無ければ自前 DCT-量子化コーデックへフォールバック）。さらに
//  「スキャナ解像度ミスマッチでセル境界が JPEG 8×8 格子から分数ずれする」
//  効果を resample で加え、ブロック段差がセル内に食い込む最悪ケースを作る。
// ==================================================================
// 解像度ミスマッチ: 一旦 s 倍へ縮小再サンプル（セル境界を JPEG 格子から分数ずらす）。
function resample(img, s) {
  const W = img.width, H = img.height;
  const nW = Math.max(8, Math.round(W * s)), nH = Math.max(8, Math.round(H * s));
  const out = { data: new Uint8ClampedArray(nW * nH * 4), width: nW, height: nH };
  for (let y = 0; y < nH; y++) {
    const fy = (y + 0.5) * H / nH - 0.5;
    for (let x = 0; x < nW; x++) {
      const fx = (x + 0.5) * W / nW - 0.5;
      const v = R.sampleGray(img, fx, fy);
      const p = (y * nW + x) * 4; out.data[p] = out.data[p+1] = out.data[p+2] = v; out.data[p+3] = 255;
    }
  }
  return out;
}
section(`§10-6 本物の canvas JPEG（${JPEG.hasRealJpeg() ? 'jpeg-js=canvas相当' : 'DCT近似'}）越しの複合劣化`);
{
  // level3（たわみ+回転+強ぼかし+ドットゲイン）に、分数リサンプル＋本物 JPEG q35 を重畳。
  const degrade = (img) => {
    let g = R.warpCenterBulge(img, 0.010);
    g = R.rotate(g, 1.3);
    g = R.blur(g, 2);
    g = R.dotGain(g, { growPx: 1, blackFloor: 35, whiteCeil: 115, bias: -8 });
    g = resample(g, 0.93);                 // JPEG 8×8 格子をセル境界から分数ずらす
    g = JPEG.roundtrip(g, 35);             // ★ 本物の canvas 相当 JPEG エンコード→デコード
    return g;
  };
  // 低〜高密度まで全帯域で、実機忠実な劣化を復元できること。
  let all = true;
  for (const v of [1, 2, 3, 4, 8, 14]) {
    const prof = CF.getProfile(v);
    const net = CF.netCapacity(prof, 3);
    const data = mkData(Math.min(net, 300), v * 7 + 1);
    const r = roundtrip(v, 3, data, degrade, 'auto');
    if (!r.match) { all = false; console.log(`  MISS ver${v}: ok=${r.ok} corr=${r.corrected}`); }
    else console.log(`  ver${v}: OK (corr=${r.corrected})`);
  }
  ok(all, 'level3 + 分数リサンプル + 本物JPEG q35 を全帯域(ver1〜14)で復元（実機忠実化）');
}

// ==================================================================
//  §10-7  ドットゲイン単独 × 高密度満載 × 本物 JPEG（RS 訂正超過の実機再現）
// ------------------------------------------------------------------
//  【実機フィードバック】dotgain_only（全体をにじませ）で MAGIC は一致するが
//  RS 訂正が失敗（ver14 高密度・満載ページで訂正能力超過）という報告があった。
//  原因は、机上の近似ノイズが本物の canvas JPEG ブロックノイズより緩く、実機の
//  厳しさを過小評価していたこと。本節は **正味容量を満載した ver14** を
//  ドットゲイン＋分数リサンプル＋本物 JPEG（複数 quality）に通し、RS が能力内で
//  訂正しきって完全復元できることを検証する（＝実機の RS 超過を机上で捕捉できる
//  ようになったことの回帰固定）。
// ==================================================================
section('§10-7 ドットゲイン単独 × ver14 満載 × 本物 JPEG（RS 訂正超過の再現・回帰）');
{
  const prof = CF.getProfile(14);
  const net = CF.netCapacity(prof, 3);      // ECC 高で満載（≈7KB）
  const data = mkData(net, 7);
  let all = true;
  for (const q of [40, 30, 25]) {
    const degrade = (img) => {
      let g = R.dotGain(img, { growPx: 1, blackFloor: 30, whiteCeil: 110 }); // 全面にじみ
      g = resample(g, 0.93);
      g = JPEG.roundtrip(g, q);             // ★ 本物 JPEG（quality 指定）
      return g;
    };
    const r = roundtrip(14, 3, data, degrade, 'auto');
    console.log(`  ver14 満載(${net}B) dotgain+resample+JPEG q${q}: match=${r.match?1:0} corr=${r.corrected}`);
    if (!r.match) all = false;
  }
  ok(all, `ver14 満載(${net}B) をドットゲイン+分数リサンプル+本物JPEG(q40/30/25)で完全復元（RS 能力内）`);
}

// ==================================================================
//  まとめ
// ==================================================================
console.log(`\n==== 結果: ${fail === 0 ? 'ALL PASS' : (fail + ' FAIL')} (pass=${pass}, fail=${fail}) ====`);
if (fail !== 0) process.exit(1);
