// The control API (plan 4.1 to 4.4 and 4.6, docs/build/controls.md): what a thing can be asked, who asked, which request wins, a request on a
// room, scenes. Mounted by one line in src/server.js. Everything is addressed by uid; an unknown uid and one of a home the user may not see
// answer the same 404; writes need what the other owner routes need (the user can see the home). Every error is { error, code }.
import express from 'express';
import { db } from '../db/db.js';
import * as C from '../core/controls.js';
import { guard, route, bad, notFound, body, text } from './things.js';
import { lookup } from '../core/things-view.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const now = () => Date.now();

// A request as the API shows it: by uid, with the thing by uid.
async function viewRequests(rows) {
  const by = await lookup(rows.map((r) => r.thing_id));
  return rows.map((r) => ({ uid: r.uid, thing: by.get(r.thing_id)?.uid ?? null, capability: r.capability, action: r.action, desired: r.desired, priority: r.priority,
    valid_from: r.valid_from, valid_until: r.valid_until, source: r.source, note: r.note, external: r.external === 1, group: r.group_uid ?? null, created_at: r.created_at, cancelled_at: r.cancelled_at }));
}
const window = (b) => {
  const t = Math.floor(now() / 1000);
  const from = b.validFrom == null ? t : Number(b.validFrom);
  const until = b.validUntil != null ? Number(b.validUntil) : from + Number(b.forS ?? 3600);
  if (!Number.isInteger(from) || !Number.isInteger(until) || until <= from) throw bad('validFrom and validUntil are epoch seconds (or give forS), the end after the start');
  if (until - from > 31 * 86400) throw bad('a request lasts at most 31 days');
  return { validFrom: from, validUntil: until };
};
const priorityOf = (req, b) => {
  const p = b.priority ?? 'manual';
  if (!C.PRIORITIES.includes(p)) throw bad(`priority is one of ${C.PRIORITIES.join(', ')}`);
  if (p !== 'manual' && req.user?.role !== 'admin') throw bad('only a manual request can be made here', 'read_only_kind');
  return p;
};

router.get('/things/:uid/controls', route(async (req) => {
  const { thing } = await guard(req, req.params.uid);
  if (thing.home_id == null) return { body: { actions: [], requests: [], winners: [] } };
  const actions = await C.actionsOf(thing.id);
  const at = Math.floor(now() / 1000);
  const all = await C.requestsOf(thing.id);
  const open = all.filter((r) => r.cancelled_at == null && r.valid_until > at);
  const winners = [...new Set(actions.map((a) => a.capability))].map((capability) => ({ capability, request: C.pickWinner(open.filter((r) => r.capability === capability), at)?.uid ?? null }));
  return { body: { actions, requests: await viewRequests(open), winners } };
}));

router.post('/things/:uid/requests', route(async (req) => {
  const { thing } = await guard(req, req.params.uid);
  const b = body(req);
  const r = await C.submitRequest({ thingId: Number(thing.id), capability: text(b.capability, 'capability', { max: 60 }), action: text(b.action, 'action', { max: 60 }), desired: b.desired ?? {},
    priority: priorityOf(req, b), ...window(b), source: `user:${req.user?.id ?? 'api'}`, note: b.note == null ? null : text(b.note, 'note', { max: 300 }), now: now() });
  const s = await C.settle(Number(thing.id), r.capability, { now: now() });
  return { status: 201, body: { request: (await viewRequests([r]))[0], winner: s.winner ? (await viewRequests([s.winner]))[0].uid : null, written: s.written, reason: s.reason ?? null, blocks: s.blocks ?? null } };
}));

router.post('/requests/:uid/cancel', route(async (req) => {
  if (!UUID.test(req.params.uid)) throw notFound('request');
  const r = await db.prepare('SELECT id, thing_id FROM control_request WHERE uid = ?::uuid').get(req.params.uid.toLowerCase());
  if (!r) throw notFound('request');
  const g = await lookup([r.thing_id]);
  await guard(req, g.get(Number(r.thing_id)).uid, { what: 'request' });
  const done = await C.cancelRequest(Number(r.id), { now: now() });
  const s = await C.settle(Number(r.thing_id), done.capability, { now: now() });
  return { body: { request: (await viewRequests([done]))[0], winner: s.winner ? (await viewRequests([s.winner]))[0].uid : null } };
}));

