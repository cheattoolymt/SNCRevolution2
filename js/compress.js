/*
 * SuperNaidesuCardRevolution II (SNCR2) — compress.js
 * ------------------------------------------------------------------
 * 「限界まで圧縮」して紙1枚あたりに詰め込めるデータ量を増やすための
 * 圧縮コンテナ。creator でチェックを入れるだけで有効化し、decoder は
 * 結合後のバイト列を見て「圧縮されているか / どの方式か」を自動判別し、
 * 自動で展開する。
 *
 * ● 破損厳禁 --------------------------------------------------------
 *   バイナリの完全一致は絶対条件。そこで
 *     1) 複数方式で圧縮 → 最小の符号語を選ぶ
 *     2) 圧縮しても元データより小さくならなければ「無圧縮(STORE)」にする
 *     3) 展開後に「元の長さ」と一致するか自己検証（不一致なら例外）
 *   という三重の安全策を取る。全方式は round-trip 可逆なもののみ採用。
 *
 * ● 方式 -----------------------------------------------------------
 *   0 STORE          : 無圧縮（そのまま）。圧縮で増える場合のフォールバック。
 *   1 DEFLATE_RAW    : deflate-raw（zlibヘッダ/checksum なし＝最小オーバヘッド）
 *                      ≒ gzip/deflate 相当の 40〜50% 削減、ヘッダ分だけさらに得。
 *   2 GZIP           : gzip（deflate_raw が使えない/劣る環境の保険）
 *   3 BROTLI         : brotli（対応環境のみ。deflate より強い ≈50% 削減）
 *   4 DEFLATE_JADICT : deflate-raw + 日本語プリセット辞書（zlib/pako の
 *                      「preset dictionary」機能。辞書は符号語に含めず、両側が
 *                      同じ辞書を共有して LZ77 の初期ウィンドウに載せる真の
 *                      辞書圧縮。短い日本語テキストで最大 60%超、長文でも
 *                      +10〜15% の上乗せを狙う）。
 *   5 LZ_DEFLATE     : ファイル全体の長距離 LZ 参照 → deflate。
 *                      deflate の 32KiB 窓を超える反復を参照に置換して、
 *                      セル寸法・ECC を変えずに実効容量を増やす。
 *                      既存 method 0〜4 / 日本語辞書は変更しない。
 *   6 UTF8_PLANE     : 厳密な UTF-8 → UTF-16 の上下位バイト分離 → deflate。
 *                      日本語の UTF-8 の共通接頭バイトを整理して圧縮する。
 *
 * ● コンテナ形式（先頭 8byte のヘッダ + 本体） --------------------
 *   [0..2] MAGIC = 'N','Z','1'   (0x4E 0x5A 0x31 = "NaidesuZip v1")
 *   [3]    method (0..6)
 *   [4..7] origLen (big-endian 32bit, 展開後の元バイト数)  ← [4..7] の 4byte
 *   [8..]  本体（method に応じた符号語 / STORE ならそのまま）
 *   ※ 実バイト位置: MAGIC(3) + method(1) + origLen(4) = 8byte ヘッダ。
 *
 *   decoder は先頭 3byte が MAGIC なら「圧縮コンテナ」とみなし展開、
 *   そうでなければ「旧来の無圧縮データ」として素通しする（後方互換）。
 *
 * ● 環境 -----------------------------------------------------------
 *   ブラウザ: CompressionStream / DecompressionStream（Baseline 2023-05〜）
 *            を deflate-raw/gzip/brotli に使用。pako(js/vendor/pako.min.js)で
 *            level 9・辞書・新方式・ネイティブ API 非対応時の展開も提供する。
 *   Node:    node:zlib / pako（テスト用）。
 * ================================================================== */

