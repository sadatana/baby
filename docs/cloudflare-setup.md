# Cloudflare への公開手順（家族共有を使うために）

家族共有（ログイン・同期・写真の共有）は、Cloudflare Workers・D1・R2 で動きます。
最初に一度だけ、以下の準備が必要です。準備が終わると、デフォルトブランチに push するたびに GitHub Actions が自動で公開します。

所要時間: 20〜30 分程度

## 1. Cloudflare アカウントを作る

1. https://dash.cloudflare.com/sign-up でアカウントを作成します（無料プランで使えます）。
2. 写真の保存（R2）を使うため、ダッシュボードの **R2** を開き、案内に従って有効にします。
   - 支払い方法の登録が必要ですが、無料枠（保存 10GB まで）の範囲なら請求はありません。

## 2. データベースと写真の保存場所を作る

### 方法 A: ダッシュボードで作る（コマンド不要・おすすめ）

1. Cloudflare ダッシュボード → **Storage & Databases → D1 SQL Database → Create Database**
   - 名前: `maternity-app`（この名前で作成してください）
   - 作成後の画面に表示される **Database ID** を控えておきます（手順 3 で使います）
2. **R2 Object Storage → Create bucket**
   - 名前: `maternity-app-media`

### 方法 B: コマンドで作る

パソコンに Node.js（v22 以上）を入れ、このリポジトリのフォルダで次を実行します。

```bash
npx wrangler@4 login                               # ブラウザで Cloudflare にログイン
npx wrangler@4 d1 create maternity-app             # データベース（D1）を作成 → database_id が表示される
npx wrangler@4 r2 bucket create maternity-app-media  # 写真の保存場所（R2）を作成
```

表示された `database_id` を控えておきます（手順 3 で使います）。

#### `Authentication error [code: 10000]` と表示された場合

コマンドが使っている認証情報に、D1 を操作する権限がありません。`npx wrangler@4 whoami` で確認できます。

- **「API Token」でログインしていると表示される** → パソコンに環境変数 `CLOUDFLARE_API_TOKEN` が設定されていて、ブラウザでのログインより優先されています。
  その API トークンに **D1: Edit** 権限を追加するか、環境変数を外してからやり直してください。
  - Mac / Linux: `unset CLOUDFLARE_API_TOKEN`
  - Windows（PowerShell）: `Remove-Item Env:CLOUDFLARE_API_TOKEN`
- **「OAuth Token」と表示される** → `npx wrangler@4 logout` → `npx wrangler@4 login` でログインし直し、ブラウザの画面ですべての権限を許可してください。
- 表示される **Account ID** が、エラーメッセージの `/accounts/…/` の部分と同じか確認してください（複数のアカウントがある場合）。

解決しない場合は、方法 A（ダッシュボード）で作成すれば、このコマンドは不要です。

### workers.dev のサブドメインを決める（初回のみ）

Cloudflare ダッシュボード → **Workers & Pages** を開き、最初に表示される案内（または右側の **Subdomain**）で、
アカウント用のサブドメインを登録します。公開 URL は `https://maternity-app.<サブドメイン>.workers.dev` になります。

> パスキーはこの URL に結び付くため、あとから変えると登録済みのパスキーが使えなくなります。短く覚えやすい名前を選んでください。

登録していないと、公開時に `You need to register a workers.dev subdomain before publishing to workers.dev` というエラーになります。

## 3. GitHub にシークレットを登録する

1. Cloudflare ダッシュボード → 右上のアカウント → **My Profile → API Tokens → Create Token**
   - テンプレート **「Edit Cloudflare Workers」** を選び、さらに権限に **「D1: Edit」** を追加して作成します。
   - **Account Resources** で、使うアカウントが選ばれていることを確認してください。
   - D1 の権限がないと、GitHub Actions でも同じ `Authentication error [code: 10000]` になります。
2. GitHub のリポジトリ → **Settings → Secrets and variables → Actions → New repository secret** で、次の 3 つを登録します。

| 名前 | 値 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 作成した API トークン |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare ダッシュボードの右側に表示される「Account ID」 |
| `D1_DATABASE_ID` | 手順 2 で表示された `database_id` |

## 4. 公開する

デフォルトブランチに push（または Actions タブで「Deploy to Cloudflare」を手動実行）すると、
テスト → データベースの更新（migrations）→ 公開 の順に実行されます。

公開 URL は `https://maternity-app.<アカウントのサブドメイン>.workers.dev` です（Cloudflare ダッシュボードの Workers で確認できます）。
独自ドメインを使う場合は、Workers の設定 → **Domains & Routes** から追加できます。

> パスキーは公開したドメインに結び付きます。あとからドメインを変えると、登録済みのパスキーは使えなくなります
> （その場合は「再ログイン用リンク」や復旧コードで登録し直せます）。最初に使うドメインを決めてから家族を招待するのがおすすめです。

## プッシュ通知について

追加の設定は不要です。通知の送信に使う鍵（VAPID）は、最初に誰かが通知をオンにしたときにサーバーが自動で作り、データベース（D1）に保存します。
データベースの更新（`migrations/0002_push.sql`）は、公開のたびに GitHub Actions が自動で行います。

自分で作った鍵を使いたい場合は、Cloudflare ダッシュボード → Workers & Pages → maternity-app → **Settings → Variables and Secrets** に、
`VAPID_PUBLIC_KEY`（非圧縮公開鍵の base64url）と `VAPID_PRIVATE_KEY`（秘密鍵の JWK を JSON 文字列で）を **Secret** として登録してください。
鍵を変えると、それまでにオンにした通知は届かなくなります（各端末で通知をオンにし直すと戻ります）。

## 5. GitHub Pages からの移行

これまでの GitHub Pages（https://sadatana.github.io/baby/）も、端末内だけで使うアプリとしてそのまま動きます（家族共有は使えません）。
GitHub Pages で記録していた場合は、次の手順で新しい URL に移せます。

1. 古い URL のアプリで、設定 → データの管理 →「バックアップを保存」
2. 新しい URL のアプリで「バックアップから復元」（写真はバックアップに含まれないため、追加し直してください）
3. 設定 →「家族グループを作る」

移行が終わったら、`.github/workflows/pages.yml` を削除すると GitHub Pages への公開を止められます。

## ローカルでの動作確認

```bash
npm run dev      # http://localhost:8787 （データは .dev/ に保存。--memory を付けると保存しない）
npm test         # 計算ロジック・同期・API のテスト
```

ローカルでは D1 の代わりに SQLite（Node.js 標準の `node:sqlite`）、R2 の代わりに `.dev/media/` を使います。
`localhost` はパスキーが使える安全な環境として扱われるため、パソコンのブラウザでログインまで試せます。

## 無料枠の目安

| サービス | 無料枠 | 家族数人での想定 |
| --- | --- | --- |
| Workers | 10 万リクエスト/日 | 数百〜数千 |
| D1 | 5GB・読み取り 500 万行/日 | 数 MB |
| R2 | 保存 10GB・取り出し無料 | 3 年で 2〜3GB |

最新の条件は Cloudflare の料金ページで確認してください。
