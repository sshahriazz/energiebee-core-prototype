-- Delta 079: sign-in with a username and a 4-digit PIN instead of an email and a password (src/core/users.js).
-- Applied after 078 by db.js, once. Same applying rules as 002-078: statements end with ';' at the end of a
-- line, an ADD COLUMN whose column exists is skipped, and every other statement may be run again.
--   app_user.username        lower case, unique; what a user types to sign in
--   app_user.pin_hash        scrypt$N$r$p$salt$hash (base64) of the PIN; NULL = cannot sign in yet
--                            (set one with scripts/set-pin.js)
--   app_user.failed_logins   wrong PINs in a row; reset by a right one
--   app_user.locked_until    ms; after 5 wrong PINs in a row the account refuses every PIN until then
-- email and password_hash stay (older rows keep them) but nothing reads them any more. An account made before
-- this delta gets the part of its email before the '@' as its username (with its id added when two would be the
-- same); it signs in once a PIN is set for it.

ALTER TABLE app_user ADD COLUMN username TEXT;
ALTER TABLE app_user ADD COLUMN pin_hash TEXT;
ALTER TABLE app_user ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_user ADD COLUMN locked_until INTEGER;

UPDATE app_user SET username = lower(substr(email, 1, instr(email, '@') - 1))
  WHERE username IS NULL AND instr(email, '@') > 1
    AND NOT EXISTS (SELECT 1 FROM app_user o WHERE o.id < app_user.id AND instr(o.email, '@') > 1
      AND lower(substr(o.email, 1, instr(o.email, '@') - 1)) = lower(substr(app_user.email, 1, instr(app_user.email, '@') - 1)));
UPDATE app_user SET username = lower(substr(email, 1, instr(email, '@') - 1)) || id
  WHERE username IS NULL AND instr(email, '@') > 1;

CREATE UNIQUE INDEX IF NOT EXISTS app_user_username ON app_user (username);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('079-pin-auth', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
