// The push format parsers (src/core/push-formats.js) are pure: each is tested against a saved body. The Shelly, Tasmota and Home Assistant
// fixtures are the vendors' DOCUMENTED shapes (test/fixtures/push/*.documented-shape.json); none is a capture from a real device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePush, toSeconds, toNumber, PushError, FORMATS } from '../src/core/push-formats.js';

const fx = (name) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'push', `${name}.documented-shape.json`), 'utf8'));
const NOW = 1782000000;
const byPoint = (r) => Object.fromEntries(r.observations.map((o) => [o.point, o.value]));
const code = (fn) => { try { fn(); } catch (e) { return e instanceof PushError ? e.code : `other:${e.message}`; } return null; };

test('the formats are listed with a source each', () => {
  assert.deepEqual(Object.keys(FORMATS), ['native', 'shelly_gen2_switch', 'tasmota_sensor', 'homeassistant_state']);
  assert.ok(Object.values(FORMATS).every((f) => f.source.startsWith('push_')));
});

test('times: seconds, milliseconds (warned), numeric strings, ISO with an offset, ISO without one (UTC, warned); nonsense refused', () => {
  const w = [];
  assert.equal(toSeconds(1782000000, w, 'ts'), 1782000000);
  assert.equal(toSeconds('1782000000', w, 'ts'), 1782000000);
  assert.equal(w.length, 0);
  assert.equal(toSeconds(1782000000123, w, 'ts'), 1782000000);
  assert.match(w[0], /milliseconds/);
  assert.equal(toSeconds('2026-06-20T12:00:00+01:00', w, 'ts'), Date.UTC(2026, 5, 20, 11) / 1000);
  assert.equal(toSeconds('2026-06-20T12:00:00Z', w, 'ts'), Date.UTC(2026, 5, 20, 12) / 1000);
  assert.equal(toSeconds('2026-06-20 12:00:00', w, 'ts'), Date.UTC(2026, 5, 20, 12) / 1000);
  assert.match(w[1], /no time zone offset/);
  assert.equal(code(() => toSeconds('yesterday', [], 'ts')), 'bad_timestamp');
  assert.equal(code(() => toSeconds(Infinity, [], 'ts')), 'bad_timestamp');
  assert.equal(code(() => toSeconds(-5, [], 'ts')), 'bad_timestamp');
  assert.equal(code(() => toSeconds({}, [], 'ts')), 'bad_timestamp');
});

test('values: numbers, numeric strings, booleans and on/off; anything else refused', () => {
  assert.deepEqual([toNumber(3, 'v'), toNumber('2.5', 'v'), toNumber(true, 'v'), toNumber('OFF', 'v'), toNumber('On', 'v')], [3, 2.5, 1, 0, 1]);
  for (const bad of [NaN, Infinity, 'abc', '', null, {}, []]) assert.equal(code(() => toNumber(bad, 'v')), 'bad_value', String(bad));
});

test('native: observations of every shape, and the points shorthand', () => {
  const r = parsePush('native', { observations: [
    { point: 'power', ts: NOW, value: 100 }, { point: 'energy_total', ts: NOW + 300, value: '12.5' }, { point: 'ev', start: NOW, end: NOW + 600, value: 2 },
    { point: 'f', start: NOW, end: NOW + 900, issuedAt: NOW - 60, value: 1 }, { point: 'plugged_in', ts: NOW, kind: 'event' }, { kind: 'ack', commandId: 7, ref: 'abc' }, { point: 'mode', ts: NOW, kind: 'state', value: 2 }] }, { now: NOW });
  assert.equal(r.observations.length, 7);
  assert.deepEqual(r.observations[3], { point: 'f', start: NOW, end: NOW + 900, issuedAt: NOW - 60, value: 1 });
  assert.deepEqual(r.observations[5], { kind: 'ack', commandId: 7, ref: 'abc', ts: NOW });
  assert.equal(r.observations[4].value, undefined, 'an event needs no value');
  const s = parsePush('native', { points: { power: 120, relay: true } }, { now: NOW });
  assert.deepEqual(s.observations.map((o) => [o.point, o.value, o.ts]), [['power', 120, NOW], ['relay', 1, NOW]]);
  assert.equal(parsePush('native', { points: { power: 1 }, ts: 1782000000999 }, { now: NOW }).warnings.length, 1, 'a millisecond ts is read and warned');
});

