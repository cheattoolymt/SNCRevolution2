# SNCR2 テストガイド

**この文書の目的**: 「どのテストが何を保証しているのか」を明らかにし、
改造時に**どれを必ず通すべきか**を判断できるようにする。

対象読者: コードを改造する人、退行を疑っている人。
改造の手順そのものは [`CONTRIBUTING.md`](CONTRIBUTING.md) を参照。

---

## 0. 前提

- **依存インストールは不要**です。`node test/xxx.js` で直接動きます。
- `jpeg-js` は**テスト専用の任意依存**です。無い環境では
  `test/jpeg-codec.js` が依存ゼロの自前 DCT–量子化コーデックへ自動フォールバックします
  （出荷物 `js/*` と `*.html` は依存ゼロを維持）。
- すべてのテストは **決定的**です（線形合同法 PRNG の seed 固定）。
  同じコードなら毎回同じ結果になります。実行順序にも依存しません。
- テストは DOM / Canvas に触りません（§8 遵守）。A4 画像は Node の生ピクセル
  バッファで合成します。

### 実行方法

```bash
# 個別
node test/design-selftest.js
node test/core-selftest.js
node test/align-selftest.js
node test/decode-message-selftest.js
node test/compat-selftest.js
node test/e2e-selftest.js

# 深掘り（600dpi 版の本物 JPEG 劣化。1 ケース数分かかるので既定から外してある）
SNCR2_DEEP=1 node test/e2e-selftest.js

# まとめて（package.json の scripts）
npm test          # design → core → align → message → e2e
npm run test:design / test:core / test:align / test:message / test:e2e
```

> ⚠️ `npm test` には **`compat-selftest.js` が含まれていません**。
> 後方互換に関わる変更をしたときは**必ず単独で実行**してください。

### 終了コードと読み方

各テストは `PASS` / `FAIL` を行単位で出し、末尾に
`==== 結果: ALL PASS ====`（または `FAIL` 件数）を表示します。
失敗が 1 件でもあれば終了コードが非 0 になります。

---

## 1. テスト一覧（何を保証しているか）

| テスト | 所要 | 種類 | 何を守っているか |
|---|---|---|---|
| `design-selftest.js` | 数秒 | 設計制約 | 箱定数・セル下限・容量モデル・ECC 単調性。**容量表も出力** |
| `core-selftest.js` | 数秒 | 単体 | RS 訂正・インターリーブ・マスク・ヘッダのラウンドトリップ |
| `align-selftest.js` | 数十秒 | 単体 | 内部アライメント検出の局所化精度とその実利 |
| `decode-message-selftest.js` | 数十秒 | 契約 | 失敗文言が実態と一致すること（`reason` の意味） |
| `compat-selftest.js` | 数秒 | **後方互換** | 既存 ver1〜14 カードがビット単位で不変（ゴールデン照合） |
| `e2e-selftest.js` | 数分 | e2e | 印刷→スキャン→復元の 1 サイクル・劣化耐性・容量到達 |
| `payload-rsfail-diag.js` | 数十秒 | **調査ツール** | テストではない。原因を数値で切り分ける計測器 |

### ヘルパ（テストではない）

| ファイル | 役割 |
|---|---|
| `test/render-helper.js` | `creator.html` の canvas 描画を Node の生ピクセルで再現。劣化シミュレータ（`warpCenterBulge` / `rotate` / `blur` / `dotGain` / `dotGainBinary` / `addNoise`）と、真値計算用の順写像（`bulgePointForward` / `rotatePointForward`）を提供 |
| `test/jpeg-codec.js` | `roundtrip`（本物優先）/ `roundtripReal`（jpeg-js 必須）/ `roundtripDCT`（依存ゼロ）。JPEG のブロックノイズ・リンギングを再現 |

---

## 2. `design-selftest.js` — §2〜§4 の設計制約

**性格**: 純粋な数値検証。画像を作らないので速い。容量表の出力元でもあります。

固定している契約:

