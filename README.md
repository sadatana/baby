# マタニティ手帳

妊娠がわかってから出産、そして赤ちゃんの成長までを記録・サポートする、スマホ向けの Web アプリ（PWA）です。
ビルド不要・依存ライブラリなしで動作し、データは端末のブラウザ内（記録は localStorage、写真は IndexedDB）にのみ保存されます。

要件定義: [docs/requirements.md](docs/requirements.md)（現在はフェーズ 1: 端末内のみで動作）

## 主な機能

| タブ | 内容 |
| --- | --- |
| 🏠 ホーム | 妊娠中: 週数・カウントダウン、今週の赤ちゃん、次の健診、受診すべきサイン／出生後: 月齢（生後◯ヶ月◯日）、最新の計測、これからの行事・「初めて」 |
| 📈 成長 | 妊娠中: 健診の計測値（推定体重・BPD・FL など）とエコー写真、推定体重グラフ（平均±1.5SD）／出生後: 身長・体重・頭囲・胸囲の記録と発育曲線（妊娠中の推定体重と続けて表示も可）、週ごとの成長ガイド |
| 📷 アルバム | 計測・写真・できごと・日記の時系列タイムライン（妊娠◯週／生後◯ヶ月ごと）、写真一覧と拡大表示、「初めてのできごと」テンプレート |
| 🤰 ママ | 体重記録とグラフ（妊娠前 BMI による増加の目安つき）、日記、陣痛タイマー、胎動カウンター |
| ✅ 準備 | 妊婦健診スケジュール、入院準備リスト、妊娠〜出産後の手続きリスト |

設定（右上の ⚙️）から、赤ちゃんの名前・出産予定日（または最終月経の開始日）、誕生の登録（生年月日・性別・出生時の大きさ）、ママの身長・妊娠前の体重を登録できます。
写真は端末内で自動的に縮小（長辺 2048px）して保存し、撮影日は写真の EXIF 情報から読み取ります。
バックアップ（JSON）の保存・復元にも対応しています（写真は含まれません）。

### 成長曲線の標準値

- 胎児の推定体重: 日本産科婦人科学会「胎児体重の妊娠週数ごとの基準値」（`js/standards.js`）
- 出生後の発育曲線（0〜3歳、男女別、3〜97パーセンタイル）: WHO Child Growth Standards（`js/who-percentiles.js`）
  - `scripts/gen-who-percentiles.py` で WHO 公式の LMS 表から月ごとのパーセンタイル値を生成しています
  - 日本の母子健康手帳（乳幼児身体発育調査）の曲線とは少し異なります。同じ形式の表を `js/standards.js` の `INFANT_PERCENTILES` に設定すれば差し替えられます

## 使い方

```bash
npm start        # http://localhost:8000 で起動（Python の簡易サーバー）
npm test         # 計算ロジックのテスト（node:test）
```

## GitHub Pages で公開

公開 URL: https://sadatana.github.io/baby/

`.github/workflows/pages.yml` により、デフォルトブランチに push するとテスト実行後に自動で公開されます。

初回のみ、リポジトリの **Settings → Pages → Build and deployment → Source** を
**「GitHub Actions」** に設定してください（設定後、Actions タブから「Deploy to GitHub Pages」を再実行するか、もう一度 push すると公開されます）。

スマホで公開 URL を開き、「ホーム画面に追加」するとアプリとして使えます（オフライン対応）。

## ファイル構成

```
index.html            画面の骨組み
css/style.css         スタイル（ダークモード対応）
js/app.js             画面描画とイベント処理
js/pregnancy.js       週数・予定日・健診・陣痛などの計算ロジック
js/growth.js          月齢・タイムライン・できごとテンプレート・写真の撮影日（EXIF）
js/standards.js       成長曲線の標準値と補間
js/who-percentiles.js WHO 発育基準のパーセンタイル値（自動生成）
js/charts.js          SVG グラフ
js/media.js           写真の縮小と IndexedDB への保存
js/data.js            週ごとの情報、チェックリストなどのコンテンツ
js/store.js           localStorage への保存（v1 → v2 のデータ移行を含む）
sw.js                 オフライン用 Service Worker
scripts/              標準値データの生成スクリプト
tests/                node:test によるテスト
.github/workflows/    GitHub Pages への自動デプロイ
```

## ご注意

本アプリの情報は一般的な目安です。妊娠の経過には個人差があります。
体調の変化や不安なことがあれば、必ずかかりつけの医師・助産師に相談してください。
