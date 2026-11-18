# Sunsynk and Octopus writes: may step 4.5 control the inverter?

Research for Phase 4.5 of `docs/thing-platform-plan.md` and open question 2 of `docs/thing-model.md` section 14. Written 18 November 2026, from public documentation only. No Sunsynk or Octopus endpoint was called, nothing was logged in to, and no code was run against a real service. Every claim carries one of three labels:

- **official**: said by the vendor itself (its terms, its documentation, its changelog).
- **community**: said by open-source projects, forums or issue threads. Nobody on those threads speaks for Sunsynk or Octopus, and nobody here has checked them against a live account.
- **inferred**: my reading of the above. It may be wrong; each one says how to settle it.

Sources are numbered S1 to S24 in section 11, each with the date it was read (all 18 November 2026).

## 1. The answer

Do not build step 4.5 on automated writes through the consumer cloud login as a production path. Sunsynk's terms (S1, official) forbid automated scraping of the app and its infrastructure, commercial use beyond the owner's own plant, and overloading its systems; they say they may suspend an account without notice; and they remove Sunsynk's liability for damage when the app is used "with un-supported equipment or applications". The licensed route (the Open API at openapi.sunsynk.net, and an OAuth flow that Predbat.com already uses) exists, but no public page says how to get access, so it has to be asked for from Sunsynk. The production path for writes is local Modbus from the home hub (section 5), which the thing model already assumes. Until then, the cloud may be used for writes only on the owner's own inverter, only if the owner accepts the account risk in writing, and only behind the conditions in section 8. The Octopus fallback (section 6) is real but weaker than the plan assumes: for a BMW, Octopus no longer sets the charge target or ready-by time (S20, official), so only a bump charge (on or off) is left, and it costs the normal rate.

Everything below is the evidence for that, the risk list, the exact conditions, and the questions only the owner can answer (section 10).

## 2. What the code does today and where a driver fits

- `src/adapters/sunsynk.js` logs in with the owner's username and password (RSA-encrypted password, MD5-signed nonce, client id `csp-web`, the web portal's own client), then only reads: plants, plant record, 5-minute day series, month totals, `inverters`, `flow`, and `battery/{sn}/realtime`. It never calls a settings endpoint and never writes. Its header comment says the terms forbid automated scraping and that production needs a partner key. The research below confirms that comment (S1 clause F) and finds a second reason: the terms also forbid use beyond one's own plant (clause J).
- The command path is built and proven only against a simulated device (`docs/control-readback.md`): gates at enqueue (`placeholder_capability`, `stale_inputs`, `limit`, `params`), `send` then read-back, `acked` only when the device reports the desired state, retry then `failed`, `expired`, `applied_late`, effect check. A driver is `{ source, read, send, handles? }`. Section 9 of `docs/control-readback.md` lists "A vendor driver" as not built.
- Existing state points that a Sunsynk driver would fill: `ctl_work_mode`, `ctl_charge_target_soc_pct`, `ctl_reserve_pct`, `ctl_charge_window_start_min`, `ctl_charge_window_end_min`, `ctl_charge_rate_w`, `ctl_discharge_rate_w`.
- Two things the research found that the current model does not cover:
  1. Sunsynk has six time slots (programs), and each slot's end is the next slot's start (community, S7 pull request 23; S11 where the six start times form a circular chain). A command with an independent "window end" does not exist on the device. The "structured schedules" gap in `control-readback.md` section 9 is therefore not optional for Sunsynk; step (c) of 4.5 needs it. Step (b), the reserve, does not.
  2. A cloud write is acknowledged before the inverter applies it, by one to seven minutes (section 4). The executor's `settleS` must be set in minutes for this driver, and `valid_until` must be longer than the settle time with room for retries.

## 3. Sunsynk's official position

### 3.1 Terms of use (official, S1)

"Sunsynk Connect | Terms and Conditions for Access and Use", Version 1.0, last updated 1 November 2025, between the user and Sunsynk Group Limited. The page is a JavaScript application; I read the text from its public script chunk (S1). Clauses that matter, quoted from the "Prohibited Activities" list. "The App" is defined to be read broadly: "the App, its components, licensed technologies outputs and its associated infrastructure, in whole or in part".

| Clause | Text (quoted) | Effect on EnergieBee |
|---|---|---|
| F | "Use the App to construct any kind of external database or to conduct automated or systemic data scraping, data mining, data extraction or similar data collection activities" | The current polling adapter, which stores Sunsynk data in our database, is inside this wording. Writes are not named, but an automated client is the same kind of use. |
| E | "Attempt to reverse engineer or otherwise access or use the App in order to set up or contribute to an endeavour that may compete with the App ... (e.g. by using aspects of the App as part of the development of your own software product or sharing with other developers ...)" | The adapter uses the web portal's client id and signing scheme. A product built on that is the case the clause describes. |
| H, I | "Attempt to damage, interfere with, slow, or otherwise alter the App, its performance or its integrity"; "Use the App in a way that could damage, disable, overburden, impair or compromise our systems" | A write loop or retry storm would be a breach. |
| J, K, L | "Use the App for any commercial purposes extending beyond management of your own Plant(s)"; "Use output generated using the App ... as part of any product or services provided in the course of business"; "... to inform research or analysis or to make decisions other than ... for your own benefit in conjunction with your own Plant(s)" | One owner running his own plant is arguably inside "management of your own Plant(s)". EnergieBee serving other homes is not. An installer may give "reasonable support service(s)" to the owner (a carve-out for installers, not for software vendors). |