- **§2 箱定数** — `PAGE 2480×3508` / `GRID_X = GRID_Y = 164` /
  `GRID_W = 2152` / `GRID_H = 3096` / `GRID_ASPECT ≈ 1.4387` / 四隅マーカー 4 点
- **§3 アライメント座標** — 軸ごとに昇順、両端が必ず `6` と `n-7`、
  長方形では `xs ≠ ys` になり得る、四隅衝突 3 点の除外
- **§4 容量モデル** — `nsym` の偶数丸め、`blockPlan` が**端数を捨てない**、
  符号語長 ≤255、ヘッダ `12+6=18`
- **セル下限** — 標準ティア（ver1〜14）は 0.7mm、拡張ティア（ver15〜20）は 0.50mm
- **標準ティアの凍結** — ver1〜14 の cols 列、アライメント密度 `20`、
  ver14 のアライメント個数 `218`、ver14 の実測グロス
- **容量到達** — ver14 グロス ≥ 10KiB、ver20 グロス ≥ 20KiB（=20480B）、
  拡張ティア最大版の ovh% < 5% かつ ver14 より小さい
- **ECC 8 段階** — 率の昇順に `nsym` も単調増加、`none` と `low` の間に `vlow`(5%) がある

出力される容量表（抜粋）:

```
ver tier cols rows  cell(mm)  floor  dpi  ovh%  aln   d  gross   none   vlow ...
 14  std  250  360 0.73x0.73  0.7mm  300   6.8  218  20  10471  10471   9883 ...
 20  ext  348  501 0.52x0.52  0.5mm  600   4.0  244  27  20907  20907  19759 ...
```

**必ず通すべき変更**: `qr-geometry.js` / `qr-align.js` / `qr-version.js` を触ったとき。

---

## 3. `core-selftest.js` — §5〜§7 のコアロジック

**性格**: 純粋関数の単体テスト。画像を作りません。

固定している契約:

- **RS（`qr-rs.js`）**
  - テーブル版 `gfMul` が nayuki の `reedSolomonMultiply` と **全 256×256 で一致**
  - `t = floor(nsym/2)` 個以下の誤りを**全て**訂正できる
  - 能力超過時は `ok:false`。**誤ったデータを `ok:true` で返さない**（サイレント誤復元の防止）
- **§5 インターリーブ**
  - `interleave` / `deinterleave` のラウンドトリップ
  - `encodePayload` / `decodePayload` のラウンドトリップ
  - **バーストエラー分散**: 最大版・ECC 高（42 ブロック）で **1310 byte の連続破損**を
    完全復元（単一ブロックの訂正能力 `t=39` を遥かに超える量）
- **§6 マスク**
  - `applyMask` が **involution**（同じマスクを再適用すると元に戻る）
  - 全 8 マスクを評価して最小スコアを選んでいること
- **§7 ヘッダ**
  - 無誤り 2000 件のラウンドトリップ
  - 1〜3byte 誤り 2000 件の訂正
- **統合** — §5+§6+§7 を通した 1 ページぶんの符号化 → グリッド化 → マスク → 復号

**必ず通すべき変更**: `qr-rs.js` / `qr-interleave.js` / `qr-mask.js` /
`qr-header.js` / `qr-core.js` を触ったとき。

---

## 4. `compat-selftest.js` — 後方互換（最重要）

**性格**: **ゴールデン値照合**。紙は書き換えられないため、このテストの意味は
他と質的に違います。

### なぜ必要か

容量拡張で触った箇所は、どれも「既存カードのビット配置を変えうる」危険な場所でした。

| 触った箇所 | 壊れ方 |
|---|---|
| `qr-align.js` のアライメント密度 | パターン位置＝機能モジュール位置が動き、データセルの並びが総崩れ |
| `qr-version.js` のオーバーヘッドモデル | 容量が変わると `blockPlan` が変わり、RS 符号語の並びが変わる |
| `qr-header.js` の `byte[7]` 転用 | ヘッダの意味が変わると版・ECC の解釈がずれる |

