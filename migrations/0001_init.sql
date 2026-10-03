-- 家族共有（フェーズ 2）の初期スキーマ（Cloudflare D1 / SQLite）
-- 日時はすべて UNIX ミリ秒

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- パスキー（1 人で複数の端末を登録できる）
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,               -- credential ID（base64url）
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alg INTEGER NOT NULL,              -- -7: ES256 / -257: RS256
  public_key TEXT NOT NULL,          -- JWK（JSON）
  sign_count INTEGER NOT NULL DEFAULT 0,
  device_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

-- ログイン中のセッション（トークンはハッシュで保存）
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- パスキー登録・ログインのチャレンジ（5 分有効・1 回限り）
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL,                -- register / login
  data TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER NOT NULL
);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,    -- 同期用の通し番号（記録を書き込むたびに増える）
  created_at INTEGER NOT NULL
);

CREATE TABLE memberships (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

-- 招待リンク（権限付き・有効期限 7 日・1 回限り）
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT
);

-- 既存ユーザーにパスキーを追加するためのリンク（端末追加・再ログイン用・復旧コード経由）
CREATE TABLE links (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('device', 'relogin', 'recovery')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- 復旧コード（ハッシュで保存）
CREATE TABLE recovery_codes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 記録（赤ちゃんの記録・写真の情報・ママの記録・リアクション・コメントなど）
CREATE TABLE records (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,            -- 作成者（ママの記録・リアクション等は本人だけが編集できる）
  data TEXT NOT NULL,                -- 記録の内容（JSON）
  private INTEGER NOT NULL DEFAULT 0, -- 「自分だけ」の日記
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  seq INTEGER NOT NULL,
  PRIMARY KEY (group_id, type, id)
);
CREATE INDEX records_seq ON records(group_id, seq);
CREATE INDEX records_owner ON records(group_id, owner_id, type);