router.post('/things/:uid/group', route(async (req) => {
  const { thing } = await guard(req, req.params.uid);
  const b = body(req);
  const out = await C.groupRequest({ placeId: Number(thing.id), capability: text(b.capability, 'capability', { max: 60 }), action: text(b.action, 'action', { max: 60 }), desired: b.desired ?? {},
    priority: priorityOf(req, b), ...window(b), source: `user:${req.user?.id ?? 'api'}`, now: now() });
  const by = await lookup(out.members.map((m) => m.thingId));
  return { status: 201, body: { group: out.group, members: out.members.map(({ thingId, requestId, ...m }) => ({ thing: by.get(thingId)?.uid, ...m })) } };
}));

// ───────────── scenes ─────────────
const viewScene = async (s) => {
  const by = await lookup(s.items.map((i) => i.thingId));
  return { uid: s.uid, name: s.name, items: s.items.map((i) => ({ thing: by.get(i.thingId)?.uid, capability: i.capability, action: i.action, desired: i.desired })), schedules: s.schedules };
};
const sceneGuard = async (req, uid) => {
  if (!UUID.test(String(uid))) throw notFound('scene');
  const s = await db.prepare('SELECT id, home_id FROM scene WHERE uid = ?::uuid').get(String(uid).toLowerCase());
  if (!s) throw notFound('scene');
  const home = (await lookup([s.home_id])).get(Number(s.home_id));
  await guard(req, home.uid, { home: true, what: 'scene' });
  return { id: Number(s.id), homeId: Number(s.home_id) };
};

router.get('/homes/:uid/scenes', route(async (req) => {
  const { thing: home } = await guard(req, req.params.uid, { home: true });
  const rows = await db.prepare('SELECT id FROM scene WHERE home_id = ? ORDER BY name').all(home.id);
  return { body: { scenes: await Promise.all(rows.map(async (r) => await viewScene(await C.getScene(Number(r.id))))) } };
}));

router.post('/homes/:uid/scenes', route(async (req) => {
  const { thing: home } = await guard(req, req.params.uid, { home: true });
  const b = body(req);
  if (!Array.isArray(b.items) || !b.items.length) throw bad('items is a list of { thing, capability, action, desired }');
  const items = [];
  for (const i of b.items) {
    const g = await guard(req, text(i?.thing, 'thing', { max: 60 }));
    if (Number(g.thing.home_id) !== Number(home.id)) throw notFound('thing');
    items.push({ thingId: Number(g.thing.id), capability: text(i.capability, 'capability', { max: 60 }), action: text(i.action, 'action', { max: 60 }), desired: i.desired ?? {} });
  }
  return { status: 201, body: { scene: await viewScene(await C.saveScene({ homeId: Number(home.id), name: text(b.name, 'name'), items, now: now() })) } };
}));

router.post('/scenes/:uid/schedules', route(async (req) => {
  const s = await sceneGuard(req, req.params.uid);
  const b = body(req);
  const days = Array.isArray(b.weekdays) ? b.weekdays.map(Number) : [];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw bad('weekdays is a list of 1 (Monday) to 7 (Sunday)');
  const from = Number(b.fromMin); const until = Number(b.untilMin);
  if (!Number.isInteger(from) || !Number.isInteger(until) || from < 0 || until > 1440 || until <= from) throw bad('fromMin and untilMin are minutes of the local day, the end after the start (a window does not cross midnight)');
  return { status: 201, body: { scene: await viewScene(await C.scheduleScene(s.id, { weekdays: days, fromMin: from, untilMin: until })) } };
}));

// A scene is asked for as a schedule (the default) or, when the person wants it to win over the optimiser and other schedules, as a manual request.
const sceneOf = (b) => { const p = b.priority ?? 'schedule'; if (!['schedule', 'manual'].includes(p)) throw bad('a scene is applied as schedule or manual'); return p; };

router.post('/scenes/:uid/apply', route(async (req) => {
  const s = await sceneGuard(req, req.params.uid);
  const b = body(req);
  const out = await C.applyScene(s.id, { ...window(b), priority: sceneOf(b), now: now(), source: `user:${req.user?.id ?? 'api'}:scene` });
  const by = await lookup(out.items.map((i) => i.thingId));
  return { body: { scene: out.scene.name, items: out.items.map((i) => ({ thing: by.get(i.thingId)?.uid, written: i.written ?? null, reason: i.reason ?? null, group: i.group ? { group: i.group.group, members: i.group.members.length } : null })) } };
}));

export default router;
