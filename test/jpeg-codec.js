/*
 * SNCR2 テスト用 自前ベースライン JPEG コーデック（Node 専用・依存ゼロ）
 * ==================================================================
 * 目的（実機フィードバック §10-6）:
 *   これまでの e2e 劣化は「ガウスぼかし＋加算ノイズ」で JPEG を*近似*して
 *   いたが、実機（decoder.html は canvas を JPEG で保存・再読込したり、
 *   スキャナ/カメラが JPEG を吐く）で効く本当の劣化は、
 *   **8×8 ブロック単位の DCT 量子化ノイズ（ブロックノイズ・リンギング）** で
 *   ある。近似ぼかしはブロック境界の段差やリンギングを再現しないため、
 *   とくに 0.7mm 級・高密度版（ver14, セル≒8.6px≒JPEG ブロックと同程度）で
 *   実機の厳しさを過小評価していた（机上では通るが実機で RS 訂正超過）。
 *
 *   そこで「実際に canvas がやる JPEG エンコード（quality 指定）」を経由した
 *   画像をテストに使うため、**ベースライン JPEG の可逆でない主効果**
 *   （前方 DCT → quality に応じた量子化 → 逆量子化 → 逆 DCT）を自前実装する。
 *   エントロピー符号化（ハフマン/ランレングス）は可逆なのでピクセル結果に
 *   影響せず、省略しても「復号後ピクセル」は本物の JPEG と一致する。よって
 *   本コーデックは *依存ゼロ* で canvas JPEG 由来のブロックノイズを忠実に
 *   再現する（グレースケール＝二値印刷物なので輝度 1 チャネルで十分）。
 *
 * ── 使い方 ──────────────────────────────────────────────────────
 *   const JPEG = require('./jpeg-codec.js');
 *   const out = JPEG.roundtrip(img, quality);   // img={data(RGBA),width,height}
 *   // out も {data(RGBA),width,height}。輝度のみ JPEG 往復した結果。
 *
 * quality: 1..100（canvas の toDataURL('image/jpeg', q/100) と同じ意味）。
 *   低いほど量子化が粗く、ブロックノイズが強い。
 *
 * このファイルは DOM 非依存・依存ゼロの純粋関数のみ。
 * ================================================================== */
'use strict';

// ==================================================================
// 【実機フィードバック §10-6 強化】実物 canvas と同じ本物の JPEG を通す
// ------------------------------------------------------------------
//  ユーザ報告: 机上 e2e の近似ノイズ（ぼかし＋加算ノイズ）は、実物の
//  canvas.toDataURL('image/jpeg', q) が吐くブロックノイズより緩く、
//  テストが実機の厳しさを過小評価していた（机上で通っても実機で RS 超過）。
//
//  対策: テスト環境に純 JS 実装の本物 JPEG コーデック `jpeg-js` があれば、
//  それで **実際にベースライン JPEG へエンコード → デコード** した画素を返す
//  （＝ブラウザ canvas と同一パイプライン: level shift・4:2:0/4:4:4 クロマ・
//  実量子化テーブル・エントロピー符号化まで通した本物の往復）。これで机上
//  テストが実機 canvas JPEG と同じブロックノイズ／リンギングを浴びる。
//
//  jpeg-js が無い環境（＝出荷物は依存ゼロ）では、下段の自前 DCT-量子化
//  コーデックへ自動フォールバックする（主効果である 8×8 ブロック量子化
//  ノイズは同等に再現でき、テストは依存が無くても走る）。
// ==================================================================
let _jpegjs = null;
try { _jpegjs = require('jpeg-js'); } catch (_e) { _jpegjs = null; }

// jpeg-js による「本物の canvas 相当」JPEG 往復。
//  img={data(RGBA Uint8*),width,height} → 同形式（RGBA）を返す。
//  quality は 1..100（canvas の toDataURL 第 2 引数 ×100 と同じ意味）。
function roundtripReal(img, quality) {
  const { width: W, height: H } = img;
  const q = Math.max(1, Math.min(100, quality != null ? (quality | 0) : 40));
  // jpeg-js は encode に {data: Buffer/Uint8Array(RGBA), width, height} を要求。
  const raw = { data: img.data, width: W, height: H };
  const enc = _jpegjs.encode(raw, q);              // 本物のベースライン JPEG バイト列
  const dec = _jpegjs.decode(enc.data, { useTArray: true }); // 画素へ復号
  // 二値印刷物なので輝度チャネルのみ意味を持つ。RGBA→グレースケール RGBA へ正規化
  //  （復号後の 3ch から輝度を再計算し、以降の処理と型を揃える）。
  const out = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  const s = dec.data;
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const v = s[p] * 0.299 + s[p + 1] * 0.587 + s[p + 2] * 0.114;
    out.data[p] = out.data[p + 1] = out.data[p + 2] = v;
    out.data[p + 3] = 255;
  }
  return out;
}

// jpeg-js が利用可能か（テスト側が「本物 JPEG を通したか」を表示するのに使う）。
function hasRealJpeg() { return !!_jpegjs; }

// ------------------------------------------------------------------
// 標準 JPEG 輝度量子化テーブル（Annex K.1, 50% 品質基準）。
// ------------------------------------------------------------------
const STD_LUM_QT = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

