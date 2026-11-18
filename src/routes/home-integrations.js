// What a home's integrations are doing (plan 6.3): each connection with its health, the things linked to it and the last raw answer it landed.
// GET /api/homes/:uid/integrations. By uid; the same 404 for a home the user may not see.
import express from 'express';
import { db } from '../db/db.js';
import { guard, route } from './things.js';
import { integrationManifest } from '../core/manifest.js';
import { lookup } from '../core/things-view.js';

const router = express.Router();
const mask = (ref) => (ref && ref.length > 6 ? `…${ref.slice(-4)}` : ref);

router.get('/homes/:uid/integrations', route(async (req) => {
  const { thing: home } = await guard(req, req.params.uid, { home: true });
  const homeId = Number(home.id);
  const manifest = new Map((await integrationManifest(db)).map((e) => [e.code, e]));
  const conns = await db.prepare('SELECT id, provider, external_ref, status, last_success_at, last_error FROM connection WHERE site_id = ? ORDER BY provider').all(homeId);
  const links = await db.prepare(`SELECT l.provider, l.kind, l.external_ref, l.valid_from, l.valid_to, l.thing_id FROM thing_link l WHERE l.home_id = ? AND l.superseded_at IS NULL ORDER BY l.provider, l.id`).all(homeId);
  const things = await lookup(links.map((l) => l.thing_id));
  const raw = await db.prepare(`SELECT DISTINCT ON (so.code) so.code AS source, r.id, r.fetched_at, r.status, r.reason FROM raw_payload r JOIN source so ON so.id = r.source_id
    WHERE r.site_id = ? ORDER BY so.code, r.fetched_at DESC`).all(homeId);
  const sourcesOf = (provider) => (manifest.get(provider)?.sources ?? []);
  return { body: {
    connections: conns.map((c) => {
      const m = manifest.get(c.provider);
      const mine = links.filter((l) => l.provider === c.provider);
      const lastRaw = raw.filter((r) => sourcesOf(c.provider).includes(r.source)).sort((a, b) => b.fetched_at - a.fetched_at)[0] ?? null;
      return {
        provider: c.provider, name: m?.name ?? c.provider, access: m?.access ?? null, reference: mask(c.external_ref), status: c.status, last_success_at: c.last_success_at, last_error: c.last_error,
        implemented: m?.implemented ?? false, discovers: m?.discovers ?? [], writes: m?.writes ?? [],
        things: mine.map((l) => ({ uid: things.get(Number(l.thing_id))?.uid, name: things.get(Number(l.thing_id))?.name, type: things.get(Number(l.thing_id))?.type, external_ref: mask(l.external_ref), kind: l.kind, valid_from: l.valid_from, valid_to: l.valid_to })),
        last_raw: lastRaw ? { source: lastRaw.source, fetched_at: Number(lastRaw.fetched_at), status: lastRaw.status, reason: lastRaw.reason, url: `/api/raw/${lastRaw.id}` } : null,
      };
    }),
    links_without_connection: links.filter((l) => !conns.some((c) => c.provider === l.provider)).map((l) => ({ provider: l.provider, kind: l.kind, thing: things.get(Number(l.thing_id))?.uid, name: things.get(Number(l.thing_id))?.name, external_ref: mask(l.external_ref) })),
  } };
}));

export default router;
