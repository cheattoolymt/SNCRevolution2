# SNCR2 アーキテクチャ

**この文書の目的**: SNCR2 のコードを初めて読む人が、30 分で「どこに何があるか」
「データがどう流れるか」「触ってよい場所とダメな場所」を把握できるようにする。

対象読者: 改造・移植・デバッグをする開発者。
利用者向けの使い方は [`../README.md`](../README.md) を参照。

---

## 1. 設計の大前提（これを外すと全部崩れます）

| 前提 | 意味 | なぜ |
|---|---|---|
| **二値固定** | 白 / 黒のみ。中間調をデータに使わない | 家庭用プリンタ・スキャナの再現性が唯一まともに信用できる階調だから（§8 禁止事項） |
| **ブラウザ完結** | サーバ不要・外部送信ゼロ・`file://` で動く | 秘密鍵やパスフレーズを焼く用途で、通信が発生しないことが価値になる |
| **UMD 形の純粋関数** | `js/*.js` は DOM に触らず、Node からも `require` できる | 同じコードを e2e テストで機械検証できる（信頼性の担保） |
| **箱は固定** | データグリッドは常に 2152×3096px @300dpi | 版が変わっても紙面の位置合わせロジックが不変になる |
| **スキャナ前提** | カメラは「動く保険」。設計目標には入れない | 0.7mm 級セルはカメラの光量ムラ・手ブレに耐えられない（§2-0） |
| **後方互換は絶対** | 既に印刷された紙は永久に読めなければならない | 紙は書き換えられない。仕様変更で「読めない紙」を作ると価値が消える |

最後の 1 行が最重要です。詳しくは [`CONTRIBUTING.md`](CONTRIBUTING.md) を参照。

---

## 2. レイヤ構造

```
┌──────────────────────────────────────────────────────────┐
│ UI 層（DOM / Canvas に触る唯一の場所）                    │
│   index.html      … 入口・前提の説明・ライセンス/商標      │
│   creator.html    … 版/ECC 選択、renderPage(canvas 描画)、 │
│                     PNG/PDF 保存                          │
│   decoder.html    … 画像/PDF 入力、結果表示、失敗文言変換  │
└───────────────┬──────────────────────────────────────────┘
                │ CardFormat / SNCR2DecodeCore / NaidesuCompress
┌───────────────┴──────────────────────────────────────────┐
│ ファサード層                                              │
│   js/card-format.js  … 「カードの論理仕様」の窓口。       │
│                        encodeFile / encodePage /          │
│                        decodePageModules / assembleFile   │
│   js/decode-core.js  … 画像 → モジュールグリッド → 復号   │
└───────────────┬──────────────────────────────────────────┘
                │
┌───────────────┴──────────────────────────────────────────┐
│ コア層（QR コアの移植・独自拡張。すべて純粋関数）          │
│   js/qr-core.js       盤面組み立て（機能モジュール+データ）│
│   js/qr-version.js    版表・容量モデル・RS ブロック割り    │
│   js/qr-geometry.js   箱・セル寸法・必要 dpi               │
│   js/qr-align.js      アライメント座標（軸独立）           │
│   js/qr-mask.js       8 マスク・ペナルティ・自動選択       │
│   js/qr-interleave.js RS 符号化 + インターリーブ           │
│   js/qr-header.js     18byte ヘッダ                        │
│   js/qr-rs.js         GF(256) Reed–Solomon（encode/decode）│
└───────────────┬──────────────────────────────────────────┘
                │
┌───────────────┴──────────────────────────────────────────┐
│ 流用層（旧 naidesu-cardloader から無改造）                │
│   js/geometry.js          射影変換・適応サンプリング窓     │
│   js/compress.js          圧縮コンテナ（自動方式選択）     │
│   js/vendor/pako.min.js   deflate/inflate                  │
└──────────────────────────────────────────────────────────┘
```

### グローバル名（ブラウザ）と `require` 名（Node）

| ファイル | `window.*` | Node |
|---|---|---|
| `js/qr-geometry.js` | `SNCR2Geometry` | `require('./js/qr-geometry.js')` |
| `js/qr-align.js` | `SNCR2Align` | 同様 |
| `js/qr-version.js` | `SNCR2Version` | 同様 |
| `js/qr-rs.js` | `SNCR2RS` | 同様 |
| `js/qr-interleave.js` | `SNCR2Interleave` | 同様 |
| `js/qr-mask.js` | `SNCR2Mask` | 同様 |
| `js/qr-header.js` | `SNCR2Header` | 同様 |
| `js/qr-core.js` | `SNCR2Core` | 同様 |
| `js/card-format.js` | `CardFormat` | 同様 |
| `js/decode-core.js` | `SNCR2DecodeCore` | 同様 |
| `js/geometry.js` | `NaidesuGeometry` | 同様 |
| `js/compress.js` | `NaidesuCompress` | 同様 |

