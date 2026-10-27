-- Delta 063: source.traits, the machine-read facts about a source (JSON: holdS, live, forecastOnly,
-- namedOnly). Written by seedRegistry from registry.js SOURCES; the planner read uses them instead of
-- lists of vendor names. Same applying rules as 002-062.
ALTER TABLE source ADD COLUMN traits TEXT;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('063-source-traits', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
