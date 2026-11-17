// GET /api/explorer/*: the Data Explorer's read-only JSON endpoints (src/core/explorer.js,
// src/core/explain.js). Mounted by one line in src/server.js. Every answer carries { site,
// generated_at }; bad input is 400 { error }, an unknown home, slot, series or payload 404 { error }.
// As a last guard, no value of a credential held in the environment can leave in an answer.
import express from 'express';
import * as X from '../core/explorer.js';
import { canSee } from '../core/users.js';

const router = express.Router();

// Values of the environment's credentials (keys, tokens, passwords), replaced if ever found.
const SECRET_ENV = /(KEY|TOKEN|PASSWORD|SECRET|PASS)$/i;
function redactEnv(text) {
  let out = text;
  for (const [k, v] of Object.entries(process.env)) {
    if (!SECRET_ENV.test(k) || typeof v !== 'string' || v.length < 6) continue;
    const json = JSON.stringify(v).slice(1, -1);
    if (out.includes(json)) out = out.split(json).join('[redacted]');
  }
  return out;
}

// A home the picked user (req.user, set in src/server.js) may not see is an unknown home: checked on the
// home asked for, and on the home an answer turns out to be about (a payload or series asked by its id).
const hidden = async (user, id) => id != null && /^\d+$/.test(String(id)) && !await canSee(user, Number(id));
const handle = (fn) => async (req, res) => {
  try {
    if (await hidden(req.user, req.query?.site)) return res.status(404).json({ error: `no home ${req.query.site}` });
    const body = await fn(req.query ?? {}, req.params ?? {});
    if (await hidden(req.user, body?.site)) return res.status(404).json({ error: 'not found' });
    res.type('application/json').send(redactEnv(JSON.stringify(body)));
  } catch (err) {
    const status = err.status ?? (err instanceof RangeError || err instanceof TypeError ? 400 : 500);
    res.status(status).json({ error: err.message });
  }
};

router.get('/overview', handle(async (q) => await X.overview(q)));
router.get('/raw', handle(async (q) => await X.rawList(q)));
router.get('/raw/:id', handle(async (q, p) => await X.rawOne(p.id, q)));
router.get('/series', handle(async (q) => await X.seriesList(q)));
router.get('/facts', handle(async (q) => await X.facts(q)));
router.get('/timeline', handle(async (q) => await X.timeline(q)));
router.get('/slot', handle(async (q) => await X.slot(q)));
router.get('/validate', handle(async (q) => await X.validate(q)));
router.get('/correlate', handle(async (q) => await X.correlate(q)));
router.get('/heatmap', handle(async (q) => await X.heatmap(q)));
router.get('/variables', handle(async (q) => await X.variables(q)));
router.use((req, res) => res.status(404).json({ error: `no explorer endpoint ${req.path}` }));

export default router;
