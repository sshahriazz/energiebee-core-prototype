// A smart-plug EMULATOR: it behaves like a plug that pushes its readings to POST /api/ingest, so the push path can be seen working (and
// tested) without a real device. Its data is SYNTHETIC: a daily-shaped heater load and a cumulative energy counter, generated here. It posts to
// the endpoint only; it never opens a database.
//
//   npm run demo:push -- --url http://localhost:4100 --site 1 --device emu-plug-1 --format shelly_gen2_switch --every 10
//
// options (all `--name value`):
//   --url        the core, default http://localhost:4100            --site     the home id (needed when the core has more than one real home)
//   --device     the device reference to push as, default emu-plug-1 (registered on the first push as an emulated smart plug)
//   --format     native | shelly_gen2_switch | tasmota_sensor | homeassistant_state   (default native)
//   --every      seconds between pushes in real time (default 10). 0 = no waiting: simulated time advances by --step per push
//   --step       simulated seconds per push when --every is 0 (default 300); --start an ISO time for the first push (default: ends now)
//   --count      how many pushes (default: forever in real time, 12 when --every is 0)
//   --restart-after N   the plug's counter restarts from 0 after N pushes (a power cut or a firmware update)
//   --gap-after K --gap N   the plug sends nothing for N pushes after push K (time and the counter keep going)
//   --tz         the home time zone for Tasmota local times (default Europe/London)     --label   the name to register (default "Emulated plug")
// The token comes from the environment: INGEST_TOKEN, when the core requires one.
import { pathToFileURL } from 'node:url';

