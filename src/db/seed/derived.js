// The derived points the core knows (plan 2.8): rows of derived_def, owned by the code like the capabilities. Each is a formula over
// points of the home (src/core/derived.js). The first three are what the build and the heating model work out in code today.
import { isDeepStrictEqual } from 'node:util';
import { orderDefs } from '../../core/derived.js';

const d = (code, label, metric, formula, inputs, description) => Object.freeze({ code, label, metric, formula, inputs: Object.freeze(inputs), description });
const m = (metric, optional = false) => Object.freeze(optional ? { metric, optional: true } : { metric });

export const DERIVED = Object.freeze([
  d('home_use_kwh', 'Home use by energy balance', 'load_kwh',
    'solar + grid_import - grid_export + battery_discharge - battery_charge',
    { solar: m('solar_kwh', true), grid_import: m('grid_import_kwh'), grid_export: m('grid_export_kwh', true), battery_discharge: m('battery_discharge_kwh', true), battery_charge: m('battery_charge_kwh', true) },
    'What the home used: what came in from the sun, the grid and the battery, less what went out to the grid and into the battery.'),
  d('untracked_kwh', 'Untracked consumption', 'extra_load_kwh',
    'max(home_use - plug - ev - heat_pump, 0)',
    { home_use: { derived: 'home_use_kwh' }, plug: m('plug_kwh', true), ev: m('ev_delivered_kwh', true), heat_pump: m('heatpump_elec_kwh', true) },
    'What the home used that no tracked device accounts for.'),
  d('heatpump_cop', 'Heat pump COP', 'heatpump_cop',
    'ratio(heat, electricity, 0.001)',
    { heat: m('heat_output_kwh'), electricity: m('heatpump_elec_kwh') },
    'Heat delivered per unit of electricity in the slot (electricity only, above 0.001 kWh).'),
]);
// the definitions must be consistent before they reach the database
orderDefs(DERIVED);

const COLS = ['label', 'metric', 'formula', 'inputs', 'description'];
export async function derivedSeedDiff(db) {
  const have = new Map((await db.prepare('SELECT code, label, metric, formula, inputs, description FROM derived_def').all()).map((r) => [r.code, r]));
  return DERIVED.filter((x) => { const r = have.get(x.code); return !r || COLS.some((c) => !isDeepStrictEqual(r[c] ?? null, x[c] ?? null)); });
}
export async function seedDerived(db, diff) {
  const up = db.prepare(`INSERT INTO derived_def (code, label, metric, formula, inputs, description) VALUES (?, ?, ?, ?, ?::jsonb, ?)
    ON CONFLICT (code) DO UPDATE SET label = excluded.label, metric = excluded.metric, formula = excluded.formula, inputs = excluded.inputs, description = excluded.description`);
  for (const x of diff) await up.run(x.code, x.label, x.metric, x.formula, JSON.stringify(x.inputs), x.description);
  return diff.length;
}
