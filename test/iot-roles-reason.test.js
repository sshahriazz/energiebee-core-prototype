// A new IoT role follows the same rule as the older ones on the real-home fixture: a change from a date inside slots already
// built needs a reason (kept on the binding row); a change from now on needs none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { bind, unbind, bindingsFor } = hasLive ? await import('../src/core/inputs.js') : {};

test('plug_energy and ev_charger_energy: a past change needs a reason, a change from now on does not', { skip }, () => {
  db.prepare("INSERT INTO source (code, name, contract) VALUES ('plug_vendor', 'Plug vendor (test)', '{}')").run();
  const first = db.prepare('SELECT MIN(slot_start) s FROM site_hh WHERE site_id = 1').get().s;
  for (const role of ['plug_energy', 'ev_charger_energy']) {
    const before = db.prepare('SELECT COUNT(*) n FROM binding').get().n;
    assert.throws(() => bind(1, role, 'plug_vendor', { from: first + 3600 }), /say why/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM binding').get().n, before, 'a refused change writes nothing');
    assert.ok(bind(1, role, 'plug_vendor', { from: first + 3600, reason: 'test: installed then' }) > 0);
    assert.deepEqual(bindingsFor(1, role).map((b) => [b.source, b.from]), [['plug_vendor', first + 3600]]);
    assert.throws(() => unbind(1, role, { at: first + 7200 }), /say why/);
    assert.ok(unbind(1, role, { at: first + 7200, reason: 'test: removed' }) >= 1);
  }
  const later = Math.floor(Date.now() / 1000) + 3600;
  assert.ok(bind(1, 'plug_energy', 'plug_vendor', { from: later }) > 0, 'a change from now on needs no reason');
});
