// Energy suppliers, one row per supplier of a country (delta 080), whatever source names them. A catalogue
// adapter calls linkSupplier when it writes a tariff: the source's own name for the supplier (Tariffscanner's
// supplier_name, tounify's company id) is an alias, so two sources naming one supplier meet on one row and the
// tariff picker lists suppliers the same way for every country.
import { db } from '../db/db.js';

// Our own code for a supplier name: lower case, letters and digits joined by '-' ("Sainsbury's Energy" ->
// 'sainsburys-energy', "E.ON Next" -> 'eon-next', "E" -> 'e'). Accents are dropped ("Électricité" -> 'electricite').
export function supplierCode(name) {
  const code = String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return code || null;
}

/**
 * The supplier a source names (created on first sight): { provider, country, externalId, name } -> supplier row.
 * The alias (provider, country, externalId) is what the source says; the name is shown to users. A source
 * whose id is not a name (tounify 'EDF') passes the display name it has, else the id is used.
 */
export function ensureSupplier({ provider, country, externalId, name = null }) {
  const ext = String(externalId ?? '').trim();
  if (!provider || !/^[A-Z]{2}$/.test(country ?? '') || !ext) throw new Error('a supplier needs provider, country and the source\'s id for it');
  const known = db.prepare(`SELECT s.* FROM supplier_alias a JOIN supplier s ON s.id = a.supplier_id
    WHERE a.provider = ? AND a.country = ? AND a.external_id = ?`).get(provider, country, ext);
  if (known) {
    // A source that first gave only its id ('EDF') and later the display name: the row takes the name, keeps its code.
    if (name && known.name === ext && String(name).trim() && String(name).trim() !== ext) {
      db.prepare('UPDATE supplier SET name = ? WHERE id = ?').run(String(name).trim(), known.id);
      return { ...known, name: String(name).trim() };
    }
    return known;
  }
  const display = String(name ?? ext).trim() || ext;
  const code = supplierCode(display) ?? supplierCode(ext);
  db.prepare('INSERT OR IGNORE INTO supplier (country, code, name, recorded_at) VALUES (?, ?, ?, ?)').run(country, code, display, Date.now());
  const s = db.prepare('SELECT * FROM supplier WHERE country = ? AND code = ?').get(country, code);
  db.prepare('INSERT OR IGNORE INTO supplier_alias (supplier_id, provider, country, external_id) VALUES (?, ?, ?, ?)').run(s.id, provider, country, ext);
  return s;
}

/** Link a tariff to the supplier a source names; returns the supplier. Changing a tariff's supplier is allowed (a corrected name). */
export function linkSupplier(tariffId, { provider, country, externalId, name = null }) {
  const s = ensureSupplier({ provider, country, externalId, name });
  db.prepare('UPDATE tariff SET supplier_id = ? WHERE id = ? AND IFNULL(supplier_id, -1) <> ?').run(s.id, tariffId, s.id);
  return s;
}

// Tariffscanner names a tariff "<supplier_name>: <product name>" (src/adapters/tariffscanner.js mapRecord).
export const tariffscannerSupplierOf = (tariffName) => {
  const i = String(tariffName ?? '').indexOf(': ');
  return i > 0 ? tariffName.slice(0, i) : null;
};

/**
 * Tariffs written before delta 080 (or by a source that did not link them) get their supplier: Tariffscanner's
 * from the name, tounify's from the company its connection recorded. Idempotent; returns the number linked.
 */
export function backfillSuppliers(d = db) {
  let n = 0;
  const ts = d.prepare("SELECT id, name, country FROM tariff WHERE provider = 'tariffscanner' AND supplier_id IS NULL").all();
  for (const t of ts) {
    const sup = tariffscannerSupplierOf(t.name);
    if (!sup) continue;
    linkSupplier(t.id, { provider: 'tariffscanner', country: t.country ?? 'GB', externalId: sup, name: sup });
    n++;
  }
  const tu = d.prepare("SELECT id, product_code, country, origin_note FROM tariff WHERE provider = 'tounify' AND supplier_id IS NULL").all();
  for (const t of tu) {
    const m = / of ([^,;]+)/.exec(t.origin_note ?? '');
    if (!m) continue;
    linkSupplier(t.id, { provider: 'tounify', country: t.country, externalId: m[1].trim() });
    n++;
  }
  return n;
}
