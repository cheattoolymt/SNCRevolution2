/*
 * SNCR2 後方互換セルフテスト（Node 実行用）
 * ------------------------------------------------------------------
 * 容量拡張（ver15〜20 追加・オーバーヘッド削減・ECC 8 段階・§D 複数ページ
 * 改善）を入れたあとも、**既に印刷済みの ver1〜14 のカードが読めること** を
 * 保証するための回帰テスト。
 *
 * ── なぜこのテストが必要か ──────────────────────────────────────
 * 容量アップのために触った箇所は、どれも「既存カードのビット配置を変えうる」
 * 危険な場所である:
 *   (1) qr-align.js のアライメント密度  … 変えるとパターン位置＝機能モジュール
 *       の位置が動き、データセルの並びが総崩れになる。
 *   (2) qr-version.js のオーバーヘッドモデル … 容量が変わると blockPlan の
 *       ブロック割りが変わり、RS 符号語の並びが変わる。
 *   (3) qr-header.js の byte[7] 転用 … ヘッダの意味が変わると版・ECC の
 *       解釈がずれる。
 * これらを「新版だけに効かせ、既存版には一切影響させない」設計にしたことを、
 * **ゴールデン値（期待ハッシュ）** で機械的に固定する。
 *
 * ── 何を固定するか ──────────────────────────────────────────────
 *   ver1〜14 × ECC 0〜3（＝拡張前に存在した全組み合わせ）について
 *     ・cols × rows（グリッド寸法）
 *     ・正味容量 net / グロス容量 gross
 *     ・encodePage が出力する modules（マスク済み全モジュール）の SHA256
 *     ・物理ヘッダ 18byte の SHA256
 *   を、拡張前のコミット（f2546dd）で実測した値と照合する。
 *
 *   ゴールデン値は「拡張前のコードを実際に動かして得た出力」であり、
 *   このテストが通ることは「拡張前後でカードがビット単位に同一」を意味する。
 *   一致すれば当然、旧カードは新デコーダでそのまま読める。
 *
 * 実行: node test/compat-selftest.js
 * ================================================================== */
'use strict';

const crypto = require('crypto');
const CF = require('../js/card-format.js');
const Ver = require('../js/qr-version.js');
const Align = require('../js/qr-align.js');
const Header = require('../js/qr-header.js');

let failures = 0;
function check(name, cond) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

// テストデータは design/e2e と同じ決定的 PRNG（線形合同法）。
function mkData(len, seed) {
  const d = new Uint8Array(len);
  let s = (seed || 1) >>> 0;
  for (let i = 0; i < len; i++) { s = (s * 1103515245 + 12345) >>> 0; d[i] = (s >>> 16) & 0xff; }
  return d;
}
const sha = (buf) => crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex').slice(0, 16);

