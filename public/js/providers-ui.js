// Words and badges for providers, shared by the Data & trust page ("Providers for this home") and
// the Connectors page. A status is always a word on a badge, never a colour only.
import { esc } from './api.js';

// What each role gives, in words (the registry's role codes: src/core/providers.js ROLES).
export const ROLE_LABEL = {
  inverter: 'Inverter', meter: 'Meter', location: 'Location', weather: 'Weather', carbon: 'Grid carbon intensity',
  gas_cv: 'Gas energy content', tariff_prices: 'Tariff prices', tariff_catalogue: 'Tariffs on sale',
  compare: 'Tariffs to compare with', solar_forecast: 'Solar forecast',
};
export const roleLabel = (role, fallback = '') => ROLE_LABEL[role] || fallback || String(role || '').replace(/_/g, ' ');

// A provider's status for one home (the API's site.providers[].status): [badge class, word, meaning].
export const PROVIDER_STATUS = {
  ok: ['good', 'OK', 'the last sync from this provider worked'],
  error: ['bad', 'Error', 'the last sync failed; the other providers still ran'],
  skipped: ['warn', 'Skipped', 'not run on the last sync (nothing to fetch yet, no credentials, or a demo home); not a failure'],
  disabled: ['', 'Disabled', 'listed for this market but switched off; the note says why'],
  none: ['', 'None', 'no provider is listed for this kind of data in this market'],
};
export const SCOPE_WORD = {
  shared: ['Shared across homes', 'fetched once per region, tariff or location and used by every home that needs it'],
  home: ['Per home', "uses this home's own connection (an account or an inverter)"],
};

export const statusBadge = (status) => {
  const [cls, word] = PROVIDER_STATUS[status] || ['', status || 'unknown'];
  return `<span class="badge ${cls}">${esc(word)}</span>`;
};
