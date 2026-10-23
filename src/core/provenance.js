// Provenance: where a number came from, in ONE vocabulary used by the data (origin columns), the
// build (site_hh.lineage), the API (origin fields and provenance blocks), the pages (badges and
// banners), the demo output and the docs. Strongest first:
//   sourced      taken from a named, checkable source; origin_note names it (GB VAT from
//                registry.js VAT_RATES, GB region numbering from the eb-auth / Octopus / MPAN lists)
//   provider     live data fetched from a provider for a real home (Octopus, Sunsynk)
//   user         typed in by the user or installer
//   derived      computed by us from the above; a figure computed from several inputs carries
//                the weakest input's label instead, so this is rarely stored on its own
//   placeholder  a stand-in from memory or an assumption, NOT verified against an official
//                source (FR and NL tax values, the DE/BE/ES market rows, anything unverified)
//   synthetic    generated test or demo data (readings, spot prices, Tempo calendar, meters)
// A value with no recorded origin (NULL: written before labels existed) counts as a placeholder:
// nobody vouched for it.
export const ORIGINS = Object.freeze(['sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic']);
const RANK = new Map(ORIGINS.map((o, i) => [o, i]));
export const UNVERIFIED = Object.freeze(['placeholder', 'synthetic']);

export const isOrigin = (o) => RANK.has(o);
export const isUnverified = (o) => UNVERIFIED.includes(originOf(o));
export const originOf = (o) => (RANK.has(o) ? o : 'placeholder');

// Throws unless o is in the vocabulary (writers call this before storing a label).
export function checkOrigin(o, what = 'origin') {
  if (!RANK.has(o)) throw new RangeError(`${what}: origin must be one of ${ORIGINS.join(', ')}, not ${o}`);
  return o;
}

// The weakest of a list of origins (null for an empty list).
export function weakest(origins) {
  let w = null;
  for (const o of origins) {
    const x = originOf(o);
    if (w == null || RANK.get(x) > RANK.get(w)) w = x;
  }
  return w;
}

// "tax_rule FR/accise [placeholder]": how an input is named in lineage, the API and the demo.
export const labelOf = (what, origin) => `${what} [${originOf(origin)}]`;

// Inputs of one or more prices ({ what, origin } each, see pricing.js priceAt) to the slot's
// provenance: the weakest origin, and every placeholder or synthetic input named.
export function inputsProvenance(inputs) {
  const seen = new Map();
  for (const i of inputs) if (i && !seen.has(`${i.what}\u0000${i.origin}`)) seen.set(`${i.what}\u0000${i.origin}`, i);
  const list = [...seen.values()];
  if (!list.length) return null;
  return {
    origin: weakest(list.map((i) => i.origin)),
    placeholder_inputs: list.filter((i) => isUnverified(i.origin)).map((i) => labelOf(i.what, i.origin)),
  };
}

// Where a home's energy data comes from: a demo home's readings are generated.
export const dataOriginOf = (site) => (site?.is_demo ? 'synthetic' : 'provider');

// A home's own label for /api/sites: generated (demo), fed by providers, or typed in.
export function siteOrigin(site, providers = []) {
  if (site.is_demo) return { origin: 'synthetic', origin_note: 'demo home: every reading, tariff and price is generated' };
  if (providers.some((p) => ['sunsynk', 'octopus', 'tariff'].includes(p))) {
    return { origin: 'provider', origin_note: 'readings and tariffs fetched from the home\'s providers; each figure carries its own label' };
  }
  return { origin: 'user', origin_note: 'home details typed in; no provider connected' };
}

// The provenance block of a period (summary, timeline, breakdown ...): the weakest origin used,
// and every placeholder or synthetic input named. Read from what each slot's lineage recorded when
// it was built. Slots built before lineage carried an origin are labelled from the tariffs, rates
// and tax rules in force over the period instead (unlabelled_slots says how many).
export function periodProvenance(db, site, from, to, bounds) {
  const q = 'FROM site_hh WHERE site_id = ? AND local_date >= ? AND local_date <= ?';
  const groups = db.prepare(`SELECT json_extract(lineage, '$.origin') AS origin, json_extract(lineage, '$.data_origin') AS data_origin,
      COUNT(*) AS n, SUM(json_extract(lineage, '$.estimated') = 1) AS estimated, SUM(json_extract(lineage, '$.capacity_unknown') = 1) AS capacity_unknown
    ${q} AND json_valid(lineage) GROUP BY 1, 2`).all(site.id, from, to);
  const listed = db.prepare(`SELECT DISTINCT j.value AS v FROM site_hh h, json_each(h.lineage, '$.placeholder_inputs') j
    WHERE h.site_id = ? AND h.local_date >= ? AND h.local_date <= ? AND json_valid(h.lineage)`).all(site.id, from, to).map((r) => r.v);
  const slots = groups.reduce((s, g) => s + g.n, 0);
  const unlabelled = groups.filter((g) => g.origin == null).reduce((s, g) => s + g.n, 0);
  const origins = groups.map((g) => g.origin).filter(Boolean);
  const placeholders = new Set(listed);
  const data = dataOriginOf(site);
  if (slots) origins.push(data);
  if (isUnverified(data) && slots) placeholders.add(labelOf('energy data (demo home)', data));
  if (unlabelled && bounds) {
    for (const i of inForceInputs(db, site, bounds[0], bounds[1])) {
      origins.push(i.origin);
      if (isUnverified(i.origin)) placeholders.add(labelOf(i.what, i.origin));
    }
  }
  const worst = weakest(origins);
  return {
    worst, placeholders: [...placeholders].sort(), demo: !!site.is_demo, data_origin: data, slots,
    unlabelled_slots: unlabelled, estimated_slots: groups.reduce((s, g) => s + (g.estimated || 0), 0),
    capacity_unknown_slots: groups.reduce((s, g) => s + (g.capacity_unknown || 0), 0),
    verified: worst != null && !isUnverified(worst),
  };
}

// The tariffs, rate rows and tax rules in force for a home over [a, b), as labelled inputs.
export function inForceInputs(db, site, a, b) {
  const out = [];
  const tariffs = db.prepare(`SELECT DISTINCT t.id, t.tariff_code, t.origin FROM tariff_agreement ag JOIN tariff t ON t.id = ag.tariff_id
    WHERE ag.site_id = ? AND ag.superseded_at IS NULL AND ag.valid_from < ? AND IFNULL(ag.valid_to, 9000000000) > ?`).all(site.id, b, a);
  for (const t of tariffs) {
    out.push({ what: `tariff ${t.tariff_code}`, origin: t.origin });
    for (const r of db.prepare(`SELECT DISTINCT origin FROM rate_interval WHERE tariff_id = ? AND superseded_at IS NULL AND valid_from < ? AND IFNULL(valid_to, 9000000000) > ?
        AND (site_id IS NULL OR site_id = ?)`).all(t.id, b, a, site.id)) out.push({ what: `rates ${t.tariff_code}`, origin: r.origin });
  }
  for (const r of db.prepare(`SELECT country, code, origin FROM tax_rule WHERE country = ? AND superseded_at IS NULL AND valid_from < ? AND IFNULL(valid_to, 9000000000) > ?`)
    .all(site.country ?? 'GB', b, a)) out.push({ what: `tax_rule ${r.country}/${r.code}`, origin: r.origin });
  return out;
}