(function (global) {
  'use strict';

  const MAGIC0 = 0x4e; // 'N'
  const MAGIC1 = 0x5a; // 'Z'
  const MAGIC2 = 0x31; // '1'
  const HEADER_LEN = 8;

  const METHOD = {
    STORE: 0,
    DEFLATE_RAW: 1,
    GZIP: 2,
    BROTLI: 3,
    DEFLATE_JADICT: 4,
    LZ_DEFLATE: 5,
    UTF8_PLANE: 6,
  };
  const METHOD_NAME = {
    0: 'STORE(無圧縮)',
    1: 'deflate-raw',
    2: 'gzip',
    3: 'brotli',
    4: 'deflate+日本語辞書',
    5: '長距離LZ+deflate',
    6: 'UTF-8文字面分離+deflate',
  };

  // ---- 環境判定 --------------------------------------------------
  const hasCompressionStream =
    typeof global.CompressionStream !== 'undefined' &&
    typeof global.DecompressionStream !== 'undefined';

  let zlib = null;
  if (typeof require !== 'undefined') {
    try { zlib = require('zlib'); } catch (e) { /* browser */ }
  }

  // pako（辞書 deflate 用）。ブラウザは <script> で window.pako を先に読み込む。
  let pako = global.pako || null;
  if (!pako && typeof require !== 'undefined') {
    try { pako = require('./vendor/pako.min.js'); } catch (e) { /* optional */ }
  }
  const hasDictDeflate = !!pako;

  // ---- 日本語プリセット辞書 --------------------------------------
  // deflate の「preset dictionary」機能を使う。辞書は符号語に一切含めず、
  // 圧縮側・展開側の両方が同じ辞書を共有して LZ77 の初期ウィンドウに載せる。
  // これにより本文中の頻出日本語トークンが「辞書内への後方参照」として
  // 短く符号化される（＝真の辞書圧縮。prefix priming と違い辞書分の
  // オーバヘッドが無い）。
  //
  // 内容: ひらがな/カタカナ/よくある助詞・語尾・記号・HTML/JSON 断片など、
  // 日本語テキストで高頻度に出るバイト列を並べたもの。deflate は辞書の
  // 「末尾」を最も近い距離で参照できるので、高頻度語を後半に置く。
  const JA_DICT_TEXT = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>',
    '{"":"","id":,"name":"","type":"","value":,"data":[],"items":[{}],"true":true,"false":false,"null":null}',
    'ぁぃぅぇぉっゃゅょがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ',
    'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンー・、。',
    'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん',
    'これはですますでしたしていますございますについてということそしてしかしまたためからまでよりへとがのにをはもや',
    'する事もの時人年月日今何私達彼女使用場合以上以下および又は当社弊社お客様ありがとうございますよろしくお願いいたします',
    'です。ます。ました。ください。について、ということ。しかし、そして、',
  ].join('\n');

  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return Uint8Array.from(Buffer.from(str, 'utf-8'));
  }
  const JA_DICT = utf8Encode(JA_DICT_TEXT);

  // ---- 低レベル: 生の deflate-raw / gzip / brotli (方式非依存) ----
  async function rawCompress(bytes, fmt) {
    // fmt: 'deflate-raw' | 'gzip' | 'brotli'
    // CompressionStream は圧縮レベルを指定できない。常時同梱している
    // pako の level 9 も候補にする（ネイティブ方式は後段で比較）。
    const strong = pako && fmt === 'deflate-raw' ? pako.deflateRaw(bytes, { level: 9 }) : null;
    if (hasCompressionStream) {
      let cs;
      try { cs = new global.CompressionStream(fmt); }
      catch (e) { cs = null; } // Node なら下の zlib へフォールバック
      if (cs) {
        const stream = new global.Blob([bytes]).stream().pipeThrough(cs);
        const buf = await new Response(stream).arrayBuffer();
        const native = new Uint8Array(buf);
        return strong && strong.length < native.length ? strong : native;
      }
    }
    if (zlib) {
      const native = await new Promise((resolve, reject) => {
        const cb = (e, r) => (e ? reject(e) : resolve(new Uint8Array(r)));
        const inp = Buffer.from(bytes);
        if (fmt === 'deflate-raw') zlib.deflateRaw(inp, { level: 9 }, cb);
        else if (fmt === 'gzip') zlib.gzip(inp, { level: 9 }, cb);
        else if (fmt === 'brotli') zlib.brotliCompress(inp, cb);
        else reject(new Error('unknown fmt ' + fmt));
      });
      return strong && strong.length < native.length ? strong : native;
    }
    return strong;
  }

  async function rawDecompress(bytes, fmt) {
    // ネイティブ deflate-raw 非対応ブラウザでもオフラインで必ず読める。
    if (pako && fmt === 'deflate-raw') return pako.inflateRaw(bytes);
    if (pako && fmt === 'gzip') return pako.ungzip(bytes);
    if (hasCompressionStream) {
      let ds;
      try { ds = new global.DecompressionStream(fmt); }
      catch (e) { ds = null; }
      if (ds) {
        const stream = new global.Blob([bytes]).stream().pipeThrough(ds);
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
      }
    }
    if (zlib) {
      return await new Promise((resolve, reject) => {
        const cb = (e, r) => (e ? reject(e) : resolve(new Uint8Array(r)));
        const inp = Buffer.from(bytes);
        if (fmt === 'deflate-raw') zlib.inflateRaw(inp, cb);
        else if (fmt === 'gzip') zlib.gunzip(inp, cb);
        else if (fmt === 'brotli') zlib.brotliDecompress(inp, cb);
        else reject(new Error('unknown fmt ' + fmt));
      });
    }
    throw new Error('展開環境なし');
  }

  // ---- 日本語辞書 deflate（真の preset dictionary） --------------
  // pako の deflateRaw/inflateRaw に dictionary オプションを渡す。辞書は
  // 符号語に含まれず、両側で共有する（この JS 内に固定で持つ）。
  function jadictCompress(bytes) {
    if (!pako) return null;
    try {
      return pako.deflateRaw(bytes, { level: 9, dictionary: JA_DICT });
    } catch (e) { return null; }
  }
  function jadictDecompress(body) {
    if (!pako) throw new Error('pako 未読み込み: 辞書展開不可');
    const out = pako.inflateRaw(body, { dictionary: JA_DICT });
    return out;
  }

  // ---- deflate の 32KiB 窓を超える重複の除去 ----------------------
  // method 5 本体は deflate-raw(トークン列)。トークンは
  // [literalLen ULEB128, literal bytes, matchLen ULEB128, distance ULEB128]。
  // 終端は literal の直後（match 不要）。参照は最小 16B、距離は最大 16MiB。
  // 短い反復は後段の deflate に任せ、参照の管理コストで容量を損なわない。
  // ハッシュ表を固定長にし、探索を直近候補 1 個へ制限して線形時間に保つ。
  const LZ_MAX = 0xffffff;
  async function longRangeCompress(bytes) {
    if (!pako || bytes.length < 16 || bytes.length > LZ_MAX) return null;
    const table = new Int32Array(1 << 18);
    table.fill(-1);
    const out = new Uint8Array(bytes.length + 4);
    let written = 0;
    function putVarint(value) {
      while (value >= 128) { out[written++] = (value & 127) | 128; value >>>= 7; }
      out[written++] = value;
    }
    let literal = 0, pos = 0, nextYield = 128 * 1024;
    while (pos + 16 <= bytes.length) {
      const word = (bytes[pos] | (bytes[pos + 1] << 8) |
        (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)) >>> 0;
      const hash = Math.imul(word, 0x9e3779b1) >>> 14;
      const previous = table[hash];
      table[hash] = pos;
      let length = 0;
      if (previous >= 0 && pos - previous <= LZ_MAX) {
        while (length < 16 && bytes[previous + length] === bytes[pos + length]) length++;
        if (length === 16) {
          while (pos + length < bytes.length && bytes[previous + length] === bytes[pos + length]) length++;
        }
      }
      if (length >= 16) {
        putVarint(pos - literal);
        out.set(bytes.subarray(literal, pos), written); written += pos - literal;
        putVarint(length); putVarint(pos - previous);
        pos += length; literal = pos;
      } else pos++;
      if (pos >= nextYield) {
        // 各 128KiB で UI へ制御を返す。入力全体の suffix sort は不要。
        await new Promise(resolve => setTimeout(resolve, 0));
        nextYield = pos + 128 * 1024;
      }
    }
    putVarint(bytes.length - literal);
    out.set(bytes.subarray(literal), written); written += bytes.length - literal;
    return pako.deflateRaw(out.subarray(0, written), { level: 9 });
  }

  // 新方式は中間バイト列の上限を事前に計算できるので、ストリームで制限。
  function inflateBounded(body, limit) {
    if (!pako) throw new Error('pako 未読み込み');
    const chunks = [];
    let size = 0;
    const inflater = new pako.Inflate({ raw: true, chunkSize: Math.min(limit + 1, 16384) });
    inflater.onData = chunk => {
      size += chunk.length;
      if (size > limit) throw new Error('展開データが上限超過');
      chunks.push(chunk);
    };
    inflater.push(body, true);
    if (inflater.err || !inflater.ended) throw new Error('deflate 展開失敗');
    const tokens = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { tokens.set(chunk, offset); offset += chunk.length; }
    return tokens;
  }

  function longRangeDecompress(body, origLen) {
    if (origLen > LZ_MAX) throw new Error('長距離LZ の元サイズが上限超過');
    // 参照は必ず 16B 以上を最大 8B の符号へ縮めるので、
    // 有効なトークン列は入力長 + 最終 literal 長の符号化（最大 4B）以下。
    const tokens = inflateBounded(body, origLen + 4);
    let offset = 0;
    let cursor = 0;
    function readVarint() {
      let value = 0, scale = 1;
      for (let i = 0; i < 4; i++, scale *= 128) {
        if (cursor >= tokens.length) throw new Error('長距離LZ トークンが不完全');
        const byte = tokens[cursor++];
        value += (byte & 127) * scale;
        if (value > LZ_MAX) throw new Error('長距離LZ 数値が上限超過');
        if (!(byte & 128)) return value;
      }
      throw new Error('不正な長距離LZ 整数');
    }
    const out = new Uint8Array(origLen);
    offset = 0;
    let terminated = false;
    while (cursor < tokens.length) {
      const literalLen = readVarint();
      if (literalLen > tokens.length - cursor || literalLen > origLen - offset) {
        throw new Error('不正な長距離LZ literal 長');
      }
      out.set(tokens.subarray(cursor, cursor + literalLen), offset);
      cursor += literalLen; offset += literalLen;
      if (cursor === tokens.length) { terminated = true; break; }
      const matchLen = readVarint(), distance = readVarint();
      if (matchLen < 16 || !distance || distance > offset || matchLen > origLen - offset) {
        throw new Error('不正な長距離LZ 参照');
      }
      // 重なる参照も前から展開すれば反復を可逆に復元できる。
      for (let i = 0; i < matchLen; i++) out[offset + i] = out[offset + i - distance];
      offset += matchLen;
    }
    if (!terminated || offset !== origLen) throw new Error('長距離LZ 展開後の長さが不一致');
    return out;
  }

  function textPlaneCompress(bytes) {
    if (!pako || typeof TextDecoder === 'undefined') return null;
    let text;
    try {
      // BOM もデータとして保存。不正 UTF-8 を置換文字で失うことを防ぐ。
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (e) { return null; }
    if (!bytesEqual(utf8Encode(text), bytes)) return null;
    const planes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      planes[i] = code & 255; planes[i + text.length] = code >>> 8;
    }
    return pako.deflateRaw(planes, { level: 9 });
  }

  function textPlaneDecompress(body, origLen) {
    const planes = inflateBounded(body, origLen * 2);
    if (planes.length % 2) throw new Error('不正な文字面データ長');
    const n = planes.length / 2, parts = [];
    for (let start = 0; start < n; start += 8192) {
      const codes = [];
      for (let i = start; i < Math.min(n, start + 8192); i++) codes.push(planes[i] | (planes[i + n] << 8));
      parts.push(String.fromCharCode.apply(null, codes));
    }
    return utf8Encode(parts.join(''));
  }

  // ---- ユーティリティ --------------------------------------------
  function makeContainer(method, origLen, body) {
    const out = new Uint8Array(HEADER_LEN + body.length);
    out[0] = MAGIC0; out[1] = MAGIC1; out[2] = MAGIC2;
    out[3] = method & 0xff;
    out[4] = (origLen >>> 24) & 0xff;
    out[5] = (origLen >>> 16) & 0xff;
    out[6] = (origLen >>> 8) & 0xff;
    out[7] = origLen & 0xff;
    out.set(body, HEADER_LEN);
    return out;
  }
  function isContainer(bytes) {
    return bytes && bytes.length >= HEADER_LEN &&
      bytes[0] === MAGIC0 && bytes[1] === MAGIC1 && bytes[2] === MAGIC2;
  }
  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ---- 公開: 圧縮 ------------------------------------------------
  // fileBytes(Uint8Array) を「限界まで」圧縮したコンテナ(Uint8Array)を返す。
  // 全方式を試し、最小＆可逆(自己検証OK)のものを採用。増える場合は STORE。
  // 返り値: { container, method, methodName, origLen, compLen, ratio, tried }
  async function compress(fileBytes) {
    const origLen = fileBytes.length;
    const tried = []; // {method, len, ok}

    // 候補 [method, bodyPromise]
    const candidates = [];
    candidates.push([METHOD.DEFLATE_RAW, rawCompress(fileBytes, 'deflate-raw')]);
    candidates.push([METHOD.GZIP, rawCompress(fileBytes, 'gzip')]);
    candidates.push([METHOD.BROTLI, rawCompress(fileBytes, 'brotli')]);
    candidates.push([METHOD.DEFLATE_JADICT, Promise.resolve(jadictCompress(fileBytes))]);
    candidates.push([METHOD.LZ_DEFLATE, longRangeCompress(fileBytes)]);
    candidates.push([METHOD.UTF8_PLANE, Promise.resolve(textPlaneCompress(fileBytes))]);

    let best = { method: METHOD.STORE, body: fileBytes };
    const bestLen = fileBytes.length; // STORE の本体長（＝origLen）

    // 直ちに全 Promise の失敗を捕捉する（順番待ち中の unhandled rejection を防ぐ）。
    const bodies = await Promise.all(candidates.map(c => c[1].catch(() => null)));
    const ranked = [];
    for (let i = 0; i < candidates.length; i++) {
      const method = candidates[i][0], body = bodies[i];
      if (!body) { tried.push({ method, methodName: METHOD_NAME[method], len: null, ok: false }); continue; }
      tried.push({ method, methodName: METHOD_NAME[method], len: body.length, ok: true });
      if (body.length < bestLen) ranked.push({ method, body });
    }

    // 最小候補が読めない環境でも、次に小さい可逆候補を採用する。
    ranked.sort((a, b) => a.body.length - b.body.length);
    for (const candidate of ranked) {
      let roundtripOk = false;
      try {
        const check = await decompressBody(candidate.method, candidate.body, origLen);
        roundtripOk = bytesEqual(check, fileBytes);
      } catch (e) { roundtripOk = false; }
      if (roundtripOk) { best = candidate; break; }
      tried.find(t => t.method === candidate.method).ok = false;
    }

    const container = makeContainer(best.method, origLen, best.body);
    return {
      container,
      method: best.method,
      methodName: METHOD_NAME[best.method],
      origLen,
      compLen: container.length,
      ratio: origLen > 0 ? container.length / origLen : 1,
      tried,
    };
  }

  // 本体(body)を方式に応じて展開して元データを返す（内部用）
  async function decompressBody(method, body, origLen) {
    switch (method) {
      case METHOD.STORE:        return body.slice();
      case METHOD.DEFLATE_RAW:  return rawDecompress(body, 'deflate-raw');
      case METHOD.GZIP:         return rawDecompress(body, 'gzip');
      case METHOD.BROTLI:       return rawDecompress(body, 'brotli');
      case METHOD.DEFLATE_JADICT: return jadictDecompress(body, origLen);
      case METHOD.LZ_DEFLATE:  return longRangeDecompress(body, origLen);
      case METHOD.UTF8_PLANE:  return textPlaneDecompress(body, origLen);
      default: throw new Error('未知の圧縮方式: ' + method);
    }
  }

  // ---- 公開: 自動展開 --------------------------------------------
  // decoder が結合したバイト列。コンテナなら展開、そうでなければ素通し。
  // 返り値: { data, wasCompressed, method, methodName }
  async function autoDecompress(bytes) {
    if (!isContainer(bytes)) {
      return { data: bytes, wasCompressed: false, method: null, methodName: null };
    }
    const method = bytes[3];
    const origLen = (bytes[4] * 0x1000000) + (bytes[5] << 16) + (bytes[6] << 8) + bytes[7];
    const body = bytes.subarray(HEADER_LEN);
    const data = await decompressBody(method, body, origLen);
    if (data.length !== origLen) {
      throw new Error(`展開後の長さが不一致 (期待 ${origLen} / 実際 ${data.length})`);
    }
    return { data, wasCompressed: method !== METHOD.STORE, method, methodName: METHOD_NAME[method] };
  }

  global.NaidesuCompress = {
    METHOD,
    METHOD_NAME,
    HEADER_LEN,
    hasCompressionStream,
    hasDictDeflate,
    isContainer,
    compress,
    autoDecompress,
    // テスト補助
    _rawCompress: rawCompress,
    _rawDecompress: rawDecompress,
    _JA_DICT_LEN: JA_DICT.length,
  };

  // Node(テスト用): require で受け取れるように module.exports も設定
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.NaidesuCompress;
  }
})(typeof window !== 'undefined' ? window : globalThis);