Other statements:

- "We may restrict, suspend or terminate your use of the App without notice or liability should you abuse or misuse the App, including any breach of this Agreement." (official). The consequence of a breach is loss of the owner's own Sunsynk Connect account, which is also the owner's monitoring and the installer's access.
- Limited remedy for damage (official): Sunsynk repairs or replaces an inverter or battery "to the extent reasonably proven to have been physically damaged by use of the App attributable to our negligence", except where the owner failed to "Follow the correct installation, configuration or usage instructions or have used the App with un-supported equipment or applications", or is "in breach of any of your obligations under this Agreement". An unapproved automated client changing settings gives Sunsynk grounds to refuse a claim.
- "Control of Your Sunsynk Equipment and Other Elements": certain capabilities "may require you to provide or cede certain access and/or control(s) to us, up to and including full control of your inverter", as detailed by Sunsynk for the offering. (official). So Sunsynk expects remote control to be agreed per offering, not taken by third parties.
- "Advanced Capabilities" may be offered on a subscription basis under separate terms; a "Acceptable Use Policy" may be notified later; the terms can be changed by notice. (official)
- Governing law for UK plants: England and Wales.
- No clause gives a rate limit, and none mentions an API or third-party clients by name.

### 3.2 The Open API (official, S2)

Sunsynk's support article "API Access" (S2; a second article of the same title, S3, returned 404 when I fetched it, so it is known only from a search listing) says to go to `https://openapi.sunsynk.net`. The only call it documents is `POST /oauth/token` with username, password, `grant_type: password`, `client_id: openapi`, and requests signed with HMAC-SHA256 using an `appKey` and `appSecret` sent in `X-Ca-*` headers plus `Content-MD5`. The sample leaves both keys blank and does not say how to obtain them. It states no terms, no rate limit, no other endpoint, and says nothing about writes. Last modified "9 May", year not shown.

- `openapi.sunsynk.net` returned 404 for its root when fetched by the research tool; no developer portal, price list or licence text was found anywhere (official gap).
- The community client S6 says its target, `api.sunsynk.net`, is "the API behind the apps, not the licensed Sunsynk OpenAPI (`openapi.sunsynk.net`)", which "uses a different authentication scheme" (community). "Licensed" implies a licence is needed; I found no page that says so, so this is **inferred**.
- A forum user reported (via search summary of a DIY Solar Forum thread; page itself returned 403) that Sunsynk staff shared documentation with them directly and that signed calls still returned 500 (community, S19b). That suggests the Open API is handed out case by case.

### 3.3 An OAuth flow exists (inferred from official front-end code; community use)

The public script of the Sunsynk web portal (S4, official artefact, my reading is inferred) contains routes `/oauth/authorize`, `/oauth/confirm`, `/oauth/login`, `/oauth/error`, a page titled "SUNSYNK Authorization", and client code for `oauth2/authorize` with `appKey`, `appSecret`, `redirect_uri`, `response_type`, `state`, `refresh_token`, `cancel` and `status`. This is a third-party authorisation flow where the owner approves an app on a Sunsynk page. Predbat documents exactly such a mode, `sunsynk_auth_method: oauth`, where Predbat.com "injects and refreshes" the token and the user "connect[s] your Sunsynk Connect account through Predbat.com" without giving credentials to the self-hosted add-on (community, S8). The Predbat page does not say how Predbat.com arranged this with Sunsynk. So: a partner OAuth path probably exists for registered apps (inferred) and the way in is a request to Sunsynk, which only the owner or EnergieBee's business side can make.

### 3.4 Rate limits (official and community)

- Home Assistant's page for its new Sunsynk integration says "Sunsynk limits API requests" and advises against using the same account in other tools that poll often; it polls every 5 minutes because the inverter uploads every 5 minutes (S5; HA's text, not Sunsynk's).
- No figure is published by Sunsynk (official gap). The openHAB binding enforces 60 s minimum and says there is "no documented rate limit" (S14, community). Community guidance on cloud writes is also about 60 s.
- No report of an account lockout from rate limiting was found for Sunsynk. Growatt's equivalent cloud does lock accounts (up to 24 h) according to Home Assistant's Growatt docs (community, other vendor, shown only as a precedent).

### 3.5 What the consumer login may do

- **Official:** nothing states that the consumer login may be used for automated writes, and nothing states that it may not, except the general prohibitions above. No developer or partner programme page exists in public.
- **Community:** the same login and the same endpoints are used by Home Assistant add-ons, Predbat, openHAB and several libraries, for reads and writes (sections 4). Sunsynk has not, in anything I found, taken public action against them. Absence of enforcement is not permission (inferred).
- **Community:** the client S6 says "the Sunsynk API only allows installer accounts to change settings". Other tools (Predbat, S8; HA add-on, S7) are used with plain owner logins and do not mention an installer requirement. These do not agree, so whether the owner's login can write is an open question that the owner can settle in one minute: try changing the same setting in the Sunsynk Connect app (section 10, Q1).
- **Community, to be checked:** MFA must be off on the account because the add-on does not support it (S7). Sunsynk changed the login in 2025 (RSA-encrypted password, a "pre-2025 plaintext login" kept for some regions, S8); the existing adapter already uses the new login.

