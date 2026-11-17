// Proof that the build engine on Postgres gives the same slots as the build that stored them: each home's stored
// site_hh rows are rebuilt (dry run, as known at the moment they were built) and compared column by column.
// Exit code 1 on any difference beyond 1e-9.
//
//   node scripts/verify-rebuild.js [siteId]          DATABASE_URL from the environment or .env
try { process.loadEnvFile('.env'); } catch { /* the environment provides DATABASE_URL */ }
const { db, closeDb } = await import('../src/db/db.js');
const { buildSite } = await import('../src/core/build.js');

const only = process.argv[2] ? Number(process.argv[2]) : null;
let bad = 0;
for (const s of await db.prepare('SELECT id, name FROM site WHERE is_demo = 0 ORDER BY id').all()) {
  if (only != null && s.id !== only) continue;
  const span = await db.prepare('SELECT MIN(local_date) AS a, MAX(local_date) AS b, MAX(built_at) AS t FROM site_hh WHERE site_id = ?').get(s.id);
  if (!span?.a) { console.log(`site ${s.id}: no stored slots`); continue; }
  const stored = new Map((await db.prepare('SELECT * FROM site_hh WHERE site_id = ? ORDER BY slot_start').all(s.id)).map((r) => [r.slot_start, r]));
  const t0 = Date.now();
  const { hhRows } = await buildSite(s.id, span.a, span.b, { asOf: span.t, dryRun: true });
  const ms = Date.now() - t0;
  let differ = 0; let compared = 0; const examples = [];
  for (const r of hhRows) {
    const o = stored.get(r.slot_start);
    if (!o) continue;
    compared++;
    for (const [k, v] of Object.entries(r)) {
      if (k === 'built_at' || !(k in o)) continue;
      const a = o[k]; const same = (typeof v === 'number' && typeof a === 'number') ? Math.abs(v - a) <= 1e-9 : (v ?? null) === (a ?? null);
      if (!same) { differ++; if (examples.length < 5) examples.push(`${r.local_date} ${r.slot_start} ${k}: stored ${a} rebuilt ${v}`); }
    }
  }
  console.log(`site ${s.id} ${s.name}: ${span.a}..${span.b}, ${compared} slots compared of ${stored.size} stored, ${differ} values differ; rebuild ${ms} ms`);
  for (const e of examples) console.log(`  ${e}`);
  if (differ) bad++;
}
await closeDb();
process.exit(bad ? 1 : 0);
