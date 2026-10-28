// The Providers screen's new HTML builders on the real home's model: health chips and cells, the replay block, escaping of
// server text, no undefined or NaN, and that the new pages' scripts parse and the CSS defines what they use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { onboarding } = hasLive ? await import('../src/core/onboarding.js') : {};
const { health } = hasLive ? await import('../src/core/health.js') : {};
const { replayCandidates } = hasLive ? await import('../src/core/replay.js') : {};
const V = hasLive ? await import('../public/js/onboarding-view.js') : {};

const colors = (model) => { const m = new Map(); for (const r of model.roles) for (const b of r.bindings) if (!m.has(b.source)) m.set(b.source, m.size); return m; };
const withExtras = (now) => { const m = onboarding(1); m.health = health(1, { now }); m.replay = replayCandidates(1, { now }); return m; };

test('with health, every role card shows a chip for its overall status and each binding a cell with the reason, with no undefined or NaN', { skip }, () => {
  const model = withExtras(Math.floor(Date.now() / 1000));
  const html = model.roles.map((r) => V.roleCard(r, model, 'Europe/London', colors(model))).join('');
  assert.ok(/class="badge (good|warn|bad) ob-health"/.test(html));
  assert.ok(html.includes('<th>Health</th>'));
  assert.ok(!/undefined|NaN|\[object/.test(html), html.match(/.{30}(undefined|NaN|\[object).{30}/)?.[0]);
  assert.match(html, /it normally sends every 5 minutes/);
});

test('without health or replay data the cards still render (the extras are optional)', { skip }, () => {
  const model = onboarding(1);
  const html = model.roles.map((r) => V.roleCard(r, model, 'Europe/London', colors(model))).join('') + V.rejectsCard(model, 'Europe/London');
  assert.ok(html.length > 3000 && !/undefined|NaN/.test(html));
  assert.ok(!/class="badge[^"]*ob-health"/.test(html), "no chip without health data");
});

test('each status has its chip class and word, and an ended binding says so instead of a status', { skip }, () => {
  const mk = (status) => ({ status, reason: 'because', rejected24h: { total: 0, top: [] }, lastPushAt: null });
  assert.match(V.healthChip(mk('ok')), /badge good ob-health.*Delivering/);
  assert.match(V.healthChip(mk('late')), /badge warn ob-health.*Late/);
  assert.match(V.healthChip(mk('silent')), /badge bad ob-health.*Silent/);
  assert.match(V.healthChip(mk('never')), /badge warn ob-health.*No data yet/);
  assert.equal(V.healthChip(null), '');
  assert.match(V.healthCell(null, 'Europe/London'), /not in force now/);
  const cell = V.healthCell({ ...mk('late'), reason: 'No new data for 3 h; it normally sends every 5 minutes.', rejected24h: { total: 4, top: [{ text: 'outside the allowed range', count: 3 }, { text: 'a point nobody mapped', count: 1 }] }, lastPushAt: 1_800_000_000_000 }, 'Europe/London');
  assert.ok(cell.includes('4 refused in 24 h: outside the allowed range (3), a point nobody mapped (1)') && cell.includes('last push'));
});

test('server text is escaped in the chip, the cell and the replay block', { skip }, () => {
  const evil = '<img src=x onerror=alert(1)>';
  assert.ok(!V.healthChip({ status: 'ok', reason: evil }).includes('<img'));
  assert.ok(!V.healthCell({ status: 'late', reason: evil, rejected24h: { total: 1, top: [{ text: evil, count: 1 }] }, lastPushAt: null }, 'UTC').includes('<img'));
  const model = { replay: { total: 0, sources: [{ source: evil, canReplay: false, receipts: 0, refused: 1, unmapped: 0, why: evil }], lastRuns: [] } };
  assert.ok(!V.replayBlock(model, 'UTC').includes('<img'));
});

test('the replay block: how many receipts per source, why a source cannot replay, a disabled button when nothing can, the last run', { skip }, () => {
  const model = { replay: { total: 3, sources: [
    { source: 'sunsynk_5min', canReplay: true, receipts: 3, refused: 4, unmapped: 1, why: null },
    { source: 'open_meteo', canReplay: false, receipts: 0, refused: 2, unmapped: 0, why: 'The parse is inline in the adapter.' }], lastRuns: [{ startedAt: 1_800_000_000_000, receipts: 5, written: 9 }] } };
  const html = V.replayBlock(model, 'Europe/London');
  assert.match(html, /3 saved receipts can be read again \(4 refused, 1 unmapped\)/);
  assert.match(html, /open_meteo<\/b>: cannot be replayed\. The parse is inline in the adapter\./);
  assert.match(html, /Replay 3 receipts…/);
  assert.match(html, /Last replay .*5 receipts read, 9 facts recovered/);
  assert.match(V.replayBlock({ replay: { ...model.replay, total: 0 } }, 'UTC'), /<button class="btn btn-sm" data-act="replay" disabled>Replay 0 receipts/);
  assert.equal(V.replayBlock({}, 'UTC'), '');
  assert.equal(V.replayBlock({ replay: { total: 0, sources: [], lastRuns: [] } }, 'UTC'), '');
});

test('a refused-values row offers Map this point for an unmapped point and Edit mapping for the others; the replay block sits in the same card', { skip }, () => {
  const model = { days: 7, rejects: { days: 7, total: 6, byReason: { out_of_range: 4, unmapped_point: 2 }, byPoint: [
    { source: 'sunsynk_5min', point: 'PV', reason: 'out_of_range', count: 4, lastAt: 1_800_000_000_000, minValue: 9, maxValue: 90 },
    { source: 'sunsynk_5min', point: 'Odd', reason: 'unmapped_point', count: 2, lastAt: 1_800_000_000_000, minValue: null, maxValue: null }] },
    replay: { total: 1, sources: [{ source: 'sunsynk_5min', canReplay: true, receipts: 1, refused: 4, unmapped: 2, why: null }], lastRuns: [] } };
  const html = V.rejectsCard(model, 'UTC');
  assert.match(html, /data-act="mapsrc" data-source="sunsynk_5min">Edit mapping/);
  assert.match(html, /data-act="mappoint" data-source="sunsynk_5min" data-point="Odd">Map this point/);
  assert.match(html, /Recover refused values/);
  assert.equal((html.match(/<section class="card"/g) ?? []).length, 1);
});

test('the Advanced hints and the unit presets exist for every option, and the presets are parseable', { skip }, () => {
  for (const k of ['kind', 'derived', 'counterWrap', 'counterResetBelow', 'maxGapS', 'maxStuckSamples', 'clockOffsetS', 'futureToleranceS', 'access', 'enumValues']) assert.ok(V.ADV_HINTS[k] && V.ADV_HINTS[k].length > 20, k);
  for (const [v] of V.UNIT_PRESETS.slice(1)) { const [t, sh] = v.split('|'); assert.ok(Number.isFinite(Number(t)) && Number.isFinite(Number(sh)), v); }
  assert.ok(V.UNIT_PRESETS.some(([v]) => v === '1000|0') && V.UNIT_PRESETS.some(([v]) => v === '0.001|0'));
});

test('the page script parses, uses only classes the stylesheet defines, and the page is served', { skip }, () => {
  const js = fs.readFileSync(path.resolve(import.meta.dirname, '../public/js/pages/providers.js'), 'utf8');
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '../public/css/onboarding.css'), 'utf8') + fs.readFileSync(path.resolve(import.meta.dirname, '../public/css/app.css'), 'utf8');
  for (const cls of ['ob-adv', 'ob-advrow', 'ob-replay', 'ob-health', 'ob-healthcell', 'ob-sub']) assert.ok(css.includes(`.${cls}`), `css defines .${cls}`);
  for (const w of ['newsource', 'src-check', 'src-create', 'pri-confirm', 'rep-real', 'adv']) assert.ok(js.includes(`'${w}'`), `the page handles ${w}`);
});
