# Slot engine: how the new system fits together

This page draws the provider-agnostic slot system as it is built today, in Mermaid. Each diagram marks what exists (solid, green) and what is planned (dashed, grey). The reasoning behind the design is in `docs/slot-engine-solution.md`; the root causes it answers are in `docs/resilient-slot-engine.md`.

**The idea in one line.** The slot builder never asks for a vendor. It asks for a *role* ("the inverter's 5-minute samples"), and a dated *binding* says which source fills that role for this home. A vendor's own units and signs are handled by *channel* rows when its data is written, so a new provider is rows, not engine code.

Contents: 1 Overview · 2 Data model · 3 Writing data in · 4 Reading data out · 5 Roles · 6 Provider lifecycle · 7 A vendor switch, worked through · 8 Crash safety · 9 Control: a command with read-back · 10 Groups and access · 11 What is built and what is not

---

## 1. Overview

![Diagram 1: see the Mermaid source below if the image does not show](img/slot-engine-architecture-1.png)

<details>
<summary>Mermaid source of diagram 1</summary>

```mermaid
flowchart TB
  subgraph SRC["1 Sources"]
    S1["Inverter cloud API"]
    S2["Supplier meter API"]
    S3["Weather carbon and forecast feeds"]
    S4["New vendor of any shape"]
  end

  subgraph ING["2 Ingest"]
    P["Processor fetch check parse"]
    RAW["Raw receipts and quarantine"]
  end

  subgraph CH["3 Channels"]
    C["Channel rows translate units signs and limits"]
    REJ["Rejected values and unmapped points"]
  end

  subgraph FACTS["4 Fact store"]
    F1["reading"]
    F2["interval_fact"]
    F3["forecast_fact"]
  end

  subgraph BIND["5 Bindings"]
    BD["binding_default"]
    B["binding rows role source dates"]
  end

  subgraph ENG["6 Engine"]
    BLD["Slot builder"]
    PR["Planner read layer"]
  end

  subgraph OUT["7 Outputs"]
    HH["site_hh and site_day"]
    PL["Arrays for Predbat and PredHeat"]
  end

  S1 --> P
  S2 --> P
  S3 --> P
  S4 --> P
  P --> RAW
  P --> C
  C --> REJ
  C --> F1
  C --> F2
  C --> F3
  BD --> B
  B --> BLD
  B --> PR
  F1 --> BLD
  F2 --> BLD
  F3 --> BLD
  F1 --> PR
  F2 --> PR
  F3 --> PR
  BLD --> HH
  PR --> PL
```

</details>

How to read it: data flows top to bottom. Vendors differ only in step 2. Steps 3 and 5 are rows in tables, not code, so adding, switching or removing a provider changes rows only. Both engine parts in step 6 read the same bindings, so the slot builder and the planner agree on which source a slot used (within 0.1 percent in the tests).

---

## 2. Data model

Only the tables this design adds or relies on, with the control and access tables in brief (their full definitions are in `docs/control-readback.md` and `docs/groups-and-access.md`). `source.traits` is a new column; `channel`, `channel_reject`, `binding` and `binding_default` are new tables (deltas 061 to 066).

![Diagram 2: see the Mermaid source below if the image does not show](img/slot-engine-architecture-2.png)

<details>
<summary>Mermaid source of diagram 2</summary>