これらを「新版だけに効かせ、既存版には一切影響させない」設計にしたことを、
**拡張前コミット（f2546dd）で実測したハッシュ**と照合して機械的に固定します。

### 固定している契約

ver1〜14 × ECC 0〜3（= 拡張前に存在した全 56 通り）について:

- `cols × rows`（グリッド寸法）
- 正味容量 `net` / グロス容量 `gross`
- `encodePage` が出力する `modules`（マスク済み全モジュール）の **SHA256**
- 物理ヘッダ 18byte の **SHA256**

加えて:

- 標準ティアの構造不変（cols 列・アライメント密度 20・ver14 の 218 個・実測グロス）
- 従来 ECC（0〜3）・単票のヘッダは `byte[7] === 0`（旧仕様とバイト一致）
- **旧仕様ヘッダ（`byte[7]=0` ・`totalFileLen` BE32）を新コードが同一に解釈する**
  → 既に印刷済みのカードが読めることの機械的な保証
- 新 ECC（4〜7）のときだけ `byte[7]` に ECC bit2 が立つ
- ver1〜14 × ECC 0〜3 の 56 通りが復号できる

### 🔴 このテストが落ちたときの意味

「既に印刷された紙が読めなくなった」ということです。
**ゴールデン値を書き換えて通すのは絶対に禁止**です。実装側を直してください。

**必ず通すべき変更**: 盤面・ヘッダ・容量に関わるあらゆる変更
（`qr-geometry.js` / `qr-align.js` / `qr-version.js` / `qr-core.js` /
`qr-header.js` / `qr-interleave.js` / `qr-mask.js` / `card-format.js`）。

---

## 5. `align-selftest.js` — 内部アライメント検出の精度（§3 / §10-8）

**性格**: 「四隅ホモグラフィの成否とは独立に」内部アライメント検出だけを評価する単体テスト。

### 背景

実機 level3（たわみ + 回転 + 強ぼかし + ドットゲイン）で
「四隅検出は正確なのに全版で MAGIC 不一致」という報告がありました。
四隅ホモグラフィと内部アライメント検出は別系統なので、四隅が正しくても
内部検出が崩れれば制御点メッシュが歪み、サンプリング格子が全面でずれて MAGIC ごと
破綻し得ます。

### “真値” の取り方（このテストの肝）

以前の場当たり検証は「劣化後の検出中心」を**クリーン画像上のセル中心**と比較して
誤差 2〜3 セルを観測し、内部検出が壊れていると**誤認**していました。
実際は、たわみ・回転で真のパターン中心が動いているだけで、検出はその動いた先を
正しく捉えていました（＝偽アラーム）。

本テストは `render-helper` の順写像（`bulgePointForward` / `rotatePointForward`）で
「劣化後に真のパターン中心が現れる座標」を厳密に計算し、そこに対して検出誤差を測ります。

### 固定している契約

| 仮説 | 内容 |
|---|---|
| §A-1 | クリーン/単一劣化（ぼかし・ドットゲイン・JPEG）で検出率が高く、局所化誤差 < 0.5 セル |
| §A-2 | level3 複合劣化でも、真の（劣化後）中心へ高精度に追従する |
| §A-3 | level3 で「メッシュ ON」のモジュール反転数が「OFF（四隅のみ）」より桁違いに小さい |
| §A-4 | 本物の JPEG（jpeg-js）を通しても §A-2 / §A-3 が保たれる |

**必ず通すべき変更**: `decode-core.js` の `refineAlignment` /
`buildControlMesh` / `sampleModules`、および `qr-align.js`。

---

## 6. `decode-message-selftest.js` — 失敗文言の契約

**性格**: UI の表示が実態と一致することの回帰テスト。

### 背景（実際にあった不具合）

`decoder.html` は復元失敗時に `r.reason || ('ver' + r.version + ' 未確定')` を
表示していました。ところが `decodeAnyVersion()` は、

