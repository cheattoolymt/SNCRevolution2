# SuperNaidesuCardRevolution II (SNCR2)

`naidesu-cardloader`（旧版）の後継。任意バイナリを紙に印刷し、印刷→スキャンで
復元する静的 HTML/JS 完結ツール。QR コードのコア技術（マスク最適化・アライメント
パターンによる歪み耐性）を移植し、**同じセルサイズ・同じセル数でも読み取り成功率
そのものを底上げする**ことを目的とする。二値（白黒）固定。

> **読み取り機材の想定**: スキャナ（300dpi・正面・等倍・平面固定）を **推奨**。
> スマートフォンカメラ撮影は「動作するが **非推奨**」。0.7mm 級の高密度セルを狙うため、
> スキャナ前提で密度・ECC を設計している（カメラでも一応動く保険は残す）。

## 実装状況

このリポジトリは実装指示書（`sncr.md`）の **§0〜§4 を実装済み**。§5〜§11 は保留。

| 指示書 | ファイル | 内容 |
|--------|----------|------|
| §2 | `js/qr-geometry.js` | A4/300dpi・データグリッド箱 2152×3096px・0.7mm 下限 |
| §3 | `js/qr-align.js` | 長方形・大版向けアライメント座標の軸独立生成 |
| §4 | `js/qr-version.js` | 独自 cols×rows 表・オーバーヘッドモデル・RS ブロック割り・ECC・ヘッダ別保護 |
| 検証 | `test/design-selftest.js` | 上記の設計制約検証＋容量表出力 |

詳細な設計判断は [`docs/DESIGN-0-4.md`](docs/DESIGN-0-4.md) を参照。

### 設計セルフテストの実行

```bash
node test/design-selftest.js
```

§2〜§4 の制約（箱定数・0.7mm 下限・アライメント両端保証・blockPlan の端数不捨・
「A4 1枚 10KB」到達）を検証し、独自バージョンの容量表を出力する。

## 📜 ライセンス

MIT License — Copyright © 2026 cheattoolymt(nyan4)

このプロジェクトは以下のオープンソースを土台にしています:
- naidesu-cardloader (MIT) — https://github.com/cheattoolymt/naidesu-cardloader
- QR-Code-generator by Project Nayuki (MIT) — https://github.com/nayuki/QR-Code-generator

> 注: nayuki QR-Code-generator のライセンス全文の掲載（LICENSE-THIRD-PARTY 等）は
> 指示書 §11 の作業であり、QR コアロジック本体の移植（§5〜§7）と合わせて後続で行う。
