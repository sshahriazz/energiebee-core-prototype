// The control scheduler: every few seconds, each registered driver gets one control cycle for each home that has a
// command to act on (pending, sent, expired but possibly applied late, or acked and not yet effect-checked).
// A vendor's driver registers itself here (registerControlDriver); with none registered the tick does nothing.
// runControlCycle (core/executor.js) does the work; this file only decides when, and keeps one failing driver or
// home from stopping the others.
import { db } from '../db/db.js';
import { runControlCycle } from '../core/executor.js';

const drivers = [];
export function registerControlDriver(driver) {
  if (!driver?.read || !driver?.send || !driver?.source) throw new Error('a driver needs source, read(device) and send(device, desired)');
  if (!drivers.includes(driver)) drivers.push(driver);
  return () => { const i = drivers.indexOf(driver); if (i >= 0) drivers.splice(i, 1); };
}
export const registeredDrivers = () => drivers.slice();

// One pass. Returns [{ siteId, driver, result | error }] for the homes and drivers it ran.
export async function controlTick({ now = Date.now(), driversList = drivers } = {}) {
  if (!driversList.length) return [];
  const sites = db.prepare(`SELECT DISTINCT d.site_id FROM command c JOIN device d ON d.id = c.device_id
    WHERE c.status IN ('pending', 'sent') OR (c.status = 'expired' AND c.sent_at IS NOT NULL AND c.applied_late_at IS NULL)
      OR (c.status = 'acked' AND c.verify_status IS NULL)`).all().map((r) => r.site_id);
  const out = [];
  for (const siteId of sites) {
    for (const driver of driversList) {
      try { out.push({ siteId, driver: driver.source, result: await runControlCycle(siteId, { driver, now }) }); }
      catch (error) { out.push({ siteId, driver: driver.source, error: error.message }); }
    }
  }
  return out;
}

// Start the periodic tick (seconds; default 30, at least 5). Returns the interval used.
let ticking = false;
export function startControlScheduler(seconds = 30) {
  const every = Math.max(Number(seconds) || 30, 5);
  setInterval(async () => {
    if (ticking) return;                       // a slow device must not stack ticks
    ticking = true;
    try { for (const r of await controlTick()) if (r.error) console.error(`control ${r.driver} home ${r.siteId}:`, r.error); }
    catch (err) { console.error('control tick:', err.message); } finally { ticking = false; }
  }, every * 1000).unref();
  return every;
}