- ヘッダ RS が完全成功（`meta.magicOk` / `meta.ok` = true で版・ECC・ページまで確定）
- しかし **本文（payload）の RS 訂正だけが失敗**

という状態で `reason` キーを**一度もセットしないまま**返していました。その結果、

| 実態 | 表示 |
|---|---|
| 版すら不明（完全な検出失敗） | 「verX 未確定」 |
| 版は確定・本文復元だけ失敗 | 「verX 未確定」（**同じ文言**） |

となり、利用者が原因を誤認していました（「ECC の問題ではなさそう」という誤解）。

### 固定している契約

- `decodeAnyVersion` は「ヘッダ RS 完全成功・本文 RS 失敗」の状態で
  `reason === 'payload-rs-fail'` かつ `meta.ok === true` を返す
- 文言が「ver 不明・検出失敗」と「verX 確定・本文の誤り訂正に失敗」を
  **明確に区別する**

**必ず通すべき変更**: `decode-core.js` の戻り値、`decoder.html` の `describeFailure()`。

---

## 7. `e2e-selftest.js` — 印刷→スキャン→復元の 1 サイクル（§10）

**性格**: 本命の統合テスト。次のサイクルをまるごと回します。

```
encodePage
  → renderPage（A4 のピクセル画像。版が要求する dpi 相当）
  → 劣化シミュレーション（傾き・ぼかし・中央たわみ・帯ノイズ・汚れ・ドットゲイン・本物 JPEG）
  → decode-core（四隅検出 + §3 アライメント制御点メッシュ + サンプリング）
  → decodePageModules（§5 RS 訂正）
  → 元バイト列と一致するか
```

### 検証する仮説

| § | 内容 |
|---|---|
| §10-1 | アライメント ON が OFF に**劣化せず**、かつ「OFF は失敗するが ON は成功する」たわみ帯域が存在する |
| §10-2 | 実運用に近い複合劣化（JPEG 近似ぼかし + 傾き + 帯ノイズ + 汚れ）でも ECC 高で復元できる |
| §10-3 | クリーン画像で**全 20 版 × 全 8 段階 ECC**（160 通り）がラウンドトリップし、最大版と複数ページ結合も復元できる |
| §10-4 | 【実機フィードバック】全面均一劣化（ドットゲイン）でも適応しきい化で復元できる |
| §10-5 | 【実機フィードバック】複合劣化 level1→level3（level3 = たわみ + 回転 1.3° + 強めぼかし + ドットゲイン。実機で破綻が判明したパターン）でも復元できる |
| §10-6 | 本物の canvas JPEG（jpeg-js）越しの複合劣化でも復元できる |
| §10-7 | ver14 満載 + ドットゲイン + 分数リサンプル + 本物 JPEG（q40/30/25）が RS 能力内に収まる |
| §10-10 | 【容量拡張】拡張ティア ver15〜20 が要求解像度で ECC 高の満載を復元でき、**15KB / 20KB を A4 1 枚**で取り出せる |
| §10-11 | 【容量拡張】§D の最終ページ自動縮小が働き、混在版のページ群を自動判別で結合復元でき、かつ**ページ欠落を成功と誤報しない** |

### メモリと時間について

- 600dpi の A4 は 1 枚 **4960×7016px（RGBA で約 139MB）**になります。
  劣化チェーンは各段の直後に前段バッファを解放し、ピークを 2 枚ぶんに抑えています。
- 本物 JPEG 往復を伴う §10-6 の 600dpi 版（ver16〜20）は 1 ケース数分かかるため
  既定から外し、`SNCR2_DEEP=1` で opt-in します。
- 高速化のため、テスト内の `roundtrip` は `decodeAnyVersion` に
  `{versions:[version], invert:false}` を渡して試し読みを絞っています
  （**プロダクションの `decoder.html` は既定＝全版自動判別のまま**です。
  自動判別そのものの検証は §10-3 / §10-11 が担います）。

