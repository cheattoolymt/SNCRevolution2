# SNCR2 API リファレンス

`js/*.js` の公開 API を、モジュールごとに引数・返り値・注意点つきでまとめます。
全体像は [`ARCHITECTURE.md`](ARCHITECTURE.md)、紙面のビット仕様は
[`FORMAT.md`](FORMAT.md) を参照してください。

> **この文書はコードから読み取った現行仕様です。** 数値や挙動が疑わしいときは
> 各ファイル冒頭のドキュメントコメントと `test/` のセルフテストが一次情報です。

---

## 0. 読み込み方

### ブラウザ

依存順に `<script>` で読み込みます（この順序は必須）。

```html
<script src="js/vendor/pako.min.js"></script>
<script src="js/qr-geometry.js"></script>
<script src="js/qr-align.js"></script>
<script src="js/qr-rs.js"></script>
<script src="js/qr-version.js"></script>
<script src="js/qr-interleave.js"></script>
<script src="js/qr-mask.js"></script>
<script src="js/qr-header.js"></script>
<script src="js/qr-core.js"></script>
<script src="js/card-format.js"></script>
<script src="js/compress.js"></script>
<!-- 読み取り側だけ追加で必要 -->
<script src="js/geometry.js"></script>
<script src="js/decode-core.js"></script>
```

