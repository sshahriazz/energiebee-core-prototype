# Pages: Places and Integrations (Phase 6)

Written 18 November 2026. Pages: `public/places.html`, `public/js/pages/places.js`, `public/css/places.css`, `public/integrations.html`, `public/js/pages/integrations.js`; the route `src/routes/home-integrations.js`; both in the menu (`public/js/layout.js`). Tests: `test/pages.test.js` (the pages and scripts are served and valid, the page asks only for routes that exist, the integrations route).

## 6.1 Places

Home → Floor → Room → Device. The tree on the left is the home's spatial tree (`GET /api/homes/:uid/graph`: `located_in`), with its systems below. What is selected fills the panel on the right:

- its **timeline** for the last day: a device's points slot by slot (with the forecast and price lanes where the device has them), a room's or the heating system's lines (`GET /api/things/:uid/timeline`);
- **what happened** to it and to everything in it (`/events`);
- what it can be **asked** (`/controls`): one button for each action, a manual request that lasts an hour and can be cancelled; an action the device has not been confirmed for is greyed out;
- what it is **connected to** (feeds, controls, parts), each a link to that thing;
- on the home: the devices **without a room** (below).

Everything is addressed by uid; the address keeps the selection (`/places?thing=<uid>`). The old **Devices** page stays: it holds the push set-up and the demo home's simulator, which this page does not replace.

## 6.2 Placing the devices

On the home's panel, every device with no room is listed with a choice of rooms and a button (`POST /api/things/:uid/move`), and a field to add a room (`POST /api/homes/:uid/things`). Placing is optional and never asked of a home-wide device (an inverter, PV, a battery, the supply, the connection). Nothing here requires a room to exist.

## 6.3 Integrations

`GET /api/homes/:uid/integrations`: each connection of the home with its health (status, last success, last error), the things the provider's names are linked to (the inverter named by the Sunsynk plant, the meters by their MPANs, each a link to the Places page), the last raw answer it landed (a link to `/api/raw/:id`), and what the integration discovers and writes (from the manifest). The page adds the other integrations the core has and this home does not use.

## Not done here

- The pages have no automated browser test: they are checked for being served, for valid syntax and for calling only routes that exist, and have been read, not clicked through.
- The onboarding page does not yet send the owner to Places after a provider is connected.
