/*
 * SNCR2 §0〜§4 設計セルフテスト（Node 実行用）
 * ------------------------------------------------------------------
 * 実装指示書の設計制約が守れているかを検証し、容量表を出力する。
 *   - §2  : 箱定数 2152x3096・0.7mm 下限
 *   - §3  : 長方形アライメント座標（軸独立・両端保証・四隅衝突除外）
 *   - §4  : cols x rows 表・オーバーヘッド・blockPlan・ECC・ヘッダ別保護
 * 使い方: node test/design-selftest.js
 * ================================================================== */
'use strict';

const Geo = require('../js/qr-geometry.js');
const Align = require('../js/qr-align.js');
const Ver = require('../js/qr-version.js');

let failures = 0;
function check(name, cond) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

console.log('==== §2 ジオメトリ定数 ====');
check('PAGE 2480x3508', Geo.PAGE_W === 2480 && Geo.PAGE_H === 3508);
check('GRID_X=GRID_Y=164', Geo.GRID_X === 164 && Geo.GRID_Y === 164);
check('GRID_W=2152', Geo.GRID_W === 2152);
check('GRID_H=3096', Geo.GRID_H === 3096);
check('GRID_ASPECT≈1.4387', Math.abs(Geo.GRID_ASPECT - 1.4387) < 0.001);
const fc = Geo.finderCenters();
check('finderCenters 4隅そろう', fc.tl && fc.tr && fc.br && fc.bl);

console.log('\n==== §3 アライメント座標 ====');
(function () {
  // 正方形でも長方形でも軸独立で計算でき、両端・昇順が保証されること。
  const cases = [[100, 144], [239, 344], [60, 86], [250, 360]];
  for (const [c, r] of cases) {
    const { xs, ys } = Align.alignmentPositions(c, r);
    const asc = a => a.every((v, i) => i === 0 || v > a[i - 1]);
    check(`xs 昇順 (${c}x${r})`, asc(xs));
    check(`ys 昇順 (${c}x${r})`, asc(ys));
    check(`xs 両端=6..${c - 7}`, xs[0] === 6 && xs[xs.length - 1] === c - 7);
    check(`ys 両端=6..${r - 7}`, ys[0] === 6 && ys[ys.length - 1] === r - 7);
    check(`xs≠ys の可能性(長方形は独立)`, JSON.stringify(xs) !== JSON.stringify(ys) || c === r);
  }
  // 四隅衝突 3 点が除外されていること（直積 - 3 = centers 上限）。
  const { xs, ys } = Align.alignmentPositions(120, 173);
  const centers = Align.alignmentCenters(120, 173);
  check('四隅衝突3点を除外', centers.length === xs.length * ys.length - 3);
  // 密度が「四隅のみ(=旧cardloader)」より確実に密（>3 本相当）。
  check('旧より密(centers>0)', centers.length > 0);
})();

console.log('\n==== §4 バージョン表 / 容量 ====');
check('ECC nsym: none=0', Ver.eccNsym(0) === 0);
check('ECC nsym: low≈26 (偶数)', Ver.eccNsym(1) % 2 === 0 && Ver.eccNsym(1) >= 24 && Ver.eccNsym(1) <= 28);
check('ECC nsym: med≈52 (偶数)', Ver.eccNsym(2) % 2 === 0 && Ver.eccNsym(2) >= 50 && Ver.eccNsym(2) <= 52);
check('ECC nsym: high≈76 (偶数)', Ver.eccNsym(3) % 2 === 0 && Ver.eccNsym(3) >= 76 && Ver.eccNsym(3) <= 78);

