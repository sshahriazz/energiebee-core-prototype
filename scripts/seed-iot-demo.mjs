// Adds the synthetic IoT demo home (a smart plug, a heat pump, an EV charger, a battery and a temperature sensor, all generated)
// to the database the app uses (DATABASE_URL, from .env unless set). It is the same thing the Devices page's "Create the synthetic demo
// home" button does, and it does nothing if the demo home is already there. It never touches a real home: it adds a separate one.
//   npm run demo:iot
//   DATABASE_URL=postgresql://.../energiebee_demo npm run demo:iot
import { databaseUrl } from '../src/db/db.js';
import { createSyntheticIotHome } from '../src/core/synthetic-iot.js';

console.log(`Database: ${new URL(databaseUrl).pathname.slice(1)}`);
const { site, created } = await createSyntheticIotHome();
console.log(created ? `Created "${site.name}" (home ${site.id}) with five synthetic devices and three days of generated data.` : `"${site.name}" (home ${site.id}) is already there: nothing changed.`);
console.log('Open the Devices page and pick it in the home list: it is marked "(demo, synthetic)".');