```mermaid
erDiagram
  site ||--o{ binding : "has"
  site ||--o{ channel : "has"
  site ||--o{ device : "has"
  source ||--o{ binding : "fills a role"
  source ||--o{ channel : "maps points of"
  source ||--o{ series : "owns"
  metric ||--o{ channel : "becomes"
  metric ||--o{ series : "measures"
  device ||--o{ channel : "optional owner"
  series ||--o{ reading : "instants"
  series ||--o{ interval_fact : "periods"
  series ||--o{ forecast_fact : "predictions"
  source ||--o{ binding_default : "starting source"
  site ||--o{ channel_reject : "refused values"
  device ||--o{ command : "is asked to"
  device ||--o{ command_block : "refused for"
  site ||--o{ site_grant : "is shared by"
  site ||--o{ site_group_member : "counts in"

  source {
    int id PK
    text code "vendor or feed name"
    text contract "human description"
    text traits "JSON: holdS, live, forecastOnly, namedOnly"
  }
  binding {
    int id PK
    int site_id FK
    text role "inverter_5min, meter_energy, ..."
    int source_id FK
    int device_id FK "null = the home itself, set for a second device"
    int valid_from "epoch s, null = open"
    int valid_to "epoch s, null = open"
    int priority "order among sources of one role"
    int recorded_at "ms"
    int superseded_at "ms"
    text reason "why, kept for changes to built slots"
  }
  binding_default {
    text role PK
    int source_id PK
    int priority
  }
  channel {
    int id PK
    int site_id FK
    int source_id FK
    int device_id FK "null = the home itself"
    text point "the vendor's own name"
    int metric_id FK "canonical metric"
    real scale
    real shift
    text part "all, positive, negative"
    real min_value
    real max_value
    int recorded_at "ms"
    int superseded_at "ms"
  }
  channel_reject {
    int id PK
    int site_id
    int source_id
    text point
    int ts
    real value
    text reason "out_of_range, not_a_number, unmapped_point"
  }
  command {
    int id PK
    int device_id FK
    text action
    text status "pending, sent, acked, failed, expired, cancelled, skipped_unchanged"
    text verify_status "verified, not_verified"
    int applied_late_at "ms"
    int valid_until "s"
  }
  command_block {
    int id PK
    int device_id FK
    text gate "placeholder_capability, stale_inputs, limit, params"
  }
  site_grant {
    int id PK
    int site_id FK
    int user_id FK
    text role "owner, operator, viewer"
    text scope "all, energy, control"
    int revoked_at "ms"
  }
  site_group_member {
    int id PK
    int group_id FK
    int site_id FK
    int valid_from "s"
    int valid_to "s"
  }
  series {
    int id PK
    text subject_kind "site, device, region"
    text subject_id
    int metric_id FK
    int source_id FK
  }
  reading {
    int series_id FK
    int ts
    real value
    int recorded_at "ms"
    int superseded_at "ms"
  }
  interval_fact {
    int series_id FK
    int start_ts
    int end_ts
    real value
    int recorded_at "ms"
    int superseded_at "ms"
  }
  forecast_fact {
    int series_id FK
    int start_ts
    int end_ts
    int issued_at
    real value
    int recorded_at "ms"
  }
```

</details>

---

## 3. Writing data in

Every vendor takes the same path. The processor knows the vendor's shape; the channels know the vendor's units and signs; the fact writer knows nothing about vendors and refuses writes outside the declared source.

