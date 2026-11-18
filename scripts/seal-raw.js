// Seal a home's raw files that were written before raw files were encrypted (fix list R14): every raw receipt with a home,
// of a source that is not public data, whose file is still plain text, is encrypted with its home's key in place. Safe to
// run again: a sealed file is left alone. Dry run unless --apply.
//   node --disable-warning=ExperimentalWarning scripts/seal-raw.js [--apply]
import fs from 'node:fs';

try { process.loadEnvFile('.env'); } catch { /* the environment provides DATABASE_URL */ }
const apply = process.argv.includes('--apply');
const { db, rawFilePath, closeDb } = await import('../src/db/db.js');
const { seal, isSealed, sealsRaw } = await import('../src/core/facts.js');

const out = { receipts: 0, sealed: 0, already: 0, public: 0, missing: 0 };
for (const r of await db.prepare('SELECT p.id, p.site_id, p.file, so.code AS source FROM raw_payload p JOIN source so ON so.id = p.source_id WHERE p.site_id IS NOT NULL ORDER BY p.id').all()) {
  out.receipts++;
  if (!await sealsRaw(r.source, r.site_id)) { out.public++; continue; }
  const file = rawFilePath(r.file);
  let buf;
  if (!file) { out.missing++; continue; }
  try { buf = fs.readFileSync(file); } catch { out.missing++; continue; }
  if (isSealed(buf)) { out.already++; continue; }
  if (apply) {
    const tmp = `${file}.sealing`;
    fs.writeFileSync(tmp, await seal(r.site_id, buf.toString('utf8')));
    fs.renameSync(tmp, file);
  }
  out.sealed++;
}
console.log(JSON.stringify({ apply, ...out }));
await closeDb();
