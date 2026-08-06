# SuperNaidesuCardRevolution II (SNCR2)

`naidesu-cardloader`（旧版）の後継。任意バイナリを紙に印刷し、印刷→スキャンで
復元する静的 HTML/JS 完結ツール。QR コードのコア技術（マスク最適化・アライメント
パターンによる歪み耐性）を移植し、**同じセルサイズ・同じセル数でも読み取り成功率
そのものを底上げする**ことを目的とする。二値（白黒）固定。

> **読み取り機材の想定**: スキャナ（300dpi・正面・等倍・平面固定）を **推奨**。
> スマートフォンカメラ撮影は「動作するが **非推奨**」。0.7mm 級の高密度セルを狙うため、
> スキャナ前提で密度・ECC を設計している（カメラでも一応動く保険は残す）。

## 実装状況

このリポジトリは実装指示書（`sncr.md`）の **§0〜§11 をすべて実装済み**。

| 指示書 | ファイル | 内容 |
|--------|----------|------|
| §2 | `js/qr-geometry.js` | A4/300dpi・データグリッド箱 2152×3096px・0.7mm 下限 |
| §3 | `js/qr-align.js` | 長方形・大版向けアライメント座標の軸独立生成 |
| §4 | `js/qr-version.js` | 独自 cols×rows 表・オーバーヘッドモデル・RS ブロック割り・ECC・ヘッダ別保護 |
| §1-B/§4 | `js/qr-rs.js` | GF(256) の encode は nayuki 移植、decode（誤り訂正）は自前実装 |
| §5 | `js/qr-interleave.js` | 旧 cardloader の interleave/deinterleave/encodePayload/decodePayload を踏襲 |
| §6 | `js/qr-mask.js` | nayuki の 8 マスク＋4 ペナルティ＋最小スコア自動選択（長方形化） |
| §7 | `js/qr-header.js` | 論理 12byte＋RS(nsym=6)=物理 18byte、byte[2] を新版数向けに再設計 |
| §1-B/§6/§9 | `js/qr-core.js` | 機能モジュール配置＋マスク最適化＋データ敷き詰め（QR コアの中核） |
| §9 | `js/card-format.js` | A4 ジオメトリ定数＋qr-core への橋渡し＋高水準 encode/decode＋複数ページ |
| §1-A/§9 | `js/decode-core.js` | 四隅検出・§3 アライメント制御点メッシュ・サンプリング・全版試し読み |
| §1-A | `js/geometry.js` / `js/compress.js` / `js/vendor/pako.min.js` | 旧 cardloader から無改造流用 |
| §9 | `index.html` / `creator.html` / `decoder.html` | ランディング・作成 UI・読み取り UI |
| §8 | （下記「§8 禁止事項・非機能要件」） | 二値固定・ブラウザ完結・外部依存最小・改造しやすさ |
| §10 | `test/e2e-selftest.js` | 印刷→スキャン→復元の 1 サイクル e2e（たわみ耐性 ON/OFF 比較・複合劣化・≈10KB 到達） |
| §11 | `LICENSE` / `LICENSE-THIRD-PARTY.md` | 本体 MIT ＋ nayuki/旧 cardloader/pako のライセンス全文 |
| 検証 | `test/design-selftest.js` | §2〜§4 の設計制約検証＋容量表出力 |
| 検証 | `test/core-selftest.js` | §5〜§7＋RS のラウンドトリップ・誤り訂正・統合テスト |

詳細な設計判断は [`docs/DESIGN-0-4.md`](docs/DESIGN-0-4.md) と
[`docs/DESIGN-5-7.md`](docs/DESIGN-5-7.md) を参照。

### セルフテストの実行

```bash
node test/design-selftest.js   # §2〜§4: 箱定数・0.7mm 下限・容量表
node test/core-selftest.js     # §5〜§7: RS 訂正・インターリーブ・マスク・ヘッダ
node test/e2e-selftest.js      # §10: 印刷→スキャン→復元の 1 サイクル e2e
```

- `design-selftest.js`: §2〜§4 の制約（箱定数・0.7mm 下限・アライメント両端保証・
  blockPlan の端数不捨・「A4 1枚 10KB」到達）を検証し容量表を出力する。
- `core-selftest.js`: RS の全訂正（t 個以下）と能力超過時の安全性、§5 の
  バーストエラー分散（最大版で 1310B 連続破損を復元）、§6 マスクの involution と
  最小スコア選択、§7 ヘッダの 1〜3byte 訂正、そして §5+§6+§7 を通した
  1 ページぶんの符号化→マスク→復号の統合ラウンドトリップを検証する。
