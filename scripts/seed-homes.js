// David Price's account and his homes, made again on a server whose database was wiped: the user (davidprice,
// PIN 1111), each home below from its country and postcode, and its Sunsynk plant connected with the login in the
// server's environment (SUNSYNK_USERNAME, SUNSYNK_PASSWORD), the plant found by its name. The tariff is skipped.
// Whatever is there already is kept: run it any time, nothing is made twice.
//
//   docker exec -u node energiebee node --disable-warning=ExperimentalWarning scripts/seed-homes.js
//   npm run seed:homes                                                     (here, on the main database)
//
// The homes' first sync is left to the server's scheduler (every SYNC_EVERY_MINUTES), not run from here.
const USER = { username: 'davidprice', pin: '1111', name: 'David Price' };
const HOMES = [
  { name: 'UK Electronics', country: 'GB', postcode: 'OL2 6EF' },
  { name: 'Lifelynk - Barn', country: 'FR', postcode: '79200' },
  { name: '68 bleasdale ainsworth', country: 'GB', postcode: 'OL2 6PP' },
  { name: 'turner power', country: 'FR', postcode: '79800' },
  { name: 'hope street', country: 'GB', postcode: 'HX6 3SG' },
  { name: 'Blackgreaves farm string', country: 'GB', postcode: 'B76 0DA' },
  { name: 'Blackgreaves farm', country: 'GB', postcode: 'B76 0DA' },
  { name: 'Lac du Maison', country: 'FR', postcode: '86470' },
  { name: 'Villeneuve', country: 'FR', postcode: '79340' },
  { name: 'chez steve 2', country: 'FR', postcode: '79200' },
  { name: 'limitless nelson', country: 'GB', postcode: 'BB9 6RY' },
  { name: 'Bougon farm', country: 'FR', postcode: '79800' },
  { name: 'lagauteliere', country: 'FR', postcode: '79220' },
  { name: 'Gerson1', country: 'FR', postcode: '79200' },
  { name: '10 Acresbrook', country: 'GB', postcode: 'BB12 9BY' },
];

const login = { username: process.env.SUNSYNK_USERNAME, password: process.env.SUNSYNK_PASSWORD };
if (!login.username || !login.password) { console.error('SUNSYNK_USERNAME and SUNSYNK_PASSWORD must be set'); process.exit(2); }

const { db, closeDb } = await import('../src/db/db.js');
const { signUp, normUsername } = await import('../src/core/users.js');
const { addHome, connectHome, homeProviders, hooks } = await import('../src/core/signup.js');
const { listSunsynkPlants } = await import('../src/adapters/sunsynk.js');
const { secretsReady } = await import('../src/core/secrets.js');
// Without it no plant could be connected: stop before making homes left without one.
if (!secretsReady()) { console.error('SECRET_KEY (32+ characters) must be set: the Sunsynk login is stored encrypted with it'); closeDb(); process.exit(2); }

const key = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
try {
  // The login's plants, read once: each home's connect is checked against this list, not a new Sunsynk login each.
  const plants = await listSunsynkPlants(login);
  console.log(`Sunsynk login ${login.username}: ${plants.length} plants`);
  hooks.verify.sunsynk = async ({ plantId }) => {
    const p = plants.find((x) => x.id === String(plantId));
    if (!p) throw new Error(`plant ${plantId} is not on this login`);
    return { plantId: p.id, plantName: p.name, plants: plants.length };
  };
  hooks.startSync = () => {};

  let user = db.prepare('SELECT * FROM app_user WHERE username = ?').get(normUsername(USER.username));
  if (user) console.log(`user ${user.username} (user ${user.id}): there already, kept`);
  else { user = signUp(USER); console.log(`user ${user.username} (user ${user.id}): made, PIN ${USER.pin}`); }

  const homeOf = db.prepare('SELECT s.* FROM site s JOIN user_site us ON us.site_id = s.id WHERE us.user_id = ? AND s.name = ?');
  let missing = 0;
  for (const h of HOMES) {
    let site = homeOf.get(user.id, h.name);
    let made = false;
    if (!site) {
      const r = await addHome(user, h);
      site = r.site; made = true;
      if (r.geoError) console.log(`  note: ${r.geoError}`);
    }
    const sunsynk = homeProviders(site).connect.find((c) => c.adapter === 'sunsynk');
    const plant = plants.find((p) => key(p.name) === key(h.name));
    let what;
    if (sunsynk?.connected) what = `plant ${sunsynk.account?.plantId ?? sunsynk.external_ref} connected already`;
    else if (!plant) { what = 'NO PLANT of that name on this login: connect it from "Your providers"'; missing++; }
    else {
      try { await connectHome(user, site, { provider: 'sunsynk', credentials: { ...login, plantId: plant.id } }); what = `plant ${plant.id} connected`; } catch (err) { what = `NOT CONNECTED: ${err.message}`; missing++; }
    }
    console.log(`  home ${String(site.id).padStart(3)}  ${h.name.padEnd(26)} ${site.postcode.padEnd(9)} ${made ? 'made' : 'there already'}, ${what}`);
  }
  console.log(`\nSign in as ${user.username}${missing ? `. ${missing} home(s) have no plant connected (above)` : '. Every home has its plant'}; the first sync runs within the server's next sync round.`);
  if (missing) process.exitCode = 1;
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally { closeDb(); }
