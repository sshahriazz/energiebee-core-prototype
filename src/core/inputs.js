// Which source fills a role for a home. The slot builder asks for a role ("the inverter's 5-minute
// samples") and gets back the sources bound to it with the period each applies for, so a new
// inverter vendor is a binding row, not a change to the builder. No rows means the legacy source.
import { db } from '../db/db.js';
import { nowSec } from './time.js';

// Roles the slot builder and the planner read ask for. Each is filled by the sources bound to it
// (binding rows, started from binding_default); nothing here names a vendor.
//   inverter_5min   power and charge-level samples      inverter_daily  the inverter's daily totals
//   meter_energy    supplier meter energy per period     gas_cv          gas calorific value
//   carbon          grid carbon intensity                weather_temp    outdoor temperature
//   ev_dispatch     smart-charge dispatch periods        solar_forecast  solar forecast (priority order)
//   heat_pump_energy electricity into a heat pump   heat_output_energy heat delivered into the heating circuit
//   heat_telemetry   heating temperatures, set-points, on/off, COP     ev_charger_energy energy delivered to a car by a charger
//   plug_energy      a smart plug's energy (one binding per device)
// The last five have no default source: a home that binds none behaves as before (heat.js reads any heating source).
export const ROLES = ['inverter_5min', 'inverter_daily', 'meter_energy', 'gas_cv', 'carbon', 'weather_temp', 'ev_dispatch', 'solar_forecast',
  'heat_pump_energy', 'heat_output_energy', 'heat_telemetry', 'ev_charger_energy', 'plug_energy'];

// asOf: epoch seconds (a build "as known at"), or null for now. Returns [{ source, from, to }] in
// order of start then priority; deviceId is the device a binding names, or null for the home itself; from and to are epoch seconds, -Infinity / Infinity when open. A role
// with no binding has no source: [].
export function bindingsFor(siteId, role, asOf = null) {
  const at = asOf == null ? Number.MAX_SAFE_INTEGER : asOf * 1000;
  const rows = db.prepare(`SELECT so.code AS source, b.valid_from, b.valid_to, b.priority, b.device_id FROM binding b JOIN source so ON so.id = b.source_id
    WHERE b.site_id = ? AND b.role = ? AND b.recorded_at <= ? AND (b.superseded_at IS NULL OR b.superseded_at > ?)
    ORDER BY b.valid_from IS NOT NULL, b.valid_from, b.priority, b.id`).all(siteId, role, at, at);
  return rows.map((r) => ({ source: r.source, deviceId: r.device_id, from: r.valid_from ?? -Infinity, to: r.valid_to ?? Infinity }));
}

// How long an instant sample of a source holds (s): its declared trait (registry.js, source.traits), else 300.
export function holdSOf(source, fallback = 300) {
  try { return JSON.parse(db.prepare('SELECT traits FROM source WHERE code = ?').get(source)?.traits || '{}').holdS ?? fallback; } catch { return fallback; }
}

// The source in force at an instant, or null.
export const sourceAt = (bindings, ts) => bindings.find((b) => ts >= b.from && ts < b.to)?.source ?? null;

const insert = 'INSERT INTO binding (site_id, role, source_id, valid_from, valid_to, recorded_at, reason, priority, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';

// A change that takes effect before `from` = now alters slots already built, so it needs a reason (it
// is kept on the binding row, the log of why history moved). A change from now on needs none.
function requireReasonForPast(siteId, from, reason, what) {
  if (from == null || from >= nowSec()) return;
  const built = db.prepare('SELECT 1 FROM site_hh WHERE site_id = ? AND slot_start >= ? LIMIT 1').get(siteId, from);
  if (built && !String(reason ?? '').trim()) throw new Error(`${what} from ${from} changes slots already built: say why (reason)`);
}

// deviceId given: only that device's binding (null = the home's own); omitted: every open binding of the role.
const openBindings = (siteId, role, deviceId) => db.prepare(`SELECT * FROM binding WHERE site_id = ? AND role = ? AND superseded_at IS NULL AND valid_to IS NULL${deviceId === undefined ? '' : ' AND device_id IS ?'}`).all(siteId, role, ...(deviceId === undefined ? [] : [deviceId]));

// End the open binding(s) of a role at `at`: the role has no source from then on. Nothing before `at`
// changes. The ended row is superseded and re-recorded with its end, so "as known before" still sees it open.
export function unbind(siteId, role, { at = nowSec(), reason = null, deviceId } = {}) {
  requireReasonForPast(siteId, at, reason, 'unbind');
  const now = Date.now();
  const open = openBindings(siteId, role, deviceId);
  for (const o of open) {
    db.prepare('UPDATE binding SET superseded_at = ? WHERE id = ?').run(now, o.id);
    db.prepare(insert).run(siteId, role, o.source_id, o.valid_from, at, now, reason ?? o.reason, o.priority, o.device_id);
  }
  return open.length;
}

// Add a binding from a date: the previous open binding of the role ends there. Nothing before
// `from` changes. Returns the new row id.
// deviceId: the binding is for that device; it replaces only that device's open binding, so a second device is added beside the first.
export function bind(siteId, role, sourceCode, { from = null, reason = null, priority = 0, keep = false, deviceId } = {}) {
  const src = db.prepare('SELECT id FROM source WHERE code = ?').get(sourceCode);
  if (!src) throw new Error(`unknown source ${sourceCode}`);
  requireReasonForPast(siteId, from, reason, 'bind');
  const now = Date.now();
  const open = keep ? [] : openBindings(siteId, role, deviceId);   // keep: add a source beside the others (a forecast with a second source)
  for (const o of open) {
    db.prepare('UPDATE binding SET superseded_at = ? WHERE id = ?').run(now, o.id);
    // From the beginning (no date): the new source replaces the old one outright; otherwise the old one is kept up to `from`.
    if (from != null) db.prepare(insert).run(siteId, role, o.source_id, o.valid_from, from, now, o.reason, o.priority, o.device_id);
  }
  return Number(db.prepare(insert).run(siteId, role, src.id, from, null, now, reason, priority, deviceId ?? null).lastInsertRowid);
}
