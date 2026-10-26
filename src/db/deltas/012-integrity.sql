-- Delta 012: integrity guards that also hold for UPDATE, and consistency checks that a NULL can no
-- longer bypass. Applied after 011 by db.js, once (its name is recorded in schema_delta). Same
-- applying rules as 002-011: statements end with ';' at the end of a line, a trigger ends with a
-- line 'END;', and every statement may be run again (CREATE ... IF NOT EXISTS only).
--
-- Overlap (stand-ins for PostgreSQL exclusion constraints). The INSERT triggers of schema.sql and
-- delta 002 stay; these refuse an UPDATE that would create the same overlap: a changed validity, a
-- version made current again (superseded_at set back to NULL), a row moved to another tariff,
-- register, component, payment method, home, meter or tax. The writers only ever set superseded_at
-- to a time (supersede, then insert), which these never refuse.
--   rate_interval     current rows of one tariff, home, component, register, charge period and
--                     payment method may not overlap
--   tariff_agreement  current agreements of one meter may not overlap
--   tax_rule          the same current tax may not be charged twice on one charge at one moment
--   register_window   (INSERT and UPDATE; no check existed) two current windows of one window set
--                     with DIFFERENT registers may not cover the same wall-clock minute while both
--                     are valid. A window set: one tariff, one meter's own windows or the tariff's
--                     (device_id NULL), one calendar (NULL: plain windows), one clock. Day types:
--                     NULL in a calendar window means every day of that calendar, so it is checked
--                     against every type of the same calendar; two different types are never in
--                     force on one day. Minutes are compared over the week: a window covers, on each
--                     weekday in its mask, start_min for its length (end_min <= start_min wraps past
--                     midnight, Sunday into Monday). This is the error src/core/tariff-expand.js
--                     throws at expansion ("register windows ... overlap"); the same register twice
--                     is allowed (the expander accepts it), and so are windows of different
--                     calendars, a calendar window over a plain one (the calendar one wins) and a
--                     meter's windows over the tariff's (the meter's replace them).
--
-- Consistency (M4). The triggers of 002 and 004 compare two columns and skip the check when either
-- is NULL. These add the rules a NULL could bypass, judged on the values the row implies:
--   - a home's currency is its own, or else its market's (site.currency NULL in market GB is GBP);
--   - a tariff's currency is its own, or else its country's market's;
--   - a tariff agreement needs those two to agree (no FX), checked on INSERT and on UPDATE of the
--     agreement, the home (currency, market) and the tariff (currency, country);
--   - a home's country is its market's country when both are set;
--   - an agreement's home is its meter's home.
-- Still NOT judged: a pair where one side is unknown even after that (no currency and no market).
-- The columns stay nullable here; making currency, country, market_code and
-- tariff_agreement.recorded_at NOT NULL needs a table rebuild and is left for later.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

-- ───────────── Overlap on UPDATE ─────────────

CREATE TRIGGER IF NOT EXISTS rate_no_overlap_update
BEFORE UPDATE OF tariff_id, site_id, component, register, charge_period, payment_method, valid_from, valid_to, superseded_at ON rate_interval
WHEN NEW.superseded_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'overlapping current rate interval')
  WHERE EXISTS (
    SELECT 1 FROM rate_interval r
    WHERE r.id <> OLD.id
      AND r.superseded_at IS NULL
      AND r.tariff_id = NEW.tariff_id
      AND r.component = NEW.component
      AND r.register = NEW.register
      AND IFNULL(r.charge_period, '') = IFNULL(NEW.charge_period, '')
      AND r.payment_method = NEW.payment_method
      AND IFNULL(r.site_id, 0) = IFNULL(NEW.site_id, 0)
      AND r.valid_from < IFNULL(NEW.valid_to, 9000000000)
      AND IFNULL(r.valid_to, 9000000000) > NEW.valid_from
  );
END;

CREATE TRIGGER IF NOT EXISTS agreement_no_overlap_update
BEFORE UPDATE OF device_id, valid_from, valid_to, superseded_at ON tariff_agreement
WHEN NEW.superseded_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'overlapping tariff agreement for this meter')
  WHERE EXISTS (
    SELECT 1 FROM tariff_agreement a
    WHERE a.id <> OLD.id AND a.device_id = NEW.device_id AND a.superseded_at IS NULL
      AND a.valid_from < IFNULL(NEW.valid_to, 9000000000)
      AND IFNULL(a.valid_to, 9000000000) > NEW.valid_from
  );