**依存の向きは上から下への一方向**です（コア層が UI 層を参照することはありません）。
HTML 側の `<script>` 読み込み順は、この依存順（geometry → align → rs → version →
interleave → mask → header → core → card-format）に一致させる必要があります。

---

## 3. データフロー: 作成（encode）

```
   ユーザーのファイル (Uint8Array)
        │
        │  ① 圧縮（任意・可逆）           NaidesuCompress.compress()
        │     deflate-raw / gzip / brotli / 日本語辞書 deflate / STORE
        │     から最小のものを選び、6byte のコンテナヘッダを付ける
        ▼
   payload バイト列
        │
        │  ② ページ分割                   CardFormat.encodeFile()
        │     1 ページの正味容量 = netCapacity(prof, eccLevel)
        │     最終ページだけは残量が収まる最小版へ自動縮小（§D）
        ▼
   ページごとの payload 断片
        │
        │  ③ ヘッダ生成                   SNCR2Header.buildHeader()
        │     論理 12byte → RS(nsym=6) → 物理 18byte
        │
        │  ④ payload 符号化               SNCR2Interleave.encodePayload()
        │     blockPlan で RS ブロックへ分割 → 各ブロック RS.encode
        │     → インターリーブ（バースト破損を分散させる）
        ▼
   header(18B) + payloadGross(バイト列)
        │
        │  ⑤ 盤面化                       SNCR2Core.encodeGrid()
        │     (a) buildFunctionGrid: ファインダ 3 隅・タイミング・
        │         アライメント・フォーマット情報を敷く
        │     (b) 機能モジュール以外を row-major で列挙し、
        │         header → payload の bit を MSB first で充填
        │     (c) chooseBestMask: 8 マスクを評価し最小ペナルティを採用
        │     (d) placeFormat: eccLevel(2bit)+mask(3bit) を BCH(15,5) で 2 箇所へ
        ▼
   modules: Uint8Array(cols*rows)   0=白 / 1=黒（row-major）
        │
        │  ⑥ 描画                        creator.html renderPage()
        │     四隅ファインダ（塗りつぶし正方形）+ 箱内のセル + フッタ文字
        │     拡張版は canvas を requiredDpi 相当へ拡大（300→600dpi なら 2 倍）
        ▼
   A4 の PNG / PDF → 二値モノクロで等倍印刷
```

### ⑥ の「四隅ファインダ」と ⑤(a) の「盤面のファインダ」は別物

混同しやすいので明記します。

- **紙面の四隅ファインダ**（`CF.FINDER`=90px の塗りつぶし正方形）… 箱の外側、
  用紙の四隅にある。旧 cardloader 由来で、**画像から箱の位置を見つける**ために使う。
  `decode-core.detectCorners` が連結成分として検出する。
- **盤面のファインダ**（QR と同じ 7×7 の同心正方形）… 箱の内側、グリッドの
  TL/TR/BL にある。機能モジュールとしてデータ領域から除外される。

---

## 4. データフロー: 読み取り（decode）