test('native: every malformed observation is refused with a code and the field', () => {
  const bad = (o) => { try { parsePush('native', { observations: [o] }, { now: NOW }); } catch (e) { return e; } return null; };
  assert.equal(bad({ ts: NOW, value: 1 }).code, 'bad_point');
  assert.equal(bad({ point: '<script>', ts: NOW, value: 1 }).code, 'bad_point');
  assert.equal(bad({ point: 'p', value: 1 }).code, 'bad_observation');
  assert.equal(bad({ point: 'p', ts: NOW, start: NOW, end: NOW + 1, value: 1 }).code, 'bad_observation');
  assert.equal(bad({ point: 'p', start: NOW, value: 1 }).code, 'bad_observation');
  assert.equal(bad({ point: 'p', start: NOW + 10, end: NOW, value: 1 }).code, 'bad_observation');
  assert.equal(bad({ point: 'p', ts: NOW }).code, 'bad_value');
  assert.equal(bad({ point: 'p', ts: NOW, value: 'abc' }).code, 'bad_value');
  assert.equal(bad({ point: 'p', ts: NOW, value: 1, kind: 'weird' }).code, 'bad_observation');
  assert.equal(bad({ kind: 'ack' }).code, 'bad_observation');
  assert.equal(bad({ point: 'p', ts: 'not a time', value: 1 }).field, 'observations[0].ts');
  assert.equal(code(() => parsePush('native', { observations: [] }, { now: NOW })), 'no_observations');
  assert.equal(code(() => parsePush('native', {}, { now: NOW })), 'no_observations');
  assert.equal(code(() => parsePush('native', [1], { now: NOW })), 'bad_body');
  assert.equal(code(() => parsePush('nope', {}, { now: NOW })), 'unknown_format');
  const r = parsePush('native', { observations: [{ point: 'p', ts: NOW, value: 1, rawId: 9 }] }, { now: NOW });
  assert.ok(!('rawId' in r.observations[0]) && /rawId is ignored/.test(r.warnings[0]), 'a client cannot name a raw receipt');
});

test('shelly gen2: the bare status, converted from Wh to kWh, with the unused fields named', () => {
  const r = parsePush('shelly_gen2_switch', fx('shelly-gen2-switch-status'), { now: NOW });
  assert.deepEqual(byPoint(r), { power: 1823.4, energy_total: 12.345678, relay: 1 });
  assert.ok(r.observations.every((o) => o.ts === NOW), 'no time in the body: the receive time');
  assert.deepEqual(r.ignored.sort(), ['current', 'freq', 'temperature', 'voltage']);
  assert.match(r.warnings[0], /not used: voltage/);
  assert.equal(r.kindHint, 'smart_plug');
});

test('shelly gen2: a NotifyStatus message carries its own time and names the device', () => {
  const r = parsePush('shelly_gen2_switch', fx('shelly-gen2-notifystatus'), { now: NOW });
  assert.deepEqual(byPoint(r), { power: 0, energy_total: 12.4, relay: 0 });
  assert.ok(r.observations.every((o) => o.ts === 1782000123));
  assert.equal(r.deviceHint, 'shellyplus1pm-a8032abc1234');
  const whole = parsePush('shelly_gen2_switch', { 'switch:0': { id: 0, output: true, apower: 5, aenergy: { total: 1000 } }, 'switch:1': { id: 1, output: false, apower: 0 }, ts: 1782000050 }, { now: NOW });
  assert.match(whole.warnings.join(' '), /several switches; only switch:0/);
  assert.equal(code(() => parsePush('shelly_gen2_switch', { hello: 1 }, { now: NOW })), 'unrecognised_shape');
  assert.equal(code(() => parsePush('shelly_gen2_switch', { id: 0, source: 'x' }, { now: NOW })), 'unrecognised_shape');
});

