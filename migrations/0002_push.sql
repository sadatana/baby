-- プッシュ通知（フェーズ 3）

-- 通知の送信先（ブラウザごと）
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_sent_at INTEGER
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

-- アプリ全体の設定（通知の送信に使う VAPID 鍵など。初回に自動で作られる）
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