// quality(1..100) → スケールした量子化テーブル（IJG/libjpeg と同じ式）。
//  canvas（Chrome/Firefox）も IJG 系のスケーリングを用いるため挙動が一致する。
function scaledQuantTable(quality) {
  let q = quality | 0;
  if (q < 1) q = 1; if (q > 100) q = 100;
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const t = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    let v = Math.floor((STD_LUM_QT[i] * scale + 50) / 100);
    if (v < 1) v = 1; if (v > 255) v = 255;   // ベースライン 8bit 量子化は 1..255
    t[i] = v;
  }
  return t;
}

// ------------------------------------------------------------------
// 8×8 2次元 DCT-II / 逆 DCT-III（分離型・素直な実装）。
//  速度より正しさ優先（テスト用）。cos は事前計算でキャッシュ。
// ------------------------------------------------------------------
const COS = (() => {
  const c = new Float64Array(64);
  for (let u = 0; u < 8; u++)
    for (let x = 0; x < 8; x++)
      c[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return c;
})();
const ALPHA = (() => {
  const a = new Float64Array(8);
  a[0] = Math.sqrt(1 / 8);
  for (let u = 1; u < 8; u++) a[u] = Math.sqrt(2 / 8);
  return a;
})();

// 8×8 ブロック（Float64Array(64), level-shift 済み −128..127）→ DCT 係数。
function fdct8x8(block, out) {
  // 行方向 DCT → 中間、列方向 DCT。分離型。
  const tmp = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS[u * 8 + x];
      tmp[y * 8 + u] = ALPHA[u] * s;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * COS[v * 8 + y];
      out[v * 8 + u] = ALPHA[v] * s;
    }
  }
}

// DCT 係数 → 8×8 ブロック（逆変換）。
function idct8x8(coef, out) {
  const tmp = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += ALPHA[u] * coef[y * 8 + u] * COS[u * 8 + x];
      tmp[y * 8 + x] = s;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += ALPHA[v] * tmp[v * 8 + x] * COS[v * 8 + y];
      out[y * 8 + x] = s;
    }
  }
}

// ------------------------------------------------------------------
// 輝度 1 チャネルの JPEG 往復（DCT → 量子化 → 逆量子化 → 逆 DCT）。
//  画像 {data(RGBA),width,height} を受け取り、輝度のみを 8×8 ブロックで
//  JPEG 往復した新しい画像（グレースケール RGBA）を返す。ブロック境界の
//  段差（ブロックノイズ）と高周波のリンギングが本物どおりに現れる。
//
//  実機注記: canvas の JPEG は輝度をそのままブロック処理し、二値印刷物では
//  クロマはほぼ無情報なので、輝度単チャネル往復で実機ブロックノイズを
//  十分忠実に再現できる（かつ依存ゼロ）。
// ------------------------------------------------------------------
function roundtripDCT(img, quality) {
  const { width: W, height: H } = img;
  const QT = scaledQuantTable(quality != null ? quality : 40);
  const src = img.data;
  const out = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  const lum = (x, y) => {
    const p = (y * W + x) * 4;
    return src[p] * 0.299 + src[p + 1] * 0.587 + src[p + 2] * 0.114;
  };
  const block = new Float64Array(64);
  const coef = new Float64Array(64);
  const rec = new Float64Array(64);

  for (let by = 0; by < H; by += 8) {
    for (let bx = 0; bx < W; bx += 8) {
      // ブロック抽出（端は縁の画素を複製＝JPEG のエッジ拡張に相当）。
      for (let y = 0; y < 8; y++) {
        const sy = Math.min(by + y, H - 1);
        for (let x = 0; x < 8; x++) {
          const sx = Math.min(bx + x, W - 1);
          block[y * 8 + x] = lum(sx, sy) - 128;   // level shift
        }
      }
      fdct8x8(block, coef);
      // 量子化 → 逆量子化（ここでのみ不可逆＝実機ブロックノイズの源）。
      for (let i = 0; i < 64; i++) {
        const q = QT[i];
        const level = Math.round(coef[i] / q);
        coef[i] = level * q;
      }
      idct8x8(coef, rec);
      // 書き戻し（level shift 戻し + クランプ）。ブロック内の実画素だけ。
      for (let y = 0; y < 8; y++) {
        const dy = by + y; if (dy >= H) break;
        for (let x = 0; x < 8; x++) {
          const dx = bx + x; if (dx >= W) break;
          let v = rec[y * 8 + x] + 128;
          v = v < 0 ? 0 : v > 255 ? 255 : v;
          const p = (dy * W + dx) * 4;
          out.data[p] = out.data[p + 1] = out.data[p + 2] = v;
          out.data[p + 3] = 255;
        }
      }
    }
  }
  return out;
}

// 公開 API: roundtrip は「本物の JPEG（jpeg-js）を優先し、無ければ自前 DCT」。
//  これで実機 canvas と同じブロックノイズを（依存があれば本物で、無ければ
//  近似で）テストへ供給する。実装ごとの往復を明示指定したい場合は
//  roundtripReal / roundtripDCT を直接呼ぶ。
function roundtrip(img, quality) {
  return _jpegjs ? roundtripReal(img, quality) : roundtripDCT(img, quality);
}

module.exports = {
  roundtrip,          // 本物優先（jpeg-js があれば canvas 相当、無ければ DCT 近似）
  roundtripReal,      // 本物の JPEG（jpeg-js 必須）
  roundtripDCT,       // 依存ゼロの自前 DCT-量子化コーデック
  hasRealJpeg,        // jpeg-js が使えるか
  scaledQuantTable, STD_LUM_QT,
};
