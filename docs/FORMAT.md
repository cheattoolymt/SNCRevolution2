# SNCR2 カードフォーマット仕様

**この文書の目的**: SNCR2 のカードを **別言語・別実装で読み書きできる**だけの
情報を、ビット単位で記述する。

対象読者: 互換リーダ／ライタを実装する人、フォーマットを検証する人。
API の呼び出し方は [`API.md`](API.md)、コードの構造は
[`ARCHITECTURE.md`](ARCHITECTURE.md) を参照。

> **一次情報はコードとテストです。** この文書と実装が食い違う場合、
> `js/qr-*.js` と `test/compat-selftest.js`（ビット単位のゴールデン値）が正です。

---

## 0. 全体像

```
ユーザーのファイル
   │ (任意) 圧縮コンテナ化                          … §6
   ▼
payload バイト列
   │ ページ分割                                     … §5
   ▼
ページごとの payload 断片
   │ ヘッダ 18B ＋ RS 符号化 + インターリーブ       … §3, §4
   ▼
header(18B) ‖ payloadGross(グロス領域)
   │ 盤面へ bit 充填 → マスク → フォーマット情報    … §2
   ▼
modules（cols×rows の 0/1）
   │ 紙面へ描画                                     … §1
   ▼
A4 の白黒画像
```

数値はすべて **KiB = 1024 byte** 基準です。

---

## 1. 紙面レイアウト（物理）

### 1-1. 基準座標系

すべて **A4 @300dpi = 2480×3508px** を基準座標系とします。
拡張ティア（§1-4）では実画素が 2 倍になりますが、**レイアウト定義はこの座標系のまま**で、
描画時に倍率をかけるだけです。

| 定数 | 値 (px) | mm | 意味 |
|---|---|---|---|
| `PAGE_W` | 2480 | 210.0 | 用紙幅 |
| `PAGE_H` | 3508 | 297.0 | 用紙高 |
| `QUIET` | 50 | 4.23 | 端余白（家庭用プリンタの印刷可能領域に収まる安全余白） |
| `FINDER` | 90 | 7.6 | 四隅マーカーの一辺 |
| `GAP` | 24 | 2.0 | 四隅マーカー〜データグリッドの隙間 |
| `FOOTER` | 84 | 7.1 | 箱直下の人間可読フッタ領域 |

### 1-2. データグリッド箱（全版共通・固定）

```
GRID_X = QUIET + FINDER + GAP                    = 164
GRID_Y = QUIET + FINDER + GAP                    = 164
GRID_W = PAGE_W - 2*GRID_X                       = 2152  (182.2mm)
GRID_H = PAGE_H - GRID_Y - GRID_X - FOOTER       = 3096  (262.1mm)
GRID_ASPECT = GRID_H / GRID_W                    ≈ 1.4387
```

**この箱は版によらず固定**です。版が変わると箱の分割数（`cols×rows`）だけが変わります。

セル寸法:

```
cellWpx = GRID_W / cols        cellWmm = cellWpx * 25.4/300
cellHpx = GRID_H / rows        cellHmm = cellHpx * 25.4/300
minCellMm = min(cellWmm, cellHmm)
```

セル `(col, row)` の矩形（箱内 px）:

```
x = GRID_X + (col / cols) * GRID_W
y = GRID_Y + (row / rows) * GRID_H
w = GRID_W / cols
h = GRID_H / rows
```

### 1-3. 四隅マーカー（紙面ファインダ）

箱の **外側**、用紙の四隅に **90×90px の塗りつぶし正方形** を 4 個置きます。
中心座標は次のとおり（`half = FINDER/2 = 45`）:

| 位置 | x | y |
|---|---|---|
| TL | `GRID_X - GAP - half` = 95 | `GRID_Y - GAP - half` = 95 |
| TR | `GRID_X + GRID_W + GAP + half` = 2385 | 95 |
| BR | 2385 | `GRID_Y + GRID_H + GAP + half` = 3329 |
| BL | 95 | 3329 |

読み取り側はこの 4 個を連結成分として検出し、箱の四隅座標へ換算します。

