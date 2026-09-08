# SNCR2 設計メモ — 実装指示書 §5〜§7

> ## ⚠️ これは「当時の記録」です（歴史的スナップショット）
>
> 本ドキュメントは `sncr.md`（実装指示書）の **§5〜§7 を実装した時点の
> コミット**における設計判断の記録です。文中の「§8〜§11 は保留」「後続に委ねる」
> といった記述は**当時の状況**であり、**現在はすべて実装済み**です。
>
> その後の容量拡張により、とくに **§7 ヘッダの記述が変わっています**。
>
> | 項目 | 本文の記述（当時） | 現在 |
> |---|---|---|
> | 版数 | 14 版 | **20 版** |
> | ECC | `byte[2]` の上位 2bit で 4 段階 | **8 段階**。`byte[2]` 上位 2bit + `byte[7]` bit0 |
> | `byte[7..10]` | `totalFileLen` BE32 | `byte[7]` = **flags**、`byte[8..10]` = `totalFileLen` **BE24**（最大 16MiB） |
> | `nsym`（ECC 高） | 76 | **78** |
>
> **現在のヘッダ仕様**は [`FORMAT.md` §3](FORMAT.md#3-ヘッダ論理-12byte--物理-18byte) を
> 参照してください（`byte[7]` を転用できた理由もそこに書いてあります）。
> API は [`API.md`](API.md)、全体構成は [`ARCHITECTURE.md`](ARCHITECTURE.md)。
>
> 本ドキュメントは **「なぜ RS decode を自前実装したのか」「なぜ byte[2] を
> 再設計したのか」といった理由を読むための資料**として保存しています。
> 以下、当時の本文をそのまま残します。

---

このドキュメントは `sncr.md`（実装指示書）の **§5〜§7** を実装した
コミットの設計判断をまとめたもの。**§8〜§11 は保留**（未実装）。

対応ファイル:

| 指示書 | 実装ファイル | 内容 |
|--------|--------------|------|
| §1-B/§4 RS | `js/qr-rs.js` | GF(256) の encode は nayuki 移植、decode（誤り訂正）は自前実装 |
| §5 インターリーブ | `js/qr-interleave.js` | 旧 cardloader の interleave/deinterleave/encodePayload/decodePayload を踏襲 |
| §6 マスク最適化 | `js/qr-mask.js` | nayuki の 8 マスク＋4 ペナルティ＋最小スコア自動選択を移植（長方形化） |
| §7 ヘッダ | `js/qr-header.js` | 論理 12byte＋RS(nsym=6)=物理 18byte、byte[2] を新版数向けに再設計 |
| コア検証 | `test/core-selftest.js` | §5〜§7 のラウンドトリップ・誤り訂正・統合テスト |

---

## RS（`js/qr-rs.js`）— なぜ decode を自前実装したか

指示書 §1-B / §4 は「Reed-Solomon は nayuki 側の実装に統一する」「GF(256) の
`reedSolomonComputeDivisor` / `reedSolomonComputeRemainder` / `reedSolomonMultiply`
はそのまま使える」と述べる。ここは忠実に移植した（exp/log テーブル版 `gfMul`
が nayuki の `reedSolomonMultiply` と全 256×256 で一致することをテストで保証）。

ただし **nayuki の QR 実装には「誤り訂正 decode」が存在しない**（QR コードの
読み取り＝decode は nayuki ライブラリのスコープ外で、encode 専用のため）。
一方 SNCR2 の目的は「破損したスキャン画像から復元する」ことなので、
§5 のデインターリーブ・§7 のヘッダ復元は必ず訂正付き decode を必要とする。

そこで、**nayuki と完全に同じ体** GF(2⁸)/0x11D・原始元 r=0x02・生成多項式
`(x−r⁰)(x−r¹)…(x−r^{nsym−1})`（r⁰ 始まり）の上で、古典的な RS 訂正デコーダ
（シンドローム → Berlekamp-Massey → Chien 探索 → Forney）を自前実装した。
体と生成多項式が nayuki と一致しているため、nayuki が生成した ECC 符号語を
そのまま訂正できる。API は旧 cardloader の `RS.encode` / `RS.decode`
（`{data, ok, corrected}`）と互換にし、§5/§7 からそのまま呼べるようにした。

- 訂正能力は 1 ブロックあたり `t = floor(nsym/2)` byte。
- 能力超過時は `ok:false` を返し、**誤ったデータを ok:true で返さない**
  ことをテストで担保（サイレントな誤復元を防ぐ）。

---

## §5 インターリーブ（`js/qr-interleave.js`）

旧 cardloader `js/card-format.js` の実装を指示書どおり「ほぼそのまま」移植:

```
出力 = cw[0][0], cw[1][0], …, cw[k-1][0], cw[0][1], cw[1][1], …
```

ブロック長が不均等（§4 blockPlan の端数割り）でも、その列に存在する
ブロックだけを出力する QR 方式。`encodePayload` は §4 の `SNCR2Version.blockPlan`
で各ブロック長を決め、`SNCR2RS.encode` で符号化してからインターリーブする。
`decodePayload` はその逆（デインターリーブ → ブロックごと RS 訂正）。

**効果（§10 検証仮説に対応）**: 印刷物上で連続する領域の破損（帯状ノイズ・
たわみによるバースト）が、復元時に各ブロックへ 1〜数 byte ずつ分散される。
テストでは最大版・ECC 高（42 ブロック）で **1310 byte 連続破損**を完全復元
できることを確認済み（単一ブロックの訂正能力 t=39 byte を遥かに超える）。

---

## §6 マスク最適化（`js/qr-mask.js`）

nayuki `qrcodegen.ts` の以下をそのまま移植:

- `applyMask()` の 8 種マスク式（`(x+y)%2==0` など、x,y 座標のみに依存）
- `getPenaltyScore()` の 4 ペナルティ
  - N1: 連続同色ラン（5 個で +3、以降 1 個ごと +1）
  - N2: 2×2 同色ブロック
  - N3: 疑似ファインダ（1:1:3:1:1 パターン）
  - N4: 黒白比率の偏り（5% 刻み）
- `finderPenalty{CountPatterns,AddHistory,TerminateAndCount}`
- 全 8 マスクを評価し最小スコアを自動選択する仕組み

**長方形化のための最小限の一般化**（マスク式そのものは 1 文字も変えていない）:

- nayuki は「明るい境界」補正に 1 辺長 `this.size` を使っていた。長方形では
  走査軸の長さ（行なら `cols`、列なら `rows`）が正しいので、ペナルティ補助
  関数に軸長 `lineLen` を引数で渡す形へ一般化した。
- N4 の総モジュール数 `total` を `size*size` ではなく `cols*rows` にした。

グリッド表現は他モジュールと共通（`Uint8Array(cols*rows)` の row-major、
0=明/1=暗、`isFunction` で機能モジュールをマスク・評価対象外にする）。
`applyMask` は XOR なので、デコード側は同じマスク番号を再適用すれば
データ領域が元に戻る（involution）ことをテストで確認済み。

---

## §7 ヘッダフォーマット（`js/qr-header.js`）

論理 12byte を RS(nsym=6) で物理 18byte に保護する構造は旧 cardloader / §4-(e)
と同一。バイトレイアウトも指示書どおり:

```
[0..1]  MAGIC = 0x4E 0x43 ("NC")
[2]     version + eccLevel（下記の再設計）
[3]     pageIndex (0-based)
[4]     totalPages
[5..6]  payloadLen (big-endian 16bit)
[7..10] totalFileLen (big-endian 32bit)
[11]    checksum = XOR of bytes[0..10]
```

### byte[2] の再設計（指示書 §7「modeId は bit 数を再設計してよい」）

旧 cardloader の byte[2] は `version_tag(2bit) + modeId(4bit) + ecc(2bit)` で、
`modeId` は「1kb〜10kb の 10 段階サイズプロファイル」を指していた。

SNCR2 では **サイズ選択は §4 の独自バージョン番号**（`SNCR2Version.VERSIONS`、
現在 14 版）が担うため、旧 modeId は version と役割が重複する。冗長な二重管理を
避け、指示書が許可する範囲で byte[2] を次のとおり再設計した:

```
byte[2] = (version & 0x3F) | ((eccLevel & 0x03) << 6)
           └ 下位 6bit: version (1..63)   └ 上位 2bit: eccLevel (0..3)
```

version に 6bit（最大 63 版）を割り当てることで、§7 が懸念する
「新バージョン数が旧 4bit(=16) を超える場合」に将来まで余裕をもって対応できる
（現行 14 版 → 上限 63 版まで拡張可）。MAGIC / pageIndex / totalPages /
payloadLen / totalFileLen / checksum の各フィールドは旧 cardloader と完全同一。

`parseHeader` は 18byte を RS 訂正してから checksum を検算し、
`{version, eccLevel, pageIndex, totalPages, payloadLen, totalFileLen, ok, corrected}`
を返す。テストで無誤り 2000 件・1〜3byte 誤り 2000 件を全て正しく復元できることを確認。

---

## テストの実行

```bash
node test/core-selftest.js    # §5〜§7 + RS のコア検証
node test/design-selftest.js  # §2〜§4 の設計検証（既存・回帰確認）
```

`core-selftest.js` は決定的 PRNG（seed 固定）で再現性を確保し、末尾に
**§5+§6+§7 を通した 1 ページぶんの符号化→グリッド化→マスク→復号**の
統合ラウンドトリップも含む。

---

## このコミットのスコープ外（§8〜§11 は保留）

- §8 禁止事項・非機能要件の最終確認
- §9 成果物一式（`creator.html` / `decoder.html` / `decode-core.js` /
  `geometry.js` / `compress.js` / `pako.min.js` の配線）
- §10 検証（実画像・JPEG 劣化・傾きシミュレーション）
- §11 ライセンス全文の掲載（`LICENSE-THIRD-PARTY.md` 等）

本コミットは §5〜§7 の**コアロジック（DOM 非依存の純粋関数）と検証**までを
確定させ、実際のセル描画・四隅検出サンプリング・UI 配線は後続に委ねる。
