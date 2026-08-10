CREATE TABLE IF NOT EXISTS email_send_rate (
  email             TEXT PRIMARY KEY,
  sends             INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_login_codes (
  email      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_change_codes (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  target_email TEXT NOT NULL,
  code         TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_delete_rate (
  user_id    INTEGER PRIMARY KEY,   -- deliberately NO foreign key: must survive the user delete
  count      INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_login_codes_expires_at  ON email_login_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_email_change_codes_expires_at ON email_change_codes(expires_at);