## 4. How the cloud settings endpoints work (community knowledge)

Everything in this section is community knowledge from open-source projects and issue threads (S6, S7, S8, S9, S14, S15). None of it is Sunsynk documentation, none was checked against a live account, and it can change without notice. The Predbat project says the same about itself: "The Predbat project has no Sunsynk account, so the wire format is inferred from third-party open-source clients" (S8).

**Endpoints.** Read the whole settings object: `GET /api/v1/common/setting/{inverter sn}/read`. Write: `POST /api/v1/common/setting/{inverter sn}/set` with a JSON body of the fields to change (S7). Older guides use `pv.inteless.com` with the same `/read` and `/set`, and a bare `common/setting/{sn}` for both GET and POST with a body like `{"batteryCap": "100"}` (community search summaries). Auth is the Bearer token that `login()` already obtains. Region: `api.sunsynk.net` or `pv.inteless.com` (S8 `sunsynk_region`).

**Fields seen in the settings object** (names as quoted by the clients; values are strings in the Go client, S15; confirm on a real dump):

| Meaning | Field | Source |
|---|---|---|
| Slot n start time (HH:mm) | `sellTime{n}` (n = 1..6) | S7 PR 23 |
| Slot n target SoC % | `cap{n}` | S7 PR 23 |
| Slot n power limit W | `sellTime{n}Pac` | S7 PR 23 |
| Slot n grid charge on | `time{n}on` | S7 PR 23 |
| Slot n sell (export) on | `sellTime{n}on` | S7 PR 23 |
| Slot n voltage | `sellTime{n}Volt` | S7 PR 23 |
| System work mode (0 to 4) | `sysWorkMode` | S7 |
| Energy mode | `energyMode` | S7 |
| Solar sell, PV export limit | `solarSell`, `pvMaxLimit` | S7 |
| Weekday flags, generator timer flags | (names not listed) | S7 |
| Battery discharge floor ("battery capacity" in the app) | `batteryCap` | search summary of community guide; S15 `battery-capacity` |
| Battery low capacity / low voltage | `batteryLowCap`, `batteryLowVolt` | search summary of community dumps |
| Shutdown capacity | present in the response, not writable through the API | S15 |

**Behaviour.**
- A write can carry only the changed fields (community guides), but the safe unit is a whole slot: the HA add-on found that sending all 36 system-mode fields on a one-slot change put a stale start time from an untouched slot into the payload, "corrupted the targeted slot's end time, because Sunsynk derives slot N's end from slot N+1's start" (S7 PR 23). The add-on now writes each slot's six fields only with each other. Predbat does the opposite: read-modify-write of the whole object, re-read before every write, "last writer wins" against the phone app (S8).
- The cloud accepts a write before the inverter has it. The dongle "picks up new settings on its next poll, typically one to five minutes later" (S8). A Predbat user timed plan-to-inverter delay at 5 to 7 minutes with a 60 s settings poll (S9). A read right after a write can show the old value (S9, Predbat issue text). The add-on's README says writes can be acknowledged before the device applies them (S7). openHAB buffers commands until its next refresh (S14).
- Writes can be reverted. In a parallel (master/slave) system a slave "may accept a setting and then revert to the master's value several seconds later"; the add-on writes to the master (S7). A user reported a cloud write that showed on the inverter screen for a second and reverted (search summary of Home Assistant issue; for Modbus over RS485, the same symptom on one 8 kW unit, S10).
- Validation is weak or silent: out-of-range values may be refused by the cloud, "settings may not apply without an obvious error" (S7). Charge and discharge currents must be checked against the inverter's Max A and the battery's BMS limit by the client (S7). `force_charge` only changes the current; whether grid charging happens still depends on the active slot (S7).
- Some settings depend on firmware (S7). Some models and firmware behave differently (S7).
- Time values are strings applied as given, not zone-adjusted; whether the inverter or the server applies daylight saving differs (S14).
- Write volume: a Predbat maintainer discussion weighs confirming that writes landed against "avoiding redundant writes that could wear the inverter's memory" (S9). No source gives an endurance figure (inferred risk, not measured).

**Known incidents.** I found no report of an inverter bricked or an account locked by a settings write through the cloud. What exists:
- Predbat issue 5138, 17 to 19 September 2026: a Sunsynk cloud user's export slot flag `sellTimeXEn` stayed on, and "battery drains past reserve". The maintainers' main suspicion was a write the cloud accepted but the inverter never applied: Predbat marks a payload as applied once the POST returns, never re-sends identical payloads, and its settle check "only warns after about 45 minutes ... and does not act". Closed after a fix in Predbat (S9, community). This is the failure our read-back design exists for, and it is a battery discharged below the intended reserve.
- The HA add-on's dual-inverter flicker and slot-corruption bug (S7 PR 23), fixed by that pull request (a release v1.9.5 of the add-on exists; I did not check that the fix is in it).
- Writes via local Modbus ignored on some units (S10, section 5), a different path.