> ⚠️ **盤面内部のファインダ（§2-2 の 7×7）とは別物です。** 紙面四隅の
> 塗りつぶし正方形は旧 cardloader 由来の「箱を見つける」ためのマーカー、
> 盤面内部の 7×7 は QR 由来の機能モジュールです。

### 1-4. 描画規則

- **黒セルのみを塗る**（白セルは何もしない）。中間調は使わない（二値固定）。
- 隣接セルの滲み・重なりを避ける **内側詰め (inset)**:
  `inset = min(0.5px, セル寸法 × 0.06)` を四方に適用する。
  高密度版でセル面積が削られすぎるのを防ぐため、固定 0.5px ではなく比例させます。
- 箱の直下に人間可読フッタを 1 行描く（データではない）:
  `SNCR2 v{version} ECC{key}  page {n}/{total}  {filename}`
- **拡張ティアの倍率**: `scale = max(1, requiredDpi / 300)`。
  canvas を `PAGE_W*scale × PAGE_H*scale` にし、300dpi 座標系に `scale` をかけて描く。
  **物理寸法（A4）は不変で、画素密度だけが上がります。**

### 1-5. 版とティア

| ティア | version | cols | セル (短辺) | `requiredDpi` |
|---|---|---|---|---|
| 標準 (std) | 1〜14 | 60, 77, 90, 108, 120, 132, 145, 160, 175, 190, 205, 220, 235, 250 | 3.04〜0.73mm | 300 |
| 拡張 (ext) | 15〜20 | 265, 280, 296, 312, 330, 348 | 0.69〜0.52mm | 300（ver15）／600（ver16〜20） |

`rows` は `cols` から箱アスペクトに合わせて決まります（`rows ≈ cols × 1.4387`）。

`requiredDpi` は「1 セルあたり 8px 以上」を確保する dpi を 300 刻みへ切り上げた値です:

```
requiredDpi(cols, rows) = max(300, ceil( (8 * 25.4 / minCellMm) / 300 ) * 300)
```

> **ver15 は拡張ティアですが `requiredDpi === 300`** です
> （0.688mm @300dpi = 8.1px/セル）。「ver15 以上は 600dpi」と決め打ちしないこと。

| version | cols×rows | minCellMm | requiredDpi |
|---|---|---|---|
| 14 | 250×360 | 0.728 | 300 |
| 15 | 265×381 | 0.688 | 300 |
| 16 | 280×403 | 0.650 | 600 |
| 17 | 296×426 | 0.615 | 600 |
| 18 | 312×449 | 0.584 | 600 |
| 19 | 330×475 | 0.552 | 600 |
| 20 | 348×501 | 0.523 | 600 |

---

## 2. 盤面（モジュールグリッド）

### 2-1. 表現

- `modules`: 長さ `cols*rows` の配列。`0`=明(白) / `1`=暗(黒)。**row-major**。
- 添字: `index(x, y) = y * cols + x`
- `isFunction`: 同じ長さ。`1`=機能モジュール（マスク対象外・データ非搭載）。

### 2-2. 機能モジュールの配置（この順序で敷く）

`buildFunctionGrid(cols, rows)` の処理順です。**後から敷くものが先を侵さない**
規則があるため、順序に意味があります。

#### (1) ファインダ 7×7（3 隅）

QR と同じ図形を **TL / TR / BL** に置きます（右下は無し）。

- 原点: TL = `(0,0)`、TR = `(cols-7, 0)`、BL = `(0, rows-7)`
- `dx, dy ∈ [-1, 7]` の範囲を機能モジュールとして予約
- `dx` または `dy` が `-1` か `7` → **セパレータ（白）**
- 7×7 本体: 外周（`dx`/`dy` が `0` か `6`）＝黒、中央 3×3（`2..4`）＝黒、その間＝白

```
- - - - - - - - -      - = セパレータ(白)
- # # # # # # # -      # = 黒
- #       # #  -
- #  # # #  # -        （QR と同一の同心正方形）
- #  # # #  # -
- #  # # #  # -
- #       # #  -
- # # # # # # # -
- - - - - - - - -
```