// blockPlan: 端数を捨てない（合計符号語 = グロス）
(function () {
  for (const g of [200, 500, 1000, 5000, 12000]) {
    for (const e of [0, 1, 2, 3]) {
      const plan = Ver.blockPlan(g, e);
      const sumCw = plan.reduce((s, b) => s + b.dataLen + b.nsym, 0);
      check(`blockPlan 端数不捨 gross=${g} ecc=${e} (sumCw=${sumCw})`, sumCw === g);
      // 255B 上限は RS 適用時(nsym>0)のみの制約。ecc=0 は RS 無効の
      // 生ビットダンプ（旧 cardloader 同様 1 ブロック）なので対象外。
      if (Ver.eccNsym(e) > 0) {
        check(`blockPlan cw<=255 gross=${g} ecc=${e}`,
          plan.every(b => b.dataLen + b.nsym <= 255));
      }
    }
  }
})();

// ヘッダ別保護: HEADER_LEN=18 が payloadGross から差し引かれている
check('ヘッダ 12+6=18', Ver.HEADER_LEN === 18);

console.log('\n---- 容量表（KiB=1024 基準）----');
console.log(
  'ver'.padStart(3), 'tier'.padStart(4),
  'cols'.padStart(4), 'rows'.padStart(4),
  'cell(mm)'.padStart(9),
  'floor'.padStart(6),
  'dpi'.padStart(4),
  'ovh%'.padStart(5),
  'aln'.padStart(4), 'd'.padStart(3),
  'gross'.padStart(6),
  'none'.padStart(6), 'vlow'.padStart(6), 'low'.padStart(6),
  'med'.padStart(6), 'high'.padStart(6), 'max'.padStart(6)
);
for (const v of Ver.VERSIONS) {
  console.log(
    String(v.version).padStart(3), v.tier.padStart(4),
    String(v.cols).padStart(4), String(v.rows).padStart(4),
    (v.cellWmm.toFixed(2) + 'x' + v.cellHmm.toFixed(2)).padStart(9),
    (v.meetsMinCell ? '0.7mm' : (v.meetsMinCellExt ? '0.5mm' : 'NG')).padStart(6),
    String(v.requiredDpi).padStart(4),
    (v.overheadPct * 100).toFixed(1).padStart(5),
    String(v.alignCount).padStart(4), String(v.alignDensity).padStart(3),
    String(v.payloadGrossBytes).padStart(6),
    String(v.net.none).padStart(6), String(v.net.vlow).padStart(6),
    String(v.net.low).padStart(6), String(v.net.med).padStart(6),
    String(v.net.high).padStart(6), String(v.net.max).padStart(6)
  );
  // 標準ティア（ver1〜14）は §2-1 の 0.7mm 下限を満たすこと。
  // 拡張ティア（ver15〜）は 0.50mm 下限（600dpi 前提）を満たすこと。
  if (v.extended) {
    check(`ver${v.version} 0.50mm下限(拡張ティア)`, v.meetsMinCellExt);
  } else {
    check(`ver${v.version} 0.7mm下限`, v.meetsMinCell);
  }
}

// ── 標準ティアの凍結（後方互換）─────────────────────────────────
//  既存 ver1〜14 は cols/rows・アライメント密度・容量を **変えてはならない**
//  （既に印刷済みのカードが読めなくなる）。ここで数値を直接ピン留めする。
check('標準ティアは 14 版で凍結', Ver.STD_VERSION_COUNT === 14);
check('標準ティア cols 凍結',
  JSON.stringify(Ver.VERSION_COLS_STD) ===
  JSON.stringify([60, 77, 90, 108, 120, 132, 145, 160, 175, 190, 205, 220, 235, 250]));
(function () {
  // 標準ティアのアライメント密度は従来の 20（セル）で固定。
  let allLegacy = true;
  for (const v of Ver.VERSIONS) {
    if (v.extended) continue;
    if (v.alignDensity !== Align.DEFAULT_DENSITY) allLegacy = false;
  }
  check('標準ティアのアライメント密度は従来値(20)で不変', allLegacy);
  // ver14 のアライメント個数（従来 218 個）が変わっていないこと。
  const v14 = Ver.VERSIONS[13];
  check('ver14 アライメント個数=218（レイアウト凍結）', v14.alignCount === 218);
})();