**Mapping to the existing command path** (inferred; verify on the first real dump):

| Desired key (`stateMetricFor`) | Sunsynk setting | Note |
|---|---|---|
| `reserve_pct` | `batteryCap`, or the active slot's `cap{n}` when time-of-use is on | Which one the inverter honours must be seen in the read-only week. One scalar, no slot coupling, so it is the safest first write. |
| `target_soc_pct` | `cap{n}` of a grid-charge slot | Needs `time{n}on` and the slot's window. |
| `window_start`, `window_end` | `sellTime{n}` and the next slot's `sellTime` | No independent end. Needs the structured-schedule work. |
| `charge_rate_w`, `discharge_rate_w` | `sellTime{n}Pac`; max charge/discharge current | Check against Max A and BMS limit. |
| `action` (work mode) | `sysWorkMode`, `energyMode`, `solarSell` | Enum values must be read from the real payload. |
| Installer limits (`control_limit`, source installer) | `batteryLowCap`, shutdown capacity, max currents, `pvMaxLimit` | Read these as installer limits; the reserve may never go below them. S11: slot capacity minimum is battery low capacity. |

## 5. Local alternatives (community)

All community; none is sanctioned by Sunsynk in what I found.

**Modbus.** Sunsynk 3.6 to 8 kW hybrids (single phase) and the 12 kW three-phase models are Deye platform inverters. The Home Assistant add-on `kellerza/sunsynk` (Apache 2.0, "Sunsynk, Deye, Turbo-Energy, single/three-phase", connection "RS485 or Solarman", S24) defines the register map. For the single-phase 5/8 kW map (S11, community):

| Setting | Register | Note |
|---|---|---|
| Prog1 to 6 time | 250 to 255 | each bounded by neighbours; circular |
| Prog1 to 6 power | 256 to 261 | W |
| Prog1 to 6 voltage | 262 to 267 | 0.01 V |
| Prog1 to 6 capacity (SoC %) | 268 to 273 | minimum is Battery Low Capacity (219) |
| Prog1 to 6 charge / mode / sell | 274 to 279 | one register, three bitmasks (0x03, 0x1C, 0x40); writing one field touches the others |
| Battery shutdown / restart / low capacity | 217 / 218 / 219 | low capacity max 50 |
| Load limit (0 allow export, 1 essentials, 2 zero export) | 244 | |
| Priority load (0 battery first, 1 load first) | 243 | |
| Grid charge enable / grid charge current | 232 / 230 | |
| Max charge / discharge current | 210 / 211 | max 185 A |

A different set of addresses (program times 148 to 153, capacity 166 to 171, shutdown 115 to 117) came back for another file of the same project (`three_phase_common.py`); the tool that read it gave an inconsistent model name, so treat the 12 kW three-phase map as **not verified**: each model and firmware has its own map (a Modbus guide says the same, community). The Developer089 add-on for 12 kW SG04LP3/SG05LP3 (S12) keeps its map in `maps/sun_3ph_hybrid.yaml`, which I did not read.

**Hardware (community).**
- Solarman or Sunsynk Wi-Fi/LAN logger stick, local TCP port 8899, Solarman V5 framing carrying Modbus RTU (pysolarmanv5 documentation, S13). Nothing to buy, but: the stick accepts one Modbus client, which conflicts with the cloud logging and any other poller (S12); port 8899 has no authentication (S13); an over-the-air stick update has been reported to stop local access on Deye sticks (S13, other vendor, one report); and Sunsynk support told one user that newer firmware might enable writes but needs a new Sunsynk dongle (S10, April 2025).
- A wired RS485 route: a USB-RS485 adapter on a Raspberry Pi, or an RS485-to-Ethernet gateway (Waveshare, Elfin EW11, USR) next to the inverter (S12, S16). Cost is tens of pounds (inferred; confirm the price). Wiring details are model-specific: on some 5 kW units the port marked RS485 (bottom right) does not work and people use the BMS-485 port (top left), which is shared with the battery's communications; a CAN battery frees it, a splitter is used by some (S16, community). The owner needs physical access to the unit and, where the installer's warranty says so, the installer's agreement.

**Experience with writes (community).**
- Works: a user with a 12 kW three-phase Sunsynk and USB-RS485 reports writes work well with the add-on (S10, April 2025). The Developer089 add-on lists writable work mode, charge limits, SoC limits and six slots on 12 kW models, with the warning that writes "can affect battery health and grid interaction" (S12).
- Does not work: on an 8 kW single phase over RS485 the writes "appear in the add-on logs, but the inverter reverts to its previous value within seconds", while the Solarman app's writes succeed; the maintainer thinks some RS485 ports are read-only; unresolved since August 2024, with a second user on a 16 kW unit in March 2026 (S10). Another user got "success" from a three-phase write with no effect (search summary).
- The Python library's own disclaimer: "Use at your own risk! Especially when writing any settings."
- Home Assistant's official integration is cloud, read-only, "cannot change settings on the inverter" (S5). It is a statement of that integration's scope, not of Sunsynk policy.

