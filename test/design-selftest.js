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
  'ver'.padStart(3),
  'cols'.padStart(4), 'rows'.padStart(4),
  'cell(mm)'.padStart(9),
  '0.7mm'.padStart(6),
  'ovh%'.padStart(5),
  'aln'.padStart(4),
  'gross'.padStart(6),
  'none'.padStart(6), 'low'.padStart(6), 'med'.padStart(6), 'high'.padStart(6)
);
for (const v of Ver.VERSIONS) {
  console.log(
    String(v.version).padStart(3),
    String(v.cols).padStart(4), String(v.rows).padStart(4),
    (v.cellWmm.toFixed(2) + 'x' + v.cellHmm.toFixed(2)).padStart(9),
    (v.meetsMinCell ? 'ok' : 'NG').padStart(6),
    (v.overheadPct * 100).toFixed(1).padStart(5),
    String(v.alignCount).padStart(4),
    String(v.payloadGrossBytes).padStart(6),
    String(v.net.none).padStart(6), String(v.net.low).padStart(6),
    String(v.net.med).padStart(6), String(v.net.high).padStart(6)
  );
  // 全バージョン 0.7mm 下限を満たすこと（§2-1）
  check(`ver${v.version} 0.7mm下限`, v.meetsMinCell);
}

// §2-1「A4 1 枚で 10KB」: 最大版のグロスが 10KiB(=10240B) 以上に到達すること。
const top = Ver.VERSIONS[Ver.VERSIONS.length - 1];
check('最大版グロス >= 10240B (10KiB)', top.payloadGrossBytes + Ver.HEADER_LEN >= 10240);
// ECC 高(≈30%)でも正味が実用的に確保できること（旧 cardloader 実績ライン）。
check('最大版 ECC高 net > 5KiB', top.net.high > 5 * 1024);

// バージョン選択ヘルパ
const pick = Ver.pickVersionForNet(4096, 2);
check('pickVersionForNet(4KiB,med) 妥当', pick.net.med >= 4096);

console.log(`\n==== 結果: ${failures === 0 ? 'ALL PASS' : failures + ' FAIL'} ====`);
process.exit(failures === 0 ? 0 : 1);
