// The sources a home starts with, per role (binding_default, delta 062), and a backfill for homes
// that have no binding of a role yet. Only missing rows are written; an operator's edit stays.
// A role is what the slot builder asks for; the source is who fills it (inputs.js ROLES).
export const BINDING_DEFAULTS = [
  ['inverter_5min', 'sunsynk_5min', 0], ['inverter_daily', 'sunsynk_daily', 0],
  ['meter_energy', 'octopus_meter', 0], ['gas_cv', 'national_gas_cv', 0], ['carbon', 'carbon_regional', 0],
  ['weather_temp', 'open_meteo', 0], ['ev_dispatch', 'octopus_kraken', 0],
  // Our own calibrated forecast first (the solar cases derive from it), Quartz where it has nothing.
  ['solar_forecast', 'core_forecast', 0], ['solar_forecast', 'quartz', 1],
];

export function bindingSeedPending(db) {
  return BINDING_DEFAULTS.some(([role, code]) => !db.prepare('SELECT 1 FROM binding_default d JOIN source s ON s.id = d.source_id WHERE d.role = ? AND s.code = ?').get(role, code))
    || Boolean(db.prepare(`SELECT 1 FROM site s CROSS JOIN binding_default d WHERE NOT EXISTS (SELECT 1 FROM binding b WHERE b.site_id = s.id AND b.role = d.role)`).get());
}

export function seedBindings(db) {
  const src = db.prepare('SELECT id FROM source WHERE code = ?');
  const insDefault = db.prepare('INSERT OR IGNORE INTO binding_default (role, source_id, priority) VALUES (?, ?, ?)');
  for (const [role, code, priority] of BINDING_DEFAULTS) {
    const s = src.get(code);
    if (s) insDefault.run(role, s.id, priority);
  }
  db.prepare(`INSERT INTO binding (site_id, role, source_id, valid_from, valid_to, recorded_at, priority, reason)
    SELECT s.id, d.role, d.source_id, NULL, NULL, ?, d.priority, 'default'
    FROM site s CROSS JOIN binding_default d
    WHERE NOT EXISTS (SELECT 1 FROM binding b WHERE b.site_id = s.id AND b.role = d.role)`).run(0);   // recorded_at 0: known from the start
}
