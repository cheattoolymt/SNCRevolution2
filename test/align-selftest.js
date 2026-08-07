/*
 * SuperNaidesuCardRevolution II (SNCR2) — align-selftest.js
 * ==================================================================
 * 内部アライメントパターン検出の「単体」検証（§3 / §10-8）。
 *
 * 【背景・実機フィードバック】
 *  実機 level3（たわみ + 回転 + 強ぼかし + ドットゲインの複合）で「四隅検出は
 *  正確なのに全版で MAGIC 不一致」という報告があった。四隅ホモグラフィと
 *  内部アライメント検出は別系統なので、四隅が正しくても内部アライメント側が
 *  崩れれば制御点メッシュが歪み、サンプリング格子が全面でずれて MAGIC ごと
 *  破綻し得る。そこで本テストは **四隅ホモグラフィの成否とは独立に**、
 *  「内部アライメント検出そのものの局所化精度」と「その検出がサンプリングに
 *  与える実利」を個別に検証・回帰固定する。
 *
 * 【“真値(ground truth)”の取り方 — ここが肝】
 *  以前の場当たり検証は「劣化後の検出中心」を **クリーン画像上のセル中心** と
 *  比較して誤差 2〜3 セルを観測し、内部検出が壊れていると誤認していた。実際は
 *  たわみ・回転で真のパターン中心が動いているだけで、検出はその動いた先を
 *  正しく捉えていた（＝偽アラーム）。本テストは render-helper の順写像
 *  （bulgePointForward / rotatePointForward）で「劣化後に真のパターン中心が
 *  現れる座標」を厳密に計算し、そこに対して検出誤差を測る。これで初めて内部
 *  検出の精度を正しく評価できる。
 *
 * 検証する仮説:
 *  §A-1  クリーン/単一劣化（ぼかし・ドットゲイン・JPEG）で内部アライメントの
 *        検出率が高く、局所化誤差が小さい（<0.5 セル）。
 *  §A-2  level3 複合劣化でも、真の（劣化後）中心に対して検出が高精度で追従する
 *        （四隅と独立に内部検出が機能している証拠）。§A-2 が崩れると実機 MAGIC
 *        不一致の温床になるため、ここを直接ガードする。
 *  §A-3  内部アライメント検出の実利: level3 で「メッシュ ON」のモジュール反転数が
 *        「メッシュ OFF（四隅ホモグラフィのみ）」より桁違いに小さい（高密度版で
 *        OFF は数万反転 → 復元不能、ON はほぼ 0）。＝内部検出がサンプリングを
 *        救っていることを高密度版で定量的に示す。
 *  §A-4  本物の JPEG（canvas 相当, jpeg-js）を通しても §A-2/§A-3 が保たれる。
 *
 * 実行: node test/align-selftest.js
 * ================================================================== */
'use strict';

const CF = require('../js/card-format.js');
const DC = require('../js/decode-core.js');
const R  = require('../test/render-helper.js');
const JPEG = require('../test/jpeg-codec.js');
const Align = require('../js/qr-align.js');
const GEO = require('../js/geometry.js');

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

