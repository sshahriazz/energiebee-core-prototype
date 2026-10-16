// Values measured from a home's own data, kept with how they were measured.
import { db } from '../db/db.js';
import { seriesId } from './facts.js';
import { nowSec } from './time.js';

// Usable battery capacity as the battery behaves: energy discharged ÷ the drop in
// charge level, over consecutive 5-minute samples where it only discharged.
// Stored on the Sunsynk connection next to the configured value and the battery's
// own Ah × V reading, so all three can be compared. The configured value (from the
// installer, in .env) stays the one the core uses when it is set.
export function measureBatteryCapacity(siteId, days = 30) {
  const sid = (m) => seriesId('site', siteId, m, 'sunsynk_5min');
  const from = nowSec() - days * 86400;
  const read = (m) => new Map(db.prepare('SELECT ts, value FROM reading WHERE series_id = ? AND superseded_at IS NULL AND ts >= ?').all(sid(m), from).map((r) => [r.ts, r.value]));
  const soc = read('battery_soc_pct'); const dis = read('battery_discharge_w'); const chg = read('battery_charge_w');
  const ts = [...soc.keys()].sort((a, b) => a - b);
  let kwh = 0; let points = 0; let steps = 0;
  for (let i = 1; i < ts.length; i++) {
    const a = ts[i - 1]; const b = ts[i];
    if (b - a !== 300) continue;
    if ((chg.get(a) || 0) > 10 || (dis.get(a) || 0) <= 50 || soc.get(b) > soc.get(a)) continue;
    kwh += (dis.get(a) * 300) / 3.6e6; points += soc.get(a) - soc.get(b); steps++;
  }
  // Charge level is reported in whole percent, so a large total drop is needed for a stable figure.
  const measured = points >= 100 ? { kwhPer100: Math.round((kwh / points) * 1000) / 10, energyKwh: Math.round(kwh * 10) / 10, socPoints: points, steps, days, at: nowSec() } : null;
  const conn = db.prepare("SELECT meta FROM connection WHERE site_id = ? AND provider = 'sunsynk'").get(siteId);
  if (!conn) return null;
  const meta = JSON.parse(conn.meta || '{}');
  meta.batteryMeasured = measured ?? { reason: `only ${points}% of discharge-only charge drop in ${days} days; needs 100%` };
  db.prepare("UPDATE connection SET meta = ? WHERE site_id = ? AND provider = 'sunsynk'").run(JSON.stringify(meta), siteId);
  // The core mostly uses capacity to turn charge level (%) into kWh, so the measured kWh per
  // 1% is the right figure when the installer's value is not configured. The battery's own
  // Ah × voltage reading drifts with the voltage at the moment it is read (10.3–10.7 kWh seen).
  if (!process.env.BATTERY_KWH && measured) db.prepare('UPDATE site SET battery_kwh = ? WHERE id = ?').run(measured.kwhPer100, siteId);
  return meta.batteryMeasured;
}

// Panel tilt and direction estimated from the home's own output, for when the installer's
// values are not known. For each candidate pair, Open-Meteo returns sunlight on a panel at
// that angle for the last 14 days; the pair whose hour-by-hour shape best matches the
// inverter's actual solar output (highest R² of a fit through the origin) wins.
// Coarse grid first, then a finer grid around the best. Returns the full ranking so the
// strength of the result can be judged (a flat ranking means the data cannot tell).
export async function estimatePanelAngles(siteId, { fetchJson }) {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  if (site?.lat == null) return { reason: 'no coordinates' };
  const now = nowSec();
  const rows = db.prepare('SELECT slot_start, solar FROM site_hh WHERE site_id = ? AND slot_start >= ? AND state != ? AND solar IS NOT NULL')
    .all(siteId, now - 14 * 86400, 'missing');
  // Hourly actual solar, keyed by the end of the hour (Open-Meteo's irradiance at t covers [t − 1h, t)).
  const actual = new Map();
  for (const r of rows) { const end = r.slot_start - (r.slot_start % 3600) + 3600; actual.set(end, (actual.get(end) || 0) + r.solar); }
  const cache = new Map();
  const fit = async (tilt, bearing) => {
    const key = `${tilt}|${bearing}`;
    if (cache.has(key)) return cache.get(key);
    const params = new URLSearchParams({
      latitude: site.lat.toFixed(3), longitude: site.lon.toFixed(3), hourly: 'global_tilted_irradiance',
      tilt: String(tilt), azimuth: String(bearing - 180), past_days: '14', forecast_days: '1', timeformat: 'unixtime', timezone: 'GMT',
    });
    const { json } = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`);
    let sxy = 0; let sxx = 0; let syy = 0; let n = 0; let sy = 0;
    json.hourly.time.forEach((t, i) => {
      const g = json.hourly.global_tilted_irradiance[i]; const a = actual.get(t);
      if (g == null || a == null || t > now || g < 50) return;
      sxy += g * a; sxx += g * g; syy += a * a; sy += a; n++;
    });
    const k = sxx ? sxy / sxx : 0;
    // R² of y = k·x against the mean of y.
    const mean = n ? sy / n : 0;
    let ssRes = 0; let ssTot = 0;
    json.hourly.time.forEach((t, i) => {
      const g = json.hourly.global_tilted_irradiance[i]; const a = actual.get(t);
      if (g == null || a == null || t > now || g < 50) return;
      ssRes += (a - k * g) ** 2; ssTot += (a - mean) ** 2;
    });
    const res = { tilt, bearing, r2: ssTot ? 1 - ssRes / ssTot : null, hours: n, kwhPerWm2: k };
    cache.set(key, res);
    return res;
  };
  const coarse = [];
  for (const tilt of [10, 20, 30, 40, 50, 60]) for (const bearing of [90, 120, 150, 180, 210, 240, 270]) coarse.push(await fit(tilt, bearing));
  coarse.sort((a, b) => b.r2 - a.r2);
  const best0 = coarse[0];
  const fine = [];
  for (let tilt = Math.max(0, best0.tilt - 10); tilt <= Math.min(70, best0.tilt + 10); tilt += 5) {
    for (let bearing = best0.bearing - 30; bearing <= best0.bearing + 30; bearing += 10) fine.push(await fit(tilt, bearing));
  }
  const all = [...cache.values()].sort((a, b) => b.r2 - a.r2);
  return { best: all[0], ranking: all, hours: all[0].hours, days: 14, candidates: all.length };
}