test('tasmota: Time is the device local time, read in the home time zone (winter and summer)', () => {
  const winter = parsePush('tasmota_sensor', fx('tasmota-sensor'), { now: NOW, tz: 'Europe/London' });
  assert.deepEqual(byPoint(winter), { power: 1820, energy_total: 123.456 });
  assert.ok(winter.observations.every((o) => o.ts === Date.UTC(2026, 9, 27, 10, 15) / 1000), 'GMT in late October: the same as UTC');
  const summer = parsePush('tasmota_sensor', { ...fx('tasmota-sensor'), Time: '2026-07-01T12:00:00' }, { now: NOW, tz: 'Europe/London' });
  assert.equal(summer.observations[0].ts, Date.UTC(2026, 6, 1, 11, 0) / 1000, 'BST: one hour behind local');
  const paris = parsePush('tasmota_sensor', { ...fx('tasmota-sensor'), Time: '2026-07-01T12:00:00' }, { now: NOW, tz: 'Europe/Paris' });
  assert.equal(paris.observations[0].ts, Date.UTC(2026, 6, 1, 10, 0) / 1000);
  assert.deepEqual(winter.ignored.sort(), ['ApparentPower', 'Current', 'Factor', 'Period', 'ReactivePower', 'Today', 'Voltage', 'Yesterday']);
  const st = parsePush('tasmota_sensor', fx('tasmota-state'), { now: NOW, tz: 'Europe/London' });
  assert.deepEqual(byPoint(st), { relay: 1 });
  assert.equal(code(() => parsePush('tasmota_sensor', { Time: '2026-03-29T01:30:00', POWER: 'ON' }, { now: NOW, tz: 'Europe/London' })), 'bad_timestamp', 'a local time that does not exist (clocks went forward) is refused');
  assert.equal(code(() => parsePush('tasmota_sensor', { Wifi: {} }, { now: NOW })), 'unrecognised_shape');
});

test('home assistant: energy, power, temperature and switch entities, converted; unavailable and unmapped entities named', () => {
  const one = parsePush('homeassistant_state', fx('homeassistant-energy'), { now: NOW });
  assert.deepEqual(byPoint(one), { energy_total: 123.456 });
  assert.equal(one.observations[0].ts, Date.UTC(2026, 9, 27, 10, 15) / 1000);
  const list = parsePush('homeassistant_state', fx('homeassistant-list'), { now: NOW });
  const v = Object.fromEntries(list.observations.map((o) => [o.point, o.value]));
  assert.equal(v.power, 1820, 'kW to W');
  assert.equal(v.energy_total, 12.345, 'Wh to kWh');
  assert.ok(Math.abs(v.temperature - 20) < 1e-9, '68 F is 20 C');
  assert.equal(v.relay, 1);
  assert.equal(list.observations.length, 4);
  assert.deepEqual(list.ignored, ['sensor.living_humidity']);
  assert.ok(list.warnings.some((x) => /garage_power.*unavailable/.test(x)) && list.warnings.some((x) => /living_humidity.*not mapped/.test(x)));
  assert.equal(list.kindHint, 'smart_plug');
  assert.equal(code(() => parsePush('homeassistant_state', { entity_id: 'sensor.x', state: 'unknown', attributes: {} }, { now: NOW })), 'nothing_to_store');
  assert.equal(code(() => parsePush('homeassistant_state', { nope: 1 }, { now: NOW })), 'unrecognised_shape');
  assert.equal(code(() => parsePush('homeassistant_state', { entity_id: 'sensor.p', state: 'lots', attributes: { unit_of_measurement: 'W', device_class: 'power' } }, { now: NOW })), 'bad_value');
});

test('tasmota: a repeated local hour (clocks went back) takes the instant nearest the moment the push arrived', () => {
  const body = { Time: '2026-10-25T01:30:00', POWER: 'ON' };
  const first = Date.UTC(2026, 9, 25, 0, 30) / 1000; const second = Date.UTC(2026, 9, 25, 1, 30) / 1000;   // BST 01:30 then GMT 01:30
  assert.equal(parsePush('tasmota_sensor', body, { now: first + 20, tz: 'Europe/London' }).observations[0].ts, first);
  assert.equal(parsePush('tasmota_sensor', body, { now: second + 20, tz: 'Europe/London' }).observations[0].ts, second);
});
