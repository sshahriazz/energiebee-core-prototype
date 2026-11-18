# Controls on every thing (Phase 4)

Written 18 November 2026. Code: `src/core/controls.js`, `src/routes/controls.js`, `src/jobs/control.js` (the request tick), changes in `src/core/commands.js` and `src/core/control.js`; migration `20261124000000_controls`. Tests: `controls`, `controls-api`, `rules-controls`.

Nothing here sends anything to a device: a request becomes a command through the command layer that was already there (gates, limits, capability rows, the executor), and a command waits as `pending` until a driver is registered. No driver is built (4.5).

## 4.1 What a thing may be asked

Actions belong to capabilities (`capability.actions`, `src/db/seed/capabilities.js`). A thing may be asked what its type's capabilities allow (`actionsOf(thing)`), and a device is *confirmed* for an action when an adapter said so (`device_capability`). The rule that refused an action the kind's own list (`device_action`) never named (a smart plug's `on` and `off`) now also accepts an action the capabilities allow.

## 4.2 Requests

`control_request(thing_id, capability, action, desired, priority, valid_from, valid_until, source, external, group_uid)`: somebody asks a thing to do something for a while. A request never changes (a trigger refuses it); it is cancelled, once, or it runs out. Priorities, strongest first: **safety, manual, schedule, optimiser**. `pickWinner` is pure: among the requests in force the highest priority wins, the newest among equals; a lower one returns when the winner ends (the next `settle`). `settle(thing, capability)` sends the winner through `enqueueIfChanged`, so every gate of the command layer applies, and the command knows its request (`command.request_id`).

- **External changes (R16):** a change nobody here explains (the owner used the manufacturer's app) is `recordExternalChange`, a manual request marked `external` that lasts hours. Nothing is sent for it and nothing reverts it before it expires, when the request below it returns. `noticeExternalChange` finds one by comparing what the device reports with what it should be doing, when no command of ours is open and the last is not recent.
- **External controller:** a thing with the attribute `external_controller` (Octopus Intelligent Go for a car) takes only manual requests (a 409 for the optimiser or a schedule).
- `requestTick` (every minute with the server): asks for the scenes that are due and settles every thing with an open request, so a request that began is sent and one that ran out lets the next return.

## 4.3 Limits on any thing

`control_limit` could already name any thing (its column points at `thing`); now a limit on a place binds what is in it. `limitsFor(device)` takes the limits of the device and of every place it is in (a room's comfort range, the home's export limit); the tightest wins, and sources stay ranked physical > legal > installer > owner > optimiser (a lower source can only tighten a higher one). A limit with `aggregate = 'sum'` holds the members of a group together (a garage's chargers: 32 A across them).

## 4.4 A request on a place

`groupRequest(place, capability, action, desired, …)`: one request on a room, a floor, a system or the home reaches every member with the capability. Each is checked against its own limits and those of its places; when the members together pass a `sum` limit nobody under that place is sent anything. The answer lists each member: `enqueued`, `unchanged`, `blocked` (with the reasons), `external` or `not_deliverable`. The requests of one group share `group_uid`; the plan's `parent_command_id` is not used (a room is not a device that takes commands).

## 4.6 Scenes and schedules

`scene` (a named set of items: a thing or a place, a capability, an action, a desired state) and `scene_schedule` (weekdays and local minutes; a window does not cross midnight). `applyScene` asks for every item at priority `schedule` (a place item reaches every capable member); `applyDueSchedules` asks for the windows that start within the hour, once each. Scenes are working state: what was sent is kept in `control_request` and `command`.

## 4.5 Not built

The first real driver, the Sunsynk inverter (`docs/build/sunsynk-writes.md`): writes stay off by default and the read-only capture of its settings needs the owner's go-ahead. Nothing in this phase talks to a vendor.

## The API

| Method | Path | What |
|---|---|---|
| GET | `/api/things/:uid/controls` | `{ actions, requests (open), winners }` |
| POST | `/api/things/:uid/requests` | `{ capability, action, desired?, forS or validFrom/validUntil, note? }`: a manual request, settled at once (a person makes only manual requests) |
| POST | `/api/requests/:uid/cancel` | the next winner takes over |
| POST | `/api/things/:uid/group` | a request on a room, system or home; one line per member |
| GET, POST | `/api/homes/:uid/scenes` | list; make or replace a scene |
| POST | `/api/scenes/:uid/schedules`, `/apply` | add a schedule; ask for the scene now (as schedule or manual) |

Access is what the other owner routes need (the user can see the home); an unknown uid and another owner's are the same 404.
