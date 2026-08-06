# Third-Party Licenses

SuperNaidesuCardRevolution II (SNCR2) は、以下の 2 つの MIT ライセンス
オープンソースプロジェクトのコードを土台にしています。MIT ライセンスの条件
（「上記著作権表示および本許諾表示を、ソフトウェアのすべての複製または重要な
部分に記載すること」）を満たすため、両者のライセンス表示を本ファイルに全文
掲載します。

SNCR2 本体のライセンス（MIT — Copyright © 2026 cheattoolymt(nyan4)）は
リポジトリ直下の [`LICENSE`](./LICENSE) を参照してください。

---

## 1. QR-Code-generator by Project Nayuki (MIT)

- リポジトリ: https://github.com/nayuki/QR-Code-generator
- 移植元ファイル: `typescript-javascript/qrcodegen.ts`
- SNCR2 での利用箇所: `js/qr-core.js`（機能モジュール配置・マスク最適化）,
  `js/qr-rs.js`（GF(256) Reed–Solomon 符号化）,
  `js/qr-mask.js`（8 マスクパターン評価・ペナルティスコア）,
  `js/qr-align.js`（アライメントパターン配置の一般化元）。

以下は nayuki/QR-Code-generator の `Readme.markdown` の License 章より、原文
のまま転載したものです。

```
Copyright © 2025 Project Nayuki. (MIT License)
https://www.nayuki.io/page/qr-code-generator-library

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

* The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.

* The Software is provided "as is", without warranty of any kind, express or
  implied, including but not limited to the warranties of merchantability,
  fitness for a particular purpose and noninfringement. In no event shall the
  authors or copyright holders be liable for any claim, damages or other
  liability, whether in an action of contract, tort or otherwise, arising from,
  out of or in connection with the Software or the use or other dealings in the
  Software.
```

---

## 2. naidesu-cardloader (MIT)

- リポジトリ: https://github.com/cheattoolymt/naidesu-cardloader
- 著作者: cheattoolymt(nyan4)（SNCR2 と同一著作者）
- SNCR2 での利用箇所: `js/geometry.js`（射影変換・適応サンプリング窓、無改造流用）,
  `js/compress.js` + `js/vendor/pako.min.js`（圧縮コンテナ、無改造流用）,
  `js/decode-core.js`（四隅ファインダ検出・グリッドサンプリングの移植元）,
  `js/qr-interleave.js`（インターリーブ方式の移植元）,
  A4/300dpi ジオメトリ定数（`js/qr-geometry.js`）。

旧 naidesu-cardloader も MIT ライセンスで公開されており、著作者は SNCR2 と同一
（cheattoolymt(nyan4)）です。ライセンス全文は下記のとおりです。

```
MIT License

Copyright © cheattoolymt(nyan4)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. pako (zlib port) — via naidesu-cardloader

`js/vendor/pako.min.js` は旧 naidesu-cardloader から無改造で流用している
deflate/inflate ライブラリ（pako 2.1.0, https://github.com/nodeca/pako ）です。
pako は `(MIT AND Zlib)` ライセンス（Copyright © 2014-2017 Vitaly Puzrin and
Andrei Tuputcyn）で配布されており、`pako.min.js` のファイル冒頭バナーにその
表示が含まれています（実ファイル 1 行目）:

```
/*! pako 2.1.0 https://github.com/nodeca/pako @license (MIT AND Zlib) */
```

配布物にこのライセンスバナーを保持したまま同梱しています。