#### (2) タイミングパターン

- 横: `y = 6`、`x = 8 .. cols-9`。`modules = (x % 2 === 0) ? 1 : 0`
- 縦: `x = 6`、`y = 8 .. rows-9`。`modules = (y % 2 === 0) ? 1 : 0`
- 既に機能モジュールのセルは上書きしない。

#### (3) フォーマット情報領域の予約（値は後で書く）

`formatCells(cols, rows)` が返す 2 コピー・各 15 セルを予約します。

- **コピー1**（TL ファインダの周囲の L 字）: 順に
  `(8,0) (8,1) (8,2) (8,3) (8,4) (8,5) (8,7) (8,8)`（`y=6` を除く）→
  `(7,8) (5,8) (4,8) (3,8) (2,8) (1,8) (0,8)`（`x=6` を除く）の先頭 15 個
- **コピー2**: `(cols-1,8) (cols-2,8) … (cols-8,8)` の 8 個 →
  `(8, rows-7) (8, rows-6) … (8, rows-1)` の 7 個 → 計 15 個

#### (4) ダークモジュール

`(8, rows-8)` を **常に黒** の機能モジュールにする（QR の dark module 相当）。

#### (5) アライメントパターン 5×5

`alignmentCenters(cols, rows)` の各中心 `(cx, cy)` に、
`dx, dy ∈ [-2, 2]` の 5×5 を描きます。

- 既に機能モジュールのセルは **侵さない**（`isFunction` が立っていたらスキップ）
- `ring = max(|dx|, |dy|)`。`ring === 0`（中央）または `ring === 2`（外周）が黒、`ring === 1` が白

```
# # # # #
#       #
#   #   #
#       #
# # # # #
```

##### アライメント中心座標の求め方

**1 軸ぶん**（`axisPositions(n, density)`、`n` は `cols` または `rows`）:

```
if (n < 21) return []                       // 小さすぎる軸には置かない
span = (n - 7) - 6
if (span <= 0) return [6]
numAlign = max(3, round(span / density) + 1)
step = ceil( span / (numAlign - 1) / 2 ) * 2        // 偶数化
result = [6]
for (pos = n - 7; result.length < numAlign && pos > 6; pos -= step)
    result.splice(1, 0, pos)                        // 先頭 6 の直後へ挿入
// 末尾に n-7 が無ければ足して昇順ソート、重複除去
```

両端に **必ず `6` と `n-7` を含みます**（ファインダ側との整合）。

**density（目標間隔・セル単位）の決め方**（`defaultDensityFor`）:

```
if (cols ∈ LEGACY_COLS) density = 20              // 標準ティア = 凍結値
else                    density = clamp( round( 20 * sqrt(11.3 / cellPx) ), 10, 34 )
```

- `LEGACY_COLS` = `{60, 77, 90, 108, 120, 132, 145, 160, 175, 190, 205, 220, 235, 250}`
- `cellPx = min(GRID_W/cols, GRID_H/rows)`、基準点は ver10（`2152/190 ≈ 11.33px`）
- 意図: bilinear 補間の残差を「セル単位で一定」に保ちながら個数を減らす
  （`p_cells ∝ 1/√cellPx`）。

**2 軸の合成**（`alignmentCenters`）: `xs × ys` の直積から、
四隅ファインダと衝突する 3 点 — `(xs[0], ys[0])` TL / `(xs[last], ys[0])` TR /
`(xs[0], ys[last])` BL — を除外します（BR は除外しない）。

> 🚫 **SNCR2 に「バージョン情報パターン」はありません。** QR にある版数の
> 盤面表現は持たず、版はヘッダ `byte[2]` と読み取り側の全版試し読みで確定します
> （その 36 セルぶんが容量になっています）。

### 2-3. データセルの列挙と bit 充填

```
dataCells = [ index(x,y) | isFunction[index(x,y)] === 0 ]   // row-major（左上→右下）
```

この順に、**MSB first** で次を詰めます。