Observations come in six kinds: an instant, a period, a forecast issue, a **counter** (a cumulative total such as a plug's energy meter, turned into energy per period by difference, with resets, wraps and backwards steps handled), an **event** (a 0 or 1 period), and the control kinds **state** and **ack**. The kinds are described in `docs/counters-events-roles.md` and `docs/control-readback.md`.

![Diagram 3: see the Mermaid source below if the image does not show](img/slot-engine-architecture-3.png)

<details>
<summary>Mermaid source of diagram 3</summary>

```mermaid
sequenceDiagram
  autonumber
  participant V as Vendor API
  participant P as Processor (pure parse)
  participant R as Raw store
  participant I as ingestObservations
  participant CH as channel rows
  participant W as Fact writer (asWriter)
  participant D as Rebuild queue

  P->>V: fetch the window
  V-->>P: body
  P->>P: check shape
  alt unexpected shape
    P->>R: quarantine (kept, no facts)
    P-->>P: error in the sync log
  else known shape
    P->>R: land raw receipt (hash, file)
    P->>P: parse to points: point, ts or start+end, value
    alt nothing parsed and data is required
      P-->>P: error: an empty answer is not a success
    else observations
      P->>I: observations and the raw id
      I->>CH: load this home's channels for the source (create defaults if none)
      loop each observation
        I->>CH: find channels for the point
        alt no channel
          I->>I: report as unmapped point
        else value is not a number
          I->>I: reject, kept in channel_reject
        else mapped
          I->>I: part (positive or negative), then x scale + shift
          alt outside min or max
            I->>I: reject, kept in channel_reject
          else accepted
            I->>I: collect under the canonical metric
          end
        end
      end
      I->>W: write per metric, only this source's series
      W->>W: last value wins for a repeated timestamp
      W->>W: unchanged value: nothing. Changed: new version, old one superseded
      I->>D: mark the earliest changed time dirty
    end
  end
```

</details>

**What the channel row does, by example** (the same inverter reported two ways):

| Vendor point | Vendor value | Channel (metric, part, scale) | Stored fact |
|---|---|---|---|
| `Grid` (signed W, + = import) | +500 | `grid_import_w`, positive, 1 | 500 |
| `Grid` | -300 | `grid_import_w`, positive, 1 | 0 |
| `Grid` | -300 | `grid_export_w`, negative, 1 | 300 |
| `grid_kw` (kW, a second vendor) | -0.3 | `grid_export_w`, negative, 1000 | 300 |
| `pv_kw` | 500000 | `solar_w`, scale 1000, max 60000 | rejected, kept in `channel_reject` |
| `firmware_temp` | 41 | none | reported as unmapped, not stored |

---

## 4. Reading data out

The builder and the planner read layer take their inputs from the same bindings, so they cannot disagree about which source a slot used.

![Diagram 4: see the Mermaid source below if the image does not show](img/slot-engine-architecture-4.png)

<details>
<summary>Mermaid source of diagram 4</summary>

```mermaid
flowchart TB
  START["Build slots for a window,<br/>as known at time T"]

  subgraph ROLES["Resolve every role"]
    direction TB
    R1["bindingsFor(site, role, T)<br/>rows recorded by T and not superseded by T"]
    R2["Each row: source, valid_from, valid_to"]
    R3["No row: the role has no source<br/>(there is no vendor fallback)"]
    R1 --> R2
    R1 --> R3
  end

  subgraph READ["Read the facts of each bound source for its period"]
    direction TB
    A1["inverter_5min<br/>power and charge samples,<br/>hold = source.traits.holdS"]
    A2["inverter_daily<br/>daily totals"]
    A3["meter_energy<br/>per-device meter periods"]
    A4["gas_cv, carbon,<br/>weather_temp, ev_dispatch"]
    A5["solar_forecast<br/>sources in priority order,<br/>first with a value wins"]
  end

  MERGE["Merge by time.<br/>Rows outside a binding's period are dropped,<br/>so two vendors never count twice"]

  subgraph CALC["Slot calculation"]
    direction TB
    K1["Integrate samples into slots<br/>(forward hold per source)"]
    K2["Fit each node to the daily total<br/>(0.6 to 1.6, past days)"]
    K3["Meter beats clamp<br/>(import and export)"]
    K4["Price, standing charge,<br/>carbon, gas conversion"]
    K1 --> K2 --> K3 --> K4
  end

  LIN["Lineage per slot:<br/>import = meter or clamp,<br/>meter = actual source,<br/>solar = actual source"]
  OUT[("site_hh and site_day")]

  START --> ROLES --> READ --> MERGE --> CALC --> LIN --> OUT

  classDef built fill:#e6f4ea,stroke:#2e7d32,color:#12351a
  class START,R1,R2,R3,A1,A2,A3,A4,A5,MERGE,K1,K2,K3,K4,LIN,OUT built
```

</details>

---

## 5. Roles

A role is what the engine asks for. A source fills it. The defaults below are what a new home starts with (`binding_default`); a home can bind anything else.

![Diagram 5: see the Mermaid source below if the image does not show](img/slot-engine-architecture-5.png)

<details>
<summary>Mermaid source of diagram 5</summary>

```mermaid
flowchart LR
  subgraph ROLES["Roles"]
    direction TB
    r1["inverter_5min"]
    r2["inverter_daily"]
    r3["meter_energy"]
    r4["gas_cv"]
    r5["carbon"]
    r6["weather_temp"]
    r7["ev_dispatch"]
    r8["solar_forecast"]
    r9["heat_pump_energy"]
    r10["heat_output_energy"]
    r11["heat_telemetry"]
    r12["ev_charger_energy"]
    r13["plug_energy"]
  end

  subgraph DEF["Default source"]
    direction TB
    d1["sunsynk_5min"]
    d2["sunsynk_daily"]
    d3["octopus_meter"]
    d4["national_gas_cv"]
    d5["carbon_regional"]
    d6["open_meteo"]
    d7["octopus_kraken"]
    d8a["core_forecast (priority 0)"]
    d8b["quartz (priority 1)"]
  end

  r1 --- d1
  r2 --- d2
  r3 --- d3
  r4 --- d4
  r5 --- d5
  r6 --- d6
  r7 --- d7
  r8 --- d8a
  r8 --- d8b
  r9 --- NODEF["No default source bound per home"]
  r10 --- NODEF
  r11 --- NODEF
  r12 --- NODEF
  r13 --- NODEF

  NEW["Any new source:<br/>a source row, channel rows, a binding"]
  NEW -.->|"replaces or adds, from a date"| ROLES
```

</details>

| Role | What the builder uses it for | Stored as |
|---|---|---|
| `inverter_5min` | Solar, load, grid, battery power and charge level, integrated into slots | `reading`, site subject |
| `inverter_daily` | The inverter's daily totals, used to fit the integrated slots | `interval_fact`, site subject |
| `meter_energy` | The supplier meter's import, export and gas per period (official figure) | `interval_fact`, device subject |
| `gas_cv` | Gas calorific value, to convert m3 to kWh | `interval_fact`, region subject |
| `carbon` | Grid carbon intensity per period | `interval_fact`, region subject |
| `weather_temp` | Outdoor temperature | `reading`, site subject |
| `ev_dispatch` | Smart-charge dispatch periods (the daily allowance) | `interval_fact`, site subject |
| `solar_forecast` | The forecast of record per slot, our own first, then Quartz | `forecast_fact`, site subject |
| `heat_pump_energy` | Electricity into a heat pump (read by the heating build) | `reading` or counter, device subject |
| `heat_output_energy` | Heat delivered by a heat pump or boiler (read by the heating build) | counter or `interval_fact`, device subject |
| `heat_telemetry` | Heating temperatures and on or off states (read by the heating build) | `reading`, site or device subject |
| `ev_charger_energy` | Energy delivered to an EV by a charger (defined, no consumer yet) | counter or `interval_fact`, device subject |
| `plug_energy` | A smart plug's energy, per device (defined, no consumer yet) | counter, device subject |

The five heating and IoT roles have no default source: a home binds one when it has the device. Roles are read from one list (`ROLES` in `src/core/inputs.js`), so the Providers screen shows new ones automatically.
---

## 6. Provider lifecycle

Everything below is a row change, done while the system runs. Slots before a change never move.

![Diagram 6: see the Mermaid source below if the image does not show](img/slot-engine-architecture-6.png)

<details>
<summary>Mermaid source of diagram 6</summary>

```mermaid
stateDiagram-v2
  [*] --> Unknown: vendor exists in the world

  Unknown --> Declared: add a source row<br/>(code, contract, traits)
  Declared --> Mapped: add channel rows<br/>(point to metric, scale, sign, range)
  Mapped --> Flowing: processor writes facts<br/>through ingestObservations
  Flowing --> Bound: bind(site, role, source, from)<br/>needs a reason if built slots change

  Bound --> Bound: add a forecast source beside<br/>the others (keep, by priority)
  Bound --> Unbound: unbind(site, role, at)<br/>role has no source from the date
  Bound --> Replaced: bind a different source<br/>old binding ends at the date
  Replaced --> Bound: new source is now the one in force

  Unbound --> Bound: bind again later
  Flowing --> Flowing: a bad value is rejected,<br/>an empty answer is an error

  note right of Bound
    previewImpact(change) first:
    how many slots move, which fields,
    by how much. Nothing is kept.
  end note

  note right of Unbound
    Retiring a device ends its use only.
    Tariff agreements stay, so the home
    keeps its prices.
  end note
```

</details>

Each inverter binding is a *unit*: a source, optionally a device, for a period. Units that follow one another take turns (a vendor switch). Units that overlap in time are two devices of one kind (two inverters, two batteries) and their figures are **added**: each is integrated on its own with its own hold, the slot energies are summed, a slot is covered only as far as its least covered unit, and a day's counter total is the sum of the units' totals (unknown if one is missing). Charge level is the average of the batteries weighted by size (the device's `battery_kwh`). `solar_forecast` is the one role that has several sources at once by priority instead of adding them.

**Safety rules that go with it**

| Rule | Where it is enforced |
|---|---|
| A change that alters built slots needs a written reason, kept on the binding row | `inputs.js` (`bind`, `unbind`) |
| A processor can only write series of its own source | `facts.js` (`asWriter`) |
| A new source or metric row is found without a restart | `db.js` (lookup on a cache miss) |
| A "preview" runs the change in a savepoint and rolls it back | `impact.js` (`previewImpact`) |
| A build "as known before" a change still sees the old binding | binding `recorded_at` and `superseded_at`, `bindingsFor(..., asOf)` |

---

## 7. A vendor switch, worked through

Tested on the real home's data (`test/runtime-provider.test.js`, `test/channels.test.js`): a second inverter vendor reports in kW with one signed grid figure, is wired in as rows, and is bound from a date.

![Diagram 7: see the Mermaid source below if the image does not show](img/slot-engine-architecture-7.png)

<details>
<summary>Mermaid source of diagram 7</summary>

```mermaid
flowchart TB
  subgraph BEFORE["Before the switch date D"]
    direction LR
    b1["binding: inverter_5min<br/>sunsynk_5min, open"]
    b2["slots read sunsynk_5min"]
    b1 --> b2
  end

  subgraph STEPS["Add the vendor"]
    direction TB
    s1["Step 1 source row: acme_kw, traits holdS"]
    s2["Step 2 channel rows:<br/>pv_kw to solar_w (x1000)<br/>grid_kw to grid_import_w (positive, x1000)<br/>grid_kw to grid_export_w (negative, x1000)<br/>bat_kw to charge and discharge<br/>soc to battery_soc_pct"]
    s3["Step 3 ingest its data through the channels"]
    s4["Step 4 previewImpact(bind acme_kw from D)"]
    s5["Step 5 bind(acme_kw, from D, reason)"]
    s1 --> s2 --> s3 --> s4 --> s5
  end

  subgraph AFTER["After the switch"]
    direction LR
    a1["sunsynk_5min binding<br/>valid_to = D"]
    a2["acme_kw binding<br/>valid_from = D"]
    a3["slots before D: byte-identical<br/>slots from D: read acme_kw<br/>lineage names the source"]
    a1 --> a3
    a2 --> a3
  end

  REPLAY["A build as known before step 5<br/>still reads sunsynk_5min everywhere"]

  BEFORE --> STEPS --> AFTER
  AFTER -.-> REPLAY
```

</details>

**Result of that test:** slots from D equal the real inverter's within 1e-6 on solar, home use, import, export, battery charge and discharge, and total cost. The planner read agrees with the builder within 0.1% across the switch.

---

## 8. Crash safety

The old failure: a sync wrote corrected facts, stopped before its rebuild, and the next sync fetched the same window, found nothing changed, and never rebuilt the day.

![Diagram 8: see the Mermaid source below if the image does not show](img/slot-engine-architecture-8.png)

<details>
<summary>Mermaid source of diagram 8</summary>

```mermaid
sequenceDiagram
  autonumber
  participant S1 as Sync 1 (completes)
  participant S2 as Sync 2 (crashes)
  participant S3 as Sync 3 (next)
  participant DB as Database

  S1->>DB: write facts
  S1->>DB: rebuild, status ok, started_at = T1
  S2->>DB: write corrected facts (recorded after T1)
  Note over S2: stops before it queues a rebuild
  S3->>DB: fetch same window: no value differs, nothing new written
  S3->>DB: watermark = start of the last sync that reached its build (T1)
  S3->>DB: earliest fact recorded since T1 = the corrected slot
  S3->>DB: queue a rebuild from that slot
  Note over S3,DB: Before the fix the watermark was S3's own start,<br/>so the corrected slot was never found.
```

</details>

Also in this stage: a batch with the same timestamp twice keeps the last value (it used to break the unique key and abort the whole batch), and `requireData` turns an empty answer into an error the sync log shows.

---

## 9. Control: a command with read-back

Writing to a device uses the same channels as reading from it. A device's settings come back as `state` observations through the same ingest path, a receipt is an `ack` that is never stored as a fact, and a command counts as done only when the **device** reports the desired state. Full detail: `docs/control-readback.md`.

![Diagram 9: see the Mermaid source below if the image does not show](img/slot-engine-architecture-9.png)

<details>
<summary>Mermaid source of diagram 9</summary>

```mermaid
sequenceDiagram
  autonumber
  participant P as Planner or a person
  participant Q as enqueueIfChanged
  participant X as Executor cycle
  participant D as Device driver
  participant CH as Channels and state facts
  participant T as Telemetry

  P->>Q: desired state, validity, plan run, actor
  Q->>Q: a person needs a control right on the home
  Q->>Q: gates: capability source, stale inputs, device limit, action range
  alt refused
    Q-->>P: forbidden, or blocked with reasons kept in command_block
  else accepted
    Q->>Q: same as the last confirmed state: write nothing
    Q->>Q: otherwise a pending command, replacing any open one
  end

  loop each cycle
    X->>X: expire commands past valid_until
    X->>D: read the device
    D-->>X: state observations and receipts
    X->>CH: ingest state through the device's channels
    alt device already runs the desired state
      X->>X: skipped_unchanged, nothing sent
    else pending
      X->>D: send, never after valid_until
      X->>X: sent
    else sent and read-back matches
      X->>X: acked
    else sent and no match after the settle time
      X->>X: retry, then failed
    end
  end

  X->>T: once the check period has ended
  T-->>X: effect metric over the period
  X->>X: verified or not_verified, with the evidence
  Note over X,D: A device that applies it after expiry:<br/>applied_late is recorded, status stays expired
```

</details>

| Gate or rule | What it stops | Kept where |
|---|---|---|
| Control right | A viewer, a stranger or a revoked user commanding a home | error `forbidden`, nothing written |
| Placeholder capability | A command for an action whose support was only stated, not confirmed | `command_block` |
| Stale inputs | A non-demand action planned on stale data | `command_block` |
| Device limit | A value outside the installer's limit for that device | `command_block` |
| Action range | A value outside the action's own parameter range | `command_block` |
| Read-back decides | Marking a command done on the database's belief | `acked` only when the device reports it |

---

## 10. Groups and access

A group is a dated set of homes. Its views are built from the homes' slot rows, never from daily totals, and who may see or command a home is a grant, not a tenant. Full detail: `docs/groups-and-access.md`.

![Diagram 10: see the Mermaid source below if the image does not show](img/slot-engine-architecture-10.png)

<details>
<summary>Mermaid source of diagram 10</summary>

```mermaid
flowchart TB
  U["app_user"]
  SG["site_grant: role, scope, period, revoked_at"]
  G["site_group: one time zone"]
  M["site_group_member: dated, recorded"]
  HH[("site_hh slot rows, with currency")]
  CC[("column_class: how each column is added")]

  V["Group view for a viewer"]
  R1["Step 1 keep members dated in force at the time asked"]
  R2["Step 2 keep homes the viewer holds a grant on, for the periods granted"]
  R3["Step 3 bucket slots by slot start in the group zone"]
  R4["Step 4 add by column class: money per currency, energy sums, prices weighted, ratios recomputed"]
  R5["Step 5 a missing slot gives null, never 0"]
  R6["Step 6 final only when every member slot is final"]
  OUT["Totals per currency, ratios, state: final, provisional or incomplete"]

  U --> SG
  G --> M
  SG --> V
  M --> V
  HH --> V
  CC --> V
  V --> R1 --> R2 --> R3 --> R4 --> R5 --> R6 --> OUT
```

</details>

| Question | Answer in this design |
|---|---|
| A group has GBP and EUR homes | Two money totals; no exchange rate exists |
| A home leaves on day X | Counted before X and not after; an earlier report re-runs identically |
| A member the viewer has no grant on | Left out completely: no count, no gap marker |
| One member slot is missing | The column is null with a `partial` figure; never 0 |
| Homes with different slot lengths | Default bucket is the longest slot; a shorter bucket is refused, not split |
| A viewer with scope energy | Reads energy and cost; cannot command |

---

## 11. What is built and what is not

![Diagram 11: see the Mermaid source below if the image does not show](img/slot-engine-architecture-11.png)

<details>
<summary>Mermaid source of diagram 11</summary>

```mermaid
flowchart TB
  subgraph DONE["Built and tested"]
    direction TB
    d1["Frozen real-home test fixture"]
    d2["Bindings for eight roles, unbind, reasons, impact preview"]
    d3["Channels: scale, shift, sign part, range, reject log, device channels"]
    d4["Source traits: hold time, live, forecast-only, named-only"]
    d5["Writer guard, runtime registry reload"]
    d6["Crash-safe rebuild watermark, repeated timestamps, empty answers"]
    d8["Control read-back: state and ack kinds, gates, limits,<br/>executor and scheduler, late ack, effect check,<br/>command in slot lineage"]
    d10["Counter and event kinds, wider ingest checks,<br/>IoT roles and device-kind channel defaults"]
    d13["Push endpoint for devices and gateways, vendor formats,<br/>push log, emulator, replay of stored receipts,<br/>source health and retention"]
    d12["Devices page and a labelled synthetic IoT demo home:<br/>counters, events, simulate a period, test a command"]
    d11["Providers API and screen: roles timeline,<br/>channels, rejects, impact preview, add or remove flow"]
    d9["Groups with dated membership, currency on slots,<br/>column classes, users and grants"]
    d7["Sunsynk, Octopus (meter, dispatches, planned),<br/>carbon, National Gas, Open-Meteo, Quartz on channels<br/>(subjects: home, device, region;<br/>instants, periods, forecast issues)"]
  end

  subgraph PART["Partly"]
    direction TB
    p1["One resampler: build and planner agree within 0.1%,<br/>but they are still two integrators"]
    p2["Tariff rates, Tariffscanner, tounify:<br/>a tariff catalogue, not slot inputs,<br/>so channels do not apply"]
  end

  subgraph TODO["Not started"]
    direction TB
    t1["Rules as data (meter beats clamp,<br/>daily fit range): stay code until a second vendor needs another rule"]
    t2["A real vendor control driver<br/>(needs a vendor, its API and a test device)"]
    t3["Sign-in, database-level row security,<br/>group views timed at scale"]
    t4["Health-based finality, dead-letter replay"]
    t5["A real IoT device tried against the push endpoint,<br/>MQTT client, per-device keys"]
  end

  classDef built fill:#e6f4ea,stroke:#2e7d32,color:#12351a
  classDef part fill:#fff7e0,stroke:#b58900,color:#4a3a00
  classDef todo fill:#f3f3f3,stroke:#9e9e9e,color:#555,stroke-dasharray: 4 3
  class d1,d2,d3,d4,d5,d6,d7,d8,d9,d10,d11,d12,d13 built
  class p1,p2 part
  class t1,t2,t3,t4,t5 todo
```

</details>

### Where each piece lives

| Piece | File |
|---|---|
| Roles, bindings, `bind`, `unbind`, hold lookup | `src/core/inputs.js` |
| Impact preview | `src/core/impact.js` |
| Channels, `ingestObservations`, `setDeviceChannel` | `src/core/channels.js` |
| Writer guard, fact writers, rebuild queue | `src/core/facts.js` |
| Slot builder | `src/core/build.js` |
| Planner read layer | `src/core/planner-read.js` |
| Sync watermark | `src/jobs/sync.js` (`sinceWatermark`) |
| Source definitions, default channels, traits | `src/db/registry.js` |
| Default bindings seed | `src/db/seed/bindings.js` |
| Schema | `src/db/deltas/061` to `066` |
| Processor template | `src/adapters/_template.js` |
| Control (stage 4) | `src/core/executor.js`, `src/core/control.js`, `src/core/commands.js`, `src/db/deltas/067-control.sql`; see `docs/control-readback.md` |
| Counters, events and IoT roles | `src/core/counters.js`, `src/core/channels.js`, `src/core/heat.js`, `src/db/deltas/072-channel-kinds.sql`; see `docs/counters-events-roles.md` |
| Providers API and screen | `src/core/onboarding.js`, routes in `src/server.js`, `public/providers.html`, `public/js/pages/providers.js`; see `docs/onboarding-api.md` |
| Push ingest | `src/core/push-ingest.js`, `src/core/push-formats.js`, `src/db/deltas/073-push-log.sql`, `scripts/push-emulator.mjs`; see `docs/push-ingest.md` |
| Source health, replay, retention | `src/core/health.js`, `src/core/replay.js`, `src/db/deltas/075-replay-log.sql`; see `docs/provider-health-replay.md` |
| Devices page and synthetic IoT demo | `src/core/devices-view.js`, `src/core/synthetic-iot.js`, `public/devices.html`, `public/js/pages/devices.js`, `npm run demo:iot`; see `docs/devices-page.md` |
| Groups and access (stage 5) | `src/core/groups.js`, `src/core/access.js`, `src/db/deltas/070-groups.sql`; see `docs/groups-and-access.md` |
| Tests | `test/runtime-provider.test.js`, `test/channels.test.js`, `test/ingest-durability.test.js`, `test/sunsynk-channels.test.js`, `test/octopus-channels.test.js`, `test/channels-subjects.test.js`, `test/multi-device.test.js` |

### Reading these diagrams

Mermaid renders in GitHub, GitLab, VS Code (Markdown preview with the Mermaid extension) and most documentation tools. If a diagram shows as plain text, open the file in one of those.
