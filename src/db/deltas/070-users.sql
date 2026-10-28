-- Delta 070: prototype users and the homes each one may see (src/core/users.js). A SWITCH, NOT A LOGIN:
-- no password, no session. The browser names the user in an X-User-Id header and the API shows that
-- user only their own homes; a request without the header sees every home, as before this delta.
-- Nothing in the build engine reads these tables (site_hh and site_day are not touched). Same applying
-- rules as 002-060: statements end with ';' at the end of a line, and every statement may be run again.
--   role   owner (a householder: their own homes) · installer (the homes they look after) · admin (every home)
-- tenant (060) stays the company a home belongs to; a user is a person looking at homes.

CREATE TABLE IF NOT EXISTS app_user (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) > 0),
  email       TEXT UNIQUE,
  role        TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'installer', 'admin')),
  note        TEXT,                            -- the scenario this user shows, in plain words
  created_at  INTEGER NOT NULL                 -- ms
);

CREATE TABLE IF NOT EXISTS user_site (
  user_id      INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  site_id      INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  recorded_at  INTEGER NOT NULL,               -- ms
  PRIMARY KEY (user_id, site_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS user_site_site ON user_site (site_id);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('070-users', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