```
n = 0 .. 143         : header[18B] の bit（144 bit）
n = 144 ..           : payloadGross の bit
残り                  : 0 埋め
```

bit の取り出しは `bit = (bytes[i >> 3] >> (7 - (i & 7))) & 1`。

> QR のジグザグ縦走査ではなく **row-major** です。スキャナ前提で射影補正済みの
> グリッドを走査するため、局所破損の分散はインターリーブ（§4-3）が担います。

### 2-4. データ容量

**実測値**が正です（`dataCapacityBytes`）。

```
dataBytes  = floor( count(isFunction === 0) / 8 )
grossBytes = max(0, dataBytes - 18)          // ヘッダ 18B を差し引いた payload グロス
```

`qr-version.js` の `functionModuleCount` / `rawDataBytes` は版表を設計するための
**近似モデル**で、実際の容量計算には使われません。

### 2-5. マスク

1. データ充填後、`chooseBestMask` が **8 種すべて**を試す。
2. 各マスクを `isFunction === 0` のセルにのみ XOR 適用する。
3. `getPenaltyScore`（N1 連続同色ラン / N2 2×2 同色 / N3 疑似ファインダ /
   N4 黒白比率の偏り）を計算し、**最小スコア**のマスクを採用する。
4. マスク式・ペナルティ係数は nayuki 版と同一。長方形化のための変更は
   「走査軸長を引数化」「N4 の総数を `cols*rows` にする」の 2 点のみ。

`applyMask` は XOR なので **involution** です（同じマスク番号を再適用すると元に戻る）。
復号側はフォーマット情報から読んだマスク番号を再適用します。

### 2-6. フォーマット情報（15 bit・2 コピー）

QR と同じ **BCH(15,5)**:

```
data5 = ((eccLevel & 3) << 3) | (mask & 7)
rem   = data5
repeat 10 times:  rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537)
bits  = ((data5 << 10) | rem) ^ 0x5412        // 15 bit
```

- 生成多項式 `0x537`、マスク定数 `0x5412`（どちらも QR と同一）
- §2-2(3) の 2 コピーへ **MSB first** で書く
- 復号は両コピーを読み、32 通りの候補との最小ハミング距離で復元し、
  距離が小さい方のコピーを採用する

> ⚠️ **フォーマット情報の `eccLevel` は 2bit しかありません。** ECC が 8 段階に
> 増えたため、ここに載るのは下位 2bit だけです。**正しい `eccLevel` は
> ヘッダ（§3）から読みます**。フォーマット情報は主にマスク番号の伝達に使います。

---

## 3. ヘッダ（論理 12byte → 物理 18byte）

### 3-1. 論理レイアウト（12byte）

| offset | 内容 |
|---|---|
| `[0]` | MAGIC0 = `0x4E` (`'N'`) |
| `[1]` | MAGIC1 = `0x43` (`'C'`) |
| `[2]` | `(version & 0x3F) \| ((eccLevel & 0x03) << 6)` |
| `[3]` | `pageIndex`（0-based） |
| `[4]` | `totalPages` |
| `[5..6]` | `payloadLen`（**BE16**。このページの正味バイト数） |
| `[7]` | `flags`（下記） |
| `[8..10]` | `totalFileLen`（**BE24**。ファイル全体のバイト数・最大 16MiB） |
| `[11]` | `checksum` = `XOR of bytes[0..10]` |

#### `byte[2]`

```
bit: 7 6 5 4 3 2 1 0
     └ecc┘ └──version──┘
```

- 下位 6bit = `version`（1〜63 まで表現可能。現行は 1〜20）
- 上位 2bit = `eccLevel` の **下位 2bit**

#### `byte[7]` = `flags`

| bit | 定数 | 意味 |
|---|---|---|
| 0 (`0x01`) | `FLAG_ECC_BIT2` | `eccLevel` の **bit2** |
| 1 (`0x02`) | `FLAG_CONTINUATION` | 2 ページ目以降（1 ページ目から続くページ） |
| 2〜7 | — | 予約（常に 0） |

`eccLevel` の復元:

```
eccLevel = ((byte[2] >> 6) & 0x03) | ((byte[7] & 0x01) ? 0x04 : 0)
```

##### なぜ `byte[7]` を転用できたのか（後方互換の要点）

旧仕様では `byte[7..10]` が `totalFileLen` の **BE32** でした。
物理上限は 255 ページ × 約 20KB ≒ 5MiB なので、`byte[7]`（最上位バイト）は
**構造上必ず 0** になります。そこでここを `flags` に転用し、`totalFileLen` を
BE24（16MiB）へ縮めました。

**帰結**: 旧カードは `byte[7] === 0` なので「flags 無し・`eccLevel` 0〜3」と
解釈され、そのまま読めます。この不変条件は `test/compat-selftest.js` が
機械的に固定しています。

### 3-2. 物理 18byte

```
physical[18] = RS_encode(logical[12], nsym = 6)
```

- ヘッダは **本体の ECC レベルに依らず常に一定の強度**（`nsym=6` → 最大 3byte 訂正）で守られます。
- 復号は次の順:
  1. 18byte を `RS.decode(cw, 6)`
  2. `checksum = XOR of bytes[0..10]` を検算
  3. MAGIC が一致し、かつ（RS 成功 または checksum 一致）ならフィールドを採用
  4. RS が破綻していても、生 12byte が偶然無傷（MAGIC + checksum が通る）なら救済

`parseHeader` は MAGIC 不一致かつ訂正失敗なら `null` を返します。

### 3-3. ECC レベル表（wire 値）

| level | key | ratio | 備考 |
|---|---|---|---|
| 0 | `none` | 0% | RS 無効（生ビットダンプ） |
| 1 | `low` | 10% | 旧 4 段階 |
| 2 | `med` | 20% | 旧 4 段階 |
| 3 | `high` | 30% | 旧 4 段階・既定 |
| 4 | `vlow` | 5% | 追加（`flags` bit0 が必要） |
| 5 | `lomed` | 15% | 追加 |
| 6 | `medhi` | 25% | 追加 |
| 7 | `max` | 40% | 追加 |

**番号順 ≠ 率順**です。0〜3 は旧 4 段階の wire 値を固定したまま 4〜7 を後付けしたためで、
**この番号は絶対に並べ替えてはいけません**（印刷済みカードの ECC 解釈が変わります）。

パリティ長は `eccNsym(eccLevel)` が返します（`round(255 × ratio)` を偶数へ丸めた値）。
現行の実測値:

| level | key | ratio | `nsym` |
|---|---|---|---|
| 0 | `none` | 0% | 0（RS 無効） |
| 4 | `vlow` | 5% | 14 |
| 1 | `low` | 10% | 26 |
| 5 | `lomed` | 15% | 38 |
| 2 | `med` | 20% | 52 |
| 6 | `medhi` | 25% | 64 |
| 3 | `high` | 30% | 78 |
| 7 | `max` | 40% | 102 |

---

## 4. payload の符号化

### 4-1. RS ブロック割り（`blockPlan(grossBytes, eccLevel)`）

```
nsym = eccNsym(eccLevel)
if (nsym === 0) return [{ dataLen: grossBytes, nsym: 0 }]     // RS 無効

nblocks = max(1, ceil(grossBytes / 255))       // 符号語長 ≤255 に収める
base    = floor(grossBytes / nblocks)
extra   = grossBytes - base * nblocks          // 先頭 extra 個が +1 byte

各ブロック i:  cwLen  = base + (i < extra ? 1 : 0)
               dataLen = max(0, cwLen - nsym)
               nsym    = nsym
```

**端数バイトを捨てません**（グロスをブロック間で均等割りし、余りを先頭ブロックへ配る）。

正味容量 `net = Σ dataLen`。

### 4-2. Reed–Solomon

