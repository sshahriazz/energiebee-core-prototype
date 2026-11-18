# The fold: homes and devices are things (Phase 1.3 and 1.3b)

Migration `20261119000000_things_are_identity`. Written 18 November 2026. This is the lean form of the fold: the owner decided on 18 November that nothing old has to be kept, so the 30-step design in [fold-design.md](fold-design.md) (which spends most of its steps on preserving data) was replaced by one migration and a handful of code changes. The target schema, the energy graph and the API of that design still apply.

## What changed

**Every home and every device is a row of `thing`, with the same id as its detail row.**

| Thing | Detail row | Same id? | What the detail row keeps |
|---|---|---|---|
| home thing (type `house`, kind `home`) | `site` | yes, the site's id | the home's settings and their versions (`site_version`): time zone, slot length, currency, market, location, sizes |
| device thing (kind `device`, or `system` for a hot water service) | `device` | no: device ids moved up by G (the largest site or device id), so no device id meets a home id | provider, external reference, label, attributes and their versions (`device_attr_version`) |

`site` and `device` are the typed detail tables of their things (class-table inheritance). A thing is the identity: its `uid`, its kind and type, its home, its relations, its place in the graph. The detail row is what only that kind of thing has. The two always agree: same id, same uid, a home thing for a site, a device thing of the device's own home and kind for a device (`site_is_home`, `device_is_thing`).

**Why not fold the settings into thing attributes, as the plan said.** The plan wanted the home's settings as versioned attributes of the home thing, replacing `site` and `site_version`. That would have meant rewriting about 130 call sites that read `FROM site`, the triggers that keep currency, country and market consistent, and the as-known-at reads of the build, for a gain nobody has asked for yet: typed, constrained columns are better for settings than a bag of attributes. With the detail tables kept, every id in the schema stays valid (a home thing has its site's id), the facts are untouched, and every insert path keeps working because inserting a site or a device now makes its thing. Phase 2 can move more onto things (points, bindings) without undoing any of this.

**Everything that named a device now names the device thing.** The 15 tables with a `device_id` (channel, binding, command, tariff_agreement, register_window, supply_price_slot, plans, limits, capabilities and the rest) reference `thing(id)`, so merge, split and the thing graph reach them with one foreign-key walk. Home columns stay `site_id` (referencing `site`, which is the home thing's detail row, the same id); the thing tables name their home as `home_id`, a foreign key to `thing(id)`.

## The migration, in order

1. The thing family is emptied (it held nothing: wave 1 never reached a database with data) and its `site_id` columns become `home_id`, foreign keys to `thing(id)`; the functions of the family are rewritten from their own definitions.
2. The rule `thing_home_rules` replaces `thing_home_exists`: a home thing is its own home (`home_id = id`); every other thing except shared context belongs to a live home thing. `thing_one_home` is dropped (the key says it now).
3. Device ids move up by G in every table that names a device, in `device` itself and in the text `series.subject_id` of device series. The tables' own fixed-field and append-only triggers stand aside for that one statement.
4. One thing per site and one per device. Types the conversion needs are inserted (the start-up seed brings labels, ports and attribute keys in line).
5. `site.id` and `device.id` lose their identity sequences and reference `thing(id)`; the tables that named a device get their keys back, pointing at `thing(id)`.
6. Triggers: inserting a site or device makes its thing (`site_make_thing`, `device_make_thing`; an id given explicitly is honoured, and a device row whose thing already exists adopts it, which is how the library makes devices), a rename or retirement of the detail row is the thing's (`site_sync_thing`, `device_sync_thing`), deleting the detail row deletes the thing and, for a home, every thing of the home (`site_delete_thing`, `device_delete_thing`), and the two guards above.

Deleting a site outside a logged erasure now fails with the append-only rule of `thing_attr_version`, like any other history: homes are deleted by `deleteHome` (which now also seeds the home thing, so the footprint counts things and relations).

## Code

- `src/core/things.js`: `site_id` is `home_id` throughout; `createThing` refuses a home (made with its site) and makes a device thing through its device row (provider `thing`); renaming or retiring a home or device thing updates its detail row; merge and split skip a table's own primary key (a detail row's `id` is identity, not a reference).
- A device kind added by one registry row (one `device_kind` row) has its thing type made by the `device_make_thing` trigger from that row; the start-up seed brings the label, ports and attribute keys in line. The promise of the registries (a new kind needs no schema change) holds.
- `src/db/seed/attributes.js`: seven device kinds that are devices of a home but not a vendor's product (hub, grid_connection, home_supply, pv_array, emitter, appliance, generic_device), so every device thing has a device row.
- `src/core/delete-home.js`: seeds the home thing.
- The GB fixture `test/fixtures/gb-home.json.gz` is the old fixture put through the migration (39,418 rows: the 39,389 of before, the home thing, four device things, their five versions and the thing types the conversion needed). Nothing else in it moved except the four device ids.

## Tests

- `test/rules-fold.test.js` (area `fold`, 8 triggers): each trigger proved by what it writes or refuses.
- `test/rules-things.test.js` and `test/things.test.js` moved to the new model (a site makes its home thing; devices go through device rows); `test/uid.test.js` follows the uid into the thing.
- A site or a device can only be deleted inside a logged erasure (their things keep append-only versions): tests that deleted one directly use `erasing()` of `test/helpers.js`.
- The ids of homes and devices come from one sequence now (the thing's), so a topology home's id differs from before. Its tariff code carries the id (`SYN-TOPO-FLAT-<id>`), so the topology hashes of `test/fixtures/price-slots-ref.json` are taken without it. Proof that no number moved: the pre-fold code and the fold code, both recording the id-free hashes, wrote byte-identical files.
- Numbers: see the build log in `docs/fix-list.md`.

## Not done here (and where it goes)

- The home's settings as thing attributes, the home's `site_version` as thing attribute versions: not planned any more; revisit only if something needs a home attribute that is not a column.
- `series.subject_kind/subject_id` stay (a device series names the device thing's id as text). `series.point_id` is Phase 2.2; until then a merge of two device things cannot move their series.
- The device-id tables accept any thing id, not only a device thing's: a guard (kind device or system, same home) is a follow-up.
- `thing.attrs` of a device thing and `device.attrs` are two bags (the first for what the thing library sets, the second for what adapters write). Phase 2 replaces both with points and attribute versions.
- Energy graph, spaces, API: Phase 1.4 to 1.6, next.
