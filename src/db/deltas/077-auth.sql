-- Delta 077: sign-up and per-home provider logins (src/core/users.js, src/core/secrets.js,
-- src/core/signup.js). Applied after 076 by db.js, once. Same applying rules as 002-076: statements
-- end with ';' at the end of a line, an ADD COLUMN whose column exists is skipped, and every other
-- statement may be run again. Nothing in the build engine reads these tables.
--   app_user.password_hash   scrypt$N$r$p$salt$hash (base64); NULL = cannot sign in (the demo users of 076)
--   user_session             a signed-in browser: only the SHA-256 of its cookie token is kept
--   connection_secret        a home's provider login (API key, password), AES-256-GCM with a key derived
--                            from SECRET_KEY in .env; bound to (site_id, provider) as associated data, so a
--                            row copied to another home or provider does not decrypt. Never sent by the API.

ALTER TABLE app_user ADD COLUMN password_hash TEXT;

CREATE TABLE IF NOT EXISTS user_session (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,                -- ms
  expires_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS user_session_user ON user_session (user_id);

CREATE TABLE IF NOT EXISTS connection_secret (
  site_id      INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  iv           BLOB NOT NULL,
  tag          BLOB NOT NULL,
  ciphertext   BLOB NOT NULL,
  recorded_at  INTEGER NOT NULL,               -- ms
  PRIMARY KEY (site_id, provider)
) WITHOUT ROWID;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('077-auth', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