END;

CREATE TRIGGER IF NOT EXISTS tax_rule_no_overlap_update
BEFORE UPDATE OF country, code, fuel, direction, customer_class, applies_to, valid_from, valid_to, superseded_at ON tax_rule
WHEN NEW.superseded_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'overlapping current tax rule')
  WHERE EXISTS (
    SELECT 1 FROM tax_rule t
    WHERE t.id <> OLD.id
      AND t.superseded_at IS NULL
      AND t.country = NEW.country AND t.code = NEW.code AND t.fuel = NEW.fuel
      AND t.direction = NEW.direction AND t.customer_class = NEW.customer_class
      AND (t.applies_to = NEW.applies_to OR t.applies_to = 'all' OR NEW.applies_to = 'all')
      AND t.valid_from < IFNULL(NEW.valid_to, 9000000000)
      AND IFNULL(t.valid_to, 9000000000) > NEW.valid_from
  );
END;

-- ───────────── Register windows: no two registers at one minute ─────────────
-- Each window is an arc on the week (10080 minutes): from day * 1440 + start_min, for its length.
-- Two arcs x (length lx) and y (length ly) meet when (y - x) mod 10080 < lx or (x - y) mod 10080 < ly.

CREATE TRIGGER IF NOT EXISTS register_window_no_overlap_insert
BEFORE INSERT ON register_window
WHEN NEW.superseded_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'overlapping register windows: two registers at the same minute')
  WHERE EXISTS (
    SELECT 1 FROM register_window w,
      (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) a,
      (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) b
    WHERE w.tariff_id = NEW.tariff_id AND w.superseded_at IS NULL
      AND IFNULL(w.device_id, 0) = IFNULL(NEW.device_id, 0)
      AND IFNULL(w.calendar, '') = IFNULL(NEW.calendar, '')
      AND (w.day_type = NEW.day_type OR w.day_type IS NULL OR NEW.day_type IS NULL)
      AND w.clock = NEW.clock
      AND w.register <> NEW.register
      AND IFNULL(w.valid_from, 0) < IFNULL(NEW.valid_to, 9000000000)
      AND IFNULL(w.valid_to, 9000000000) > IFNULL(NEW.valid_from, 0)
      AND (NEW.weekdays >> a.d) & 1 = 1 AND (w.weekdays >> b.d) & 1 = 1
      AND (((b.d * 1440 + w.start_min) - (a.d * 1440 + NEW.start_min) + 10080) % 10080
             < (CASE WHEN NEW.end_min > NEW.start_min THEN NEW.end_min - NEW.start_min ELSE NEW.end_min + 1440 - NEW.start_min END)
        OR ((a.d * 1440 + NEW.start_min) - (b.d * 1440 + w.start_min) + 10080) % 10080
             < (CASE WHEN w.end_min > w.start_min THEN w.end_min - w.start_min ELSE w.end_min + 1440 - w.start_min END))
  );
END;

CREATE TRIGGER IF NOT EXISTS register_window_no_overlap_update
BEFORE UPDATE OF tariff_id, device_id, register, start_min, end_min, weekdays, calendar, day_type, clock, valid_from, valid_to, superseded_at ON register_window
WHEN NEW.superseded_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'overlapping register windows: two registers at the same minute')
  WHERE EXISTS (
    SELECT 1 FROM register_window w,
      (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) a,
      (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) b
    WHERE w.id <> OLD.id AND w.tariff_id = NEW.tariff_id AND w.superseded_at IS NULL
      AND IFNULL(w.device_id, 0) = IFNULL(NEW.device_id, 0)
      AND IFNULL(w.calendar, '') = IFNULL(NEW.calendar, '')
      AND (w.day_type = NEW.day_type OR w.day_type IS NULL OR NEW.day_type IS NULL)
      AND w.clock = NEW.clock
      AND w.register <> NEW.register
      AND IFNULL(w.valid_from, 0) < IFNULL(NEW.valid_to, 9000000000)
      AND IFNULL(w.valid_to, 9000000000) > IFNULL(NEW.valid_from, 0)
      AND (NEW.weekdays >> a.d) & 1 = 1 AND (w.weekdays >> b.d) & 1 = 1
      AND (((b.d * 1440 + w.start_min) - (a.d * 1440 + NEW.start_min) + 10080) % 10080
             < (CASE WHEN NEW.end_min > NEW.start_min THEN NEW.end_min - NEW.start_min ELSE NEW.end_min + 1440 - NEW.start_min END)
        OR ((a.d * 1440 + NEW.start_min) - (b.d * 1440 + w.start_min) + 10080) % 10080
             < (CASE WHEN w.end_min > w.start_min THEN w.end_min - w.start_min ELSE w.end_min + 1440 - w.start_min END))
  );