// ==================================================================
//  ゴールデン値（拡張前コミット f2546dd の実測出力）
// ------------------------------------------------------------------
//  形式: 'ver,ecc' -> [cols, rows, net, gross, modulesHash, headerHash]
//  modulesHash / headerHash は SHA256 の先頭 16 文字（16進）。
//
//  ★ この表は「手で書いた期待値」ではなく、拡張前コミットのコードを実行して
//    採取した実測値である。したがって FAIL は即ち「既存カードのビット配置を
//    変えてしまった」ことを意味し、後方互換の破壊を検出したことになる。
//    設計変更が意図的で正当な場合のみ、次の手順で再採取する:
//      git archive <拡張前コミット> | tar -x -C /tmp/old
//      # 本テストと同じ mkData(seed=v*10+e) / len=min(net,400) で
//      # cols,rows,net,gross,sha(modules),sha(header) を出力して貼り替える
// ==================================================================
const GOLDEN = {
  '1,0': [60, 86, 549, 549, '5f69c15e47aa55eb', 'c92d06274e1a2a9d'],
  '1,1': [60, 86, 471, 549, 'cd7b91f6c0936a1f', '932495e789d9734a'],
  '1,2': [60, 86, 393, 549, 'b322ab4363a3f897', '48aaf8df3089a349'],
  '1,3': [60, 86, 315, 549, '3b04530a49dea525', 'f617e9f2d878b401'],
  '2,0': [77, 111, 941, 941, '77e79e16177da666', '8e18d04358955297'],
  '2,1': [77, 111, 837, 941, 'dad8d3d80f9c0fb0', '35ad858b6f2e9f42'],
  '2,2': [77, 111, 733, 941, 'b37f3d76ac9a9c85', '498f2c6dfd4fb895'],
  '2,3': [77, 111, 629, 941, 'e85c5192bc50e76a', 'd23d653ca586eb1c'],
  '3,0': [90, 129, 1287, 1287, 'e56cb665cd476cef', '90f89d41fe2565d5'],
  '3,1': [90, 129, 1131, 1287, '442a68a2e4842b0b', 'ddf67d8d1a9b51d4'],
  '3,2': [90, 129, 975, 1287, '277efbcb73d200d7', '2c31ce78de25180e'],
  '3,3': [90, 129, 819, 1287, '7eddcddae884bd31', '7756fb8fd08089e9'],
  '4,0': [108, 155, 1883, 1883, '12d5eddc806dd7a9', '76c0375e923f8d0b'],
  '4,1': [108, 155, 1675, 1883, 'ffc8eee70cb58e56', '749d88faecd68e09'],
  '4,2': [108, 155, 1467, 1883, 'e4e009081eb4dd81', '3c86b995b83ed516'],
  '4,3': [108, 155, 1259, 1883, 'c103e9cb5155d58b', '6bcd6069397e2072'],
  '5,0': [120, 173, 2364, 2364, '740f92b9df8efbe8', '21ced0349d4af0e0'],
  '5,1': [120, 173, 2104, 2364, '0be1188764c2fb01', '2234b97dc55c0d48'],
  '5,2': [120, 173, 1844, 2364, 'a4ad2045f170da80', 'c6895264fc8995a2'],
  '5,3': [120, 173, 1584, 2364, '8ecc8679c22098f7', '07f453ce8184bb85'],
  '6,0': [132, 190, 2851, 2851, '3b98eb4b798261b6', 'f06adc63bcbea087'],
  '6,1': [132, 190, 2539, 2851, '4bd980bcb6b66ac6', 'b16022714bcabff8'],
  '6,2': [132, 190, 2227, 2851, '89aedc6b62eff9c3', '5ae0296b407e54f7'],
  '6,3': [132, 190, 1915, 2851, '62c63d0ca419d20b', 'acace7f93f73b082'],
  '7,0': [145, 209, 3445, 3445, 'cc2cadc79798bf57', '905d65fe5a29a9a0'],
  '7,1': [145, 209, 3081, 3445, '82defab2d3228668', '5daf259042820782'],
  '7,2': [145, 209, 2717, 3445, '8ac79c9c9d0e256d', 'b0be6809ac6e09d0'],
  '7,3': [145, 209, 2353, 3445, '581130d22195c92d', '76097fb47378f8e2'],
  '8,0': [160, 230, 4228, 4228, '11a5f4fa5f597dc1', '2bd2491887cc4c21'],
  '8,1': [160, 230, 3786, 4228, '25091288b575b7e5', '440256df18924dc1'],
  '8,2': [160, 230, 3344, 4228, '231654d6fa38a236', '504914619f09fd77'],
  '8,3': [160, 230, 2902, 4228, 'e8fc0afc2f77d7d7', '17f30223c63beb38'],
  '9,0': [175, 252, 5072, 5072, '59ef5e2f69fce7cf', '7e19e7d6ddc2fa52'],
  '9,1': [175, 252, 4552, 5072, '260b4ab181ff15fe', 'dd20f778a12a1f0c'],
  '9,2': [175, 252, 4032, 5072, '2b91719c1916dd0d', '4424efac6db53788'],
  '9,3': [175, 252, 3512, 5072, '40a1ac452d3031b0', '761923725e0af538'],
  '10,0': [190, 273, 5968, 5968, 'be8056118682e0a8', '42815094000a7e5c'],
  '10,1': [190, 273, 5344, 5968, '9197e07e6f7df10f', '198e55cc8bd7945e'],
  '10,2': [190, 273, 4720, 5968, 'bb817ebc3c345151', '74845e83eb82d63c'],
  '10,3': [190, 273, 4096, 5968, 'c9b74d944827e330', 'b4044aea09058c65'],
  '11,0': [205, 295, 6996, 6996, 'f48009a127e56ad7', 'ec32f7ede40d743a'],
  '11,1': [205, 295, 6268, 6996, '36e01c4305c8fc07', 'cf08ea3ea3e7dc2c'],
  '11,2': [205, 295, 5540, 6996, 'dd3a88fbc2de277a', 'f815d34eac4c722a'],
  '11,3': [205, 295, 4812, 6996, 'de2e414bca516d13', 'bf6dc8a987ff69f1'],
  '12,0': [220, 317, 8116, 8116, 'e0706c752cdd8d9e', '72cd5a4b886e26ec'],
  '12,1': [220, 317, 7284, 8116, '9033a67e35d22117', 'befe8d808091ecea'],
  '12,2': [220, 317, 6452, 8116, '26410905adb2e0e7', 'cb20998ca2757ef6'],
  '12,3': [220, 317, 5620, 8116, '55a34dc5ded55fc2', '014c7318972c82d8'],
  '13,0': [235, 338, 9269, 9269, '4fc13ce402e48308', '186fe6e908e5a8ad'],
  '13,1': [235, 338, 8307, 9269, '931038f9ac0a5989', '6f1ae77e46881ef0'],
  '13,2': [235, 338, 7345, 9269, '570543442791db5a', '55e399d7df98db1b'],
  '13,3': [235, 338, 6383, 9269, '133ba9af5a6887c3', 'd31947248a3bc266'],
  '14,0': [250, 360, 10466, 10466, '302a70f4954c4754', '49d5df033c402f7d'],
  '14,1': [250, 360, 9374, 10466, '21858301829226ad', '220f5366777c8ee6'],
  '14,2': [250, 360, 8282, 10466, '1ab872c68f8fa5f9', 'dae313d3e362ebc9'],
  '14,3': [250, 360, 7190, 10466, '22090d495be904d6', '0af400e3a6d5d8a3'],
};

