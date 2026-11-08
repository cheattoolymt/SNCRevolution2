/*
 * SNCR2 — 圧縮容量・互換・破損検出の回帰テスト。
 * セル縮小や ECC 削減によらず、同じ版でページ数が減ることを検証する。
 * Node と、ネイティブ圧縮 API の無いオフラインブラウザ相当の両方で実行。
 * 既存 e2e がカバーしなかった「圧縮 → 紙面 → 結合 → 展開」も固定する。
 * 実行: node test/compress-selftest.js（追加依存なし、乱数 seed 固定）
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const zlib = require('zlib');
const C = require('../js/compress.js');
const pako = require('../js/vendor/pako.min.js');
const CF = require('../js/card-format.js');
const DC = require('../js/decode-core.js');
const R = require('./render-helper.js');

function browserCodec(extra) {
  const context = Object.assign({ pako, TextEncoder, TextDecoder, setTimeout }, extra);
  context.window = context;
  vm.runInNewContext(fs.readFileSync(require.resolve('../js/compress.js'), 'utf8'), context);
  return context.NaidesuCompress;
}
const offline = browserCodec();

function randomBytes(len, seed) {
  let state = seed;
  return Uint8Array.from({ length: len }, () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return state & 255;
  });
}
function kanaBytes(count) {
  const random = randomBytes(count, 72);
  return new TextEncoder().encode(Array.from(random, b => String.fromCharCode(0x3041 + b % 80)).join(''));
}
function container(method, length, body) {
  const out = Buffer.alloc(8 + body.length);
  out.write('NZ1'); out[3] = method; out.writeUInt32BE(length, 4);
  out.set(body, 8);
  return out;
}
function legacyLength(result) {
  return 8 + Math.min(result.origLen, ...result.tried
    .filter(t => t.method <= 4 && t.ok).map(t => t.len));
}
function equal(actual, expected) { assert.deepStrictEqual(Buffer.from(actual), Buffer.from(expected)); }

async function main() {
  // 全バイト値、非 UTF-8、BOM、結合文字、非 BMP、空、長い反復を保存できる。
  const fixtures = [new Uint8Array(), new Uint8Array([0]), Uint8Array.from({ length: 256 }, (_, i) => i),
    randomBytes(70001, 5), new Uint8Array(200000).fill(65),
    new TextEncoder().encode('\ufeff日本語\r\n😀𠮷e\u0301\0'.repeat(2000)),
    new Uint8Array([0xed, 0xa0, 0x80, 0xff, 0xc0, 0x80])];
  for (const codec of [C, offline]) {
    for (const input of fixtures) {
      const result = await codec.compress(input);
      equal((await codec.autoDecompress(result.container)).data, input);
      assert(result.compLen <= legacyLength(result));
      assert(result.compLen <= input.length + 8);
    }
  }
  console.log('PASS Node / offline browser: arbitrary bytes, Unicode, no regression, STORE');

  // 新 decoder は既存 method 0〜4 を読み続ける。辞書の fixture は改修前に採取。
  const oldData = Buffer.from('legacy card payload '.repeat(100));
  const oldBodies = [oldData, zlib.deflateRawSync(oldData), zlib.gzipSync(oldData), zlib.brotliCompressSync(oldData)];
  for (let method = 0; method < oldBodies.length; method++) {
    equal((await C.autoDecompress(container(method, oldData.length, oldBodies[method]))).data, oldData);
    if (method !== 3) equal((await offline.autoDecompress(container(method, oldData.length, oldBodies[method]))).data, oldData);
  }
  const dictGolden = Buffer.from('4e5a31040000005183c71b30089ecd59f362d53c50c801132e287def04255fb833887034501900', 'hex');
  const dictData = Buffer.from('これは日本語のテキストです。よろしくお願いいたします。');
  for (const codec of [C, offline]) equal((await codec.autoDecompress(dictGolden)).data, dictData);
  equal((await C.autoDecompress(oldData)).data, oldData);
  console.log('PASS legacy methods 0–4, frozen Japanese dictionary, raw payload');

  // 不一致を隠していた slice(0, origLen) に戻らないことを保証。
  for (let method = 0; method < oldBodies.length; method++) {
    await assert.rejects(() => C.autoDecompress(container(method, oldData.length - 1, oldBodies[method])));
    await assert.rejects(() => C.autoDecompress(container(method, oldData.length + 1, oldBodies[method])));
  }
  const wrongDict = Buffer.from(dictGolden); wrongDict.writeUInt32BE(dictData.length - 1, 4);
  await assert.rejects(() => C.autoDecompress(wrongDict));

  // method 6 を明示して BOM / 非 BMP / NUL のコードユニットを固定する。
  const unicode = '\ufeff日本語😀𠮷e\u0301\0';
  const planes = new Uint8Array(unicode.length * 2);
  for (let i = 0; i < unicode.length; i++) {
    planes[i] = unicode.charCodeAt(i) & 255;
    planes[i + unicode.length] = unicode.charCodeAt(i) >>> 8;
  }
  const unicodeBytes = Buffer.from(unicode);
  equal((await offline.autoDecompress(container(6, unicodeBytes.length, pako.deflateRaw(planes)))).data, unicodeBytes);

  // 独立に組んだ LZ トークンで重なる参照・破損境界を検証。
  const lz = tokens => container(C.METHOD.LZ_DEFLATE, 20, pako.deflateRaw(Uint8Array.from(tokens)));
  equal((await offline.autoDecompress(lz([1, 65, 19, 1, 0]))).data, Buffer.alloc(20, 65));
  for (const bad of [[1, 65, 19, 0, 0], [1, 65, 19, 2, 0], [0, 20, 1, 0],
    [1, 65, 20, 1, 0], [1, 65, 18, 1, 0], [1, 65, 19, 1], [128], [0, 128, 128, 128, 128], [21]]) {
    await assert.rejects(() => offline.autoDecompress(lz(bad)));
  }
  await assert.rejects(() => offline.autoDecompress(container(5, 1, pako.deflateRaw(new Uint8Array(1000)))));
  await assert.rejects(() => offline.autoDecompress(container(6, 1, pako.deflateRaw(new Uint8Array(1000)))));
  await assert.rejects(() => offline.autoDecompress(container(6, 2, pako.deflateRaw(new Uint8Array(3)))));
  await assert.rejects(() => offline.autoDecompress(container(255, 0, [])));
  // 不完全な deflate stream を成功扱いしない。
  const valid = lz([1, 65, 19, 1, 0]);
  await assert.rejects(() => offline.autoDecompress(valid.subarray(0, valid.length - 1)));
  console.log('PASS corrupt length, invalid references, bounds, unknown method, truncation');

  // 長距離の同じブロックが 10 回出現。32KiB 窓では参照できない。
  const block = randomBytes(40000, 1), repeated = new Uint8Array(400000);
  for (let i = 0; i < 10; i++) repeated.set(block, i * block.length);
  const long = await offline.compress(repeated);
  assert.strictEqual(long.method, C.METHOD.LZ_DEFLATE);
  assert(long.compLen < legacyLength(long) * 0.15);
  equal((await offline.autoDecompress(long.container)).data, repeated);

  const japanese = kanaBytes(20000), text = await offline.compress(japanese);
  assert.strictEqual(text.method, C.METHOD.UTF8_PLANE);
  assert(text.compLen < legacyLength(text) * 0.8);
  equal((await offline.autoDecompress(text.container)).data, japanese);
  console.log(`PASS capacity: long repetition ${legacyLength(long)}B → ${long.compLen}B; kana ${legacyLength(text)}B → ${text.compLen}B`);

  // 新 2 方式とも、同じ ver14 / ECC30% の盤面経由で完全一致する。
  // 乱順スキャンのページ群を結合してから展開する（圧縮は分割前）。
  const cap = CF.netCapacity(CF.getProfile(14), 3);
  for (const [input, packed] of [[repeated, long], [japanese, text]]) {
    const encoded = CF.encodeFile(packed.container, { version: 14, eccLevel: 3 });
    assert(encoded.totalPages < Math.ceil(legacyLength(packed) / cap));
    const decoded = encoded.pages.map(p => {
      assert(p.prof.minCellMm >= CF.getProfile(14).minCellMm);
      const result = CF.decodePageModules(p.modules, p.prof.COLS, p.prof.ROWS);
      assert(result.ok); return result;
    });
    const assembled = CF.assembleFile(decoded.reverse());
    assert(assembled.ok);
    equal((await offline.autoDecompress(assembled.data)).data, input);
    console.log(`PASS same cells / ECC30%: ${Math.ceil(legacyLength(packed) / cap)} → ${encoded.totalPages} pages, exact restoration`);
  }
  // 文字面分離は 60KB の元データを 3 枚に格納。PNG 相当画像も自動復号する。
  const enc = CF.encodeFile(text.container, { version: 14, eccLevel: 3 });
  const scanned = enc.pages.map(page => {
    const image = R.renderPage(page, 1);
    const result = DC.decodeAnyVersion(image);
    image.data = null; assert(result.ok); return result;
  });
  const assembled = CF.assembleFile(scanned.reverse());
  assert(assembled.ok);
  equal((await offline.autoDecompress(assembled.data)).data, japanese);
  console.log('PASS compression → page images → automatic version detection → assemble → decompression');
  console.log('ALL PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
