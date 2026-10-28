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
const hidden = (user, id) => id != null && /^\d+$/.test(String(id)) && !canSee(user, Number(id));
const handle = (fn) => (req, res) => {
  try {
    if (hidden(req.user, req.query?.site)) return res.status(404).json({ error: `no home ${req.query.site}` });
    const body = fn(req.query ?? {}, req.params ?? {});
    if (hidden(req.user, body?.site)) return res.status(404).json({ error: 'not found' });
    res.type('application/json').send(redactEnv(JSON.stringify(body)));
  } catch (err) {
    const status = err.status ?? (err instanceof RangeError || err instanceof TypeError ? 400 : 500);
    res.status(status).json({ error: err.message });
  }
};

router.get('/overview', handle((q) => X.overview(q)));
router.get('/raw', handle((q) => X.rawList(q)));
router.get('/raw/:id', handle((q, p) => X.rawOne(p.id, q)));
router.get('/series', handle((q) => X.seriesList(q)));
router.get('/facts', handle((q) => X.facts(q)));
router.get('/timeline', handle((q) => X.timeline(q)));
router.get('/slot', handle((q) => X.slot(q)));
router.get('/validate', handle((q) => X.validate(q)));
router.get('/correlate', handle((q) => X.correlate(q)));
router.get('/heatmap', handle((q) => X.heatmap(q)));
router.get('/variables', handle((q) => X.variables(q)));
router.use((req, res) => res.status(404).json({ error: `no explorer endpoint ${req.path}` }));

export default router;
