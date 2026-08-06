/*
 * SuperNaidesuCardRevolution II (SNCR2) — qr-rs.js
 * ==================================================================
 * 実装指示書 §1-B / §4「Reed-Solomon 実装は nayuki 側に統一する」の実装。
 *
 * ── 移植元（エンコード側・そのまま使える部分）────────────────────
 *   nayuki/QR-Code-generator (MIT, Project Nayuki)
 *   typescript-javascript/qrcodegen.ts の GF(256) 実装:
 *     reedSolomonComputeDivisor / reedSolomonComputeRemainder /
 *     reedSolomonMultiply
 *   → 指示書 §1-B「そのまま使える」に従い、係数配列レイアウト・
 *     生成多項式（原始元 r=0x02, 既約多項式 0x11D）まで nayuki と一致。
 *
 * ── 追加実装（デコード側・訂正）─────────────────────────────────
 *   nayuki の QR 実装は「ECC 符号語の生成」だけで誤り“訂正”は範囲外
 *   （QR デコードは nayuki のスコープ外）。しかし本プロジェクトの
 *   §5 デインターリーブ・§7 ヘッダ復元は「破損したスキャン画像から
 *   復元する」ことが目的なので、シンドローム→Berlekamp-Massey→
 *   Chien 探索→Forney という古典的 RS 誤り訂正デコーダを自前で実装する。
 *   使用する GF(256) は nayuki と完全に同じ体（0x11D, r=0x02）なので、
 *   nayuki が生成した ECC 符号語をそのまま訂正できる。
 *
 * ── API（旧 cardloader の RS.encode / RS.decode と互換）──────────
 *   RS.encode(data:Uint8Array, nsym:int) -> Uint8Array(data.length+nsym)
 *       末尾 nsym byte に ECC（パリティ）を付けた符号語を返す。
 *   RS.decode(codeword:Uint8Array, nsym:int)
 *       -> { data:Uint8Array(codeword.length-nsym), ok:bool, corrected:int }
 *       誤りを訂正して正味データ部を返す。ok=false は訂正失敗（過負荷）。
 *
 * このファイルは DOM 非依存の純粋関数のみ。
 * ================================================================== */

