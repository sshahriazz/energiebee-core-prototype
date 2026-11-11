-- Delta 082: the Dutch tariff picker no longer asks for the connection size (fuse, e.g. 3x25A). Delta 080 made it a
-- required question for the tounify v3 preview, which could take it per connection (capacity.fuse_ampere); the answer
-- was never stored or sent, and tounify v2 (src/adapters/tounify.js) prices a tariff at a postal code with no
-- connection details, so it priced nothing. Applied once by db.js; a question that does price something is a new row.
DELETE FROM market_question WHERE market_code = 'NL' AND field = 'fuse';

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('082-nl-fuse-question', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