// ==================================================================
//  1) ゴールデン値との照合（ver1〜14 × ECC 0〜3 の全 56 通り）
// ------------------------------------------------------------------
//  拡張前に存在した全組み合わせ（14 版 × 4 ECC = 56 通り）を厳密照合する。
//  GOLDEN の値は拡張前コミット f2546dd のコードを実際に走らせて採取した
//  実測値であり、一致は「拡張前後で生成カードがビット単位に同一」を意味する。
// ==================================================================
console.log('==== 後方互換: 生成カードのゴールデン値照合（拡張前 f2546dd と同一） ====');
{
  let allMatch = true, n = 0;
  for (const key of Object.keys(GOLDEN)) {
    const [v, e] = key.split(',').map(Number);
    const g = GOLDEN[key];
    const prof = CF.getProfile(v);
    const net = CF.netCapacity(prof, e);
    const data = mkData(Math.min(net, 400), v * 10 + e);
    const enc = CF.encodePage(data, { version: v, eccLevel: e });
    const got = [prof.COLS, prof.ROWS, net, prof.grossBytes, sha(enc.modules), sha(enc.header)];
    n++;
    const same = got.every((x, i) => x === g[i]);
    if (!same) {
      allMatch = false;
      console.log(`  DIFF ver${v}/ecc${e}`);
      console.log(`    期待: ${g.join(', ')}`);
      console.log(`    実測: ${got.join(', ')}`);
    }
  }
  check(`ver1〜14 × ECC0〜3 が拡張前とビット単位一致 (${n} 通り)`, allMatch);
}

// ==================================================================
//  2) 構造不変条件（ver1〜14 の全域）
// ------------------------------------------------------------------
//  ハッシュ表を全 56 通り持たなくても、「既存カードのビット配置を動かす
//  要因」を個別に固定すれば同じ保証が得られる。
// ==================================================================
console.log('\n==== 後方互換: 標準ティア（ver1〜14）の構造不変条件 ====');