- `e2e-selftest.js`（§10）: `encodePage → A4/300dpi 画像へ描画 → 劣化
  シミュレーション（傾き・ぼかし・中央たわみ・帯ノイズ・汚れ・**ドットゲイン**）→
  四隅検出＋§3 アライメント制御点メッシュでサンプリング → RS 復号` の 1 サイクルを
  回し、元バイト列と一致するか（ラウンドトリップ成功率）を測る。
  検証する仮説（§10）: **(1)** アライメント ON が OFF に劣化せず、かつ
  「OFF は失敗するが ON は成功する」たわみ帯域が存在すること、**(2)** 実運用に
  近い複合劣化でも ECC 高で復元できること、**(3)** クリーン画像で全版×全 ECC が
  ラウンドトリップし、「A4 1 枚 10KB 前後」到達版と複数ページ結合が復元できること、
  **(4)【実機フィードバック】** 全面均一劣化（ドットゲイン）でも適応しきい化で
  復元できること、**(5)【実機フィードバック】** 単一劣化ではなく複合劣化
  （level1→level3。level3＝たわみ+回転1.3°+強めぼかし+ドットゲイン、実機で
  破綻が判明したパターン）でも復元できること。

  > **実機フィードバック対応（ドットゲイン/複合劣化）**: 実機検証で「局所劣化
  > （汚れ）には強いが、全面一律の劣化（ドットゲイン）に弱い」ことが判明した。
  > 原因は `sampleModules` のセル二値化が**固定しきい 128** だったこと。全面が
  > 一律に暗化して白背景が 128 を割ると白セルまで黒と誤判定され、一度に半数近い
  > セルが反転して ECC 能力を超えていた（固定しきいで flips≈49%）。対策として
  > `js/decode-core.js` の `sampleModules` を**適応しきい化**（セル平均の大域
  > Otsu ＋ 積分画像による局所適応平均のブレンド）へ置き換え、輝度ヒストグラムの
  > 平行移動に追従できるようにした。併せて `test/render-helper.js` に全面均一
  > 劣化を再現する `dotGain()`（モルフォロジー膨張＋ダイナミックレンジ圧縮＋
  > 全面バイアス）を追加し、e2e に §10-4（ドットゲイン耐性）と §10-5（複合劣化
  > level1〜3）のテストを追加した。

### §8 禁止事項・非機能要件（遵守事項）

実装は指示書 §8 の制約を全ファイルで満たしている:

- **多値化・カラー化は禁止（二値固定）**: 描画は `creator.html` の `renderPage`
  で黒セルのみ塗り、読み取りは `card-format.otsuThreshold`（大津法）で二値化する。
  グレースケール/カラーの中間値をデータに用いる箇所は存在しない。
- **完全ブラウザ完結・静的 HTML/JS のみ**: サーバ不要・外部送信なし。すべての
  コアモジュールは DOM 非依存の純粋関数（Node からも `require` できる UMD 形）で、
  Canvas/DOM に触れるのは `creator.html`（描画）と `decoder.html`（画像入力）のみ。
- **外部依存は最小限**: 実行時依存はローカル同梱の `js/vendor/pako.min.js` のみ
  （圧縮）。`creator.html` の jsPDF は PDF 出力の**任意**機能で、読み込み失敗時は
  PNG 保存へ自動フォールバックする（`window.__noJsPDF`）。
- **改造しやすさ最優先**: nayuki 方式のドキュメントコメント密度を踏襲し、各ファイル
  冒頭に責務・入出力・指示書該当章を明記している。

## 📜 ライセンス

MIT License — Copyright © 2026 cheattoolymt(nyan4)（全文は [`LICENSE`](./LICENSE)）

このプロジェクトは以下のオープンソースを土台にしています:
- naidesu-cardloader (MIT) — https://github.com/cheattoolymt/naidesu-cardloader
- QR-Code-generator by Project Nayuki (MIT) — https://github.com/nayuki/QR-Code-generator
  （上記の nayuki ライセンス全文および旧 cardloader・pako の表示は
  [`LICENSE-THIRD-PARTY.md`](./LICENSE-THIRD-PARTY.md) に全文掲載）

> MIT ライセンスの条件（著作権表示および許諾表示をソフトウェアのすべての複製
> または重要な部分に記載すること）を満たすため、QR コアロジック（`js/qr-core.js`
> ほか）の移植元である nayuki/QR-Code-generator のライセンス全文を
> [`LICENSE-THIRD-PARTY.md`](./LICENSE-THIRD-PARTY.md) に転載しています（§11-2）。
