// Presentation model for the focused electricity demo. The core's stored facts and
// calculations remain unchanged; absent sensor readings are not presented as zeros.
import { slotsOfDay, localDate, SLOT } from './time.js';

export const ENERGY = ['solar', 'home', 'grid_import', 'grid_export', 'battery_charge', 'battery_discharge'];
export const FLOWS = [
  'solar_to_home',
  'solar_to_battery',
  'solar_to_grid',
  'battery_to_home',
  'battery_to_grid',
  'grid_to_home',
  'grid_to_battery',
  'solar_to_loss',
  'battery_to_loss',
  'grid_to_loss',
];
export const POWER = {
  solar: 'solar_w',
  home: 'load_w',
  grid_import: 'grid_import_w',
  grid_export: 'grid_export_w',
  battery_charge: 'battery_charge_w',
  battery_discharge: 'battery_discharge_w',
};
export const ENERGY_CHECKS = new Set([
  'completeness',
  'energy_balance',
  'meter_vs_ct',
  'meter_vs_ct_export',
  'counter_fit_solar',
  'counter_fit_load',
  'counter_fit_import',
  'counter_fit_export',
  'counter_fit_charge',
  'counter_fit_discharge',
]);

export function validDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

export function defaultDay(days, today) {
  return (
    days.find((d) => d.local_date < today && d.slots_final === d.expectedSlots && d.slots === d.expectedSlots)
      ?.local_date ??
    days.find((d) => d.local_date < today)?.local_date ??
    days[0]?.local_date ??
    null
  );
}

// Match the build engine's maximum five-minute forward hold at slot boundaries.
export function sensorCoverage(readings) {
  const grouped = new Map();
  for (const r of readings) {
    if (!grouped.has(r.metric)) grouped.set(r.metric, []);
    grouped.get(r.metric).push(r);
  }
  const result = new Map();
  for (const [metric, values] of grouped) {
    values.sort((a, b) => a.ts - b.ts);
    values.forEach((r, i) => {
      if (r.value == null) return;
      const end = Math.min(r.ts + 300, values[i + 1]?.ts ?? r.ts + 300);
      for (let t = r.ts; t < end;) {
        const slot = Math.floor(t / SLOT) * SLOT;
        const until = Math.min(end, slot + SLOT);
        const key = `${metric}:${slot}`;
        result.set(key, Math.min(1, (result.get(key) || 0) + (until - t) / SLOT));
        t = until;
      }
    });
  }
  return result;
}

export function energyRow(row, coverage) {
  const lineage = typeof row.lineage === 'string' ? JSON.parse(row.lineage || '{}') : row.lineage || {};
  const out = {
    slot_start: row.slot_start,
    state: row.state,
    quality: row.quality || 0,
    built_at: row.built_at ?? null,
    method: row.method_version ?? null,
    source: { import: lineage.import ?? null, export: lineage.export ?? null, solar: lineage.solar ?? null },
    fit: lineage.fit || {},
    coverage: {},
    soc_end: row.soc_end ?? null,
  };
  for (const key of ENERGY) {
    const sensor = coverage.get(`${POWER[key]}:${row.slot_start}`) || 0;
    const meter =
      key === 'grid_import'
        ? lineage.import === 'octopus_meter'
        : key === 'grid_export' && lineage.export === 'octopus_meter';
    out.coverage[key] = meter ? 1 : sensor;
    out[key] = (meter || sensor > 0) && row[key] != null ? row[key] : null;
  }
  // The allocation and house-load clamp need all source flows, not just a load reading.
  const inputsKnown = ENERGY.filter((k) => k !== 'home').every((k) => out[k] != null);
  if (!inputsKnown) out.home = null;
  const completeInputs = inputsKnown && out.home != null;
  for (const key of FLOWS) out[key] = completeInputs ? (row[key] ?? null) : null;
  out.loss = completeInputs ? (row.loss ?? null) : null;
  out.partial = ENERGY.some((k) => out[k] == null || out.coverage[k] < 0.8);
  return out;
}

export function dayView(storedRows, coverage, date, timezone, now) {
  const stored = new Map(storedRows.map((r) => [r.slot_start, r]));
  const all = slotsOfDay(timezone, date);
  const slots = all.filter((t) => t <= now);
  const rows = slots.map((slot) =>
    energyRow(stored.get(slot) || { slot_start: slot, state: 'missing' }, coverage)
  );
  const totals = Object.fromEntries(
    [...ENERGY, ...FLOWS].map((key) => {
      const known = rows.filter((r) => r[key] != null);
      return [
        key,
        {
          value: known.length ? known.reduce((s, r) => s + r[key], 0) : null,
          knownSlots: known.length,
          complete: known.length === rows.length && rows.every((r) => !r.partial),
        },
      ];
    })
  );
  const states = Object.fromEntries(
    ['final', 'provisional', 'missing'].map((s) => [s, rows.filter((r) => r.state === s).length])
  );
  return {
    date,
    timezone,
    rows,
    totals,
    states,
    expectedSlots: all.length,
    elapsedSlots: slots.length,
    partialSlots: rows.filter((r) => r.partial).length,
    closed: date < localDate(timezone, now),
  };
}