// (a) グリッド寸法の凍結。cols/rows が動けば全てが崩れる。
{
  const EXPECT = [
    [60, 86], [77, 111], [90, 129], [108, 155], [120, 173], [132, 190], [145, 209],
    [160, 230], [175, 252], [190, 273], [205, 295], [220, 317], [235, 338], [250, 360],
  ];
  let ok = true;
  for (let i = 0; i < EXPECT.length; i++) {
    const p = CF.getProfile(i + 1);
    if (p.COLS !== EXPECT[i][0] || p.ROWS !== EXPECT[i][1]) {
      ok = false;
      console.log(`  DIFF ver${i + 1}: ${p.COLS}x${p.ROWS} (期待 ${EXPECT[i][0]}x${EXPECT[i][1]})`);
    }
  }
  check('ver1〜14 の cols×rows が凍結されている', ok);
}

// (b) アライメント密度・個数の凍結。これが動くと機能モジュール配置が動く。
{
  const EXPECT_ALN = [12, 21, 32, 45, 51, 67, 85, 93, 114, 137, 151, 162, 189, 218];
  let ok = true;
  for (let i = 0; i < 14; i++) {
    const v = Ver.VERSIONS[i];
    if (v.alignDensity !== Align.DEFAULT_DENSITY || v.alignCount !== EXPECT_ALN[i]) {
      ok = false;
      console.log(`  DIFF ver${i + 1}: density=${v.alignDensity} count=${v.alignCount} ` +
                  `(期待 density=${Align.DEFAULT_DENSITY} count=${EXPECT_ALN[i]})`);
    }
  }
  check('ver1〜14 のアライメント密度(20)と個数が凍結されている', ok);
}

// (c) 実測データ容量（grossBytes）の凍結。blockPlan の割り方が変わらない証拠。
{
  const EXPECT_GROSS = [549, 941, 1287, 1883, 2364, 2851, 3445, 4228, 5072, 5968,
                        6996, 8116, 9269, 10466];
  let ok = true;
  for (let i = 0; i < 14; i++) {
    const p = CF.getProfile(i + 1);
    if (p.grossBytes !== EXPECT_GROSS[i]) {
      ok = false;
      console.log(`  DIFF ver${i + 1}: gross=${p.grossBytes} (期待 ${EXPECT_GROSS[i]})`);
    }
  }
  check('ver1〜14 の実測グロス容量が凍結されている', ok);
}

// ==================================================================
//  3) ヘッダの後方互換（byte[7] の flags 転用が旧カードを壊さない）
// ------------------------------------------------------------------
//  §E で byte[7]（旧 totalFileLen BE32 の最上位バイト）を flags へ転用した。
//  安全の根拠は「本形式の物理上限は 255 ページ × 約 20KB ≒ 5MiB なので、
//  旧カードの byte[7] は必ず 0x00 である」こと。よって:
//    ・旧仕様のヘッダ（byte[7]=0）は flags 無し＝従来と同じ解釈になる
//    ・従来 ECC（0..3）を使う限り、新コードも byte[7]=0 を書く（＝バイト一致）
//  を検証する。
// ==================================================================
console.log('\n==== 後方互換: ヘッダ byte[7] の flags 転用が旧カードを壊さない ====');

// (a) 従来 ECC（0..3）・単票なら byte[7]=0 ＝ 旧仕様とバイト単位で同一。
{
  let ok = true;
  for (let e = 0; e <= 3; e++) {
    for (const v of [1, 7, 14]) {
      const h = Header.buildLogical({
        version: v, eccLevel: e, pageIndex: 0, totalPages: 1,
        payloadLen: 1234, totalFileLen: 1234,
      });
      if (h[7] !== 0) { ok = false; console.log(`  DIFF ver${v}/ecc${e}: byte[7]=${h[7]} (期待 0)`); }
    }
  }
  check('従来 ECC(0〜3)・単票のヘッダは byte[7]=0（旧仕様とバイト一致）', ok);
}