END;

-- ───────────── Consistency that a NULL cannot bypass ─────────────
-- Implied currency of a home: its own, else its market's. Of a tariff: its own, else the currency of
-- the market of its country. Compared only when both are known.

CREATE TRIGGER IF NOT EXISTS agreement_currency_implied_insert
BEFORE INSERT ON tariff_agreement
BEGIN
  SELECT RAISE(ABORT, 'tariff currency differs from the home currency')
  WHERE (SELECT COALESCE(t.currency, (SELECT m.currency FROM market m WHERE m.country = t.country LIMIT 1)) FROM tariff t WHERE t.id = NEW.tariff_id)
     <> (SELECT COALESCE(s.currency, m.currency) FROM site s LEFT JOIN market m ON m.code = s.market_code WHERE s.id = NEW.site_id);
END;

CREATE TRIGGER IF NOT EXISTS agreement_currency_implied_update
BEFORE UPDATE OF site_id, tariff_id ON tariff_agreement
BEGIN
  SELECT RAISE(ABORT, 'tariff currency differs from the home currency')
  WHERE (SELECT COALESCE(t.currency, (SELECT m.currency FROM market m WHERE m.country = t.country LIMIT 1)) FROM tariff t WHERE t.id = NEW.tariff_id)
     <> (SELECT COALESCE(s.currency, m.currency) FROM site s LEFT JOIN market m ON m.code = s.market_code WHERE s.id = NEW.site_id);
END;

CREATE TRIGGER IF NOT EXISTS site_currency_implied_matches_agreements
BEFORE UPDATE OF currency, market_code ON site
BEGIN
  SELECT RAISE(ABORT, 'tariff currency differs from the home currency')
  WHERE EXISTS (
    SELECT 1 FROM tariff_agreement a JOIN tariff t ON t.id = a.tariff_id
    WHERE a.site_id = NEW.id
      AND COALESCE(t.currency, (SELECT m.currency FROM market m WHERE m.country = t.country LIMIT 1))
          <> COALESCE(NEW.currency, (SELECT m.currency FROM market m WHERE m.code = NEW.market_code))
  );
END;

CREATE TRIGGER IF NOT EXISTS tariff_currency_implied_matches_agreements
BEFORE UPDATE OF currency, country ON tariff
BEGIN
  SELECT RAISE(ABORT, 'tariff currency differs from the home currency')
  WHERE EXISTS (
    SELECT 1 FROM tariff_agreement a JOIN site s ON s.id = a.site_id LEFT JOIN market m ON m.code = s.market_code
    WHERE a.tariff_id = NEW.id
      AND COALESCE(s.currency, m.currency)
          <> COALESCE(NEW.currency, (SELECT m2.currency FROM market m2 WHERE m2.country = NEW.country LIMIT 1))
  );
END;

CREATE TRIGGER IF NOT EXISTS site_country_matches_market_insert
BEFORE INSERT ON site
WHEN NEW.country IS NOT NULL AND NEW.market_code IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'home country differs from its market country')
  WHERE (SELECT country FROM market WHERE code = NEW.market_code) <> NEW.country;
END;

CREATE TRIGGER IF NOT EXISTS site_country_matches_market_update
BEFORE UPDATE OF country, market_code ON site
WHEN NEW.country IS NOT NULL AND NEW.market_code IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'home country differs from its market country')
  WHERE (SELECT country FROM market WHERE code = NEW.market_code) <> NEW.country;
END;

CREATE TRIGGER IF NOT EXISTS agreement_device_same_site_insert
BEFORE INSERT ON tariff_agreement
BEGIN
  SELECT RAISE(ABORT, 'tariff agreement home differs from its meter home')
  WHERE (SELECT site_id FROM device WHERE id = NEW.device_id) <> NEW.site_id;
END;

CREATE TRIGGER IF NOT EXISTS agreement_device_same_site_update
BEFORE UPDATE OF site_id, device_id ON tariff_agreement
BEGIN
  SELECT RAISE(ABORT, 'tariff agreement home differs from its meter home')
  WHERE (SELECT site_id FROM device WHERE id = NEW.device_id) <> NEW.site_id;
END;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('012-integrity', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