So local writes are not guaranteed either: a hardware and firmware test on the owner's unit decides. The cost of finding out is one adapter and one afternoon, and it breaks no contract.

## 6. The Octopus fallback (official unless marked)

**The API.** Kraken GraphQL, endpoint `https://api.octopus.energy/v1/graphql/` (S17). The docs describe the API as "for customers and partner organisations" (S23); a customer gets a personal API key from the account dashboard (S23, S24 evcc docs, community-level for the exact page). Octopus's GraphQL docs say points used within an hour must stay under a limit reported by the `rateLimitInfo` query and give the error `KT-CT-1199` when exceeded; the number is not published in the pages I read (a Home Assistant FAQ says 100 calls per hour, community). Each smart-device mutation lists "Allowed Viewers: Customer, Partner, User, Third party" and "Rate Limits: user 300/h" (S17, official).

**The mutations (S17, S18).**
- `updateBoostCharge(input: UpdateBoostChargeInput)`: "Update the boost charge for a specific device." Input: `deviceId` (String), `action` (`BOOST` or `CANCEL`), and, since 23 October 2026, either `targetSocPercentage` (Int 1 to 100, "cannot be combined with endTime", refused with `BC_TARGET_SOC_NOT_ABOVE_CURRENT` if not above the current charge) or `endTime` (DateTime with offset, whole minute, within 14 days). Returns `SmartFlexDeviceInterface`. Refusals are error `KT-CT-4357` with reasons `BC_DEVICE_NOT_YET_LIVE`, `_RETIRED`, `_SUSPENDED`, `_DISCONNECTED`, `_NOT_AT_HOME`, `BC_BOOST_CHARGE_IN_PROGRESS`, `BC_DEVICE_FULLY_CHARGED`, and the two above. `KT-CT-4354` is a failed cancel.
- `triggerBoostCharge` and `deleteBoostCharge` are deprecated (since 12 May 2025; removal on or after 26 January 2026), `suspendControl` too (removal on or after 11 December 2025). Code must use `updateBoostCharge` and `updateDeviceSmartControl`.
- `setDevicePreferences(SmartFlexDevicePreferencesInput)`: sets a device's preferences schedule (`deviceId`, `mode`, `schedules`, `unit`). The reference does not say which device types accept it.
- The 14 October 2026 changelog adds per-device `capabilities` (`FlexTriggerBoostChargeCapability`, `FlexCancelBoostChargeCapability`, `FlexUpdatePreferencesCapability`, `FlexSuspendDeviceCapability`, ...). A driver should read a device's `capabilities` and refuse any action the device does not list.
- The schema moves quickly: nine smart-flex entries between 13 October and 17 November 2026 (S18). The current domain redirects among `developer.octopus.energy`, `docs.octopus.energy` and `developer.oegb-kraken.energy`.
- The Home Assistant Octopus integration exposes the same as a bump-charge switch, a charge-target number and ready-by select, "None are available for OHME chargers"; "Octopus Energy determines smart-charge dispatches, so the integration does not control when charging occurs" (S22, community).

**Does it apply to the owner's car?**
- Whether the BMW 530e is eligible: an Octopus compatibility page lists 530e variants (found only through a search summary; my fetch of that page returned nothing, so this is **unconfirmed**; the owner can check in the Octopus app, Q9).
- Official, important: from 2 March 2026 "BMW no longer lets Octopus set your charging preferences. ... you now set your charging preferences directly in your BMW or MINI app"; changes made in the Octopus app after that date "won't be saved" (S20). This most probably covers the API as well (inferred): `setDevicePreferences` for a BMW would not stick, and a target in the Kraken API is not available. The article does not mention bump charge, so I do not know whether a bump charge still works for BMW (open; test by the owner in the Octopus app first).
- Cost and eligibility (official): bump charge starts a charge at once, can be stopped in the app; "any charging we haven't scheduled is charged at your normal home energy rate" (S19). Octopus's help pages for chargers say bump charge is billed at the day rate (community/search summary). The FAQ does not say whether frequent bump charging affects the smart discount.
- Conflict warning (official): customers should ensure "any other charging services aren't controlling your car"; third-party apps "can conflict with Intelligent Octopus Go because two systems could send clashing instructions", which could stop Octopus guaranteeing its rates; and "you won't be able to join any other flexibility service whilst on the tariff" (S19). The API is offered to customers, but a controller of the same car is what Octopus warns about. A bump charge button pressed by the owner through EnergieBee is the mildest form, but it should be an owner-confirmed action, never automatic (inferred).
- It does not help the inverter. It exercises the command path against a real device with a small, cheap downside (a few kWh at the normal rate), so it is a useful second driver, not a replacement for Sunsynk.

## 7. Options compared

