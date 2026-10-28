// Adds the synthetic IoT demo home (a smart plug, a heat pump, an EV charger, a battery and a temperature sensor, all generated)
// to the database the app uses: DB_FILE if set, else data/core.db. It is the same thing the Devices page's "Create the synthetic demo
// home" button does, and it does nothing if the demo home is already there. It never touches a real home: it adds a separate one.
//   npm run demo:iot
//   DB_FILE=/path/to/other.db npm run demo:iot
import { dbFile } from '../src/db/db.js';
import { createSyntheticIotHome } from '../src/core/synthetic-iot.js';

console.log(`Database: ${dbFile}`);
const { site, created } = await createSyntheticIotHome();
console.log(created ? `Created "${site.name}" (home ${site.id}) with five synthetic devices and three days of generated data.` : `"${site.name}" (home ${site.id}) is already there: nothing changed.`);
console.log('Open the Devices page and pick it in the home list: it is marked "(demo, synthetic)".');