// クリーン画像上のアライメント (col,row) 中心（scale=1 では画像座標と一致）。
function cleanCenter(prof, col, row) {
  const rect = CF.cellRect(prof, col, row);
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

// 幾何劣化の「順写像」を合成して、劣化後に真の中心が現れる座標を返す。
//  level3 の適用順（warpCenterBulge → rotate）に合わせて forward も同順で合成。
//  blur/dotGain/JPEG は特徴位置を動かさないので位置には無関係。
function trueDegradedCenter(W, H, geom, col, row, prof) {
  let p = cleanCenter(prof, col, row);
  if (geom.bulgeK) p = R.bulgePointForward(W, H, geom.bulgeK, p.x, p.y);
  if (geom.rotDeg) p = R.rotatePointForward(W, H, geom.rotDeg, p.x, p.y);
  return p;
}

// ------------------------------------------------------------------
//  内部アライメント検出の精度計測（buildControlMesh 経由＝プロダクション経路）。
//   返り値: { detected, total, meanErr, maxErr, farMiss }（誤差は真の劣化後
//   中心に対する“セル”単位）。farMiss は真の中心から 1.5 セル超のずれ＝
//   誤検出（内部検出の崩壊を表す）。
// ------------------------------------------------------------------
function measureInternalAlignment(version, geom, degrade) {
  const prof = CF.getProfile(version);
  const net = CF.netCapacity(prof, 3);
  const data = mkData(Math.min(net, 400), version * 3 + 1);
  const enc = CF.encodePage(data, { version, eccLevel: 3 });
  let img = R.renderPage(enc, 1, { antialias: true });
  const W = img.width, H = img.height;
  if (degrade) img = degrade(img);

  const corners = DC.detectCorners(img, { invert: false });
  if (!corners) return { noCorners: true };

  const centers = Align.alignmentCenters(prof.COLS, prof.ROWS);
  if (centers.length === 0) return { noInternal: true };

  const mesh = DC.buildControlMesh(img, corners, prof.COLS, prof.ROWS, false);
  const { xs, ys } = Align.alignmentPositions(prof.COLS, prof.ROWS);
  const span = mesh.span;
  const cellPx = Math.max(1, (span.w + span.h) / 2);

  // メッシュ内部節点（実検出＝predicted===false）を、対応する真の劣化後中心と比較。
  let detected = 0, total = 0, errSum = 0, errMax = 0, farMiss = 0;
  for (let jj = 1; jj < mesh.vs.length - 1; jj++) {
    for (let ii = 1; ii < mesh.us.length - 1; ii++) {
      const isTL = (ii === 1 && jj === 1);
      const isTR = (ii === mesh.us.length - 2 && jj === 1);
      const isBL = (ii === 1 && jj === mesh.vs.length - 2);
      if (isTL || isTR || isBL) continue;       // 未描画（ファインダと重なる）
      total++;
      const cell = mesh.pts[jj][ii];
      const col = xs[ii - 1], row = ys[jj - 1];
      const tc = trueDegradedCenter(W, H, geom, col, row, prof);
      if (cell.predicted === false && !cell.extrapolated) {
        const err = Math.hypot(cell.x - tc.x, cell.y - tc.y) / cellPx;
        if (err > 1.5) { farMiss++; continue; }
        detected++; errSum += err; if (err > errMax) errMax = err;
      }
    }
  }
  return {
    detected, total, farMiss,
    rate: total ? detected / total : 0,
    meanErr: detected ? errSum / detected : Infinity,
    maxErr: errMax, refined: mesh.refined,
  };
}

// メッシュ ON / OFF のモジュール反転数を測る（サンプリングへの実利）。
function measureFlips(version, degrade) {
  const prof = CF.getProfile(version);
  const net = CF.netCapacity(prof, 3);
  const data = mkData(Math.min(net, 400), version * 3 + 1);
  const enc = CF.encodePage(data, { version, eccLevel: 3 });
  const truth = enc.modules;
  let img = R.renderPage(enc, 1, { antialias: true });
  if (degrade) img = degrade(img);
  const corners = DC.detectCorners(img, { invert: false });
  if (!corners) return { noCorners: true };
  const countFlips = (useAlignment) => {
    const mods = DC.sampleModules(img, corners, prof.COLS, prof.ROWS, { invert: false, useAlignment });
    let f = 0; for (let i = 0; i < truth.length; i++) if (mods[i] !== truth[i]) f++;
    return f;
  };
  return { on: countFlips(true), off: countFlips(false) };
}

// ---- 劣化プリセット（幾何パラメタは trueDegradedCenter と同期させる）--------
const level3Geom = { bulgeK: 0.010, rotDeg: 1.3 };
const level3 = (img) => R.dotGain(
  R.blur(R.rotate(R.warpCenterBulge(img, level3Geom.bulgeK), level3Geom.rotDeg), 2),
  { growPx: 1, blackFloor: 35, whiteCeil: 115, bias: -8 });
const level3jpeg = (img) => JPEG.roundtrip(level3(img), 35);

// ==================================================================
//  §A-1  クリーン/単一劣化での内部アライメント検出精度（真値=劣化後中心）
// ==================================================================
section('§A-1 内部アライメント検出精度: クリーン/単一劣化（真の劣化後中心に対して）');
{
  const noGeom = {};
  const singles = {
    clean:   { geom: noGeom, fn: null },
    blur2:   { geom: noGeom, fn: (img) => R.blur(img, 2) },
    dotgain: { geom: noGeom, fn: (img) => R.dotGain(img, { growPx: 1, blackFloor: 30, whiteCeil: 110 }) },
    jpeg35:  { geom: noGeom, fn: (img) => JPEG.roundtrip(img, 35) },
  };
  let all = true;
  for (const v of [8, 10, 14]) {
    for (const [name, spec] of Object.entries(singles)) {
      const m = measureInternalAlignment(v, spec.geom, spec.fn);
      const line = `  ver${v} ${name}: rate=${(100*m.rate).toFixed(0)}% meanErr=${m.meanErr.toFixed(3)}cell maxErr=${m.maxErr.toFixed(2)} farMiss=${m.farMiss}`;
      console.log(line);
      // 単一劣化では高検出率・低誤差・誤検出ほぼ無しを要求。
      if (!(m.rate >= 0.6 && m.meanErr <= 0.5 && m.farMiss <= 2)) all = false;
    }
  }
  ok(all, '単一劣化（ぼかし/ドットゲイン/本物JPEG）で内部検出率≥60%・平均誤差≤0.5セル・誤検出≤2');
}

// ==================================================================
//  §A-2  level3 複合劣化での内部アライメント検出（真の劣化後中心に追従）
// ==================================================================
section('§A-2 内部アライメント検出精度: level3 複合劣化（真の劣化後中心に対して）');
{
  let all = true;
  for (const v of [8, 10, 14]) {
    const m = measureInternalAlignment(v, level3Geom, level3);
    console.log(`  ver${v} level3: rate=${(100*m.rate).toFixed(0)}% meanErr=${m.meanErr.toFixed(3)}cell maxErr=${m.maxErr.toFixed(2)} farMiss=${m.farMiss}`);
    // 真の劣化後中心に対して: 検出率が十分・平均誤差が小さい・誤検出が少数。
    //  （四隅とは独立に内部検出が機能している＝MAGIC 不一致の温床を潰す。）
    if (!(m.rate >= 0.6 && m.meanErr <= 0.5 && m.farMiss <= Math.ceil(m.total * 0.12))) all = false;
  }
  ok(all, 'level3 でも内部検出が“劣化後の真の中心”に高精度で追従（率≥60%・平均誤差≤0.5セル）');
}

// ==================================================================
//  §A-3  内部アライメント検出の実利: level3 で ON が OFF を桁違いに下回る反転数
// ==================================================================
section('§A-3 内部検出の実利: level3 メッシュ ON vs OFF のモジュール反転数');
{
  let all = true;
  for (const v of [8, 10, 14]) {
    const f = measureFlips(v, level3);
    console.log(`  ver${v} level3: flips ON=${f.on}  OFF=${f.off}`);
    // 高密度版では四隅のみ(OFF)は大量反転して復元不能。内部メッシュ(ON)がほぼ 0 に抑える。
    //  ON は OFF の 1/10 以下、かつ ON は RS が確実に救える少数（<= total*1%）。
    const prof = CF.getProfile(v);
    const budget = Math.ceil(prof.COLS * prof.ROWS * 0.01);
    if (!(f.on * 10 <= f.off && f.on <= budget)) all = false;
  }
  ok(all, 'level3 高密度版で内部メッシュ ON の反転数は OFF の 1/10 以下かつ RS 救済圏内');
}

// ==================================================================
//  §A-4  本物の JPEG（canvas 相当）を通しても内部検出が保たれる
// ==================================================================
section(`§A-4 本物 JPEG（${JPEG.hasRealJpeg() ? 'jpeg-js=canvas相当' : 'DCT近似フォールバック'}）越しの内部検出`);
{
  let all = true;
  for (const v of [8, 10, 14]) {
    const m = measureInternalAlignment(v, level3Geom, level3jpeg);
    console.log(`  ver${v} level3+realJPEG: rate=${(100*m.rate).toFixed(0)}% meanErr=${m.meanErr.toFixed(3)}cell farMiss=${m.farMiss}`);
    if (!(m.rate >= 0.55 && m.meanErr <= 0.55 && m.farMiss <= Math.ceil(m.total * 0.15))) all = false;
  }
  ok(all, 'level3 + 本物JPEG でも内部検出が真の中心に追従（率≥55%・平均誤差≤0.55セル）');
}

console.log(`\n==== 結果: ${fail === 0 ? 'ALL PASS' : (fail + ' FAIL')} (pass=${pass}, fail=${fail}) ====`);
if (fail !== 0) process.exit(1);
