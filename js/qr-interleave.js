/*
 * SuperNaidesuCardRevolution II (SNCR2) — qr-interleave.js
 * ==================================================================
 * 実装指示書 §5「インターリーブ（旧 cardloader の実装をそのまま踏襲）」の実装。
 *
 * ── 移植元 ──────────────────────────────────────────────────────
 *   naidesu-cardloader (MIT, cheattoolymt(nyan4))
 *   js/card-format.js の interleaveBlocks / deinterleaveBlocks /
 *   encodePayload / decodePayload をほぼそのまま移植した
 *   （指示書 §5「ロジックが汎用的なのでほぼそのまま移植可能」）。
 *
 * ── 方式（QR コードと同じ）─────────────────────────────────────
 *   複数 RS ブロックの符号語をバイト単位で「縦方向に取り出して交互配置」:
 *       出力 = cw[0][0], cw[1][0], …, cw[k-1][0], cw[0][1], cw[1][1], …
 *   こうすると、印刷物上で連続する領域（=バースト破損）が、復元時に
 *   各ブロックへ「1〜数バイトずつ」分散され、ブロック単位の誤り数が減る。
 *   → §10 検証仮説「中央部のたわみ・帯状ノイズ耐性」に効く。
 *
 * ── 依存 ────────────────────────────────────────────────────────
 *   SNCR2RS      (js/qr-rs.js)      … RS.encode / RS.decode（nayuki 統一）
 *   SNCR2Version (js/qr-version.js) … blockPlan / eccNsym（§4 の設計）
 *
 * このファイルは DOM 非依存の純粋関数のみ。
 * ================================================================== */

(function (global, factory) {
  'use strict';
  const RS = (typeof require !== 'undefined') ? require('./qr-rs.js') : global.SNCR2RS;
  const Ver = (typeof require !== 'undefined') ? require('./qr-version.js') : global.SNCR2Version;
  const mod = factory(RS, Ver);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  global.SNCR2Interleave = mod;
})(typeof window !== 'undefined' ? window : globalThis, function (RS, Ver) {
  'use strict';

  // ==================================================================
  //  §5: インターリーブ（cardloader interleaveBlocks そのまま）
  // ------------------------------------------------------------------
  //  ブロックごとに長さが違う場合（端数）は、その列(col)に存在する
  //  ブロックだけを出力する。QR の混在ブロック長と同じ扱い。
  // ==================================================================
  function interleaveBlocks(codewords) {
    const maxLen = codewords.reduce((m, cw) => Math.max(m, cw.length), 0);
    const total = codewords.reduce((s, cw) => s + cw.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (let col = 0; col < maxLen; col++) {
      for (let b = 0; b < codewords.length; b++) {
        if (col < codewords[b].length) out[o++] = codewords[b][col];
      }
    }
    return out;
  }

  // インターリーブを解く。plan（各ブロックの符号語長 cwLen=dataLen+nsym）
  // から元のブロック配列 cw[0..k-1] を復元する（cardloader そのまま）。
  function deinterleaveBlocks(inter, plan) {
    const lens = plan.map(b => b.dataLen + b.nsym);
    const maxLen = lens.reduce((m, l) => Math.max(m, l), 0);
    const cws = lens.map(l => new Uint8Array(l));
    let o = 0;
    for (let col = 0; col < maxLen; col++) {
      for (let b = 0; b < lens.length; b++) {
        if (col < lens[b] && o < inter.length) cws[b][col] = inter[o++];
      }
    }
    return cws;
  }

  // ==================================================================
  //  正味データ(dataBytes) を RS 符号化 + インターリーブして
  //  グロス領域(grossBytes)へ詰める（cardloader encodePayload そのまま）。
  // ------------------------------------------------------------------
  //  ECC なし(nsym=0)は RS 無効の生ビットダンプ（cardloader と同一挙動）。
  // ==================================================================
  function encodePayload(dataBytes, grossBytes, eccLevel) {
    const nsym = Ver.eccNsym(eccLevel);
    if (nsym === 0) {
      const out = new Uint8Array(grossBytes);
      out.set(dataBytes.subarray(0, Math.min(dataBytes.length, grossBytes)), 0);
      return out;
    }
    const plan = Ver.blockPlan(grossBytes, eccLevel);
    const codewords = [];
    let dOff = 0;
    for (const b of plan) {
      const data = new Uint8Array(b.dataLen);
      const take = Math.min(b.dataLen, dataBytes.length - dOff);
      if (take > 0) data.set(dataBytes.subarray(dOff, dOff + take), 0);
      dOff += b.dataLen;
      codewords.push(RS.encode(data, b.nsym));
    }
    const inter = interleaveBlocks(codewords);
    const out = new Uint8Array(grossBytes);
    out.set(inter.subarray(0, Math.min(inter.length, grossBytes)), 0);
    return out;
  }

  // ==================================================================
  //  グロス領域(grossData) をデインターリーブ + RS デコードして
  //  正味データ(netLen)を取り出す（cardloader decodePayload そのまま）。
  // ------------------------------------------------------------------
  //  返り値: { data:Uint8Array(netLen), ok:bool, corrected:int }
  //    ok=false は少なくとも 1 ブロックが訂正能力を超えたことを示す。
  // ==================================================================
  function decodePayload(grossData, eccLevel, netLen) {
    const nsym = Ver.eccNsym(eccLevel);
    if (nsym === 0) {
      return { data: grossData.slice(0, netLen), ok: true, corrected: 0 };
    }
    const plan = Ver.blockPlan(grossData.length, eccLevel);
    const cws = deinterleaveBlocks(grossData, plan);
    const data = new Uint8Array(plan.reduce((s, b) => s + b.dataLen, 0));
    let dOff = 0, allOk = true, corrected = 0;
    for (let i = 0; i < plan.length; i++) {
      const b = plan[i];
      const r = RS.decode(cws[i], b.nsym);
      if (!r.ok) allOk = false;
      corrected += r.corrected;
      data.set(r.data.subarray(0, b.dataLen), dOff);
      dOff += b.dataLen;
    }
    return { data: data.slice(0, netLen), ok: allOk, corrected };
  }

  return {
    interleaveBlocks,
    deinterleaveBlocks,
    encodePayload,
    decodePayload,
  };
});
