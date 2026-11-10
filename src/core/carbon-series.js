// Which grid-carbon series a home reads: one place, so the build, the forecast, the explorer and the trust view agree.
//
//   GB  the NESO region of the home's postcode (site.carbon_region, set by src/adapters/geo.js): series
//       carbon:<region id> of source carbon_regional, past periods and a 48-hour forecast.
//   FR  one national series, carbon:FR, of source rte_eco2mix (src/adapters/rte.js): past periods only (RTE
//       publishes no carbon forecast).
// Any other country: none (the slot's carbon stays null, never a guess).
// The series id is a region subject, so every home of a region or country shares it; which sources a home
// reads it from is its 'carbon' binding (binding_default lists both, in priority order: the first source that
// has a value for a period wins, so a GB home reads NESO and a French home RTE).
export const NATIONAL_CARBON = Object.freeze({
  FR: Object.freeze({ subject: 'carbon:FR', source: 'rte_eco2mix', provider: 'RTE éCO2mix', scope: 'national', forecast: false }),
});

/** { subject, source, provider, scope, forecast } for the home, or null when no carbon source covers it. */
export function carbonSeriesOf(site) {
  if (!site) return null;
  if (site.carbon_region != null) {
    return { subject: `carbon:${site.carbon_region}`, source: 'carbon_regional', provider: 'NESO', scope: `region ${site.carbon_region}`, forecast: true };
  }
  return NATIONAL_CARBON[site.country ?? site.market_code] ?? null;
}

/** The region subject id alone (carbon:3, carbon:FR), or null. */
export const carbonSubjectOf = (site) => carbonSeriesOf(site)?.subject ?? null;