**必ず通すべき変更**: `decode-core.js`、`creator.html` の `renderPage`、
その他あらゆる encode/decode 経路の変更。

---

## 8. `payload-rsfail-diag.js` — 調査ツール（テストではない）

**性格**: PASS/FAIL を出しません。**原因を数値で切り分けるための計測器**です。

```bash
node test/payload-rsfail-diag.js          # 数値レポート
node test/payload-rsfail-diag.js --json   # 機械可読サマリ（1 行 JSON）
```

「verX 確定なのに本文 RS 失敗」を机上で決定的に再現し、次を計測します。

- モジュール（セル bit）反転率
- RS ブロックごとの byte 誤り数と訂正能力 `t` の関係
- 誤りが「局所バースト」か「全面一様」か（変動係数 CV）

結論は [`INVESTIGATE-payload-rsfail.md`](INVESTIGATE-payload-rsfail.md) にあります。
要約すると **実装バグではなく設計マージンの問題**で、
モジュール反転 約 2.1% が bit→byte で約 15.6% に増幅され、ECC 高の訂正上限
`t/blockLen = 39/250 = 15.6%` とちょうど拮抗するためです。

> 本ツールは PASS/FAIL を持たない計測器なので、サンプリング改善などで数値が
> 数％変動しても「失敗」ではありません（`INVESTIGATE-payload-rsfail.md` に
> 記載の数値は執筆時点のスナップショットです）。見るべきは
> **「平均ブロック誤りが訂正能力 `t` の近傍に張り付いているか」** と
> **「誤りが一様か（CV が小さいか）」** の 2 点です。

---

## 9. 変更内容別・実行すべきテスト早見表

| 変更した場所 | 最低限 | 推奨 |
|---|---|---|
| `qr-geometry.js` | design + **compat** | 全部 |
| `qr-align.js` | design + **compat** + align | 全部 |
| `qr-version.js` | design + **compat** | design, core, compat, e2e |
| `qr-rs.js` | core | core, compat, e2e |
| `qr-interleave.js` | core + **compat** | core, compat, e2e |
| `qr-mask.js` | core + **compat** | core, compat, e2e |
| `qr-header.js` | core + **compat** | core, compat, message, e2e |
| `qr-core.js` | core + **compat** | 全部 |
| `card-format.js` | core + **compat** | 全部 |
| `decode-core.js` | e2e + align + message | 全部 |
| `geometry.js` | e2e + align | e2e, align |
| `compress.js` | — | 手動でブラウザ確認（e2e はカバーしない） |
| `creator.html` の `renderPage` | e2e | e2e, align |
| `decoder.html` の文言 | message | message |
| コメント・docs のみ | — | 変更なしを `git diff` で確認 |

**太字は「落ちたら既存の紙が読めなくなる」テストです。**

---

## 10. テストを追加するときの作法

1. **決定的にする** — 乱数は seed 固定の PRNG（既存テストの `mkData` を踏襲）。
   時刻・環境依存の値を使わない。
2. **依存を増やさない** — 出荷物（`js/*`・`*.html`）の依存ゼロを崩さない。
   テスト専用依存は任意にし、無い環境ではフォールバックさせる。
3. **DOM に触らない** — Node の生ピクセルバッファで完結させる（§8）。
4. **何を固定するのかをファイル冒頭に書く** — 既存テストと同じ密度で、
   「背景（なぜ必要か）」「固定する契約」「実行方法」を明記する。
   後から読む人が「このテストを消してよいか」を判断できることが目的です。
5. **偽アラームを疑う** — `align-selftest.js` の教訓のとおり、
   「真値の取り方」を間違えると健全な実装をバグと誤認します。
   期待値の導出根拠をコメントに残してください。
6. **メモリを意識する** — 600dpi の A4 は 1 枚 139MB。使い終わったバッファは
   `img.data = null` で解放する。

---

QRコードは株式会社デンソーウェーブの登録商標です。
QR Code is a registered trademark of DENSO WAVE INCORPORATED in Japan and in
other countries.
