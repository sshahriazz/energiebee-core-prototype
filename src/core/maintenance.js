// Start-up corrections and migrations. Each is idempotent (safe on every start) and every
// fact it withdraws is logged in fact_correction with the reason, so nothing changes silently.
import { db, tx } from '../db/db.js';
import { seriesId } from './facts.js';
import { nowSec } from './time.js';
import { seedAttributes } from './attributes.js';

// Earlier code (before 16 Oct 2026) converted this home's gas readings from m³ to kWh with a
// fixed calorific value as it stored them, and saved the result as Octopus 'gas_kwh' facts.
// Octopus never sent those numbers: it reports m³ for this meter, and the m³ readings are
// stored as 'gas_m3' and converted in the build with the daily calorific value. The build
// already ignores the old 'gas_kwh' rows; withdrawing them keeps the facts truthful.
export function withdrawDerivedGas(siteId) {
  let withdrawn = 0;
  for (const d of db.prepare("SELECT id, attrs FROM device WHERE site_id = ? AND kind = 'meter_gas'").all(siteId)) {
    if (JSON.parse(d.attrs || '{}').gasUnit?.unit !== 'm3') continue;
    const series = seriesId('device', d.id, 'gas_kwh', 'octopus_meter');
    tx(() => {
      const n = db.prepare('UPDATE interval_fact SET superseded_at = ? WHERE series_id = ? AND superseded_at IS NULL').run(Date.now(), series).changes;
      if (n) {
        db.prepare('INSERT INTO fact_correction (site_id, corrected_at, series_id, rows, reason) VALUES (?, ?, ?, ?, ?)').run(siteId, nowSec(), series, n,
          'Gas kWh values computed by earlier EnergieBee code (m³ × a fixed calorific value) had been stored as if Octopus sent them. '
          + 'Octopus reports m³ for this meter; those readings are kept and converted with National Gas\'s daily calorific value.');
        withdrawn += n;
      }
    });
  }
  return withdrawn;
}

// Record the system details already on `site` as their first versions (databases created
// before details were versioned), with the source they most likely came from.
export function seedSiteAttributes(siteId) {
  const meta = JSON.parse(db.prepare("SELECT meta FROM connection WHERE site_id = ? AND provider = 'sunsynk'").get(siteId)?.meta || '{}');
  const env = process.env;
  seedAttributes(siteId, (attr, value) => {
    if (attr === 'battery_kwh') {
      if (env.BATTERY_KWH) return { source: 'installer', detail: '.env BATTERY_KWH' };
      if (meta.batteryMeasured?.kwhPer100 === value) return { source: 'measured', detail: `measured: ${meta.batteryMeasured.energyKwh} kWh discharged over ${meta.batteryMeasured.socPoints} points of charge drop` };
      return { source: 'provider', detail: 'battery reading (Ah × voltage)' };
    }
    if (attr === 'pv_kwp') return env.PV_KWP ? { source: 'installer', detail: '.env PV_KWP' } : { source: 'provider', detail: 'Sunsynk plant record' };
    const est = meta.panelAnglesEstimate;
    const isEst = est && ((attr === 'pv_tilt' && value === est.tilt) || (attr === 'pv_orientation' && value === est.bearing));
    return isEst ? { source: 'estimated', detail: "estimated from this home's output" } : { source: 'installer', detail: `.env ${attr === 'pv_tilt' ? 'PV_TILT' : 'PV_ORIENTATION'}` };
  });
}

export function runMaintenance() {
  const out = {};
  for (const { id } of db.prepare('SELECT id FROM site').all()) {
    seedSiteAttributes(id);
    out[id] = { gasKwhWithdrawn: withdrawDerivedGas(id) };
  }
  return out;
}
