// The pages' words follow the home: slot length (quarter-hour / half-hour / hour) and currency
// (p / c) from the API, and an origin badge always carries its word, not only a colour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setSlot, setCurrency, slotNoun, slotNouns, perSlot, zeroPrice, minorName, slotsPerHour, originBadge, originLegend } from '../public/js/api.js';

test('slot and currency words come from the home', () => {
  setSlot(900); setCurrency('EUR');
  assert.deepEqual([slotNoun(), slotNouns(), perSlot(), zeroPrice(), minorName(), slotsPerHour()], ['quarter-hour', 'quarter-hours', 'per quarter-hour', '0c', 'cents', 4]);
  setSlot(3600); setCurrency('GBP');
  assert.deepEqual([slotNoun(), zeroPrice(), minorName(), slotsPerHour()], ['hour', '0p', 'pence', 1]);
  setSlot(1800);
  assert.equal(slotNoun(), 'half-hour');
});

test('origin badges say the word; placeholder and synthetic are marked apart', () => {
  for (const o of ['sourced', 'provider', 'user', 'placeholder', 'synthetic']) {
    const b = originBadge(o, 'note');
    assert.ok(b.includes(`origin-${o}`) && b.includes(`>${o === 'placeholder' || o === 'synthetic' ? '⚠ ' : ''}${o}<`), b);
  }
  assert.match(originBadge(null), /origin-placeholder.*no origin recorded/);
  assert.ok(['sourced', 'provider', 'user', 'placeholder', 'synthetic'].every((o) => originLegend().includes(`origin-${o}`)));
});

test('no page hard-codes "0p" or a GB-only half-hour where the home\'s own words belong', () => {
  const dir = path.resolve(import.meta.dirname, '..', 'public', 'js', 'pages');
  for (const f of fs.readdirSync(dir)) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/\b0p\b/.test(code), `${f}: 0p`);
    assert.ok(!/['"`][^'"`]*\b[Hh]alf-hours?\b[^'"`]*['"`]/.test(code.replace(/NESO is its forecast for each half-hour/g, '')), `${f}: half-hour in a string`);
  }
});

test('the shared provider, Connectors and Compatibility views say no GB-only slot or currency words either', () => {
  const dir = path.resolve(import.meta.dirname, '..', 'public', 'js');
  for (const f of ['providers-ui.js', 'connectors-view.js', 'compatibility-view.js']) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/\b0p\b/.test(code), `${f}: 0p`);
    assert.ok(!/['"`][^'"`]*\b[Hh]alf-hours?\b[^'"`]*['"`]/.test(code), `${f}: half-hour in a string`);
    assert.ok(!/['"`][^'"`]*[£€][^'"`]*['"`]/.test(code), `${f}: a currency symbol in a string`);
  }
});
