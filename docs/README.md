# SNCR2 開発者向けドキュメント — 索引

このフォルダは **SNCR2 の内部を理解・改造・再実装したい人**のための資料置き場です。
利用者向けの使い方は、リポジトリ直下の [`../README.md`](../README.md) を読んでください。

## どれを読めばいい？

| あなたの目的 | 読む順序 |
|---|---|
| **全体像をつかみたい** | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| **コードを呼び出したい**（Node / 自作 UI から） | [`ARCHITECTURE.md`](ARCHITECTURE.md) → [`API.md`](API.md) |
| **別言語で実装／互換リーダを書きたい** | [`FORMAT.md`](FORMAT.md) |
| **既存コードを改造したい** | [`CONTRIBUTING.md`](CONTRIBUTING.md) → [`TESTING.md`](TESTING.md) |
| **なぜこの設計なのか知りたい** | [`DESIGN-0-4.md`](DESIGN-0-4.md) / [`DESIGN-5-7.md`](DESIGN-5-7.md) |
| **読み取り失敗の原因を追いたい** | [`INVESTIGATE-payload-rsfail.md`](INVESTIGATE-payload-rsfail.md) |

## ファイル一覧

| ファイル | 種類 | 内容 |
|---|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 現行仕様 | モジュール依存図・encode/decode のデータフロー・設計の勘所 |
| [`API.md`](API.md) | 現行仕様 | 全モジュールの公開 API リファレンス（引数・返り値・使用例） |
| [`FORMAT.md`](FORMAT.md) | 現行仕様 | 紙面レイアウト・ヘッダのバイト単位・ビット充填順・後方互換規則 |
| [`TESTING.md`](TESTING.md) | 現行仕様 | セルフテスト 6 本 + 調査ツールが何を固定しているか |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 規約 | 改造の作法・**後方互換の絶対ルール**・レビュー観点 |
| [`DESIGN-0-4.md`](DESIGN-0-4.md) | 履歴 | §0〜§4 実装当時の設計判断（当時のスナップショット） |
| [`DESIGN-5-7.md`](DESIGN-5-7.md) | 履歴 | §5〜§7 実装当時の設計判断（当時のスナップショット） |
| [`INVESTIGATE-payload-rsfail.md`](INVESTIGATE-payload-rsfail.md) | 調査 | 「ver 確定なのに本文 RS 失敗」の根本原因レポート |

> **「現行仕様」と「履歴」の違い**
> `DESIGN-*.md` は **書かれた時点のコミットの記録**です（当時「§8 以降は保留」等と
> 書かれています）。その後の実装で数値やスコープが変わっている箇所があるため、
> **いま現在の仕様を知りたいときは `ARCHITECTURE.md` / `API.md` / `FORMAT.md`** を
> 参照してください。`DESIGN-*.md` は「なぜそう決めたか」の理由を読む資料です。

## 用語

| 用語 | 意味 |
|---|---|
| **セル / モジュール** | 紙面上の 1 個の白黒の点。`modules` 配列の 1 要素（0=白 / 1=黒）。 |
| **箱 / データグリッド** | セルを並べる A4 上の固定長方形（2152×3096px @300dpi）。全版共通。 |
| **版 / バージョン** | 箱を `cols×rows` に何分割するかの段階（ver1〜20）。QR の version 相当だが独自体系。 |
| **ティア** | 版の帯。標準（ver1〜14 / 300dpi）と拡張（ver15〜20 / 600dpi）。 |
| **ECC レベル** | 誤り訂正の強さ（0〜7 の 8 段階）。番号は wire 互換のため固定。 |
| **グロス (gross)** | ECC パリティを含めた payload 領域のバイト数。 |
| **正味 (net)** | 実際に載せられるユーザーデータのバイト数（グロス − パリティ）。 |
| **機能モジュール** | ファインダ・タイミング・アライメント・フォーマット情報のセル。データを載せない。 |
| **ファインダ** | 四隅の位置合わせパターン。紙面上は塗りつぶし正方形、盤面上は QR と同じ 7×7。 |
| **アライメント** | 盤面内部に散らす 5×5 パターン。たわみ・歪みの局所補正に使う。 |
| **ドットゲイン** | 印刷時にインクが滲んで点が太る現象。全面一律に暗くなるため二値化を壊しやすい。 |

## 商標について

QRコードは株式会社デンソーウェーブの登録商標です。
QR Code is a registered trademark of DENSO WAVE INCORPORATED in Japan and in
other countries.

SNCR2 は QR コードの技術的な考え方を参考にした**独自フォーマット**であり、
ISO/IEC 18004 に準拠した QR コードそのものではありません。