```
   スキャン画像 (PNG/JPEG/PDF)
        │
        │  ① 画素化                      decoder.html imageToData()
        │     {data: RGBA, width, height}
        │     PDF は PDF.js で 600dpi 相当へラスタライズ（メモリ不足時は段階的に低下）
        ▼
   img
        │
        │  ② 四隅検出                    decode-core.detectCorners()
        │     大津法で二値化 → 連結成分 → 四隅の塗りつぶし正方形を同定
        │     → finderToGrid で「箱の四隅」座標へ換算
        │     （invert=false/true の両方を試すので白地/黒地どちらでも動く）
        ▼
   corners（箱の 4 点）
        │
        │  ③ 版候補の並べ替え             decode-core.estimateGridPitch()
        │     セルピッチのスペクトル推定で「正解らしい版」を先頭へ
        │     ※ 速度最適化のみ。候補集合は変えないので正しさに影響しない
        │
        │  ④ 版ごとに試し読み（ループ）
        │     ├ sampleModules(img, corners, cols, rows)
        │     │   ・射影変換（ホモグラフィ）で単位正方形→画像座標
        │     │   ・refineAlignment / buildControlMesh で内部アライメントを
        │     │     実測し、局所的な制御点メッシュへ（たわみ補正）
        │     │   ・適応しきい二値化（大域 Otsu + 局所適応平均のブレンド）
        │     │     → ドットゲイン（全面一律の暗化）に追従
        │     └ CardFormat.decodePageModules(modules, cols, rows)
        │         ・readFormat で mask/eccLevel を BCH 訂正して読む
        │         ・applyMask（XOR なので同じマスクで元に戻る）
        │         ・ヘッダ 18byte を RS 訂正 → version/ecc/page/len 確定
        │         ・payload を deinterleave → ブロックごと RS 訂正
        ▼
   ページごとの復号結果 { ok, data, meta, corrected, version, reason }
        │
        │  ⑤ ページ結合                   CardFormat.assembleFile()
        │     meta.pageIndex 順に payloadLen ぶんだけ詰める
        │     欠番があれば missingPages で報告（成功と誤報しない）
        ▼
        │  ⑥ 自動展開                    NaidesuCompress.autoDecompress()
        │     コンテナ MAGIC 'NZ1' を見て方式判別 → 展開 → 長さ自己検証
        ▼
   元のファイル
```

### 二重の安全網（`decodeAnyVersion` の試行マトリクス）

`decode-core.decodeAnyVersion` は既定で次を**総当たり**します。

| 軸 | 既定値 | 意味 |
|---|---|---|
| `invert` | `[false, true]` | 白地/黒地の両方 |
| version | 全 20 版（ピッチ推定で並べ替え） | 版を紙面に書いていないため |
| `useAlignment` | `[true, false]` | メッシュ ON で失敗したら大域ホモグラフィで再挑戦 |

「メッシュ ON → OFF の二段試行」は §10-1 の仮説
（アライメント ON が OFF に劣化しない）を、静的な当て推量ではなく
**実際に両方試して RS 完全復号できた方を採る**ことで決定的に保証する設計です。

---

## 5. 「なぜこうなっているのか」勘所メモ

改造時に踏みやすい罠を、理由とセットで並べます。

### 5-1. 版数は紙面に書かれていない

QR には version 情報パターンがありますが、SNCR2 は**持ちません**。
版はヘッダ `byte[2]` の下位 6bit と、読み取り側の「全版試し読み」で確定します。
そのぶん盤面のオーバーヘッドが 36 セル減ります（容量拡張で削除した実体）。

**帰結**: 読み取りは版の総当たりが必要 → ピッチ推定で高速化している。
版を増やすと読み取り時間が線形に増えるので、版追加は容量メリットと
速度コストを比較して決めること。

### 5-2. 容量モデルは「近似」と「実測」の 2 系統がある

- `qr-version.js` の `functionModuleCount` / `rawDataBytes` … **近似モデル**。
  版表の設計・容量計算に使う。
- `qr-core.js` の `dataCapacityBytes` … **実測**。`buildFunctionGrid` を実際に
  組んで機能モジュールを数える。`card-format.getProfile` はこちらを採用する。

**帰結**: 表示・分割計算で使われる真の容量は `getProfile().grossBytes`（実測系）。
近似モデルだけを直しても実際の容量は変わりません（逆もまた同様）。

### 5-3. データ充填順は QR のジグザグではなく row-major

QR は右下から 2 列ずつ蛇行しますが、SNCR2 は
**機能モジュール以外を左上→右下の row-major で列挙**して順に詰めます。
スキャナ前提で射影補正済みグリッドを走査するため、ジグザグの利点
（局所破損の分散）が薄く、代わりに §5 のインターリーブが
バースト分散を担っているからです（§8「改造しやすさ最優先」）。

### 5-4. ECC レベル番号は「率の順」ではない

`ECC_LEVELS` は 0=なし / 1=10% / 2=20% / 3=30% の**旧 4 段階の番号を固定**したまま、
4=5% / 5=15% / 6=25% / 7=40% を後ろに足した体系です。
番号順 ≠ 率順なので、UI 表示や掃引は必ず `Ver.eccLevelsByRatio()` を使います。

**理由**: 番号は紙に焼かれる wire 値です。並べ替えると既存カードの ECC 解釈が
変わり、印刷済みの紙が読めなくなります。

### 5-5. `byte[7]` は「必ず 0 になるバイト」を転用した flags

ヘッダを 1byte も増やさずに ECC を 8 段階（3bit 必要）へ拡張するため、
`totalFileLen` BE32 の最上位バイト（物理上限 ≒5MiB なので常に 0）を
flags に転用し、`totalFileLen` を BE24（最大 16MiB）へ縮めています。