| Path | May we do it? | Works for writes? | Effort and cost | Main risk |
|---|---|---|---|---|
| Cloud login as today (`csp-web` client) | Not for a product (S1 E, F, J). Owner's own plant, low rate: arguable, not approved (inferred) | Yes per community; installer-only claim unresolved | Zero hardware; driver is a few hundred lines | Account suspension, no warranty remedy, undocumented format, write acknowledged but not applied |
| Sunsynk Open API (`openapi.sunsynk.net`) | Yes if Sunsynk grants keys (official gap on how) | Unknown: the only documented call is the token | A request to Sunsynk; signing code | Not obtainable, undocumented |
| Sunsynk OAuth for partner apps (inferred from S4, S8) | Yes if registered (inferred) | Predbat.com uses it with control | Business agreement | Same |
| Local Modbus over RS485 or TCP via the hub | Nothing in the terms covers local Modbus (inferred) | Yes on some units, ignored on others (S10, S12) | One adapter or gateway; one test day | Wrong register map, shared registers, ports read-only, voids installer warranty |
| Solarman dongle port 8899 | Same | Same | None to buy | One client at a time, firmware may close it |
| Octopus bump charge (BMW) | Yes for a customer's own key (official, with the conflict warning) | Bump only; no target for BMW | Low | Cost at normal rate; interacting with Octopus's own control |

## 8. Recommendation for step 4.5

**Order of work.**
1. **4.5(a) now: read the settings only**, through the same login and the same low rate as the existing adapter (one settings read per 5 minutes at most), as state points, for a week, plus one stored raw dump (`landRaw`) of the whole settings object and the plant, battery and inverter records. This breaks no clause that the current adapter does not already stretch, and it settles three unknowns: the real field names and values, which of `batteryCap` or `cap{n}` the inverter honours, and whether the owner's login sees installer-level fields. Build the same dump as a command-line diagnostic that writes nothing (as Predbat has with `--dump-settings`).
2. **In parallel, ask Sunsynk** in writing for the Open API or partner OAuth, saying what is wanted: one owner's own inverter first, battery reserve and slot settings, with read-back, expiring writes. Ask what the terms mean for a self-hosted client on the owner's own plant. Keep the answer in the repository.
3. **In parallel, test the local route:** one USB-RS485 adapter or gateway, read-only first, on the owner's inverter, to see whether registers 217 to 219 and 250 to 279 (or the model's own) are readable and whether a write of one reserve value sticks (section 8 conditions apply). This is the production path in the thing model (section 14, Q1).
4. **4.5(b) only after 1 to 3:** the battery reserve, as a driver whose `send` is the local Modbus write if it works, else the cloud write under the conditions below.
5. **4.5(c) windows** only after the structured-schedule model exists (section 2).
6. **Octopus** as a second driver after 4.5(b): read dispatches and device capabilities first; bump charge only on an explicit owner confirmation each time.