各モジュールは `window.SNCR2Geometry` などのグローバルに載ります
（対応表は [`ARCHITECTURE.md` §2](ARCHITECTURE.md#グローバル名ブラウザと-require-名node)）。

### Node

同じファイルが CommonJS としても読めます（UMD 形）。

```js
const CF = require('./js/card-format.js');   // 高水準 API
const DC = require('./js/decode-core.js');   // 画像 → 復号
```

`require` すると内部で依存も自動解決されるので、順序を気にする必要はありません。

### 共通のデータ表現

| 名前 | 型 | 意味 |
|---|---|---|
| `modules` | `Uint8Array(cols*rows)` | 盤面。row-major、`0`=白 / `1`=黒 |
| `isFn` / `isFunction` | `Uint8Array(cols*rows)` | `1`=機能モジュール（マスク・データ対象外） |
| index | `y * cols + x` | 座標 → 配列添字 |
| `img` | `{ data: Uint8ClampedArray, width, height }` | RGBA 画素（canvas の `getImageData()` と同形式） |

---

## 1. `CardFormat`（`js/card-format.js`）— まずここ

「カードの論理仕様」の窓口。UI とテストが共有する高水準 API です。

### 1-1. 定数

| 名前 | 値 | 意味 |
|---|---|---|
| `DPI` | `300` | 基準解像度 |
| `PAGE_W` / `PAGE_H` | `2480` / `3508` | A4 の px 寸法（@300dpi） |
| `QUIET` / `FINDER` / `GAP` / `FOOTER` | `50` / `90` / `24` / `84` | 紙面余白・四隅マーカー・隙間・フッタ |
| `GRID_X` / `GRID_Y` | `164` / `164` | データグリッド箱の左上 |
| `GRID_W` / `GRID_H` | `2152` / `3096` | 箱の寸法（**全版で固定**） |
| `MIN_CELL_MM` | `0.7` | 標準ティアのセル下限 |
| `HEADER_LEN` | `18` | 物理ヘッダ長（論理 12 + RS 6） |
| `VERSIONS` | `[1..20]` | 利用可能な版番号 |
| `ECC_LEVELS` | オブジェクト | ECC レベル表（下記） |
| `STD_VERSION_COUNT` | `14` | この番号までが標準ティア |

#### `ECC_LEVELS`

```js
{
  0: { key:'none',  label:'なし',        ratio:0.00 },
  1: { key:'low',   label:'低(約10%)',   ratio:0.10 },
  2: { key:'med',   label:'中(約20%)',   ratio:0.20 },
  3: { key:'high',  label:'高(約30%)',   ratio:0.30 },
  4: { key:'vlow',  label:'極低(約5%)',  ratio:0.05 },
  5: { key:'lomed', label:'低中(約15%)', ratio:0.15 },
  6: { key:'medhi', label:'中高(約25%)', ratio:0.25 },
  7: { key:'max',   label:'最大(約40%)', ratio:0.40 },
}
```

> ⚠️ **番号順 ≠ 率順です。** 0〜3 は旧 4 段階の wire 値を固定したまま、
> 4〜7 を後付けしたためです。UI 表示や掃引は必ず
> `CF.eccLevelsByRatio()` を使ってください（率の昇順で返ります）。

### 1-2. `getProfile(version) → prof`

その版の「プロファイル」（寸法・容量・ティア情報の束）を返します。
`version` が範囲外なら `RangeError`。

```js
const prof = CF.getProfile(20);
// {
//   version: 20,
//   COLS: 348, ROWS: 501,
//   CELL_W, CELL_H,                 // 1 セルの px
//   cellWmm, cellHmm, minCellMm,    // 1 セルの mm（minCellMm=0.523）
//   GRID_X, GRID_Y, GRID_W, GRID_H, PAGE_W, PAGE_H,
//   dataBytes,                      // data セル総容量（ヘッダ 18B 込み・実測）
//   grossBytes,                     // payload グロス = dataBytes - 18
//   alignCount,                     // アライメントパターン個数
//   extended: true, tier: 'ext',    // 拡張ティアか
//   requiredDpi: 600,               // 必要な印刷/スキャン解像度
//   meetsMinCell: false,            // 0.7mm 下限を満たすか
// }
```

> **`requiredDpi` は必ずこの値を使ってください。** 「ver15 以上は 600dpi」と
> 決め打ちするのは誤りです（ver15 は 0.688mm@300dpi = 8.1px/セルなので
> `requiredDpi === 300` になります）。

### 1-3. `netCapacity(prof, eccLevel) → number`

その版・その ECC で載せられる**正味バイト数**（ユーザーデータ量）。

```js
CF.netCapacity(CF.getProfile(20), 3);  // → 14504 (ver20 / ECC 高)
CF.netCapacity(CF.getProfile(14), 3);  // → 7190  (ver14 / ECC 高)
```

### 1-4. `pickProfileForNet(netBytes, eccLevel) → prof`

`netBytes` が 1 ページに収まる**最小の版**のプロファイル。収まる版が無ければ最大版。

### 1-5. `cellRect(prof, col, row) → {x, y, w, h}`

グリッド座標 → 箱内の px 矩形（@300dpi 座標系）。描画とサンプリングで共有します。

### 1-6. `encodePage(payloadBytes, opts) → enc`

1 ページぶんの盤面を作ります。

| `opts` | 既定 | 意味 |
|---|---|---|
| `version` | 収まる最小版 | 版を明示指定 |
| `eccLevel` | `3`（高） | ECC レベル 0〜7 |
| `pageIndex` | `0` | 0-based ページ番号（ヘッダへ） |
| `totalPages` | `1` | 総ページ数（ヘッダへ） |
| `totalFileLen` | `payloadBytes.length` | ファイル全体のバイト数（ヘッダへ） |

```js
const enc = CF.encodePage(bytes, { version: 14, eccLevel: 3 });
// { modules, isFn, cols, rows, mask, eccLevel, prof, header, payloadLen }
```

`payloadBytes.length` がその版・ECC の正味容量を超えた場合、超過分は
**切り捨てられます**（例外は投げません）。事前に `netCapacity` で確認するか、
`encodeFile` を使ってください。

### 1-7. `encodeFile(fileBytes, opts) → { pages, totalPages, perPageNet, prof, eccLevel }`

ファイル全体を必要なだけのページへ自動分割し、各ページの `encodePage` 結果を返します。

| `opts` | 既定 | 意味 |
|---|---|---|
| `version` | 最大版（ver20） | 全ページの版 |
| `eccLevel` | `3`（高） | ECC レベル |
| `autoLastPage` | `true` | 最終ページを残量が収まる最小版へ自動縮小（§D） |

```js
const { pages, totalPages, perPageNet } = CF.encodeFile(bytes, { version: 20, eccLevel: 3 });
pages[0].prof.version;                 // 20
pages[totalPages - 1].prof.version;    // 残り 50B なら 1 まで自動縮小され得る
```

> `autoLastPage` は**縮小方向のみ**働きます（指定版より大きくはなりません）。
> 最終ページのセルが大きくなるため、読み取りは逆に頑丈になります。

### 1-8. `decodePageModules(recvModules, cols, rows) → result`

サンプリング済みの盤面から 1 ページを復号します。

```js
{
  meta: {          // ヘッダの内容（null なら MAGIC 不一致）
    magicOk, version, eccLevel, pageIndex, totalPages,
    payloadLen, flags, continuation, totalFileLen, checksumOk, ok, corrected,
  },
  data: Uint8Array,   // 正味データ（payloadLen 長）
  ok: boolean,        // ヘッダ・本文とも RS 完全成功
  corrected: number,  // 訂正できた byte 数の合計
  eccLevel, mask, formatDist,
  reason: 'header-magic',  // 失敗時のみ
}
```

**`ok` と `meta.ok` の違いが重要です。**

| 状態 | `meta` | `meta.ok` | `ok` | 意味 |
|---|---|---|---|---|
| 完全成功 | あり | `true` | `true` | データが信用できる |
| 本文だけ失敗 | あり | `true` | `false` | 版・ECC・ページは確定。劣化が RS 能力超過 |
| ヘッダ不一致 | `null` | — | `false` | 版すら不明（検出失敗） |

真ん中の状態を「検出失敗」と同じ文言で表示すると利用者が原因を誤認します
（`decoder.html` の `describeFailure()` と `test/decode-message-selftest.js` が
この区別を固定しています）。

### 1-9. `decodeAnyVersion(recvModules) → result`

`recvModules.length === cols*rows` になる版を総当たりする**保険**の入口です。
通常は `decode-core.decodeAnyVersion(img)` を使ってください（画像から入ります）。

### 1-10. `assembleFile(pageResults) → result`

`decodePageModules` / `decode-core.decodeAnyVersion` の結果配列を結合します。

```js
{
  ok: boolean,          // 全ページそろって長さも一致
  data: Uint8Array,     // 結合結果（totalFileLen 長）
  bytesFilled, totalFileLen,
  totalPages, pagesFound,
  missingPages: number[],  // 0-based の欠番リスト
  reason: 'no-page' | 'missing-pages' | 'short-data' | undefined,
}
```

- 同じ `pageIndex` が複数あれば最初の 1 枚だけ採用します（同じ紙の二重スキャン対策）。
- **`missingPages` が空でないときは `data` を信用してはいけません**（一部しか埋まっていません）。
  `decoder.html` はこの場合を成功と誤報しないようエラー表示にしています。

### 1-11. `parseHeader` / `buildHeader`

`SNCR2Header` の同名関数の素通しです（旧 cardloader 互換名）。

### 1-12. `otsuThreshold(gray) → number`

輝度配列（`0..255`）から大津法の二値化しきい値を返します。`decode-core` が使用。

---

## 2. `SNCR2DecodeCore`（`js/decode-core.js`）— 画像から読む

### 2-1. `decodeAnyVersion(img, opt) → result`

**読み取りの本番入口**です。四隅検出 → メッシュ補正 → サンプリング →
全版試し読みまでを一括で行います。

| `opt` | 既定 | 意味 |
|---|---|---|
| `invert` | 未指定＝`[false, true]` 両方試す | 白地/黒地。明示すると片方のみ（高速化） |
| `versions` | 全版 | 候補版の絞り込み（テスト・版既知の場面用の**任意最適化**） |
| `useAlignment` | 未指定＝`[true, false]` 二段試行 | メッシュ ON/OFF。明示すると 1 モードのみ（比較検証用） |
| `corners` | 自前検出 | 四隅を外から与える |
| `estimatePitch` | `true` | 版候補のピッチ推定並べ替え（速度のみ・正しさ不変） |

```js
const r = DC.decodeAnyVersion(imageData);
if (r.ok) {
  // r.data … 復元バイト列 / r.meta … ヘッダ / r.version … 確定した版
} else {
  // r.reason: 'no-corners' | 'payload-rs-fail' | 'not-detected' など
}
```

返り値は `CardFormat.decodePageModules` の結果に
`{ version, corners, invert, useAlignment }` を足したものです。

`reason` の主な値:

| `reason` | 意味 | 対処 |
|---|---|---|
| `no-corners` | 四隅マーカーを検出できない | 見切れ・傾き・低コントラスト。再スキャン |
| `payload-rs-fail` | 版は確定、本文 RS が能力超過 | 解像度を上げて再スキャン／ECC を上げて再作成 |
| `not-detected` | どの版でも MAGIC 不一致 | 解像度不足が最有力（拡張版は 600dpi 必須） |

> **プロダクションでは `versions` / `useAlignment` を指定しないでください。**
> 既定の総当たりが「読めない紙を作らない」ための安全網です。
> 指定は e2e テストの高速化や、原因切り分けのための比較検証用です。

### 2-2. 下位関数（デバッグ・研究用）

| 関数 | 用途 |
|---|---|
| `grayAt(img, x, y)` | 画素の輝度取得 |
| `findFinders(bin, w, h)` | 二値画像から四隅マーカー候補を連結成分で探す |
| `finderToGrid(fc)` | 四隅マーカー中心 → データグリッド箱の四隅へ換算 |
| `detectCorners(img, opt)` | 上 2 つをまとめた四隅検出（`{invert}`） |
| `refineAlignment(img, predicted, span, invert, opt)` | 予測位置周辺で実際のアライメント中心を局所探索 |
| `buildControlMesh(img, corners, cols, rows, invert)` | アライメント実測値から制御点メッシュを構築 |
| `meshMap(mesh, col, row)` | メッシュ経由でグリッド座標 → 画像座標 |
| `sampleModules(img, corners, cols, rows, opt)` | 盤面サンプリング（適応しきい二値化つき） |
| `estimateGridPitch(img, corners, invert)` | セルピッチのスペクトル推定 |
| `orderVersionsByPitch(versions, est)` | 推定結果で版候補を並べ替え |

---

## 3. `SNCR2Core`（`js/qr-core.js`）— 盤面の組み立て

| 関数 | 説明 |
|---|---|
| `buildFunctionGrid(cols, rows)` | `{ modules, isFn, formatCells }`。機能モジュールを敷いた盤面 |
| `drawFinder(modules, isFn, cols, rows, ox, oy)` | 7×7 ファインダ + セパレータを描く |
| `drawAlign(modules, isFn, cols, rows, cx, cy)` | 5×5 アライメントを描く（既存機能セルは侵さない） |
| `formatBits(eccLevel, mask) → 15bit` | BCH(15,5)。生成多項式 `0x537`、マスク `0x5412` |
| `decodeFormat(raw15)` | `{ eccLevel, mask, dist }`。最小ハミング距離で復元 |
| `formatCells(cols, rows)` | `{ copy1, copy2 }` 各 15 セルの座標（2 重配置） |
| `placeFormat` / `readFormat` | フォーマット情報の書き / 読み（BCH 訂正込み） |
| `dataCellList(isFn, cols, rows)` | 機能モジュール以外の添字を row-major で列挙 |
| `dataCapacityBytes(cols, rows)` | **実測**の data 容量（byte）。`getProfile` が採用する値 |
| `encodeGrid(headerBytes, payloadGross, cols, rows, eccLevel)` | 充填 + マスク自動選択 + フォーマット描画 |
| `decodeGrid(recvModules, cols, rows, payloadGrossLen)` | フォーマット読み + デマスク + `{header, payloadGross, ...}` |
| `idx(x, y, cols)` | `y*cols + x` |

```js
const g = Core.encodeGrid(header18, payloadGross, 250, 360, 3);
// { modules, isFn, cols, rows, mask, eccLevel, penalty, dataCells, formatCells }
```

> `dataCapacityBytes`（実測）と `SNCR2Version.rawDataBytes`（近似モデル）は
> **別系統**です。容量表示・ページ分割に効くのは実測側です
> （[`ARCHITECTURE.md` §5-2](ARCHITECTURE.md#5-2-容量モデルは近似と実測の-2-系統がある)）。

---

## 4. `SNCR2Version`（`js/qr-version.js`）— 版表・容量モデル

### 4-1. 定数

| 名前 | 意味 |
|---|---|
| `VERSION_COLS_STD` | 標準ティアの cols `[60,77,90,108,120,132,145,160,175,190,205,220,235,250]`（**凍結**） |
| `VERSION_COLS_EXT` | 拡張ティアの cols `[265,280,296,312,330,348]` |
| `VERSION_COLS` | 上記の連結（= 20 版） |
| `STD_VERSION_COUNT` | `14` |
| `BLOCK_N` | `255`。RS 符号語長の上限。ブロック数は `ceil(gross / BLOCK_N)` で決まる |
| `ECC_LEVELS` / `ECC_LEGACY_MAX` | ECC 表 / 旧ヘッダで表現できる上限（`3`） |
| `HEADER_DATA_LEN` / `HEADER_NSYM` / `HEADER_LEN` | `12` / `6` / `18` |
| `VERSIONS` | 全 20 版のメタ情報配列（下記 `buildVersion` の形） |

### 4-2. 関数

| 関数 | 説明 |
|---|---|
| `makeVersionCols(cols)` | `cols` から箱アスペクトに合う `{cols, rows}` を作る |
| `functionModuleCount(cols, rows)` | `{ total, functionModules, ... }`（**近似**オーバーヘッドモデル） |
| `rawDataBytes(cols, rows)` | 近似モデルでの data 容量 |
| `eccNsym(eccLevel)` | `round(255 × ratio)` を偶数丸めしたパリティ長 |
| `eccLevelsByRatio()` | `[{level, key, label, ratio}...]` を**率の昇順**で返す（UI 用） |
| `blockPlan(grossBytes, eccLevel)` | `[{dataLen, nsym}...]`。端数を捨てず均等割り、符号語長 ≤255 |
| `payloadGrossBytes(cols, rows)` | 近似 data 容量 − 18 |
| `netPayload(cols, rows, eccLevel)` | 近似ベースの正味容量 |
| `buildVersion(index)` | 版メタ情報を構築（`VERSIONS[index]` の中身） |
| `pickVersionForGross(targetGrossBytes)` | 目標グロスを満たす最小版 |
| `pickVersionForNet(netBytes, eccLevel)` | 目標正味を満たす最小版 |

`VERSIONS[i]` の主なフィールド:

```js
{
  version, cols, rows,
  extended, tier,                     // 'std' | 'ext'
  cellWmm, cellHmm, minCellMm,
  meetsMinCell, meetsMinCellExt,
  requiredDpi,                        // 1 セル 8px 以上を確保する dpi（300 刻み）
  totalCells, functionModules, overheadPct,
  rawDataBytes, headerLen, payloadGrossBytes,
  alignCount, alignDensity,
  net: { none, vlow, low, lomed, med, medhi, high, max },  // ECC key ごとの正味
}
```

---

## 5. `SNCR2Geometry`（`js/qr-geometry.js`）— 箱とセル寸法

| 名前 | 意味 |
|---|---|
| `DPI` `PAGE_W` `PAGE_H` `QUIET` `FINDER` `GAP` `FOOTER` | A4 紙面定数 |
| `GRID_X` `GRID_Y` `GRID_W` `GRID_H` | 箱の位置と寸法（`2152×3096`・固定） |
| `GRID_ASPECT` | `3096/2152 ≈ 1.4387` |
| `MM_PER_PX` | `25.4/300` |
| `MIN_CELL_MM` | `0.7`（標準ティア下限） |
| `MIN_CELL_EXT_MM` | `0.5`（拡張ティア下限） |
| `EXT_RECOMMENDED_DPI` | `600` |
| `pxToMm(px)` | px → mm |
| `finderCenters()` | 紙面四隅マーカーの中心 4 点 |
| `cellSize(cols, rows)` | `{ cellWpx, cellHpx, cellWmm, cellHmm, minCellMm }` |
| `meetsMinCell(cols, rows)` | 0.7mm 下限を満たすか |
| `meetsMinCellExt(cols, rows)` | 0.50mm 下限を満たすか |
| `requiredDpi(cols, rows, minPxPerCell=8)` | 1 セル `minPxPerCell` px を確保する dpi（300 刻みへ切り上げ） |

---

## 6. `SNCR2Align`（`js/qr-align.js`）— アライメント座標

| 名前 | 意味 |
|---|---|
| `DEFAULT_DENSITY` | `20`（セル間隔）。標準ティアの凍結値 |
| `REF_CELL_PX` / `REF_DENSITY` | 密度法則の基準点（ver10 の 11.3px / 20） |
| `DENSITY_MIN` / `DENSITY_MAX` | `10` / `34`（安全クランプ） |
| `LEGACY_COLS` | 標準ティアの cols 集合（この cols は常に密度 20＝後方互換） |
| `densityForCellPx(cellPx)` | `20 * sqrt(11.3 / cellPx)` をクランプ・丸め |
| `defaultDensityFor(cols, rows)` | 既定密度。`LEGACY_COLS` なら `20`、それ以外は上式 |
| `axisPositions(n, density)` | 1 軸の中心座標配列（両端に `6` と `n-7` を必ず含む・step は偶数） |
| `alignmentPositions(cols, rows, opts)` | `{ xs, ys }`。`opts.density` / `densityX` / `densityY` で上書き可 |
| `alignmentCenters(cols, rows, opts)` | `xs×ys` の直積から四隅衝突 3 点（TL/TR/BL）を除いた `[{x,y}...]` |

> 密度を「セル数一定」ではなく `∝ 1/√cellPx` にしている理由（bilinear 補間の
> 残差[セル]を版に依らず一定に保つ）は、ファイル内の長いコメントと
> [`ARCHITECTURE.md`](ARCHITECTURE.md) を参照。
> **`LEGACY_COLS` の挙動を変えると既存カードが全滅します。**

---

## 7. `SNCR2Mask`（`js/qr-mask.js`）— マスク最適化

| 名前 | 意味 |
|---|---|
| `NUM_MASKS` | `8` |
| `PENALTY_N1..N4` | nayuki と同じペナルティ係数 |
| `maskCondition(mask, x, y)` | 8 種のマスク式（x,y のみに依存） |
| `applyMask(modules, isFunction, cols, rows, mask)` | XOR でマスク適用（**involution**＝同じ呼び出しで元に戻る） |
| `getPenaltyScore(modules, cols, rows)` | N1〜N4 の合計スコア |
| `finderPenaltyCountPatterns` / `AddHistory` / `TerminateAndCount` | N3 の補助（`lineLen` を引数で受ける長方形対応版） |
| `chooseBestMask(modulesIn, isFunction, cols, rows)` | `{ modules, mask, penalty }`。全 8 マスクを評価し最小を採用 |

マスク式そのものは nayuki 版から 1 文字も変えていません。長方形化のための
一般化は「走査軸長を引数化」と「N4 の総数を `cols*rows` にする」の 2 点のみです。

---

## 8. `SNCR2Interleave`（`js/qr-interleave.js`）— RS 符号化 + 並べ替え

| 関数 | 説明 |
|---|---|
| `interleaveBlocks(codewords)` | `cw[0][0], cw[1][0], …, cw[0][1], …` の順に平坦化 |
| `deinterleaveBlocks(inter, plan)` | 逆変換（`plan` は `blockPlan` の結果） |
| `encodePayload(dataBytes, grossBytes, eccLevel)` | `blockPlan` → 各ブロック `RS.encode` → インターリーブ → `Uint8Array(grossBytes)` |
| `decodePayload(grossData, eccLevel, netLen)` | `{ data, ok, corrected }`。1 ブロックでも能力超過なら `ok:false` |

`eccLevel` が `0`（なし）のときは RS を通さず素通しします（生ビットダンプ）。

インターリーブの目的は、紙面上で連続した破損（帯ノイズ・たわみによるバースト）を
各 RS ブロックへ 1〜数 byte ずつ分散させることです。最大版・ECC 高（42 ブロック）で
**1310 byte 連続破損**を完全復元できることを `test/core-selftest.js` が確認しています。

---

## 9. `SNCR2Header`（`js/qr-header.js`）— 18byte ヘッダ

| 名前 | 意味 |
|---|---|
| `MAGIC0` / `MAGIC1` | `0x4E` / `0x43`（`"NC"`） |
| `HEADER_DATA_LEN` / `HEADER_NSYM` / `HEADER_LEN` | `12` / `6` / `18` |
| `VERSION_MASK` / `ECC_SHIFT` | `0x3F` / `6`（byte[2] の割り当て） |
| `FLAG_BYTE` | `7`（flags バイトの位置） |
| `FLAG_ECC_BIT2` | `0x01`（eccLevel の bit2） |
| `FLAG_CONTINUATION` | `0x02`（2 ページ目以降） |
| `MAX_TOTAL_FILE_LEN` | `0xFFFFFF`（BE24 = 16MiB） |
| `buildLogical(fields)` | 論理 12byte を組む（checksum 込み） |
| `buildHeader(fields)` | 論理 12byte を RS(6) で保護した 18byte |
| `interpretLogical(h, checksumOk)` | 12byte → フィールド展開 |
| `parseHeader(bytes)` | 18byte を RS 訂正 → checksum 検算 → フィールド。読めなければ `null` |

`fields`: `{ version, eccLevel, pageIndex, totalPages, payloadLen, totalFileLen, continuation }`

バイトレイアウトの詳細は [`FORMAT.md`](FORMAT.md) を参照。

---

## 10. `SNCR2RS`（`js/qr-rs.js`）— Reed–Solomon

| 名前 | 意味 |
|---|---|
| `EXP` / `LOG` | GF(256) のテーブル（既約多項式 `0x11D`・原始元 `0x02`） |
| `gfMul` `gfDiv` `gfInv` `gfPow` | GF 演算 |
| `reedSolomonMultiply(x, y)` | nayuki 版と同一実装（テーブル版との一致をテストで保証） |
| `computeDivisor(degree)` / `computeRemainder(data, divisor)` / `divisorFor(nsym)` | nayuki 移植の生成多項式・剰余 |
| `encode(data, nsym) → Uint8Array(data.length + nsym)` | 末尾に ECC パリティを付けた符号語 |
| `decode(codeword, nsym) → { data, ok, corrected }` | 誤り訂正して正味データを返す |

- 訂正能力は 1 ブロックあたり `t = floor(nsym / 2)` byte。
- **能力超過時は `ok:false` を返し、誤ったデータを `ok:true` で返しません**
  （サイレントな誤復元の防止。`test/core-selftest.js` が固定）。
- encode は nayuki 移植、decode（シンドローム → Berlekamp-Massey → Chien 探索 →
  Forney）は自前実装です。体と生成多項式が nayuki と一致しているため、
  nayuki が生成した符号語をそのまま訂正できます。

---

## 11. `NaidesuCompress`（`js/compress.js`）— 圧縮コンテナ

旧 cardloader から無改造で流用。**非同期 API** です。

| 名前 | 意味 |
|---|---|
| `METHOD` | `{ STORE:0, DEFLATE_RAW:1, GZIP:2, BROTLI:3, DEFLATE_JADICT:4 }` |
| `compress(fileBytes)` | `Promise<{ container, method, methodName, ... }>` |
| `autoDecompress(bytes)` | `Promise<{ data, wasCompressed, method, methodName }>` |

```js
const res = await NaidesuCompress.compress(bytes);
const toBurn = res.container;          // これをカードへ焼く

const de = await NaidesuCompress.autoDecompress(restored);
const original = de.data;              // 圧縮されていなければそのまま返る
```

三重の安全策で「破損厳禁」を担保しています。

1. 複数方式を試して最小の符号語を選ぶ
2. 元データより小さくならなければ `STORE`（無圧縮）にする
3. 展開後に元の長さと一致するか自己検証（不一致なら例外）

コンテナ形式は先頭 6byte のヘッダ（MAGIC `'N','Z','1'` + method + 元長）+ 本体です。
`autoDecompress` は MAGIC を見て「圧縮コンテナかどうか」を自動判別するので、
無圧縮のバイト列を渡しても安全に素通しします。

---

## 12. `NaidesuGeometry`（`js/geometry.js`）— 射影変換

旧 cardloader から無改造で流用。`decode-core` が使用します。

| 関数 | 説明 |
|---|---|
| `computeHomography(dst)` | 単位正方形 → 画像上 4 点（TL,TR,BR,BL）の 3×3 射影変換 |
| `applyHomography(H, u, v)` | `(u,v) ∈ [0,1]²` → `{x, y}` |
| `bilinearMap(corners, u, v)` | 双一次（台形近似）マップ |
| `makeCellMapper(corners, cols, rows)` | `{ map, cellSpanPx, homography }` |
| `samplingRadius(cellSpanPx)` | セルの実効 px サイズに応じた適応サンプリング窓半径 |

---

## 13. よく使うレシピ

### Node でラウンドトリップを試す

```js
const CF = require('./js/card-format.js');

const data = Buffer.from('hello, paper storage!');
const enc  = CF.encodePage(new Uint8Array(data), { version: 5, eccLevel: 3 });
const dec  = CF.decodePageModules(enc.modules, enc.cols, enc.rows);

console.log(dec.ok, Buffer.from(dec.data).toString());
// true 'hello, paper storage!'
```

### 全版 × 全 ECC の容量表を出す

```js
const CF = require('./js/card-format.js');
for (const v of CF.VERSIONS) {
  const prof = CF.getProfile(v);
  const nets = CF.eccLevelsByRatio()
    .map(lv => `${(lv.ratio * 100).toFixed(0)}%:${CF.netCapacity(prof, lv.level)}B`);
  console.log(`ver${v} ${prof.COLS}x${prof.ROWS} ${prof.requiredDpi}dpi`, nets.join(' '));
}
```

（同じ内容の整形済み表は `node test/design-selftest.js` が出力します。）

### 画像から復元する（ページ結合込み）

```js
const CF = require('./js/card-format.js');
const DC = require('./js/decode-core.js');

const results = images.map(img => DC.decodeAnyVersion(img));
const asm = CF.assembleFile(results.filter(r => r && r.ok));

if (!asm.ok) {
  console.error('失敗:', asm.reason, '欠番:', asm.missingPages);
} else {
  // asm.data が復元バイト列（圧縮コンテナなら autoDecompress にかける）
}
```

---

QRコードは株式会社デンソーウェーブの登録商標です。
QR Code is a registered trademark of DENSO WAVE INCORPORATED in Japan and in
other countries.