**帰結**: 旧カードは `byte[7]==0` なので「flags 無し・ECC 0〜3」と解釈され、
そのまま読めます。この不変条件は `test/compat-selftest.js` が機械的に固定しています。

### 5-6. 適応しきい二値化は「実機で壊れた」ことへの対策

かつて `sampleModules` のセル判定は**固定しきい 128** でした。
全面一律に暗化するドットゲインで白背景が 128 を割ると、白セルまで黒と誤判定され、
一度に半数近いセルが反転して ECC 能力を超えていました（固定しきいで flips≈49%）。

現在は「セル平均の大域 Otsu ＋ 積分画像による局所適応平均のブレンド」で、
輝度ヒストグラムの平行移動に追従します。
`test/render-helper.js` の `dotGain()` と e2e §10-4 / §10-5 が回帰を固定しています。

### 5-7. 満載運用はマージンが 0

ver14・ECC 高（30%）で正味容量ギリギリまで詰めると、1 ブロックの訂正能力
`t/blockLen = 39/250 = 15.6%` に対して、実機ドットゲイン＋低品質 JPEG 時の
平均 byte 誤り率が **15.6%** とちょうど拮抗します（モジュール反転 2.12% が
bit→byte で 8 倍に増幅されるため）。統計的な上振れブロックから順に落ちます。

詳細な計測は [`INVESTIGATE-payload-rsfail.md`](INVESTIGATE-payload-rsfail.md)。
**帰結**: 大事なデータは 1 段低い版＋複数ページ、または ECC を上げる運用にする。

### 5-8. 拡張ティアは「力技の縮小」ではない

ver15〜20 はセルが 0.7mm を割りますが、印刷/スキャンを 600dpi にする前提なので
**1 セルあたりの画素数はむしろ増えます**（0.52mm@600dpi = 12.4px/セル >
0.7mm@300dpi = 8.27px/セル）。`getProfile().requiredDpi` がその版の要求解像度を返し、
`creator.html` の `renderScaleFor` が canvas をその倍率へ拡大します。

なお `requiredDpi` は「1 セル 8px 以上」を 300 刻みへ切り上げた値なので、
**ver15 だけは拡張ティアでも `requiredDpi === 300`** です（0.688mm@300dpi = 8.1px）。
「ver15 以上は必ず 600dpi」とハードコードしないこと。

---

## 6. どこを触ると危険か

| 場所 | 危険度 | 理由 |
|---|---|---|
| `qr-align.js` の密度体系 | 🔴 極大 | アライメント位置＝機能モジュール位置が動き、データセルの並びが総崩れ |
| `qr-version.js` の `VERSION_COLS_STD` | 🔴 極大 | 既存版の cols が変わると既存カードが読めない |
| `qr-header.js` のバイトレイアウト | 🔴 極大 | 版・ECC・ページの解釈がずれる |
| `qr-core.js` の充填順 / 機能モジュール配置 | 🔴 極大 | 盤面のビット配置そのもの |
| `qr-mask.js` のマスク式・ペナルティ | 🟠 大 | マスク番号の意味が変わると復号不能 |
| `qr-interleave.js` の並べ替え規則 | 🟠 大 | RS ブロックの対応がずれる |
| `decode-core.js` のサンプリング | 🟡 中 | 読み取り側だけなので紙は無効化しないが、成功率を退行させ得る |
| `creator.html` の `renderPage` 寸法 | 🟠 大 | `decode-core` の四隅検出・箱定数と厳密一致が必要 |
| UI 文言・コメント・docs | 🟢 小 | 表示のみ |

赤〜橙の箇所を触る場合は、**必ず** `node test/compat-selftest.js` を通してください
（ver1〜14 × ECC0〜3 の 56 通りがビット単位で不変であることをゴールデン値で照合します）。
作法は [`CONTRIBUTING.md`](CONTRIBUTING.md) にまとめてあります。

---

## 7. 次に読むもの

- API を呼びたい → [`API.md`](API.md)
- ビット単位の仕様が欲しい → [`FORMAT.md`](FORMAT.md)
- テストの意味を知りたい → [`TESTING.md`](TESTING.md)
- 改造の作法 → [`CONTRIBUTING.md`](CONTRIBUTING.md)

---

QRコードは株式会社デンソーウェーブの登録商標です。
QR Code is a registered trademark of DENSO WAVE INCORPORATED in Japan and in
other countries.
