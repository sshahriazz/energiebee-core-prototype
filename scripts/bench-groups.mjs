// Times the group views on synthetic data: 20 homes (mixed slot lengths and currencies) by one year of slots.
// A throwaway database in the temp folder; data/core.db is never opened.
//   node --disable-warning=ExperimentalWarning scripts/bench-groups.mjs [homes] [days]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const homes = Number(process.argv[2]) || 20;
const days = Number(process.argv[3]) || 365;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-bench-'));
process.env.DB_FILE = path.join(dir, 'bench.db');
const { db, tx } = await import('../src/db/db.js');
const { makeHome, fillSlots } = await import('../test/groups-fixtures.js');
const { createGroup, addMember, groupDay, groupRange } = await import('../src/core/groups.js');

const owner = Number((await db.prepare("INSERT INTO app_user (name, created_at) VALUES ('bench', 0)").run()).lastInsertRowid);
const start = Date.UTC(2025, 0, 1) / 1000;
const to = start + days * 86400;
const mix = [[1800, 'GBP', 'GB', 'Europe/London'], [900, 'EUR', 'NL', 'Europe/Amsterdam'], [3600, 'GBP', 'GB', 'Europe/London'], [1800, 'EUR', 'FR', 'Europe/Paris']];
const g = await createGroup({ name: 'bench', ownerId: owner, timezone: 'Europe/London' });
let t0 = performance.now();
await tx(async () => {
  for (let i = 0; i < homes; i++) {
    const [slotS, currency, country, tz] = mix[i % mix.length];
    const id = await makeHome({ tz, slotS, currency, country });
    await fillSlots(id, { tz, slotS, currency, from: start, to });
    await addMember(g, id);
  }
});
const rows = (await db.prepare('SELECT COUNT(*) n FROM site_hh').get()).n;
console.log(`built ${homes} homes, ${rows} slot rows in ${(performance.now() - t0).toFixed(0)} ms`);
const time = async (label, fn) => { const a = performance.now(); const r = await fn(); console.log(`${label}: ${(performance.now() - a).toFixed(0)} ms`); return r; };
await time('groupDay (one day)', async () => await groupDay(g, '2025-06-10'));
await time('groupRange (30 days)', async () => await groupRange(g, '2025-06-01', '2025-06-30'));
const year = time(`groupRange (${days} days)`, async () => await groupRange(g, '2025-01-01', '2025-12-31'));
console.log(`year total currencies: ${year.currencies.join(', ')}; days: ${year.days.length}`);
fs.rmSync(dir, { recursive: true, force: true });
