// Live smoke check of the Tariffscanner adapter (NOT part of npm test). At most 3 requests: the
// token, then one page of limit=5 with active=true (the client's budget is set to 3, the 3 s gap
// holds). Prints the record field names found and one record as the adapter maps it; never a
// credential or the token. Writes nothing to data/core.db: the adapter's database is a temporary
// file deleted at exit.
//   node --env-file=.env scripts/tariffscanner-smoke.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.TARIFFSCAN_USERNAME || !process.env.TARIFFSCAN_PASSWORD) {
  console.log('TARIFFSCAN_USERNAME and TARIFFSCAN_PASSWORD are not set: nothing requested. Run: node --env-file=.env scripts/tariffscanner-smoke.js');
  process.exit(0);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-tariffscanner-smoke-'));
process.env.DB_FILE = path.join(dir, 'smoke.db');
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const TS = await import('../src/adapters/tariffscanner.js');
const { creds } = TS.credentialsFromEnv();
const client = TS.createClient({ ...creds, store: TS.memoryStore() });
const say = (...a) => console.log(...a.map((x) => client.scrub(typeof x === 'string' ? x : JSON.stringify(x, null, 2))));
client.beginRun(3);
try {
  const page = await client.domestic({ active: true, offset: 0, limit: 5 });
  const records = Array.isArray(page?.data) ? page.data : [];
  say(`requests made: ${client.used}`);
  say('pagination:', page?.pagination ?? null);
  say(`records: ${records.length}`);
  say('field names:', [...new Set(records.flatMap((r) => Object.keys(r)))].join(', '));
  if (records.length) {
    const r = records[0];
    const m = TS.mapRecord(r);
    const day = (s) => (s == null ? null : new Date(s * 1000).toISOString());
    say('first record:', { product_id: r.product_id, supplier_name: r.supplier_name, name: r.name, payment_method: r.payment_method, service_type: r.service_type, rate_type: r.rate_type, dno_region_id: r.dno_region_id, dno_region: r.dno_region });
    say('mapped:', {
      skipped: m.skipped, warnings: m.warnings, annual_cost_minor: m.annualCostMinor,
      tariffs: m.tariffs.map((t) => ({
        tariff_code: t.tariff.tariffCode, name: t.tariff.name, fuel: t.tariff.fuel, direction: t.tariff.direction, structure: t.tariff.structure,
        kind: t.tariff.kind, region: t.tariff.region, origin_note: t.tariff.originNote,
        rows: t.rows.map((x) => ({ component: x.component, register: x.register, payment_method: x.paymentMethod, price_pence: x.price, valid_from: day(x.validFrom), valid_to: day(x.validTo) })),
        windows: t.windows,
      })),
    });
  }
} catch (err) {
  say(`failed after ${client.used} request(s): ${err.message}`);
  process.exitCode = 1;
}