(function (global, factory) {
  'use strict';
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  global.SNCR2RS = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // ==================================================================
  //  GF(2^8) 演算  — 既約多項式 0x11D, 原始元 r = 0x02（nayuki と同一）
  // ------------------------------------------------------------------
  //  高速化のため exp/log テーブルを前計算する。乗算はテーブル参照。
  //  nayuki の reedSolomonMultiply（ロシア農民法）と数学的に同一の体。
  // ==================================================================
  const PRIM = 0x11d; // x^8 + x^4 + x^3 + x^2 + 1
  const EXP = new Uint8Array(512); // r^i（i=0..255 の 2 周期ぶん）
  const LOG = new Uint8Array(256); // log_r(x)
  (function initTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= PRIM;
    }
    // 2 周期ぶん複製しておくと EXP[a+b]（a,b<255）を mod 無しで引ける。
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  // GF(256) 乗算（テーブル版）。0 は特別扱い。
  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }
  // GF(256) 除算 a/b。
  function gfDiv(a, b) {
    if (b === 0) throw new Error('GF division by zero');
    if (a === 0) return 0;
    return EXP[(LOG[a] + 255 - LOG[b]) % 255];
  }
  // GF(256) 逆元 1/a。
  function gfInv(a) { return EXP[(255 - LOG[a]) % 255]; }
  // r^i（原始元のべき）。
  function gfPow(i) { return EXP[((i % 255) + 255) % 255]; }

  // 参考: nayuki の reedSolomonMultiply（検証用にそのまま残す）。
  // gfMul と常に一致することを self-test で確認する。
  function reedSolomonMultiply(xIn, yIn) {
    let x = xIn & 0xff, y = yIn & 0xff, z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * PRIM);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  // ==================================================================
  //  §1-B: 生成多項式（ECC 用 divisor）— nayuki 移植（そのまま使える）
  // ------------------------------------------------------------------
  //  係数は「最高次から最低次」順、先頭の 1x^degree は省略して格納。
  //  例: x^3 + 255x^2 + 8x + 93 → [255, 8, 93]（nayuki と同一レイアウト）。
  // ==================================================================
  function computeDivisor(degree) {
    if (degree < 1 || degree > 255) throw new RangeError('Degree out of range');
    const result = new Uint8Array(degree);
    result[degree - 1] = 1; // 単項式 x^0 から開始
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  // ECC 符号語（剰余）を返す — nayuki 移植（そのまま使える）。
  function computeRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);
    for (let k = 0; k < data.length; k++) {
      const factor = data[k] ^ result[0];
      // shift（result.shift() 相当）: 左へ 1、末尾に 0。
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      for (let i = 0; i < divisor.length; i++) {
        result[i] ^= gfMul(divisor[i], factor);
      }
    }
    return result;
  }

  // 生成多項式はブロック長ごとに使い回せるのでキャッシュ。
  const _divisorCache = new Map();
  function divisorFor(nsym) {
    let d = _divisorCache.get(nsym);
    if (!d) { d = computeDivisor(nsym); _divisorCache.set(nsym, d); }
    return d;
  }

  // ------------------------------------------------------------------
  //  RS.encode: data の末尾に nsym byte の ECC を付けた符号語を返す。
  //  （systematic 符号 = データ部はそのまま、後ろにパリティを付加）
  // ------------------------------------------------------------------
  function encode(data, nsym) {
    if (nsym <= 0) return Uint8Array.from(data);
    const div = divisorFor(nsym);
    const ecc = computeRemainder(data, div);
    const out = new Uint8Array(data.length + nsym);
    out.set(data, 0);
    out.set(ecc, data.length);
    return out;
  }

  // ==================================================================
  //  RS.decode: 古典的シンドローム復号（誤り位置・誤り値の訂正）
  // ------------------------------------------------------------------
  //  手順:
  //    1) シンドローム S_j = C(r^j)  (j=1..nsym) を計算。全 0 なら無誤り。
  //    2) Berlekamp-Massey で誤り位置多項式 Λ(x) を求める。
  //    3) Chien 探索で Λ の根 → 誤り位置を特定。
  //    4) Forney で各誤り位置の誤り値を計算し、符号語を訂正。
  //    5) 訂正後に再計算したシンドロームが全 0 なら成功(ok=true)。
  //  訂正能力は t = floor(nsym/2) byte まで。超えると ok=false。
  //
  //  符号語のインデックスと多項式の次数対応:
  //    codeword[0] が最高次（x^{n-1}）、codeword[n-1] が定数項 x^0。
  //    位置 i の誤りは x^{n-1-i} に対応 → r^{n-1-i} を根に持つ。
  // ==================================================================
  function decode(codewordIn, nsym) {
    const codeword = Uint8Array.from(codewordIn);
    const n = codeword.length;
    const dataLen = n - nsym;
    if (nsym <= 0) {
      return { data: codeword.slice(0, Math.max(0, dataLen)), ok: true, corrected: 0 };
    }

    // 1) シンドローム。nayuki の生成多項式は
    //      g(x) = (x - r^0)(x - r^1) ... (x - r^{nsym-1})
    //    と「r^0 始まり」なので、シンドロームも同じ根で評価する:
    //      S_j = C(r^j)  (j = 0 .. nsym-1)
    //    C(x) は codeword[0] を最高次とみなし Horner 法で評価する。
    const synd = new Uint8Array(nsym);
    let hasError = false;
    for (let j = 0; j < nsym; j++) {
      const rj = gfPow(j); // r^j （r^0 始まり = nayuki 生成多項式に整合）
      let acc = 0;
      for (let i = 0; i < n; i++) acc = gfMul(acc, rj) ^ codeword[i];
      synd[j] = acc;
      if (acc !== 0) hasError = true;
    }
    if (!hasError) {
      return { data: codeword.slice(0, dataLen), ok: true, corrected: 0 };
    }

    // 2) Berlekamp-Massey：誤り位置多項式 Λ(x)（低次→高次で保持）。
    let lambda = [1];        // Λ(x)
    let bPoly = [1];         // B(x)（前回の Λ）
    let L = 0;               // 現在の LFSR 長
    let m = 1;               // シフト量
    let bScalar = 1;         // 直近の非零 discrepancy
    for (let nStep = 0; nStep < nsym; nStep++) {
      // discrepancy Δ = S_n + Σ Λ_i S_{n-i}
      let delta = synd[nStep];
      for (let i = 1; i <= L; i++) {
        if (i < lambda.length && lambda[i] !== 0) {
          delta ^= gfMul(lambda[i], synd[nStep - i]);
        }
      }
      if (delta === 0) {
        m++;
      } else if (2 * L <= nStep) {
        const tPrev = lambda.slice();
        const coef = gfDiv(delta, bScalar);
        // Λ(x) = Λ(x) - (Δ/b) x^m B(x)
        lambda = polySubShift(lambda, bPoly, coef, m);
        L = nStep + 1 - L;
        bPoly = tPrev;
        bScalar = delta;
        m = 1;
      } else {
        const coef = gfDiv(delta, bScalar);
        lambda = polySubShift(lambda, bPoly, coef, m);
        m++;
      }
    }

    const numErr = L;
    // 訂正能力超過（誤り数が t=nsym/2 を超える）は復元不能。
    if (numErr <= 0 || numErr > (nsym >> 1)) {
      return { data: codeword.slice(0, dataLen), ok: false, corrected: 0 };
    }

    // 3) Chien 探索：Λ(r^{-i})=0 となる i（=誤り位置）を全走査で求める。
    //    位置 i（0..n-1）の誤りは根 X_k = r^{n-1-i} に対応。
    const errPos = [];
    for (let i = 0; i < n; i++) {
      const xInvExp = (n - 1 - i); // この位置に対応する根の指数
      // Λ(r^{-(n-1-i)}) を評価。Λ_j * (r^{-(xInvExp)})^j の総和。
      let val = 0;
      for (let j = 0; j < lambda.length; j++) {
        if (lambda[j] === 0) continue;
        // (r^{xInvExp})^{-j} = r^{-xInvExp*j}
        val ^= gfMul(lambda[j], gfPow(-xInvExp * j));
      }
      if (val === 0) errPos.push(i);
    }
    if (errPos.length !== numErr) {
      // 根の個数が次数と一致しない＝訂正不能。
      return { data: codeword.slice(0, dataLen), ok: false, corrected: 0 };
    }

    // 4) Forney：誤り評価多項式 Ω(x) = [S(x)Λ(x)] mod x^nsym と
    //    Λ'(x)（形式微分）から各誤り値 e_k を求め、符号語を訂正。
    //    S(x) = Σ_{j=1..nsym} S_{j} x^{j-1}
    const omega = computeOmega(synd, lambda, nsym);
    const lambdaDeriv = formalDerivative(lambda);

    let corrected = 0;
    for (const pos of errPos) {
      const xExp = (n - 1 - pos);   // X_k = r^{xExp}
      const Xk = gfPow(xExp);
      const XkInv = gfInv(Xk);
      // Ω(X_k^{-1})
      const omegaVal = polyEval(omega, XkInv);
      // Λ'(X_k^{-1})
      const denom = polyEval(lambdaDeriv, XkInv);
      if (denom === 0) {
        return { data: codeword.slice(0, dataLen), ok: false, corrected: 0 };
      }
      // e_k = X_k * Ω(X_k^{-1}) / Λ'(X_k^{-1})  （1-indexed 定義に合わせ Xk 倍）
      const err = gfMul(Xk, gfDiv(omegaVal, denom));
      codeword[pos] ^= err;
      corrected++;
    }

    // 5) 再シンドロームで検算（生成多項式と同じ r^0 始まりの根で評価）。
    for (let j = 0; j < nsym; j++) {
      const rj = gfPow(j);
      let acc = 0;
      for (let i = 0; i < n; i++) acc = gfMul(acc, rj) ^ codeword[i];
      if (acc !== 0) {
        return { data: codeword.slice(0, dataLen), ok: false, corrected };
      }
    }
    return { data: codeword.slice(0, dataLen), ok: true, corrected };
  }

  // ---- 多項式ヘルパ（係数配列は低次→高次: p[0]=x^0）--------------
  // a(x) - coef * x^shift * b(x)   （GF(256) では減算=XOR）
  function polySubShift(a, b, coef, shift) {
    const len = Math.max(a.length, b.length + shift);
    const out = new Array(len).fill(0);
    for (let i = 0; i < a.length; i++) out[i] = a[i];
    for (let i = 0; i < b.length; i++) {
      out[i + shift] ^= gfMul(coef, b[i]);
    }
    // 末尾の 0 を詰める（次数管理を簡潔に保つ）。
    while (out.length > 1 && out[out.length - 1] === 0) out.pop();
    return out;
  }

  // Ω(x) = [S(x) Λ(x)] mod x^nsym。S(x)=Σ S_{j} x^{j-1}（j=1..nsym）。
  function computeOmega(synd, lambda, nsym) {
    const s = new Array(nsym);
    for (let i = 0; i < nsym; i++) s[i] = synd[i];
    const omega = new Array(nsym).fill(0);
    for (let i = 0; i < nsym; i++) {
      let acc = 0;
      for (let j = 0; j <= i; j++) {
        if (j < lambda.length) acc ^= gfMul(s[i - j], lambda[j]);
      }
      omega[i] = acc;
    }
    // x^nsym で切り詰め（既に長さ nsym なのでそのまま）。
    while (omega.length > 1 && omega[omega.length - 1] === 0) omega.pop();
    return omega;
  }

  // 形式微分 Λ'(x)。GF(2^m) では 2=0 なので偶数次項の微分は消える。
  //   Λ = Σ λ_j x^j → Λ' = Σ_{j odd} λ_j x^{j-1}
  function formalDerivative(poly) {
    const out = [];
    for (let j = 1; j < poly.length; j++) {
      out[j - 1] = (j & 1) ? poly[j] : 0;
    }
    if (out.length === 0) out.push(0);
    return out;
  }

  // Horner 法で p(x) を x=val で評価（p[0]=x^0）。
  function polyEval(poly, val) {
    let acc = 0;
    for (let i = poly.length - 1; i >= 0; i--) acc = gfMul(acc, val) ^ poly[i];
    return acc;
  }

  return {
    // GF 演算（テスト・他モジュールから利用可）
    EXP, LOG, gfMul, gfDiv, gfInv, gfPow, reedSolomonMultiply,
    // 生成多項式・剰余（nayuki 移植）
    computeDivisor, computeRemainder, divisorFor,
    // 高水準 API（cardloader 互換）
    encode, decode,
  };
});