// (b) 旧仕様で作られたヘッダ（byte[7]=0）を新コードが正しく解釈する。
//     旧 totalFileLen は BE32 だったが、上位バイトが 0 の範囲（<16MiB）では
//     新 BE24 解釈と完全に一致する。
{
  const RS = require('../js/qr-rs.js');
  let ok = true;
  for (const tfl of [0, 1, 1234, 65535, 1234567, 0xFFFFFF]) {
    // 旧仕様のバイト列を手で組む（byte[7..10] = totalFileLen BE32）。
    const h = new Uint8Array(12);
    h[0] = 0x4e; h[1] = 0x43;
    h[2] = (9 & 0x3f) | ((2 & 3) << 6);        // ver9 / ECC 中(2)
    h[3] = 3; h[4] = 7;                         // page 3/7
    h[5] = (999 >> 8) & 0xff; h[6] = 999 & 0xff;
    h[7] = (tfl >>> 24) & 0xff;                 // 旧 BE32 の最上位（<16MiB なら 0）
    h[8] = (tfl >>> 16) & 0xff; h[9] = (tfl >>> 8) & 0xff; h[10] = tfl & 0xff;
    let x = 0; for (let i = 0; i < 11; i++) x ^= h[i];
    h[11] = x;
    const info = Header.parseHeader(RS.encode(h, Header.HEADER_NSYM));
    const good = info && info.ok && info.version === 9 && info.eccLevel === 2 &&
                 info.pageIndex === 3 && info.totalPages === 7 &&
                 info.payloadLen === 999 && info.totalFileLen === tfl &&
                 info.continuation === false;
    if (!good) {
      ok = false;
      console.log(`  DIFF totalFileLen=${tfl}: ` + JSON.stringify(info));
    }
  }
  check('旧仕様ヘッダ（byte[7]=0・BE32）を新コードが同一に解釈する', ok);
}

// (c) ECC を 4..7（新レベル）にしたときだけ byte[7] に bit が立つ。
{
  let ok = true;
  for (let e = 4; e <= 7; e++) {
    const h = Header.buildLogical({ version: 20, eccLevel: e, payloadLen: 1, totalFileLen: 1 });
    if (!(h[7] & Header.FLAG_ECC_BIT2)) { ok = false; console.log(`  DIFF ecc${e}: byte[7]=${h[7]}`); }
  }
  check('新 ECC(4〜7) のときだけ byte[7] に ECC bit2 が立つ', ok);
}

// ==================================================================
//  4) 旧カードのラウンドトリップ（実際に読めることの最終確認）
// ------------------------------------------------------------------
//  上の (1)〜(3) は「生成物が同一」を示す。ここでは実際に
//  encodePage → decodePageModules を通し、ver1〜14 が読めることを確認する。
// ==================================================================
console.log('\n==== 後方互換: ver1〜14 × ECC0〜3 のラウンドトリップ ====');
{
  let ok = true, n = 0;
  for (let v = 1; v <= 14; v++) {
    const prof = CF.getProfile(v);
    for (let e = 0; e <= 3; e++) {
      const net = CF.netCapacity(prof, e);
      const data = mkData(Math.min(net, 500), v * 100 + e);
      const enc = CF.encodePage(data, { version: v, eccLevel: e });
      const r = CF.decodePageModules(enc.modules, prof.COLS, prof.ROWS);
      n++;
      let good = r.ok && r.meta && r.meta.version === v && r.meta.eccLevel === e &&
                 r.data && r.data.length >= data.length;
      if (good) for (let i = 0; i < data.length; i++) if (r.data[i] !== data[i]) { good = false; break; }
      if (!good) { ok = false; console.log(`  MISS ver${v}/ecc${e}: ok=${r.ok}`); }
    }
  }
  check(`ver1〜14 × ECC0〜3 が復号できる (${n} 通り)`, ok);
}

console.log(`\n==== 結果: ${failures === 0 ? 'ALL PASS' : failures + ' FAIL'} ====`);
process.exit(failures === 0 ? 0 : 1);
