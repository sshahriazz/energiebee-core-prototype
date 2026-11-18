-- A mark whose work failed is counted and parked after a few tries, so one failing change never blocks the marks behind it
-- (price-queue.js). A new change to the same tariff, country or home sets the count back to 0.
ALTER TABLE price_dirty ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE price_dirty ADD COLUMN last_error text;
COMMENT ON COLUMN price_dirty.attempts IS 'failed tries of the work on this mark; a mark with 3 or more is parked until a new change resets it';