- 体: **GF(2⁸)**、既約多項式 `0x11D`、原始元 `r = 0x02`（**nayuki と同一**）
- 生成多項式: `(x − r⁰)(x − r¹)…(x − r^{nsym−1})`（`r⁰` 始まり）
- 符号語 = `data ‖ parity[nsym]`（パリティは末尾）
- 訂正能力: 1 ブロックあたり `t = floor(nsym / 2)` byte
- decode は シンドローム → Berlekamp-Massey → Chien 探索 → Forney
- **能力超過時は `ok:false`**（誤ったデータを成功として返さない）

### 4-3. インターリーブ

各ブロックを RS 符号化したあと、バイト単位で「縦に」取り出して並べます。

```
出力 = cw[0][0], cw[1][0], …, cw[k-1][0],
       cw[0][1], cw[1][1], …, cw[k-1][1],
       …
```

ブロック長が不均等（§4-1 の端数割り）な場合、その列に存在するブロックのみ出力します
（QR と同じ規則）。

**目的**: 紙面上で連続する破損（帯ノイズ・たわみによるバースト）が、復元時に
各ブロックへ 1〜数 byte ずつ分散され、ブロック単位の誤り数が訂正能力内に収まります。

結果を `Uint8Array(grossBytes)` に収め、余りは 0 埋めします。

### 4-4. 復号

```
plan       = blockPlan(grossData.length, eccLevel)
codewords  = deinterleaveBlocks(grossData, plan)
各ブロック  → RS.decode(cw, nsym) → dataLen ぶんを連結
data       = 連結結果の先頭 netLen (= header.payloadLen) バイト
ok         = 全ブロックが RS 成功
```

---

## 5. 複数ページ

### 5-1. 分割

```
perPageNet = netCapacity(prof, eccLevel)
totalPages = max(1, ceil(fileBytes.length / perPageNet))
ページ p の内容 = fileBytes[ p*perPageNet .. min((p+1)*perPageNet, len) )
```

**各ページは完全に自己完結**です（すべてのページが 18B ヘッダを持つ）。
1 枚を紛失・汚損しても、他のページは独立して読めます。

### 5-2. 最終ページの自動縮小

`autoLastPage`（既定 `true`）かつ `totalPages > 1` のとき、最終ページのみ
「残りバイト数が収まる最小の版」へ落とします。

- **縮小方向のみ**（指定版より大きくは絶対にしない）
- 例: ver20 / ECC 高で 14,554B を焼くと、2 ページ目は 50B のために
  14,504B 枠を丸ごと使っていた → ver1（3.04mm セル）へ縮小
- 紙とインクが減るうえ、最終ページのセルが 6 倍大きくなり **読み取りは頑丈になります**

> 当初検討された「2 ページ目以降のヘッダ削除」は、実測で **0.09% しか効かない**のに
> 「1 枚汚損で全滅」という堅牢性の後退を招くため採用していません。

### 5-3. 結合

```
1. 読めたページ（ok && meta）だけを集める
2. 同じ pageIndex が複数あれば最初の 1 枚を採用（同じ紙の二重スキャン対策）
3. pageIndex の昇順に並べる
4. totalFileLen / totalPages は先頭ページの meta から取る
5. 0 .. totalPages-1 のうち欠けている番号を missingPages に記録
6. 各ページの data から payloadLen ぶんを順に詰める
7. ok = (詰めた総バイト数 === totalFileLen) && missingPages が空
```

ページの版が混在していても（§5-2 の縮小があるため）、
「`pageIndex` 順に `payloadLen` ぶんずつ詰める」方式なのでそのまま結合できます。

> ⚠️ **`missingPages` が空でないとき `data` は不完全です。** 成功と誤報しないよう、
> 実装は必ずこれを検査してください。

---

## 6. 圧縮コンテナ（任意・カードの外側の層）

カードフォーマットとは独立した層です。Creator は圧縮した結果をカードへ焼き、
Decoder は復元したバイト列を見て自動判別・展開します。

### 6-1. コンテナ形式

| offset | 内容 |
|---|---|
| `[0..2]` | MAGIC = `0x4E 0x5A 0x31` (`"NZ1"`) |
| `[3]` | `method`（下記） |
| `[4..]` | 元データ長ほかのヘッダ + 本体 |

`method`:

| 値 | 方式 |
|---|---|
| 0 | `STORE`（無圧縮） |
| 1 | `DEFLATE_RAW`（deflate-raw。zlib ヘッダ/checksum なし） |
| 2 | `GZIP` |
| 3 | `BROTLI` |
| 4 | `DEFLATE_JADICT`（deflate-raw + 日本語プリセット辞書） |

### 6-2. 三重の安全策（破損厳禁）

1. 複数方式で圧縮し、**最小の符号語**を選ぶ
2. 圧縮しても元より小さくならなければ `STORE` にする
3. 展開後に **元の長さと一致するか自己検証**（不一致なら例外）

MAGIC を見て判別するため、**無圧縮のバイト列を渡しても安全に素通しします**。

---

## 7. 互換リーダを実装する人へのチェックリスト

読み取り側を別実装するときの最小手順です。

1. **箱を見つける** — 二値化（大津法）→ 連結成分 → 四隅の塗りつぶし正方形
   （§1-3）→ 箱の四隅座標へ換算
2. **版を仮定して盤面をサンプリング** — 射影変換で `(col,row)` → 画像座標。
   `cols×rows` は §1-5 の表から
3. **フォーマット情報を読む**（§2-6）→ マスク番号を得る
4. **デマスク** — 同じマスクを `isFunction === 0` のセルへ XOR（§2-5）
5. **`dataCells` を row-major で列挙**（§2-3）し、先頭 144bit をヘッダ 18B として取り出す
6. **ヘッダを RS(6) で訂正**（§3-2）→ MAGIC `"NC"` を確認 →
   `version` が仮定と一致するか確認。しなければ次の版へ
7. **payload グロスを取り出す** — `grossLen = floor(dataCells.length / 8) - 18`
8. **デインターリーブ → ブロックごと RS 訂正**（§4）→ 先頭 `payloadLen` バイト
9. **複数ページなら結合**（§5-3）
10. **圧縮コンテナなら展開**（§6）

実装の妥当性は `test/compat-selftest.js` の考え方（ver1〜14 × ECC0〜3 の
ビット単位ゴールデン照合）を移植して検証するのが確実です。

### 二値化の注意（実機で最も効いた点）

セル判定を **固定しきい 128** にしないでください。
印刷のドットゲイン（インク滲み）で盤面全体が一律に暗化すると、白背景が 128 を割り、
**白セルまで黒と誤判定されて一度に半数近いセルが反転**します
（固定しきいで flips ≈ 49%、RS 能力を大幅超過）。

本実装は「セル平均の大域 Otsu ＋ 積分画像による局所適応平均のブレンド」で、
輝度ヒストグラムの平行移動に追従します。

---

## 8. 変更してはいけないもの（後方互換）

紙は書き換えられません。以下を変えると **既に印刷されたカードが読めなくなります**。

| 項目 | 参照 |
|---|---|
| `VERSION_COLS_STD`（ver1〜14 の cols） | §1-5 |
| `LEGACY_COLS` のアライメント密度（`20`） | §2-2(5) |
| 機能モジュールの配置規則と敷く順序 | §2-2 |
| データセルの列挙順（row-major）と充填順 | §2-3 |
| マスク式・ペナルティ・フォーマット情報の符号化 | §2-5, §2-6 |
| ヘッダのバイトレイアウトと `flags` の意味 | §3-1 |
| `ECC_LEVELS` の **番号** と `nsym` の算出式 | §3-3 |
| `blockPlan` の割り当て規則 | §4-1 |
| RS の体・生成多項式・パリティ位置 | §4-2 |
| インターリーブの並べ替え規則 | §4-3 |

改造の作法は [`CONTRIBUTING.md`](CONTRIBUTING.md) を参照してください。

---

QRコードは株式会社デンソーウェーブの登録商標です。
QR Code is a registered trademark of DENSO WAVE INCORPORATED in Japan and in
other countries.

SNCR2 は QR コードの技術的な考え方を参考にした独自フォーマットであり、
ISO/IEC 18004 に準拠した QR コードそのものではありません。