// §2-1「A4 1 枚で 10KB」: 標準ティア最大版（ver14）のグロスが 10KiB 以上。
const std14 = Ver.VERSIONS[Ver.STD_VERSION_COUNT - 1];
check('ver14 グロス >= 10240B (10KiB)', std14.payloadGrossBytes + Ver.HEADER_LEN >= 10240);
check('ver14 ECC高 net > 5KiB', std14.net.high > 5 * 1024);

// ── 容量目標（今回の拡張の主目的）: 15〜20KB ───────────────────
const top = Ver.VERSIONS[Ver.VERSIONS.length - 1];
check(`最大版 ver${top.version} グロス >= 15KiB`, top.payloadGrossBytes >= 15 * 1024);
check(`最大版 ver${top.version} グロス >= 20KiB (=20480B, 目標上限)`,
  top.payloadGrossBytes >= 20 * 1024);
// ECC を付けても 15KB 級が残ること（＝「読めないことを避けつつ容量アップ」）。
check(`最大版 ECC極低(5%) net >= 15KiB`, top.net.vlow >= 15 * 1024);
check(`最大版 ECC低(10%) net >= 15KiB`, top.net.low >= 15 * 1024);
check(`最大版 ECC中(20%) net >= 15KiB`, top.net.med >= 15 * 1024);
// ECC 高(30%) でも旧最大版(ver14 ECC なし=10471B)を上回ること。
check(`最大版 ECC高(30%) net > ver14 の ECC なし容量`, top.net.high > std14.net.none);

// ── §C オーバーヘッド削減の効果 ──────────────────────────────
//  拡張ティアは「補間誤差一定」密度でアライメント個数を抑えるので、
//  高密度なのにオーバーヘッド率が標準ティア最大版より下がっているはず。
check(`拡張ティア最大版の ovh% < ver14 の ovh%`, top.overheadPct < std14.overheadPct);
check(`拡張ティア最大版の ovh% < 5%`, top.overheadPct < 0.05);

// ── §E ECC 率の細分化 ────────────────────────────────────────
check('ECC は 8 段階', Object.keys(Ver.ECC_LEVELS).length === 8);
check('ECC nsym: vlow≈5% (偶数)',
  Ver.eccNsym(4) % 2 === 0 && Ver.eccNsym(4) >= 12 && Ver.eccNsym(4) <= 14);
check('ECC nsym: max≈40% (偶数)',
  Ver.eccNsym(7) % 2 === 0 && Ver.eccNsym(7) >= 100 && Ver.eccNsym(7) <= 104);
(function () {
  // 率が単調なら nsym も単調（＝レベル指定が直感どおり効く）。
  const sorted = Ver.eccLevelsByRatio();
  let mono = true;
  for (let i = 1; i < sorted.length; i++) {
    if (Ver.eccNsym(sorted[i].level) < Ver.eccNsym(sorted[i - 1].level)) mono = false;
  }
  check('ECC: 率の昇順に nsym も単調増加', mono);
  // 「なし」と「低(10%)」の間に極低(5%)が入ったこと（指示の §E そのもの）。
  const keys = sorted.map(s => s.key);
  check('ECC: none と low の間に vlow(5%) がある',
    keys.indexOf('vlow') === keys.indexOf('none') + 1 &&
    keys.indexOf('low') === keys.indexOf('vlow') + 1);
})();

// バージョン選択ヘルパ
const pick = Ver.pickVersionForNet(4096, 2);
check('pickVersionForNet(4KiB,med) 妥当', pick.net.med >= 4096);
const pick15k = Ver.pickVersionForNet(15 * 1024, 1);
check('pickVersionForNet(15KiB,low) が拡張版を返す',
  pick15k.net.low >= 15 * 1024 && pick15k.extended);

console.log(`\n==== 結果: ${failures === 0 ? 'ALL PASS' : failures + ' FAIL'} ====`);
process.exit(failures === 0 ? 0 : 1);