**Conditions under which cloud writes may be switched on** (all of them; any other home than the owner's own plant is excluded):
1. The owner has decided, in a file in the repository or a configuration row, that they accept that Sunsynk may suspend the account and refuse a damage claim, for their own inverter only, or Sunsynk has agreed in writing.
2. The one-week settings capture is complete, the field names in the driver are the ones seen in the real dump, and the dump parses with no unknown fields in the group being written.
3. The owner has changed the same setting by hand in the Sunsynk Connect app, so the login is known to be allowed to; MFA is off.
4. Installer limits are recorded as `control_limit` rows with source `installer`, read from the inverter (battery low capacity, shutdown capacity, max charge and discharge current, `pvMaxLimit`), and the owner's bounds as source `owner`. The reserve may never go below the installer's low capacity. The owner chooses the bounds (Q8).
5. The capability row for the action has a confirmed source (`probe` or `user`), not `placeholder`. The existing `placeholder_capability` gate then blocks every write until the owner confirms the probe result. This is the first lock.
6. The write carries only the fields of one unit (the single scalar, or one whole slot's six fields), never the whole settings object, and is built from a fresh read taken within the last minute.
7. The settings object before the change is stored (`landRaw`), as the revert point.
8. `valid_until` is at least 30 minutes after the write; `settleS` is at least 10 minutes (the cloud may take 5 to 7 minutes, S9); at most 3 attempts. A command is `acked` only when a later settings read shows the desired values and, where the metric exists, the inverter's own telemetry agrees. The cloud's "ok" never counts.
9. On `expired`, `failed`, `cancelled` or the kill switch, the fields written are restored to their stored values by a revert command at `safety` priority, itself read back. If the revert cannot be confirmed, writes for the device stay off and the owner is told.
10. Writes happen only on a change (`enqueueIfChanged` already does that), at most 8 per inverter per day and 1 per 15 minutes (my figure, no vendor number exists), and reads stay at one per 5 minutes or slower.
11. A setting that differs from the last known state with no command explaining it (the owner used the app, the installer changed it, Predbat or another tool wrote) becomes a `manual` request and stops automated writes for that device until the owner clears it (R16). The core never overwrites it.
12. A manual revert is documented for the owner in the app: the settings and values to set by hand. This is the second lock: writes expire by themselves.

**What the code must do by default.**
- Writes off. The Sunsynk driver ships read-only: `read` implemented, `send` returns `{ accepted: false, error: 'writes_disabled' }` unless a per-device switch that defaults to off is on and the capability source is confirmed. Two locks: the capability gate at enqueue, and the switch inside `send`.
- The driver takes its HTTP function as a parameter, so tests never reach the network. Parsing is tested against a recorded settings dump (a fixture the owner's read-only run produces), and the format is the first thing a Sunsynk change would break (that is why the dump is kept as raw data).
- Tests use `createSimulatedDriver` from `src/core/executor.js` for everything it already does (ignored writes, late application, refusal, no ack reference), plus cases this research adds: a write that is acknowledged and then not applied for longer than `settleS` (Predbat issue 5138); a write that reverts after a few seconds (parallel slave); an external change by the app; a slot write whose neighbour's start was stale; and a read-back that lags by 5 to 7 minutes. These are simulated device behaviours, so no new schema is needed.
- No script, test or scheduled job ever writes to a real inverter unless started by hand by the owner with the switch on.

## 9. Risk list

| # | Risk | Label | Mitigation |
|---|---|---|---|
| 1 | Sunsynk suspends the account for automated access (S1 E, F, H, I) and cuts monitoring and the installer's access | official terms, likelihood unknown | Low rate, one owner, written owner acceptance, ask Sunsynk, move to local Modbus |
| 2 | Sunsynk refuses a damage claim because an unsupported app changed settings (S1) | official | Installer limits as hard limits, reserve bounds, owner awareness; local route does not use the app but is also unsupported |
| 3 | Product use for other homes breaches clause J | official | No cloud writes for any other home; partner or OAuth or local only |
| 4 | Write acknowledged by the cloud, never applied (S9) and the battery drains below the intended reserve | community, observed Sept 2026 | Read-back decides; settle time in minutes; revert and stop on mismatch |
| 5 | Slot write corrupts the neighbouring slot's end (S7 PR 23) | community | Write one whole slot only; read first; compare the neighbours after |
| 6 | Another writer (app, installer, Predbat, HA) overwrites or is overwritten, "last writer wins" (S8) | community | External-change detection, no silent revert |
| 7 | Settings revert after seconds (parallel slave S7; Modbus read-only port S10) | community | Read-back; write to the master; hardware test before relying on it |
| 8 | Field names, endpoints or login change without notice (the login did in 2025, S8; terms can change by notice, S1) | community and official | Keep raw dumps, parse strictly, fail closed on unknown fields |
| 9 | Memory wear from many writes | community (concern only, S9; no figure found) | Write on change only, daily cap |
| 10 | Wrong register map or shared bitmask register on local Modbus (S11) | community | Read-modify-write the register with mask; read-only first; model-specific map |
| 11 | Dongle accepts one Modbus client; local polling breaks cloud logging (S12) | community | Use a separate RS485 path, or stop cloud logging deliberately |
| 12 | Octopus: a boost costs the normal rate and may conflict with its own smart control (S19) | official | Owner confirms each bump; read `capabilities`; no automatic loop |
| 13 | Octopus schema churn and deprecations (S18) | official | Pin to `updateBoostCharge`, read device capabilities, tolerate refusals |
| 14 | Reserve set too low leaves no backup during a grid outage | inferred | Owner's floor, installer's low capacity |
| 15 | Export limit under the grid operator's approval (G98/G99) disturbed by a mode or export write | inferred | Treat as a legal limit that can never be loosened (R17); do not touch export settings in 4.5(b) |

## 10. Open questions only the owner can answer

1. Is the Sunsynk login the owner's own plant-owner login, or an installer account? Can you change the Time of Use and battery settings yourself in the Sunsynk Connect app? Is MFA on?
2. Which exact inverter (model, serial prefix, firmware shown in the app), which dongle (Sunsynk or Solarman stick, model), single inverter or parallel, and which region (`api.sunsynk.net` or `pv.inteless.com`)?
3. Which battery, which communication to the inverter (CAN or RS485), and what shutdown and low capacity did the installer set? Is there a battery or inverter warranty that mentions remote changes?
4. Do you accept, for your own inverter, the risk that Sunsynk may suspend the account and refuse a damage claim? If not, writes wait for Sunsynk's answer or the local route.
5. Who contacts Sunsynk about the Open API or partner OAuth, and may EnergieBee say that it is a self-hosted tool on the owner's own plant?
6. Does anyone else already write to the inverter (installer remote access, Predbat, Home Assistant, Octopus, a VPP or any "Advanced Capabilities" subscription)?
7. Will you buy an RS485 adapter or gateway and open or reach the inverter's port, and does the installer need to agree? Do you want a Raspberry Pi or a small PC as the hub?
8. Which reserve bounds do you accept (lowest and highest), what does the battery need to cover in a grid outage, and what is the largest change per day you accept? How many writes per day are acceptable?
9. Are you on Intelligent Octopus Go with the BMW 530e, connected through the BMW app or a charger? Does a bump charge still work from the Octopus app for this car after the 2 March 2026 change? Do you accept bump charges at the normal rate, confirmed one by one? Will you create a personal API key for EnergieBee, and is any other flexibility service on the account?
10. Is there a G98 or G99 export limit that the installer set in the inverter, and which settings may never be touched?

## 11. Sources

All read on 18 November 2026. "Read through" means the page text was read by the research tool; "search summary" means only a search-engine summary of the page was available.

- S1 Sunsynk Connect Terms and Conditions for Access and Use, v1.0, 1 November 2025: https://www.sunsynk.net/termsofUse (text read from https://www.sunsynk.net/static/js/chunk-505abb3b.749b7faf.js)
- S2 Sunsynk support, "API Access": https://support.sunsynk.com/support/solutions/articles/103000400854-api-access ; S3 the second article, https://support.sunsynk.com/support/solutions/articles/103000380621-api-access (404 when fetched; search listing only)
- S4 Sunsynk web portal script (OAuth routes and client code): https://www.sunsynk.net/static/js/app.9be295b1.js
- S5 Home Assistant Sunsynk integration (HA 2026.10, cloud polling, read-only, maintainer jamesridgway): https://www.home-assistant.io/integrations/sunsynk/
- S6 jamesridgway/sunsynk-api-client README: https://github.com/jamesridgway/sunsynk-api-client
- S7 MarcinG81/SunSynk_HA_Integration README and PR 23 (slot payload scoping): https://github.com/MarcinG81/SunSynk_HA_Integration , https://github.com/MarcinG81/SunSynk_HA_Integration/pull/23
- S8 Predbat, Sunsynk Cloud API component and inverter setup: https://springfall2008.github.io/batpred/components , https://springfall2008.github.io/batpred/inverter-setup
- S9 Predbat issue 5138 (September 2026): https://github.com/springfall2008/batpred/issues/5138
- S10 kellerza/sunsynk issue 331 (writes revert over RS485, 2024 to 2026): https://github.com/kellerza/sunsynk/issues/331
- S11 kellerza/sunsynk register definitions, 5 and 8 kW: https://raw.githubusercontent.com/kellerza/sunsynk/main/src/sunsynk/definitions/single_phase.py
- S12 Developer089/deye-modbus-ha (12 kW SG04LP3/SG05LP3, Modbus TCP): https://github.com/Developer089/deye-modbus-ha
- S13 pysolarmanv5, Solarman V5 protocol: https://pysolarmanv5.readthedocs.io/en/stable/solarmanv5_protocol.html (search summary); Deye troubleshooting guide on port 8899: https://marklabs.pl/en/deye-home-assistant-troubleshooting/ (search summary)
- S14 openHAB Sunsynk binding: https://www.openhab.org/addons/bindings/sunsynk/
- S15 synkctl REST package (Go): https://pkg.go.dev/github.com/hammingweight/synkctl/rest
- S16 Power Forum RS485 port threads and the sunsynk library notes: https://powerforum.co.za/topic/24521-deye-5kw-rs485-port-for-home-assistant/ , https://pypi.org/project/sunsynk/0.3.1/ (search summaries); kellerza add-on landing page S24: https://kellerza.github.io/sunsynk/
- S17 Octopus Kraken GraphQL reference: https://developer.oegb-kraken.energy/graphql/reference/mutations/updateboostcharge/ , `.../updateboostchargeinput/` (under input-objects), `.../updateboostchargeaction/` (under enums), `.../setdevicepreferences/`, `.../triggerboostcharge/`, `.../suspendcontrol/`
- S18 Kraken GraphQL changelog: https://developer.oegb-kraken.energy/graphql/changelog/
- S19 Intelligent Octopus FAQs: https://octopus.energy/intelligent-faqs , https://octopus.energy/intelligent-go-faqs/ ; S19b DIY Solar Forum thread on the intelless API: https://diysolarforum.com/threads/monitoring-sunsynk-deye-via-intelless-api.32512/ (search summary; page returned 403)
- S20 Octopus, setting charging preferences for BMW and MINI (from 2 March 2026): https://octopus.energy/help-and-faqs/articles/set-my-charging-preferences-for-my-bmw-mini-with-intelligent-octopus-go/
- S21 Octopus list of compatible EVs: https://octopusenergy.com/help-and-faqs/what-electric-vehicles-evs-are-compatible-with-intelligent-octopus (search summary; fetch returned nothing)
- S22 Home Assistant Octopus Energy integration, intelligent entities: https://bottlecapdave.github.io/HomeAssistant-OctopusEnergy/entities/intelligent/
- S23 Octopus GraphQL basics (authentication, points limit, KT-CT-1199): https://developer.octopus.energy/graphql/guides/basics (search summary; the page redirected in a loop when fetched)
- S24 evcc Octopus docs (where the API key is): https://docs.evcc.io/en/tariffs/octopus-energy-api.md

## 12. What this research did not establish

- No Sunsynk page says whether the consumer login may be used for writes, how to obtain the Open API keys, or what the rate limit is. That is a gap in Sunsynk's public material, not something I missed in a page I read.
- No field name or endpoint was checked against a real response; they come from community projects, and a few from search summaries. The week of read-only capture is the check.
- The register map for the 12 kW three-phase models is not verified (section 5).
- The BMW 530e's eligibility and whether bump charge still works for it are not confirmed.
- The Octopus point limit per hour was not found in the pages I could read.
- No numbers were measured. Timings quoted (5 minute upload, 1 to 5 minute dongle pickup, 5 to 7 minute plan-to-inverter delay, 60 s minimum poll, 300 per hour per Octopus mutation) are other people's figures with their sources.