const hash01 = (n) => { let x = (n ^ 0x9e3779b9) >>> 0; x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0; x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0; return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };
const localParts = (ts, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  .formatToParts(ts * 1000).map((x) => [x.type, x.value]));
export const localStamp = (ts, tz = 'Europe/London') => { const p = localParts(ts, tz); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`; };

/** The heater load at a time: on in the morning and evening in 15-minute blocks (a thermostat cycling), off at night. Deterministic. */
export function heaterWatts(ts, tz = 'Europe/London') {
  const p = localParts(ts, tz); const h = Number(p.hour) + Number(p.minute) / 60;
  const window = (h >= 6 && h < 9) || (h >= 17 && h < 22);
  if (!window) return 0;
  const block = Math.floor(ts / 900);
  if (hash01(block) > 0.62) return 0;
  return Math.round((1800 + 140 * (hash01(ts) - 0.5)) * 10) / 10;
}

// The body and query of one push, per format. device/label/kind/emulated/site go in the envelope (native) or the query string (vendor formats).
export function buildPush({ format, device, site, label, tz, ts, watts, kwh, on }) {
  const common = { device, register: '1', kind: 'smart_plug', label, emulated: '1', ...(site != null ? { site: String(site) } : {}) };
  if (format === 'native') {
    return { query: {}, body: { ...(site != null ? { site } : {}), device, register: true, kind: 'smart_plug', label, emulated: true, observations: [
      { point: 'power', ts, value: watts }, { point: 'energy_total', ts, value: kwh }, { point: 'relay', ts, value: on ? 1 : 0 }] } };
  }
  if (format === 'shelly_gen2_switch') {
    return { query: { format, ...common }, body: { src: device, dst: 'ingest', method: 'NotifyStatus', params: { ts, 'switch:0': { id: 0, source: 'timer', output: on, apower: watts, voltage: 231.4, current: Math.round((watts / 231.4) * 100) / 100, aenergy: { total: Math.round(kwh * 1000 * 1000) / 1000, by_minute: [0, 0, 0], minute_ts: ts - (ts % 60) } } } } };
  }
  if (format === 'tasmota_sensor') {
    return { query: { format, ...common }, body: { Time: localStamp(ts, tz), ENERGY: { Total: Math.round(kwh * 1000) / 1000, Power: Math.round(watts), Voltage: 231, Current: Math.round((watts / 231) * 100) / 100 } } };
  }
  if (format === 'homeassistant_state') {
    const at = new Date(ts * 1000).toISOString();
    return { query: { format, ...common }, body: [
      { entity_id: 'sensor.emulated_plug_energy', state: String(Math.round(kwh * 1000) / 1000), attributes: { unit_of_measurement: 'kWh', device_class: 'energy', friendly_name: 'Emulated plug energy' }, last_updated: at },
      { entity_id: 'sensor.emulated_plug_power', state: String(Math.round(watts)), attributes: { unit_of_measurement: 'W', device_class: 'power' }, last_updated: at },
      { entity_id: 'switch.emulated_plug', state: on ? 'on' : 'off', attributes: {}, last_updated: at }] };
  }
  throw new Error(`unknown format ${format}`);
}

/**
 * Run the emulator. Returns { posts, ok, failed, responses } so a test can assert on what the core answered.
 * log(line) receives one line per push; sleep(ms) and fetchImpl can be replaced (tests).
 */
export async function runEmulator({ url = 'http://localhost:4100', site = null, device = 'emu-plug-1', format = 'native', every = 10, step = 300, start = null, count = null,
  restartAfter = null, gapAfter = null, gap = 0, tz = 'Europe/London', label = 'Emulated plug', token = process.env.INGEST_TOKEN, log = console.log,
  fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Math.floor(Date.now() / 1000) } = {}) {
  const real = Number(every) > 0 && !start;
  const total = count ?? (real ? Infinity : 12);
  let t = real ? now() : (start ? Math.floor(Date.parse(start) / 1000) : Math.floor(now() / step) * step - (total - 1) * step);
  let kwh = 12.5; let lastT = t; let skip = 0;
  const out = { posts: 0, ok: 0, failed: 0, responses: [] };
  log(`EMULATOR (synthetic data): a smart plug "${device}" pushing ${format} to ${url}/api/ingest ${real ? `every ${every} s in real time` : `with simulated time, ${step} s per push`}${token ? ' with a token' : ''}`);
  for (let i = 0; i < total; i++) {
    if (real && i > 0) { await sleep(Number(every) * 1000); t = now(); }
    else if (!real && i > 0) t += step;
    const watts = heaterWatts(t, tz);
    kwh += (watts * Math.max(0, t - lastT)) / 3_600_000; lastT = t;
    if (restartAfter != null && i === Number(restartAfter)) { kwh = 0; log('  (the plug restarted: its energy counter is back at 0)'); }
    if (gapAfter != null && i === Number(gapAfter)) skip = Number(gap);
    if (skip > 0) { skip--; log(`  tick ${i + 1}: the plug is silent (a gap), counter now ${kwh.toFixed(3)} kWh`); continue; }
    const { query, body } = buildPush({ format, device, site, label, tz, ts: t, watts, kwh, on: watts > 0 });
    const qs = new URLSearchParams(query).toString();
    const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
    out.posts++;
    try {
      const res = await fetchImpl(`${url}/api/ingest${qs ? `?${qs}` : ''}`, { method: 'POST', headers, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      out.responses.push({ status: res.status, ...j });
      if (res.ok) {
        out.ok++;
        log(`  push ${out.posts}: ${res.status} ${localStamp(t, tz)} ${Math.round(watts)} W, counter ${kwh.toFixed(3)} kWh -> stored ${j.written} (derived ${j.derived}, rejected ${j.rejected}${j.unmapped?.length ? `, unmapped ${j.unmapped.join('/')}` : ''})${j.warnings?.length ? ` [${j.warnings[0]}]` : ''}`);
      } else { out.failed++; log(`  push ${out.posts}: ${res.status} ${j.code ?? ''} ${j.error ?? ''}`); }
    } catch (err) { out.failed++; log(`  push ${out.posts}: could not reach ${url} (${err.message})`); }
  }
  return out;
}

// ───────────── Command line ─────────────
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[key] = true; else { o[key] = next; i++; }
  }
  return o;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const a = parseArgs(process.argv.slice(2));
    if (a.help) { console.log('See the header of scripts/push-emulator.mjs for the options.'); process.exit(0); }
    const num = (v) => (v == null || v === true ? null : Number(v));
    const r = await runEmulator({ url: a.url ?? 'http://localhost:4100', site: num(a.site), device: a.device ?? 'emu-plug-1', format: a.format ?? 'native', every: a.every != null ? Number(a.every) : 10,
      step: num(a.step) ?? 300, start: typeof a.start === 'string' ? a.start : null, count: num(a.count), restartAfter: num(a.restartAfter), gapAfter: num(a.gapAfter), gap: num(a.gap) ?? 0,
      tz: a.tz ?? 'Europe/London', label: a.label ?? 'Emulated plug' });
    console.log(`done: ${r.ok} accepted, ${r.failed} failed (EMULATOR: synthetic data)`);
    process.exit(r.failed ? 1 : 0);
  } catch (err) { console.error(err.message); process.exit(2); }
}
