# Predbat and PredHeat: data requirements catalogue

26 October 2026. Research only: nothing in `src/`, the schema or `data/` was opened or changed; this file is the only file written in the repo.

**Purpose.** One traceable list of every piece of data Predbat and PredHeat read, keep, produce or write, so the EnergieBee schema can be checked item by item. Each row is one thing that needs a home (a column, a row type, a key in a key/value table, or a file). The **PD** column says where the planning design (the three planning documents, see 1.2) would put it; `—` means the planning design has no home for it.

---

## 1. Method and sources

### 1.1 How it was done

1. **Docs.** The Predbat documentation site (springfall2008.github.io/batpred) is built by mkdocs from the `docs/` folder of the GitHub repo `springfall2008/batpred`. I downloaded the raw Markdown of 26 docs pages from the `main` branch at commit `ef1432b` (committed 25 Oct 2026 19:40 UTC) and read the sections that define data. I opened one rendered page on the live site (Predheat) to confirm it matches the Markdown.
2. **Code, mechanically.** From `apps/predbat/config.py` I parsed, with Python `ast`, the full `CONFIG_ITEMS` list (every Home Assistant switch, input_number and select Predbat creates, with default, range and unit), `APPS_SCHEMA` (every validated `apps.yaml` key), `INVERTER_DEF` (25 built-in inverter profiles) and `CONFIG_API_OVERRIDE`. I also grepped every `get_arg("…")` call in 12 core source files (292 distinct keys) and every entity name the code publishes, to catch keys the docs do not mention.
3. **Code, read.** All of `predheat.py` (733 lines) was read line by line. Targeted reads of `const.py`, `utils.py` (export-limit encoding), `plan.py` (charge/freeze encoding), `output.py` (plan JSON fields), `inverter.py` (control methods), `solcast.py` and `octopus.py` (field names).
4. **PredHeat history.** The archived standalone repo `springfall2008/predheat` (archived; last push 12 Oct 2024) was checked only to flag keys that no longer apply.
5. **Planning documents** (local extracts `1.txt`, `2.txt`, `3.txt`; called PD1, PD2, PD3) were read in full and used as a second source. Their claims were re-checked against current Predbat code where possible (see 1.4).
6. **Status column.** `verified` = I read the item in a fetched source named in the **Src** column (doc text, code, or both). `unverified` = not found in any fetched source (from memory, or only in the planning documents).
7. **Changes column.** Where a source states a cadence it is given plainly (for example "8 h"). Otherwise it is my classification and starts with `~`. Vocabulary: `install` (set once), `~rare` (user tweak), `5m` (every Predbat cycle; `RUN_EVERY = 5` in `const.py`), `plan` (every plan calculation, default 10 min via `calculate_plan_every`), `event` (when something happens), `daily`.
8. **Dir column.** `CFG` input configuration, `LIVE` live input read each cycle, `HIST` history input (past values are needed, not just the latest), `OUT` output, `CTRL` value written to a device (and usually read back), `STATE` internal state Predbat keeps between cycles.

### 1.2 Sources (all fetched 26 Oct 2026)

Docs pages: rendered at `https://springfall2008.github.io/batpred/<page>/`, Markdown at `https://raw.githubusercontent.com/springfall2008/batpred/main/docs/<page>.md`.

| Code | Source | URL |
| --- | --- | --- |
| WD | What does Predbat do? | <https://springfall2008.github.io/batpred/what-does-predbat-do/> |
| AY | apps.yaml settings | <https://springfall2008.github.io/batpred/apps-yaml/> |
| CU | Customisation (HA entities) | <https://springfall2008.github.io/batpred/customisation/> |
| ER | Energy rates | <https://springfall2008.github.io/batpred/energy-rates/> |
| CC | Car charging | <https://springfall2008.github.io/batpred/car-charging/> |
| OD | Output data (predbat.* entities) | <https://springfall2008.github.io/batpred/output-data/> |
| IS | Inverter setup (supported list, control options) | <https://springfall2008.github.io/batpred/inverter-setup/> |
| CO | Components | <https://springfall2008.github.io/batpred/components/> |
| LM | ML load prediction | <https://springfall2008.github.io/batpred/load-ml/> |
| MA | Manual API | <https://springfall2008.github.io/batpred/manual-api/> |
| CMP | Compare tariffs | <https://springfall2008.github.io/batpred/compare/> |
| PC | Predbat plan card (plan columns) | <https://springfall2008.github.io/batpred/predbat-plan-card/> |
| WI | Web interface (views, metrics) | <https://springfall2008.github.io/batpred/web-interface/> |
| DV | Devices | <https://springfall2008.github.io/batpred/devices/> |
| PH | Predheat docs (rendered page also opened) | <https://springfall2008.github.io/batpred/predheat/> |
| CFG | `config.py` (CONFIG_ITEMS, APPS_SCHEMA, INVERTER_DEF) | <https://github.com/springfall2008/batpred/blob/main/apps/predbat/config.py> |
| APY | `config/apps.yaml` template | <https://github.com/springfall2008/batpred/blob/main/apps/predbat/config/apps.yaml> |
| CONST | `const.py` | <https://github.com/springfall2008/batpred/blob/main/apps/predbat/const.py> |
| UT | `utils.py` | <https://github.com/springfall2008/batpred/blob/main/apps/predbat/utils.py> |
| PL | `plan.py` | <https://github.com/springfall2008/batpred/blob/main/apps/predbat/plan.py> |
| OUT | `output.py` | <https://github.com/springfall2008/batpred/blob/main/apps/predbat/output.py> |
| INV | `inverter.py` | <https://github.com/springfall2008/batpred/blob/main/apps/predbat/inverter.py> |
| PB | `predbat.py` | <https://github.com/springfall2008/batpred/blob/main/apps/predbat/predbat.py> |
| SC | `solcast.py` | <https://github.com/springfall2008/batpred/blob/main/apps/predbat/solcast.py> |
| OC | `octopus.py` | <https://github.com/springfall2008/batpred/blob/main/apps/predbat/octopus.py> |
| PHPY | `predheat.py` | <https://github.com/springfall2008/batpred/blob/main/apps/predbat/predheat.py> |
| PHT | `templates/predheat.yaml` | <https://github.com/springfall2008/batpred/blob/main/templates/predheat.yaml> |
| PHA | Archived standalone PredHeat repo | <https://github.com/springfall2008/predheat> |
| PD1–3 | Planning documents (local text extracts) | `scratchpad/d/1.txt`, `2.txt`, `3.txt` |

### 1.3 Pages not opened, and what that means

- **Rendered site pages**: only the Predheat page was opened in rendered form. All other docs content comes from the same Markdown the site is built from, so content is the same; anchors in Src refer to section headings.
- **Not read at all**: `install.md`, `annual-prediction.md` (What-If tool, out of scope), `discovery-catalogue.md`, `hub-live-display.md`, `developing.md`, `plugins.md`, `rest_api.md`, `random-scenarios.md`, `video-guides.md`, `faq.md` (headings only), the `docs/superpowers/` design notes, the images (for example the `load_forecast` attribute screenshot) and the YouTube videos.
- **Partly read**: the per-vendor sections of `inverter-setup.md` and `components.md`, and the 30 per-vendor `templates/*.yaml` files. Vendor entity names are therefore **not** catalogued; vendor keys are listed from `APPS_SCHEMA` only.
- **GitHub PRs and issues** cited by the planning documents (#4491 slot pruning, #4616 freeze export, #4481 release mode, #5494 dispatch slots, AlphaESS write-limit report) were **not opened**. Where those claims matter they were checked against current code instead (see 1.4).
- **Third-party docs** (Octopus Energy HA integration, Solcast HA integration, Met Office / OpenWeatherMap) were **not opened**; field names come from Predbat's own code (`octopus.py`, `solcast.py`, `predheat.py`).
- **Items from memory**: none are used as `verified`. The `unverified` rows are the few places where I state where data comes from without seeing it, plus Appendix A (planning-design fields with no Predbat source).

### 1.4 Discrepancies found (docs vs code vs planning documents)

1. **PredHeat COP key**: docs say `heating_cop`; code and template read `heat_cop` (PHPY line 606, PHT). Use `heat_cop`.
2. **PredHeat defaults differ** between code and template: `mode` defaults to `pump` in code, `gas` in template; `flow_difference_target` defaults to 20 (gas) or 5 (pump) in code, 40 in the template and docs example.
3. **PredHeat `volume_temp`** is read without the `predheat` domain (PHPY line 610), i.e. from the top level of `apps.yaml`, although the docs describe it as a Predheat setting.
4. **Export instruction encoding changed.** Current Predbat stores an export window as a 3-tuple (mode = target / freeze / idle, target SoC %, power fraction). The old single number (99 = freeze, 100 = off, fractional part = reduced power) is still decoded for old dumps (UT "Export limit encoding"; CONST `EXPORT_LIMIT_FREEZE = 99.0`, `EXPORT_LIMIT_IDLE = 100.0`). PD2/PD3's `export_limit_pct` with 100 = no export is the legacy form and has no freeze or power field.
5. **Freeze charge** is encoded in the optimiser as a charge limit equal to the reserve (PL line 1409), not "target = current SoC" as PD2 says (PD2 describes the inverter effect, which matches CU).
6. **Default Predbat mode**: `CONFIG_ITEMS` default is "Control charge & discharge"; WD says a new install starts in Monitor.
7. **`charge_low_power_margin`** range is 0–60 min in code, 0–30 in CU.

---

## 2. Predbat catalogue

### PB-INV: inverter and battery (configuration, live sensors, derived outputs)

| ID | Item | Type / unit | Dir | Origin in Predbat | Changes | Src | Status | PD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-INV-01 | Number of inverters | int ≥ 1 | CFG | `num_inverters` | install | AY §num_inverters; CFG | verified | count of `inverter` rows |
| PB-INV-02 | Inverter type, per inverter | enum: 25 built-in codes (GE, GEC, GEE, GS, GS_fb00, SE, SX4, SF, SFMB, HU, SK, SA, SIG, FoxESS, FoxCloud, TESLA, EnphaseCloud, DeyeCloud, HanchuCloud, SunsynkCloud, AlphaESSCloud, SolaxCloud, SolisCloud, SIGCLOUD, GWMQTT) or a custom code | CFG | `inverter_type` (list) | install | AY §inverter_type; CFG INVERTER_DEF | verified | inverter.vendor |
| PB-INV-03 | Custom inverter capability block | dict of flags (PB-CAP table) | CFG | `inverter:` block | install | IS §I want to add an unsupported inverter | verified | inverter.supports_freeze / supports_export only |
| PB-INV-04 | Inverter or system serial | string, per inverter | CFG | `geserial`, `ge_cloud_serial`, `<vendor>_inverter_sn`, `teslemetry_site_id`, `enphase_site_id`, `sigenergy_system_id` | install | AY §geserial; CFG | verified | inverter.serial |
| PB-INV-05 | AC inverter limit | W, per inverter (sensor or literal; literal is always W) | CFG | `inverter_limit` | install | AY §inverter_limit | verified | inverter.ac_limit_w |
| PB-INV-06 | PV AC output limit (AC-coupled PV only) | W | CFG | `pv_ac_limit` | install | AY §pv_ac_limit | verified | — |
| PB-INV-07 | Grid export limit (G98/G99 approval) | W, per inverter; GE Cloud reads site limit | CFG | `export_limit`; `sensor.predbat_gecloud_<serial>_export_limit` | install; GE site re-read 12 h | AY §export_limit; CO §Site export limits | verified | site.export_limit_w |
| PB-INV-08 | Charge rate cap | W, per inverter | CFG | `inverter_limit_charge` | ~rare | AY §inverter_limit_charge | verified | inverter.charge_limit_w |
| PB-INV-09 | Discharge rate cap | W, per inverter | CFG | `inverter_limit_discharge` | ~rare | AY | verified | inverter.discharge_limit_w |
| PB-INV-10 | Force-export rate cap | W, per inverter (defaults to discharge cap) | CFG | `inverter_limit_export` | ~rare | AY §inverter_limit_export | verified | inverter.export_rate_limit_w |
| PB-INV-11 | DC solar charge ceiling (hybrid) | W, per inverter | CFG | `inverter_limit_charge_dc` | install | AY §inverter_limit_charge_dc | verified | — |
| PB-INV-12 | Runtime rate cap override | W, 0 = none (0–50000) | CFG | `input_number.predbat_inverter_limit_override` | ~rare | CU §Inverter control options; CFG | verified | site_setting |
| PB-INV-13 | Battery max charge/discharge rate | W (2600 if unknown) | CFG/LIVE | `battery_rate_max` | install | AY §Battery Information | verified | battery.rate_max_w |
| PB-INV-14 | Leak rate when set to zero | W, per inverter | CFG | `inverter_battery_rate_min` | install | AY §Inverter rate minimum | verified | — |
| PB-INV-15 | Highest reserve the inverter accepts | % (template 98; AY gives default as 100 in one section and 98 in another) | CFG | `inverter_reserve_max` | install | AY §Inverter reserve maximum | verified | — |
| PB-INV-16 | Lowest target SoC the inverter accepts | % | CFG | `battery_min_soc` | install | AY §Battery Information | verified | — |
| PB-INV-17 | Battery can charge from PV during export | bool (true) | CFG | `inverter_can_charge_during_export` | install | AY | verified | — |
| PB-INV-18 | Battery leak during freeze export | W (0 = off) | CFG | `inverter_freeze_export_discharge_rate` | install | AY | verified | — |
| PB-INV-19 | Hybrid or AC-coupled | bool (on = hybrid) | CFG | `switch.predbat_inverter_hybrid` | install | CU §Battery loss options; CFG | verified | inverter.is_hybrid |
| PB-INV-20 | Nominal battery voltage (W↔A conversion) | V | CFG | `battery_voltage`; `<vendor>_battery_nominal_voltage`, `solis_nominal_voltage` | install | AY; IS §output_charge_control; CFG | verified | — |
| PB-INV-21 | Usable battery capacity | kWh, per inverter (0 = auto-detect from history) | CFG/LIVE | `soc_max` | install; daily if auto | AY §Battery Information | verified | battery.soc_max_kwh |
| PB-INV-22 | Use nominal capacity field | bool (off) | CFG | `switch.predbat_battery_capacity_nominal` (`soc_max_nominal`) | ~rare | CU §Scaling and weight options; INV | verified | — |
| PB-INV-23 | Battery size scaling | factor per inverter (1.0) | CFG | `battery_scaling` | ~rare | AY §Battery size scaling | verified | — |
| PB-INV-24 | Auto battery scaling and measured capacity | bool; kWh, 7-day trimmed mean, clamp 0.8–1.0 | CFG/OUT | `battery_scaling_auto`; `sensor.predbat_soc_max_calculated[_N]` | once a day | AY §Battery size scaling; OD §Battery data | verified | — |
| PB-INV-25 | Depth of discharge and state of health (GivTCP REST) | factor; ratio | CFG/OUT | `givtcp_battery_dod`; published `battery_soh`, `battery_dod_soh` | ~rare | AY §Battery Information | verified | — |
| PB-INV-26 | Battery charge loss | fraction (0.03) | CFG | `input_number.predbat_battery_loss` | ~rare | CU §Battery loss options; CFG | verified | battery.loss_charge |
| PB-INV-27 | Battery discharge loss | fraction (0.03) | CFG | `input_number.predbat_battery_loss_discharge` | ~rare | CU; CFG | verified | battery.loss_discharge |
| PB-INV-28 | Inverter conversion loss | fraction (0.04) | CFG | `input_number.predbat_inverter_loss` | ~rare | CU; CFG | verified | — |
| PB-INV-29 | Charge rate scaling | factor (1.0, 0–2) | CFG | `input_number.predbat_battery_rate_max_scaling` | ~rare | CU §Scaling; CFG | verified | — |
| PB-INV-30 | Discharge rate scaling | factor (1.05, 0–2) | CFG | `input_number.predbat_battery_rate_max_scaling_discharge` | ~rare | CU; CFG | verified | — |
| PB-INV-31 | PV10 charge-rate scaling | factor (0.8, 0.1–1) | CFG | `input_number.predbat_charge_scaling10` | ~rare | CU; CFG | verified | — |
| PB-INV-32 | Charge power curve | map SoC % → rate factor, or `auto` | CFG | `battery_charge_power_curve` | install; auto at start-up | AY §Battery charge/discharge curves | verified | battery.charge_curve |
| PB-INV-33 | Discharge power curve | map SoC % → factor, or `auto` | CFG | `battery_discharge_power_curve` | install | AY | verified | — |
| PB-INV-34 | Fallback charge curve | map | CFG | `battery_charge_power_curve_default` | install | AY | verified | — |
| PB-INV-35 | Fallback discharge curve | map | CFG | `battery_discharge_power_curve_default` | install | AY | verified | — |
| PB-INV-36 | Temperature charge curve | map °C (0–20) → C-rate | CFG | `battery_temperature_charge_curve` | install | AY §Battery temperature curves | verified | — |
| PB-INV-37 | Temperature discharge curve | map °C → C-rate | CFG | `battery_temperature_discharge_curve` | install | AY | verified | — |
| PB-INV-38 | Reserve minimum, per inverter (up to 4) | % (4, 0–100) | CFG | `input_number.predbat_set_reserve_min`, `_1`, `_2`, `_3` | ~rare | CU §Inverter control options; CFG | verified | battery.reserve_pct |
| PB-INV-39 | Inverter clock skew offsets | minutes × 4 | CFG | `inverter_clock_skew_start`, `_end`, `_discharge_start`, `_discharge_end` | ~rare | AY §Clock skew | verified | — |
| PB-INV-40 | Host clock skew | minutes | CFG | `clock_skew` | ~rare | AY §Clock skew | verified | — |
| PB-INV-41 | Import/export data scaling | factor (1.0) | CFG | `import_export_scaling` | ~rare | AY §Import export scaling | verified | — |
| PB-INV-42 | Sign conventions | bool per inverter | CFG | `battery_power_invert`, `grid_power_invert`, `load_power_invert` | install | AY §Power Data; source get_arg | verified | — |
| PB-INV-43 | Use HA sensors instead of REST power | bool per inverter | CFG | `givtcp_rest_power_ignore` | install | AY §REST Interface | verified | — |
| PB-INV-44 | CT clamp topology (multi-inverter) | bool flags | CFG | `ge_cloud_automatic_shared_ct`, `_split_ct`, `_split_pv`; `gateway_shared_ct` | install | CO §gecloud; CFG | verified | — |
| PB-INV-45 | Connection endpoints | URL / host / port / topic | CFG | `givtcp_rest`, `<vendor>_base_url`, `sigenergy_mqtt_host`, `gateway_mqtt_host`, `gateway_mqtt_port`, `gateway_device_id`, `mqtt_topic`, `device_id` | install | AY §REST, §MQTT API; CFG | verified | — |
| PB-INV-46 | Vendor credentials and token state | secret strings; token expiry time and hash | CFG/STATE | `ge_cloud_key`, `fox_key`, `solis_api_key/secret`, `deye_*`, `sunsynk_*`, `alphaess_app_id/secret`, `teslemetry_key`, `enphase_*`, `sigenergy_*` (incl. PEM files), `hanchu_*`, `gateway_mqtt_token`, `*_auth_method`, `*_token_expires_at`, `*_token_hash` | ~rare (refresh) | AY §Storing secrets; CFG | verified | credential |
| PB-INV-47 | Vendor integration switches | bool | CFG | `<vendor>_automatic`, `_automatic_ignore_pv`, `_control_enable`, `ge_cloud_direct`, `ge_cloud_inverter_control`, `givtcp_automatic`, `sigenergy_enable_controls`, `hanchu_work_mode_control`, `teslemetry_tbc_control`, `teslemetry_hybrid`, `solis_cloud_pv_load_ignore`, `gateway_integrate_power` | install | CFG; CO; AY | verified | — |
| PB-INV-48 | Vendor rate and limit overrides | W | CFG | `alphaess_battery_rate_max`, `hanchu_battery_rate_max`, `hanchu_inverter_limit` | install | AY §AlphaESS; CFG | verified | — |
| PB-INV-49 | Battery SoC (energy) | kWh | LIVE/HIST | `soc_kw` | 5m | AY §Battery SoC | verified | telemetry.soc_kwh |
| PB-INV-50 | Battery SoC (percent) | % | LIVE/HIST | `soc_percent` | 5m | AY §Battery SoC | verified | — |
| PB-INV-51 | Battery power | W or kW; + discharge, − charge | LIVE/HIST | `battery_power` | 5m | AY §Power Data | verified | telemetry.battery_w |
| PB-INV-52 | PV power | W or kW | LIVE | `pv_power` | 5m | AY §Power Data | verified | telemetry.pv_w |
| PB-INV-53 | Load power (+ extra phases) | W or kW; `load_power_1..N` when `num_load_entities` > 1 | LIVE/HIST | `load_power` | 5m | AY §Power Data; IS §num_load_entities | verified | telemetry.load_w |
| PB-INV-54 | Grid power | W or kW; − import, + export | LIVE | `grid_power` | 5m | AY §Power Data | verified | telemetry.grid_w |
| PB-INV-55 | Battery temperature | °C (20 if not set) | LIVE | `battery_temperature` | 5m | AY §Battery Information | verified | — |
| PB-INV-56 | Battery temperature history | °C series | HIST | `battery_temperature_history` | 5m | AY §Battery temperature curves | verified | — |
| PB-INV-57 | Battery calibration in progress | on/off | LIVE | `battery_calibration` | event | AY §Battery Information; WD §Predbat status | verified | — |
| PB-INV-58 | Inverter clock | timestamp | LIVE | `inverter_time` | 5m | AY §Inverter Info, §Clock skew | verified | — |
| PB-INV-59 | Inverter work mode | enum string | LIVE/CTRL | `inverter_mode` | 5m | AY §Inverter Info | verified | — |
| PB-INV-60 | Reserve setting | % (entity or fixed value) | LIVE/CTRL | `reserve` | 5m | AY §Battery Information | verified | — |
| PB-INV-61 | Charge rate setting | W, or % (`charge_rate_percent`), or A (`timed_charge_current`) | LIVE/CTRL | `charge_rate` | 5m | AY §Charge/Discharge rate | verified | — |
| PB-INV-62 | Discharge rate setting | W, %, or A | LIVE/CTRL | `discharge_rate`, `discharge_rate_percent`, `timed_discharge_current` | 5m | AY §Charge/Discharge rate | verified | — |
| PB-INV-63 | Target SoC (charge limit) and its enable | %; bool | LIVE/CTRL | `charge_limit`, `charge_limit_enable` | 5m | AY §Schedule | verified | — |
| PB-INV-64 | Charge window | start/end as HH:MM[:SS], or hour+minute entities, or "H:M-H:M" | LIVE/CTRL | `charge_start_time`, `charge_end_time` (or `charge_start_hour/minute`, `charge_end_hour/minute`, `charge_time`) | 5m | AY §Schedule; IS §charge_time_format | verified | — |
| PB-INV-65 | Charge schedule enable | bool | LIVE/CTRL | `scheduled_charge_enable` | 5m | AY §Schedule | verified | — |
| PB-INV-66 | Discharge (export) window | start/end, same formats | LIVE/CTRL | `discharge_start_time`, `discharge_end_time` (or hour/minute, `discharge_time`) | 5m | AY §Schedule | verified | — |
| PB-INV-67 | Discharge schedule enable | bool | LIVE/CTRL | `scheduled_discharge_enable` | 5m | AY §Schedule | verified | — |
| PB-INV-68 | Export target SoC | % | LIVE/CTRL | `discharge_target_soc` | 5m | AY §Schedule | verified | — |
| PB-INV-69 | Pause mode and window | enum; start/end | LIVE/CTRL | `pause_mode`, `pause_start_time`, `pause_end_time` | 5m | AY §Schedule; IS §has_timed_pause | verified | — |
| PB-INV-70 | Idle (Eco) window, GE EMS | start/end | LIVE/CTRL | `idle_start_time`, `idle_end_time` | 5m | AY §Schedule; IS §has_idle_time | verified | — |
| PB-INV-71 | Per-inverter "cannot span midnight" | bool attribute | LIVE | `can_span_midnight` attribute on the `charge_start_time` entity | install | IS §can_span_midnight | verified | — |
| PB-INV-72 | History used to learn curves and capacity | series of status, charge/discharge rate, battery power, SoC | HIST | HA history of `predbat.status`, `charge_rate`, `discharge_rate`, `battery_power`, `soc_percent` or `soc_kw` | at start-up / daily | AY §Battery charge/discharge curves, §soc_max | verified | telemetry |
| PB-INV-73 | Effective inverter configuration | kW / kWh totals and flags: `inverter_limit`, `export_limit`, `pv_ac_limit`, `battery_rate_max_charge`, `battery_rate_max_charge_dc`, `battery_rate_max_discharge`, `battery_rate_max_export`, `battery_rate_min`, `soc_max`, `reserve`, `num_inverters`, `num_cars`, `inverter_can_charge_during_export`, `inverter_support_feedin_first`, `metric_standing_charge`, `forecast_minutes`, `plan_interval_minutes` | OUT | `sensor.predbat_inverter_config` attributes | plan | OD §Inverter data | verified | — |
| PB-INV-74 | Live power totals | W | OUT | `predbat.battery_power`, `predbat.pv_power`, `predbat.load_power`, `predbat.grid_power` | 5m | OD §Sensor data | verified | — |
| PB-INV-75 | Scaled SoC now | kWh | OUT | `predbat.soc_kw_h0` | 5m | OD §'Today' energy data | verified | — |

#### PB-CAP: inverter capability profile (one set per inverter type; built-in in INVERTER_DEF, or user `inverter:` block)

All `CFG`, change `install`, Src CFG INVERTER_DEF + IS §Inverter control options (rows marked "code only" are in INVERTER_DEF but not documented). PD has only `inverter.supports_freeze` and `inverter.supports_export`.

| ID | Flag | Type | Meaning | Status |
| --- | --- | --- | --- | --- |
| PB-CAP-01 | `has_rest_api` | bool | Control and read via GivTCP REST | verified |
| PB-CAP-02 | `has_mqtt_api` | bool | Control via MQTT messages under `mqtt_topic` | verified |
| PB-CAP-03 | `has_service_api` | bool | Control via HA services (charge/discharge start/stop/freeze) | verified |
| PB-CAP-04 | `output_charge_control` | enum power / current / none | Rate written in W or A | verified |
| PB-CAP-05 | `charge_control_immediate` | bool | Control by setting current directly, not time windows | verified |
| PB-CAP-06 | `current_dp` | int 0–1 | Decimal places for amps | verified |
| PB-CAP-07 | `charge_discharge_with_rate` | bool | Other direction's rate must be 0 when charging/discharging | verified |
| PB-CAP-08 | `has_charge_enable_time` | bool | Uses `scheduled_charge_enable` | verified |
| PB-CAP-09 | `has_discharge_enable_time` | bool | Uses `scheduled_discharge_enable` | verified |
| PB-CAP-10 | `has_target_soc` | bool | Inverter stops at `charge_limit` itself | verified |
| PB-CAP-11 | `target_soc_used_for_discharge` | bool | `charge_limit` also sets discharge target | verified |
| PB-CAP-12 | `has_reserve_soc` | bool | Inverter has a reserve register | verified |
| PB-CAP-13 | `has_timed_pause` | bool | Pause mode with start/end | verified |
| PB-CAP-14 | `time_button_press` | bool | Needs a button press to commit schedule | verified |
| PB-CAP-15 | `support_charge_freeze` | bool | Can hold SoC (freeze charge) | verified |
| PB-CAP-16 | `support_discharge_freeze` | bool | Can block charging (freeze export) | verified |
| PB-CAP-17 | `support_feedin_first` | bool | Freeze export is a real feed-in-first mode (PV over export limit goes to battery) | verified |
| PB-CAP-18 | `has_ge_inverter_mode` | bool | GivEnergy Eco / Timed Export modes | verified |
| PB-CAP-19 | `has_ge_eco_toggle` | bool | Eco toggle (GE Cloud) | verified (code only) |
| PB-CAP-20 | `has_idle_time` | bool | Idle (Eco) start/end registers | verified |
| PB-CAP-21 | `has_time_window` | bool | Not currently used | verified |
| PB-CAP-22 | `has_solis_energy_control` | bool | Solis energy-control register path | verified (code only) |
| PB-CAP-23 | `charge_time_format` | enum "HH:MM:SS" / "H M" / "H:M-H:M" / "S" | How window times are written | verified |
| PB-CAP-24 | `charge_time_entity_is_option` | bool | Time entities are selects vs numbers | verified |
| PB-CAP-25 | `can_span_midnight` | bool | One window may cross midnight | verified |
| PB-CAP-26 | `clock_time_format` | strftime string | Format of `inverter_time` | verified |
| PB-CAP-27 | `num_load_entities` | int | Number of load power sensors | verified |
| PB-CAP-28 | `soc_units` | enum % / kWh | SoC units (currently unused) | verified |
| PB-CAP-29 | `write_and_poll_sleep` | seconds | Wait before reading back a write | verified |
| PB-CAP-30 | `rate_step_percent_of_capacity` | % | Rate stored in steps; read-back tolerance | verified |
| PB-CAP-31 | `write_max_retry`, `write_backoff` | int; seconds | Write retry policy | verified (code only) |

### PB-RATE: energy rates, events, dispatch

| ID | Item | Type / unit | Dir | Origin in Predbat | Changes | Src | Status | PD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-RATE-01 | Plan slot length | minutes (30; 15 for 15-min markets) | CFG | `plan_interval_minutes` | install | ER §Plan Interval | verified | site.plan_interval_min |
| PB-RATE-02 | Currency symbols | [major, minor], e.g. £, p | CFG | `currency_symbols` | install | AY §currency_symbols | verified | — |
| PB-RATE-03 | Import rates from Octopus integration | sensor + day events; attribute `rates`, `raw_today` or `prices` | LIVE | `metric_octopus_import` (`event.*_previous/current/next_day_rates`) | ~30m; next day's Agile ~16:00 | ER §Octopus Energy integration; OC line 4796–4818 | verified | tariff_rate |
| PB-RATE-04 | Export rates from Octopus integration | same | LIVE | `metric_octopus_export` | same | ER | verified | tariff_rate |
| PB-RATE-05 | Gas rates | same | LIVE | `metric_octopus_gas` | ~daily | ER | verified | — |
| PB-RATE-06 | Octopus direct account | account number; API key (secret) | CFG | `octopus_api_account`, `octopus_api_key` | install | ER §Octopus Energy direct | verified | credential |
| PB-RATE-07 | Octopus rate record | `value_inc_vat`, `valid_from`, `valid_to` | LIVE | Octopus REST API | per fetch | OC | verified | tariff_rate.rate_p_kwh |
| PB-RATE-08 | Tariff code and region | string; DNO region letter A–P | CFG/LIVE | `octopus_region`, `dno_region`, Kraken `tariff_code` | ~rare | CFG; CMP; CO §kraken | verified | — |
| PB-RATE-09 | Standing charge | £/day (sensor or value; display only, does not change the plan) | LIVE/CFG | `metric_standing_charge` | daily | ER §Standing charge; APY | verified | — |
| PB-RATE-10 | Manual import rate bands | list {start, end, rate p, day_of_week 1–7, utc} | CFG | `rates_import` | ~rare | ER §Rate Bands | verified | tariff_rate (copied per site) |
| PB-RATE-11 | Manual export rate bands | same | CFG | `rates_export` | ~rare | ER §Rate Bands | verified | tariff_rate |
| PB-RATE-12 | Manual gas rate bands | same | CFG | `rates_gas` | ~rare | ER §Rate Bands | verified | — |
| PB-RATE-13 | Octopus product URLs | URL | CFG | `rates_import_octopus_url`, `rates_export_octopus_url` | ~rare | ER §Octopus Rates URL | verified | — |
| PB-RATE-14 | Off-peak hours override | list {start, end, utc} | CFG | `octopus_night_times` | ~rare | ER §Manually configuring Octopus off-peak times | verified | — |
| PB-RATE-15 | Import rate overrides | list {date?, start, end, rate?, rate_increment?, load_scaling?} | CFG | `rates_import_override` | event | ER §Manually over-riding energy rates | verified | tariff_rate source 'override' |
| PB-RATE-16 | Export rate overrides | same | CFG | `rates_export_override` | event | ER | verified | same |
| PB-RATE-17 | Manual per-slot import rate | slot list + p/kWh (0; −50…1000); automation form HH:MM=rate | CFG | `select.predbat_manual_import_rates` + `input_number.predbat_manual_import_value` | event | CU §Manual Control; CFG | verified | — |
| PB-RATE-18 | Manual per-slot export rate | same | CFG | `select.predbat_manual_export_rates` + `input_number.predbat_manual_export_value` | event | CU; CFG | verified | — |
| PB-RATE-19 | Low-rate (charge) threshold | factor of future average (0 = automatic; 0–2) | CFG | `input_number.predbat_rate_low_threshold` | ~rare | CU §Battery margins; WD | verified | site_setting |
| PB-RATE-20 | High-rate (export) threshold | factor (0 = automatic; 0–2) | CFG | `input_number.predbat_rate_high_threshold` | ~rare | CU; WD | verified | site_setting |
| PB-RATE-21 | Combine-rate threshold | p (0 = off) | CFG | `input_number.predbat_combine_rate_threshold` | ~rare | CU; CFG | verified | site_setting |
| PB-RATE-22 | Offset for unpublished import rates | p/kWh (0) | CFG | `input_number.predbat_metric_future_rate_offset_import` | ~rare | CU; ER §Rate offsets | verified | site_setting |
| PB-RATE-23 | Offset for unpublished export rates | p/kWh (0) | CFG | `input_number.predbat_metric_future_rate_offset_export` | ~rare | CU; ER | verified | site_setting |
| PB-RATE-24 | Future Agile estimate from Nord Pool | URL; flags import/export/auto; peak start/end; peak premiums | CFG | `futurerate_url`, `futurerate_adjust_import`, `_export`, `_auto`, `futurerate_peak_start`, `_end`, `futurerate_peak_premium_import`, `_export` | ~rare; data daily ~10:00 | ER §Future Agile energy rates; APY | verified | — |
| PB-RATE-25 | AgilePredict forecast | flag; region; URL | CFG | `futurerate_agilepredict`, `_region`, `_url` | cached 30 min | ER §AgilePredict forecast | verified | — |
| PB-RATE-26 | Saving sessions (Power Down) | events {id/code, start, end, octopoints_per_kwh}; joined vs available | LIVE | `octopus_saving_session` event (`joined_events`, `available_events`) | event | ER §Octopus Saving sessions; OC | verified | — |
| PB-RATE-27 | Octopoints per penny | int (8) | CFG | `octopus_saving_session_octopoints_per_penny` | ~rare | ER | verified | — |
| PB-RATE-28 | Minimum reward to auto-join | octopoints/kWh (0) | CFG | `octopus_saving_session_min_octopoints_per_kwh` | ~rare | ER; APY | verified | — |
| PB-RATE-29 | Auto-join and lead time | bool (on); hours (0–12) | CFG | `switch.predbat_octopus_saving_auto_join`, `input_number.predbat_octopus_saving_auto_join_lead_hours` | ~rare | ER; CFG | verified | — |
| PB-RATE-30 | Fixed saving-session rate | p | CFG | `octopus_saving_session_rate` | ~rare | CFG APPS_SCHEMA (not in docs) | verified | — |
| PB-RATE-31 | Free (Power Up) sessions | events {start, end} | LIVE | `octopus_free_session` event; `octopus_free_url` web scrape | event | ER §Octopus free (Power Up) events | verified | — |
| PB-RATE-32 | Axle VPP events | events (export or import type), start/end | LIVE | `binary_sensor.predbat_axle_event` (or `axle_session`) | event | ER §Axle VPP; CO §axle | verified | — |
| PB-RATE-33 | Axle settings | API key; p/kWh uplift (100); automatic; stand-aside control | CFG | `axle_api_key`, `axle_pence_per_kwh`, `axle_automatic`, `axle_control` | ~rare | ER §Axle VPP | verified | — |
| PB-RATE-34 | Intelligent Octopus dispatches | per car: planned and completed dispatches {start, end, charge_in_kwh, source, location} | LIVE | `octopus_intelligent_slot` sensor attrs, Octopus direct, Kraken `intelligent_dispatch` | event (minutes) | CC §Planned Car Charging, §Octopus-led; OC | verified | tariff_rate source 'iog_dispatch' |
| PB-RATE-35 | Planned dispatches from another sensor | sensor per car | LIVE | `octopus_intelligent_planned_slot` | event | CC §Taking planned slots from another sensor | verified | — |
| PB-RATE-36 | Dispatch pricing rules | bool; int half-hours per 24 h (auto 12 or 48); enum auto / octopus / window | CFG | `octopus_slot_low_rate`, `octopus_slot_max`, `intelligent_dispatch_billing` | ~rare | CC §Planned Car Charging | verified | — |
| PB-RATE-37 | Kraken (EDF / E.ON Next) account | provider; account ids; auth method; key or email+password; MPANs; base URL | CFG | `kraken_provider`, `kraken_account_id`, `kraken_export_account_id`, `kraken_auth_method`, `kraken_key`, `kraken_email`, `kraken_password`, `kraken_mpan`, `kraken_export_mpan`, `kraken_base_url` | install | ER §Kraken; CO §kraken | verified | credential |
| PB-RATE-38 | Kraken published rates and events | rate periods; standing £/day; EDF free hours | LIVE | `sensor.predbat_kraken_<acct>_import_rates`, `_export_rates`, `_import_standing`, `_free_electricity` | rates 10 min; tariff 30 min | CO §kraken | verified | — |
| PB-RATE-39 | Other spot-rate sources | sensor with `raw_today`/`raw_tomorrow` [{start, end, value}]; Danish feeds | LIVE | `metric_octopus_import/export` → template sensor; `metric_energidataservice_import/_export`; `metric_stromligning_import_today/_tomorrow`, `_export_today/_tomorrow` | daily | ER §Other spot rate, §Energidataservice, §Strømligning; source get_arg | verified | — |
| PB-RATE-40 | Resolved rate per slot with its provenance | p/kWh; adjust type: future offset, future estimate, override (=), increment (±), saving/Axle ($), previous-day copy (?) | OUT | plan rows `import_rate`, `export_rate`, `import_rate_adjust_type`, `export_rate_adjust_type`; `predbat.rates`, `predbat.rates_export`, `predbat.rates_gas` (yesterday/today/tomorrow attrs) | plan | PC §Understanding the plan; OD §Other rate entities; OUT | verified | tariff_rate |
| PB-RATE-41 | Rate after losses and cycle cost | p/kWh | OUT | plan rows `import_rate_adjusted`, `export_rate_adjusted` | plan | OUT line 1904–1905 | verified | — |
| PB-RATE-42 | Thresholds actually used | p/kWh | OUT | raw plan `import_cost_threshold`, `export_cost_threshold` | plan | OUT line 1264–1265 | verified | — |
| PB-RATE-43 | Next low-rate import windows | start, end, cost p, duration min (next two); slot flag | OUT | `predbat.low_rate_start`, `_end`, `_cost`, `_duration`, `_2` variants; `binary_sensor.predbat_low_rate_slot` | plan | OD §Low-rate import entities | verified | — |
| PB-RATE-44 | Next high-rate export windows | same | OUT | `predbat.high_rate_export_*`; `binary_sensor.predbat_high_rate_export_slot` | plan | OD §High-rate export entities | verified | — |
| PB-RATE-45 | Tariff comparison list | list {`id`, `name`, `rates_*` / URLs / `metric_*`, `config` overrides, `override_soc_max_kwh`, `override_battery_rate_max_charge_kw`, `override_battery_rate_max_discharge_kw`, `override_battery_rate_max_export_kw`, `override_inverter_limit_kw`} | CFG | `compare_list` | ~rare | CMP | verified | — |
| PB-RATE-46 | Tariff comparison results | p per tariff per day + detail attrs; "Existing" match | OUT/HIST | `predbat.compare_tariff_<id>`; `switch.predbat_compare_active` | daily (midnight) | CMP §Running a comparison, §Comparison sensors | verified | — |

### PB-PV: solar generation and forecast

| ID | Item | Type / unit | Dir | Origin in Predbat | Changes | Src | Status | PD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-PV-01 | PV generated today | kWh, incrementing, one per inverter, summed | HIST | `pv_today` | 5m | AY §Data from Home Assistant | verified | — |
| PB-PV-02 | Solcast forecast sensors | kWh/day + `detailedForecast` [{period_start, pv_estimate, pv_estimate10, pv_estimate90}] | LIVE | `pv_forecast_today`, `_tomorrow`, `_d3`, `_d4` (d5–d7 supported) | per Solcast update | AY §Solcast Solar Forecast; SC | verified | pv_forecast |
| PB-PV-03 | Solcast direct API | host; API key(s); site ids; poll hours (8; hobby limit 10 polls/day) | CFG | `solcast_host`, `solcast_api_key`, `solcast_sites`, `solcast_poll_hours` | install | AY §Solcast Solar Forecast | verified | credential |
| PB-PV-04 | Forecast.solar arrays | list {postcode or latitude/longitude, kwp, azimuth (0 = N), declination, efficiency, api_key, days, azimuth_zero_south} | CFG | `forecast_solar` | install | AY §Forecast.solar | verified | — |
| PB-PV-05 | Forecast.solar refresh | hours (8) | CFG | `forecast_solar_max_age` | ~rare | AY §Forecast.solar | verified | — |
| PB-PV-06 | Open-Meteo arrays | list {postcode or latitude/longitude, kwp, declination, azimuth, efficiency (1.0), azimuth_zero_south, shading_factors} | CFG | `open_meteo_forecast` | install | AY §Open-Meteo Solar Forecast | verified | — |
| PB-PV-07 | Open-Meteo refresh | hours (4) | CFG | `open_meteo_forecast_max_age` | ~rare | AY | verified | — |
| PB-PV-08 | Source order | bool × 2 | CFG | `forecast_solar_open_meteo_backup`, `forecast_solar_open_meteo_first` | ~rare | AY §Open-Meteo backup, §primary source | verified | — |
| PB-PV-09 | DC array size | kWp (auto from `kwp` of arrays) | CFG | `pv_array_kwp` | install | AY §pv_array_kwp | verified | — |
| PB-PV-10 | Forecast per slot, three scenarios + calibrated | kWh per 30 min: PV50, PV10, PV90, CL; source; time fetched | LIVE/STATE | `detailedForecast` of Predbat PV sensors | per fetch | OD §Solar forecast data; SC | verified | pv_forecast (pv10/pv50/pv90, source, fetched_at) |
| PB-PV-11 | PV scaling | factor (1.0, 0–2) | CFG | `input_number.predbat_pv_scaling` | ~rare | CU §Solar PV adjustment options | verified | site_setting |
| PB-PV-12 | PV10 weight | 0–1 (0.15) | CFG | `input_number.predbat_pv_metric10_weight` | ~rare | CU | verified | site_setting |
| PB-PV-13 | PV90 weight | 0–1 (0.15; expert) | CFG | `input_number.predbat_pv_metric90_weight` | ~rare | CU | verified | site_setting |
| PB-PV-14 | Simulate PV90 plan | bool (on) | CFG | `switch.predbat_calculate_pv90_plan` | ~rare | CU | verified | site_setting |
| PB-PV-15 | PV calibration | bool (on); needs 7 days of forecast vs actual | CFG | `switch.predbat_metric_pv_calibration_enable` | ~rare | CU | verified | site_setting |
| PB-PV-16 | Cloud model | bool (on) | CFG | `switch.predbat_metric_cloud_enable` | ~rare | CU §Cloud coverage and load variance | verified | site_setting |
| PB-PV-17 | Provider forecast "now", uncalibrated (calibration input) | kW + 10 %/90 % attrs | HIST | `sensor.predbat_pv_forecast_h0_uncalibrated` | 5m | OD §Solar forecast data; CU | verified | — |
| PB-PV-18 | Calibrated forecast "now" | kW + 10 %/90 % attrs | OUT/HIST | `sensor.predbat_pv_forecast_h0` | 5m | OD | verified | — |
| PB-PV-19 | Daily forecast outputs | kWh; attrs total, total10, total90, totalCL, remaining, remaining10, remaining90, remainingCL, detailedForecast | OUT | `sensor.predbat_pv_today`, `_tomorrow`, `_d2`, `_d3` | per fetch | OD §Solar forecast data | verified | — |
| PB-PV-20 | Calibration factors | worst day, best day, total | OUT | Metrics view "PV Calibration Scaling" | daily | WI §Metrics View | verified | — |
| PB-PV-21 | Dawn flag | bool | OUT | `binary_sensor.predbat_dawn` | 5m | OD §Solar forecast data | verified | — |
| PB-PV-22 | PV today mirror | kWh | OUT | `predbat.pv_energy_h0` | 5m | OD §'Today' energy data | verified | — |
| PB-PV-23 | Predicted clipping per slot | kWh | OUT | plan rows `clipped` (Clip column) | plan | PC; OUT | verified | — |

### PB-LOAD: load history, prediction and scaling

| ID | Item | Type / unit | Dir | Origin in Predbat | Changes | Src | Status | PD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-LOAD-01 | House load today | kWh, incrementing, resets at midnight (required; list summed) | HIST | `load_today` | 5m | AY §Data from Home Assistant; CFG (required) | verified | load_history.load_kwh |
| PB-LOAD-02 | Grid import today | kWh, incrementing | HIST | `import_today` | 5m | AY | verified | telemetry.import_kwh_today |
| PB-LOAD-03 | Grid export today | kWh, incrementing | HIST | `export_today` | 5m | AY | verified | telemetry.export_kwh_today |
| PB-LOAD-04 | GivEnergy cloud as history source | bool; serial; key; ignore cloud load | CFG | `ge_cloud_data`, `ge_cloud_serial`, `ge_cloud_key`, `ge_cloud_load_today_ignore` | install; cloud data every 30 min | AY §GivEnergy Cloud Data; CO | verified | — |
| PB-LOAD-05 | Fill gaps from load power | bool (true) | CFG | `load_power_fill_enable` | ~rare | AY §Load filtering | verified | — |
| PB-LOAD-06 | Fill from Predbat's own load history | bool (true); uses history of `predbat.load_energy_h0` | CFG | `load_history_fill_enable` | ~rare | AY §Load filtering | verified | — |
| PB-LOAD-07 | Zero-load gap threshold | minutes (30; 1440 = off) | CFG | `load_filter_threshold` | ~rare | AY §Load filtering | verified | — |
| PB-LOAD-08 | Drop lowest day | bool (on) | CFG | `switch.predbat_load_filter_modal` | ~rare | CU §Historical load data | verified | site_setting |
| PB-LOAD-09 | History days | list of int ([7]) | CFG | `days_previous` | ~rare | AY §days_previous | verified | site_setting |
| PB-LOAD-10 | Weight per history day | list of float (1) | CFG | `days_previous_weight` | ~rare | AY §days_previous | verified | site_setting |
| PB-LOAD-11 | Weighted-bucket forecast | bool (true); window = max(days_previous) ≤ 30 days; weekday weight 1.0 / 0.7 / 0.5; age 0.9 − 0.03 per day, floor 0.1; zero buckets ignored | CFG | `days_previous_auto` | ~rare | AY §days_previous_auto | verified | site_setting |
| PB-LOAD-12 | HA history retention | days (10 by default) | CFG (external) | HA `recorder: purge_keep_days` | install | AY §days_previous | verified | — |
| PB-LOAD-13 | Holiday days left | days (0–28), counts down at midnight; its history gives holiday state per 5 min | CFG/HIST | `input_number.predbat_holiday_days_left` | event / daily | CU §Holiday mode; AY §days_previous_auto | verified | load_history.is_holiday |
| PB-LOAD-14 | Holiday load scaling | factor (0.7, 0.1–1) | CFG | `input_number.predbat_holiday_load_scaling` | ~rare | CU §Holiday mode | verified | site_setting |
| PB-LOAD-15 | Base load floor | W (100) | CFG | `base_load` | ~rare | AY §Base load | verified | — |
| PB-LOAD-16 | Load scaling | factor (1.05) | CFG | `input_number.predbat_load_scaling` | ~rare | CU §Scaling and weight options | verified | site_setting |
| PB-LOAD-17 | Load scaling, PV10 case | factor (1.1) | CFG | `input_number.predbat_load_scaling10` | ~rare | CU | verified | site_setting |
| PB-LOAD-18 | Load scaling, PV90 case | factor (0.9; expert); clamped so PV90 ≤ central ≤ PV10 | CFG | `input_number.predbat_load_scaling90` | ~rare | CU | verified | site_setting |
| PB-LOAD-19 | Load scaling in saving sessions / Axle export | factor (1.0) | CFG | `input_number.predbat_load_scaling_saving` | ~rare | CU; ER | verified | site_setting |
| PB-LOAD-20 | Load scaling in free sessions / Axle import | factor (1.2) | CFG | `input_number.predbat_load_scaling_free` | ~rare | CU; ER | verified | site_setting |
| PB-LOAD-21 | Manual per-slot load adjustment | slot list + kWh (0.5; −10…10); HH:MM=adj | CFG | `select.predbat_manual_load_adjust` + `input_number.predbat_manual_load_value` | event | CU §Manual Control | verified | — |
| PB-LOAD-22 | Energy to remove from load history (EV, heat pump, other) | kWh, daily incrementing, list | HIST | `car_charging_energy` | 5m | CC §Filtering Car Charging Energy; PH §Exclude Heat Pump load | verified | load_history.car_kwh |
| PB-LOAD-23 | Scale for that sensor | factor (1.0, 0–1) | CFG | `input_number.predbat_car_charging_energy_scale` | ~rare | CC | verified | — |
| PB-LOAD-24 | Car detection threshold (no energy sensor) | kW (6; 4–24) | CFG | `input_number.predbat_car_charging_threshold` | ~rare | CC | verified | — |
| PB-LOAD-25 | Remove car load from history | bool (on) | CFG | `switch.predbat_car_charging_hold` | ~rare | CC | verified | — |
| PB-LOAD-26 | Charger inside CT clamp | bool (on) | CFG | `switch.predbat_car_energy_reported_load` | install | CC | verified | — |
| PB-LOAD-27 | External load forecast | `sensor$attribute` list; [{last_updated, energy}] incrementing, or {timestamp: kWh} | LIVE | `load_forecast` (e.g. `predheat.heat_energy$external`) | 5m | AY §Load Forecast | verified | — |
| PB-LOAD-28 | Use external forecast only | bool | CFG | `load_forecast_only` | ~rare | AY §Load Forecast | verified | — |
| PB-LOAD-29 | In-day adjustment | bool (on); damping (0.95, 0.5–2) | CFG | `switch.predbat_calculate_inday_adjustment`, `input_number.predbat_metric_inday_adjust_damping` | ~rare | CU §Battery margins and metrics options | verified | site_setting |
| PB-LOAD-30 | In-day adjustment factor | % + `yesterday_adjustment`, `yesterday_weight` | OUT/STATE | `predbat.load_inday_adjustment` | plan | OD §In-day load adjustment data | verified | — |
| PB-LOAD-31 | Dynamic load adjust | bool (off); last-period load kW | CFG/OUT | `switch.predbat_metric_dynamic_load_adjust`; `predbat.load_energy_last_period` | ~rare | CU §Scaling; PL line 254 | verified | site_setting |
| PB-LOAD-32 | Load divergence model | bool (on); uses std dev of next 4 h | CFG | `switch.predbat_metric_load_divergence_enable` | ~rare | CU §Cloud coverage and load variance | verified | site_setting |
| PB-LOAD-33 | Load ML settings | enable; use for planning; max history days (28); on-disk days (90); retrain hours (2, 1–48) | CFG | `load_ml_enable`, `load_ml_source`, `load_ml_max_days_history`, `load_ml_database_days`, `load_ml_retrain_interval_hours` | ~rare | CO §load_ml | verified | — |
| PB-LOAD-34 | Load ML inputs | 24 h of 5-min load, PV, temperature, import and export rates; minute-of-day, day-of-week, day-of-year | HIST | `load_today`, `pv_today`, `sensor.predbat_temperature`, rates, `car_charging_energy` | predict 30 min; train 2 h | LM §Input Features; CO | verified | — |
| PB-LOAD-35 | Load ML forecast and stats | 576 × 5-min kWh; stats | OUT | `sensor.predbat_load_ml_forecast` (`results`), `sensor.predbat_load_ml_stats` | 30 min | CO §load_ml; source entity list | verified | — |
| PB-LOAD-36 | Load ML model state | status (not_initialized, training, active, validation_failed, stale); val_mae; files `predbat_ml_model.npz`, `predbat_ml_history.npz` | STATE | load_ml component | 2 h | CO §load_ml; LM §Model Persistence | verified | — |
| PB-LOAD-37 | Temperature forecast feed | enable; URL; latitude; longitude → hourly °C keyed by ISO time | CFG/LIVE | `temperature_enable`, `temperature_url`, `temperature_latitude`, `temperature_longitude` → `sensor.predbat_temperature` | 1 h | CO §temperature | verified | — |
| PB-LOAD-38 | Today's load as measured | kWh, unscaled; `source` attr (load_today / ge_cloud / load_forecast) | OUT/HIST | `predbat.load_energy_h0` | 5m | OD §'Today' energy data | verified | — |
| PB-LOAD-39 | Today's import and export mirrors | kWh | OUT | `predbat.import_energy_h0`, `predbat.export_energy_h0` | 5m | OD | verified | — |
| PB-LOAD-40 | Load forecast series | kWh, 5-min series to horizon (base, best, base10, best10) | OUT | `predbat.load_energy`, `best_load_energy`, `base10_load_energy`, `best10_load_energy`, `load_power_best` | plan | OD §Baseline, §Best | verified | — |
| PB-LOAD-41 | Load actual / predicted / adjusted today | kWh; attrs today, today_so_far, today_remaining | OUT | `predbat.load_energy_actual`, `_predicted`, `_adjusted` | plan | OD §In-day load adjustment data | verified | — |
| PB-LOAD-42 | History depth available | days | OUT | Metrics view "Data Age" | plan | WI §Metrics View | verified | — |

### PB-CAR: electric vehicles

| ID | Item | Type / unit | Dir | Origin in Predbat | Changes | Src | Status | PD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-CAR-01 | Number of cars | int (0 = none) | CFG | `num_cars` | install | CC §Configure apps.yaml | verified | — |
| PB-CAR-02 | Cars share one charger | bool per car | CFG | `car_charging_exclusive` | install | CC | verified | — |
| PB-CAR-03 | Plugged in and planned to charge | sensor per car + list of "yes" values | LIVE | `car_charging_planned`, `car_charging_planned_response` | event | CC §Planned Car Charging | verified | — |
| PB-CAR-04 | Plugged in (only) | sensor per car | LIVE | `car_charging_plugged` | event | CC | verified | — |
| PB-CAR-05 | Charging now | on/off or power (≥ 200 W = charging) per car + response list | LIVE | `car_charging_now`, `car_charging_now_response` | polled 15 s | CC | verified | — |
| PB-CAR-06 | Charger live power (display only) | W or kW, list summed | LIVE/OUT | `car_charging_power` → `predbat.car_charging_power` | 5m | CC; OD §Sensor data | verified | — |
| PB-CAR-07 | Car battery size | kWh per car (100 if unset) | CFG | `car_charging_battery_size` | install | CC | verified | — |
| PB-CAR-08 | Car charge limit | % per car (100 if unset) | LIVE | `car_charging_limit` | event | CC | verified | — |
| PB-CAR-09 | Car SoC | % per car (0 if unset) | LIVE | `car_charging_soc` | 5m | CC | verified | — |
| PB-CAR-10 | Car charge rate | kW per car (7.4; 0.1–24), cars 0–7 | CFG | `input_number.predbat_car_charging_rate`, `_1` … `_7` | ~rare | CC §Predbat-led charging; CFG | verified | — |
| PB-CAR-11 | Car charging loss | fraction (0.08) | CFG | `input_number.predbat_car_charging_loss` | ~rare | CC §Additional | verified | — |
| PB-CAR-12 | Manual car SoC | bool + kWh per car (cars 0–7) | CFG/STATE | `switch.predbat_car_charging_manual_soc[_N]`, `input_number.predbat_car_charging_manual_soc_kwh[_N]` | event | CC §Predbat-led charging; CFG | verified | — |
| PB-CAR-13 | Tracked car SoC | kWh + attrs since, counted, plugged, unplugged_since, active; read back on restart | STATE/OUT | `sensor.predbat_car_manual_soc_tracked[_N]` | 5m | CC §Predbat-led charging | verified | — |
| PB-CAR-14 | Ready-by time | HH:MM:SS (07:00) | CFG | `select.predbat_car_charging_plan_time` | ~rare | CC; CFG | verified | — |
| PB-CAR-15 | Cheapest-slot car planning | bool (on) | CFG | `switch.predbat_car_charging_plan_smart` | ~rare | CC | verified | — |
| PB-CAR-16 | Maximum car charging price | p/kWh (0 = off) | CFG | `input_number.predbat_car_charging_plan_max_price` | ~rare | CC | verified | — |
| PB-CAR-17 | Car may drain home battery | bool (off) | CFG | `switch.predbat_car_charging_from_battery` | ~rare | CC §Additional | verified | — |
| PB-CAR-18 | Octopus-led car planning | bool (on) | CFG | `switch.predbat_octopus_intelligent_charging` | ~rare | CC §Octopus-led charging | verified | — |
| PB-CAR-19 | IOG ready time | time per car | LIVE | `octopus_ready_time` | event | CC §Planned Car Charging | verified | — |
| PB-CAR-20 | IOG charge target | % per car | LIVE | `octopus_charge_limit` | event | CC | verified | — |
| PB-CAR-21 | IOG trust and check switches | bools: ignore unplugged (off), consider full (off), dynamic check (on), trust slots (on), drive charger to dispatches (off) | CFG | `switch.predbat_octopus_intelligent_ignore_unplugged`, `_consider_full`, `_dynamic`, `_trust_slots`, `_charger_follows_car` | ~rare | CC §Octopus-led charging; CFG | verified | — |
| PB-CAR-22 | Octopus device data | battery kWh; charger kW; weekday target time and SoC; device state | LIVE | Octopus direct: `vehicle_battery_size_in_kwh`, `charge_point_power_in_kw`, `weekday_target_time`, `weekday_target_soc`, `current_state` | event | CC §Planned Car Charging; OC | verified | — |
| PB-CAR-23 | Dispatch cancellation state | per car: cancelled flag; kept cheap half hour; survives restart | STATE | internal | event | CC §What happens when the car is not charging | verified | — |
| PB-CAR-24 | Charger integrations | logins, flags, poll seconds (Wallbox 120) | CFG | `ohme_*`, `wallbox_*`, `hypervolt_*`, `myenergi_*` (hub serial, key, automatic, zappi, eddi, controls, poll), `ge_cloud_automatic_evc`, `ge_cloud_evc_control`, `ge_cloud_evc_direct`, `gateway_evc_automatic` | install | AY §Car Charging Integration, §myenergi; CO; CFG | verified | credential |
| PB-CAR-25 | Car charging slots (plan) | per car: on/off + `planned` [{start, end, kWh, cost}] | OUT | `binary_sensor.predbat_car_charging_slot[_N]` | plan | OD §Car data | verified | — |
| PB-CAR-26 | Car charging start | HH:MM:SS | OUT | `predbat.car_charging_start` | plan | OD §Car data | verified | — |
| PB-CAR-27 | Predicted car SoC | % series per car (base, best) | OUT | `predbat.car_soc[_N]`, `predbat.car_soc_best[_N]` | plan | OD; CC §Multiple Electric Cars | verified | — |
| PB-CAR-28 | Car charging cost | p today (with future slots), yesterday, running total | OUT/HIST | `predbat.cost_today_car`, `cost_yesterday_car`, `cost_total_car` | 5m / daily | OD §Car data | verified | — |
| PB-CAR-29 | Car energy per plan slot | kWh; cancelled flag ("?"); car rate; split rate | OUT | plan rows `car_charging`, `car_charging_cancelled`, `car_rate`, `rate_split` | plan | PC; OUT | verified | — |

### PB-OTHER: iBoost / immersion, battery value, keep, metric weights, set_* toggles, calculation options, balance, alerts

| ID | Item | Type / unit | Dir | Origin in Predbat | Changes | Src | Status | PD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-OTH-01 | iBoost model on | bool (off) | CFG | `switch.predbat_iboost_enable` | ~rare | CU §iBoost model options | verified | site_setting |
| PB-OTH-02 | Divert solar | bool (on) | CFG | `switch.predbat_iboost_solar` | ~rare | CU §iBoost modes | verified | site_setting |
| PB-OTH-03 | Only solar that would be exported | bool (off) | CFG | `switch.predbat_iboost_solar_excess` | ~rare | CU | verified | site_setting |
| PB-OTH-04 | Run while battery charges | bool (off) | CFG | `switch.predbat_iboost_charging` | ~rare | CU | verified | site_setting |
| PB-OTH-05 | Cheapest slots to hit energy target | bool (off) | CFG | `switch.predbat_iboost_smart` | ~rare | CU | verified | site_setting |
| PB-OTH-06 | Smart minimum slot length | minutes (30, 30–120) | CFG | `input_number.predbat_iboost_smart_min_length` | ~rare | CU | verified | site_setting |
| PB-OTH-07 | Allow during forced export | bool (off) | CFG | `switch.predbat_iboost_on_export` | ~rare | CU | verified | site_setting |
| PB-OTH-08 | Block battery discharge while active | bool (off) | CFG | `switch.predbat_iboost_prevent_discharge` | ~rare | CU | verified | site_setting |
| PB-OTH-09 | Compare import / export with gas | bool × 2 (off) | CFG | `switch.predbat_iboost_gas`, `switch.predbat_iboost_gas_export` | ~rare | CU §iBoost energy rate filtering | verified | site_setting |
| PB-OTH-10 | Gas price scaling (1 / boiler efficiency) | factor (1.0) | CFG | `input_number.predbat_iboost_gas_scale` | ~rare | CU | verified | site_setting |
| PB-OTH-11 | Max import / export price to boost | p/kWh (100 each) | CFG | `input_number.predbat_iboost_rate_threshold`, `_rate_threshold_export` | ~rare | CU | verified | site_setting |
| PB-OTH-12 | Max diverter energy per day | kWh (3) | CFG | `input_number.predbat_iboost_max_energy` | ~rare | CU §iBoost basic configuration | verified | site_setting |
| PB-OTH-13 | Diverter max and min power | W (2400; 500) | CFG | `input_number.predbat_iboost_max_power`, `_min_power` | ~rare | CU | verified | site_setting |
| PB-OTH-14 | Minimum home battery SoC | % (0) | CFG | `input_number.predbat_iboost_min_soc` | ~rare | CU | verified | site_setting |
| PB-OTH-15 | Value of diverted energy | factor of lowest future import rate (0.75) | CFG | `input_number.predbat_iboost_value_scaling` | ~rare | CU | verified | site_setting |
| PB-OTH-16 | Subtract diverter energy from load history | bool (on) | CFG | `switch.predbat_iboost_energy_subtract` | ~rare | CU | verified | site_setting |
| PB-OTH-17 | Diverter energy sensor | kWh incrementing; scaling factor | HIST | `iboost_energy_today`, `iboost_energy_scaling` | 5m | AY §iBoost energy; CU §iBoost output data | verified | — |
| PB-OTH-18 | Diverter energy modelled today | kWh, resets nightly (OD says 23:30, CU says midnight) | STATE/OUT | `input_number.predbat_iboost_today` | 5m | OD §iBoost; CU | verified | — |
| PB-OTH-19 | Diverter on/off signal | bool; attrs `solar`, `full` | OUT/CTRL | `binary_sensor.predbat_iboost_active` | 5m | OD §iBoost; CU §iBoost output data | verified | — |
| PB-OTH-20 | Planned diverter energy | kWh series; plan column | OUT | `predbat.iboost_best`; plan rows `iboost`, `iboost_change` | plan | OD; PC; OUT | verified | — |
| PB-OTH-21 | myenergi Eddi as diverter | bool | CFG | `myenergi_automatic_eddi` | install | CFG APPS_SCHEMA; AY §myenergi | verified | — |
| PB-OTH-22 | Battery end-of-plan value scaling | factor (1.0, 0–2) | CFG | `input_number.predbat_metric_battery_value_scaling` | ~rare | CU §Battery loss options | verified | site_setting |
| PB-OTH-23 | Battery value when export is worthless | factor (0.8, 0–1) | CFG | `input_number.predbat_metric_battery_value_export_scaling` | ~rare | CU | verified | site_setting |
| PB-OTH-24 | Battery cycle cost | p/kWh (0) | CFG | `input_number.predbat_metric_battery_cycle` | ~rare | CU | verified | site_setting |
| PB-OTH-25 | Self-sufficiency bias | p/kWh (0, 0–100) | CFG | `input_number.predbat_metric_self_sufficiency` | ~rare | CU | verified | site_setting |
| PB-OTH-26 | Min improvement to charge less | p (0) | CFG | `input_number.predbat_metric_min_improvement` | ~rare | CU §Battery margins | verified | site_setting |
| PB-OTH-27 | Min improvement to export | p per slot (0.1) | CFG | `input_number.predbat_metric_min_improvement_export` | ~rare | CU | verified | site_setting |
| PB-OTH-28 | Min improvement to freeze export | p per slot (0.1) | CFG | `input_number.predbat_metric_min_improvement_export_freeze` | ~rare | CU | verified | site_setting |
| PB-OTH-29 | Min improvement to move export later | p (−0.25) | CFG | `input_number.predbat_metric_min_improvement_swap` | ~rare | CU | verified | site_setting |
| PB-OTH-30 | Min improvement to replace the plan | p (2.0, −50…250) | CFG | `input_number.predbat_metric_min_improvement_plan` | ~rare | CFG (not in docs) | verified | site_setting |
| PB-OTH-31 | Best SoC keep (soft floor, ignored first 4 h) | kWh (0) | CFG | `input_number.predbat_best_soc_keep` | ~rare | CU §Battery margins; WD | verified | site_setting |
| PB-OTH-32 | Keep weighting | factor (0.5, 0.1–5) | CFG | `input_number.predbat_best_soc_keep_weight` | ~rare | CU | verified | site_setting |
| PB-OTH-33 | Best SoC min (hard floor for charge/export) | kWh (0) | CFG | `input_number.predbat_best_soc_min` | ~rare | CU | verified | site_setting |
| PB-OTH-34 | Best SoC max (charge ceiling) | kWh (0 = off) | CFG | `input_number.predbat_best_soc_max` | ~rare | CU | verified | site_setting |
| PB-OTH-35 | Carbon tracking | bool (off) | CFG | `switch.predbat_carbon_enable` | ~rare | CU; ER §Grid Carbon intensity | verified | site_setting |
| PB-OTH-36 | Carbon weight in plan | p per kg CO2 (0, 0–500) | CFG | `input_number.predbat_carbon_metric` | ~rare | CU | verified | site_setting |
| PB-OTH-37 | Grid carbon intensity feed | g/kWh per half hour, forecast; postcode; automatic | LIVE/CFG | `carbon_postcode`, `carbon_automatic`, `carbon_intensity` → `sensor.predbat_carbon` | ~30m | ER §Grid Carbon intensity; CO §carbon | verified | — |
| PB-OTH-38 | Allow freeze charge | bool (on; expert) | CFG | `switch.predbat_set_charge_freeze` | ~rare | CU §Inverter control options | verified | site_setting |
| PB-OTH-39 | Freeze charge only (no grid charge) | bool (off) | CFG | `switch.predbat_set_charge_freeze_only` | ~rare | CU | verified | site_setting |
| PB-OTH-40 | Allow freeze export | bool (on) | CFG | `switch.predbat_set_export_freeze` | ~rare | CU | verified | site_setting |
| PB-OTH-41 | Freeze export only (no forced export) | bool (off) | CFG | `switch.predbat_set_export_freeze_only` | ~rare | CU | verified | site_setting |
| PB-OTH-42 | Low-power charging | bool (off) | CFG | `switch.predbat_set_charge_low_power` | ~rare | CU | verified | site_setting |
| PB-OTH-43 | Low-power finish margin | minutes (10; code 0–60) | CFG | `input_number.predbat_charge_low_power_margin` | ~rare | CU; CFG | verified | site_setting |
| PB-OTH-44 | Low-power PV threshold | W (150, 0–2000) | CFG | `input_number.predbat_low_power_pv_threshold_w` | ~rare | CU | verified | site_setting |
| PB-OTH-45 | Full rate when solar | bool (on) | CFG | `switch.predbat_set_charge_low_power_solar_full_rate` | ~rare | CU | verified | site_setting |
| PB-OTH-46 | Low-power export | bool (off) | CFG | `switch.predbat_set_export_low_power` | ~rare | CFG | verified | site_setting |
| PB-OTH-47 | Use reserve to hold SoC | bool (on) | CFG | `switch.predbat_set_reserve_enable` | ~rare | CU | verified | site_setting |
| PB-OTH-48 | No discharge during charge slots | bool (on) | CFG | `switch.predbat_set_discharge_during_charge` | ~rare | CU §Calculation options | verified | site_setting |
| PB-OTH-49 | Freeze export instead of Demand | bool (off) | CFG | `switch.predbat_set_freeze_export_during_demand` | ~rare (often by automation at sunrise/sunset) | CU §Freeze Export during Demand | verified | site_setting |
| PB-OTH-50 | Reset target SoC to 100 % outside charge | bool (on) | CFG | `switch.predbat_inverter_soc_reset` | ~rare | CU | verified | site_setting |
| PB-OTH-51 | Program charge window before it starts | bool (on) | CFG | `switch.predbat_inverter_set_charge_before` | ~rare | CU §Calculation options | verified | site_setting |
| PB-OTH-52 | Export more solar | bool (off); threshold p (1) | CFG | `switch.predbat_export_more_solar`, `input_number.predbat_export_more_solar_threshold` | ~rare | CU §Calculation options | verified | site_setting |
| PB-OTH-53 | Export inside charge slots | bool (off) | CFG | `switch.predbat_calculate_export_oncharge` | ~rare | CU | verified | site_setting |
| PB-OTH-54 | Export during solar production | bool (on) | CFG | `switch.predbat_calculate_export_on_pv` | ~rare | CU | verified | site_setting |
| PB-OTH-55 | Second optimisation pass | bool (on) | CFG | `switch.predbat_calculate_second_pass` | ~rare | CU | verified | site_setting |
| PB-OTH-56 | Sort equal import slots by export price | bool (on) | CFG | `switch.predbat_calculate_import_low_export` | ~rare | CU | verified | site_setting |
| PB-OTH-57 | Sort equal export slots by import price | bool (on) | CFG | `switch.predbat_calculate_export_high_import` | ~rare | CU | verified | site_setting |
| PB-OTH-58 | Re-plan interval | minutes (10, 5–60) | CFG | `input_number.predbat_calculate_plan_every` | ~rare | CU §Performance related | verified | site_setting |
| PB-OTH-59 | Combine charge slots | bool (off) | CFG | `switch.predbat_combine_charge_slots` | ~rare | CU §Battery margins | verified | site_setting |
| PB-OTH-60 | Combine export slots | bool (off) | CFG | `switch.predbat_combine_export_slots` | ~rare | CU | verified | site_setting |
| PB-OTH-61 | Forecast horizon | hours (48) | CFG | `forecast_hours` | install | AY §forecast_hours; WD | verified | site.forecast_hours |
| PB-OTH-62 | Minimum plan length after first charge | hours (24, 8–96) | CFG | `input_number.predbat_forecast_plan_hours` | ~rare | CU §Calculation options; WD | verified | site_setting |
| PB-OTH-63 | Coarse/fine search | bool (true) | CFG | `enable_coarse_fine_levels` | ~rare | AY §enable_coarse_fine_levels | verified | — |
| PB-OTH-64 | Random re-plan delay | seconds (0) | CFG | `plan_random_delay` | ~rare | AY §plan_random_delay | verified | — |
| PB-OTH-65 | Savings baseline charge slots | int (1; 0 = Demand baseline) | CFG | `calculate_savings_max_charge_slots` | ~rare | AY §Savings Max Charge Slots | verified | — |
| PB-OTH-66 | Predbat mode | enum: Monitor, Control SOC only, Control charge, Control charge & discharge | CFG | `select.predbat_mode` | ~rare | CU §Predbat mode; CONST | verified | site.mode |
| PB-OTH-67 | Expert and performance gating | bool × 2 (off); hidden settings are pinned to defaults | CFG | `switch.predbat_expert_mode`, `switch.predbat_performance_tweaks` | ~rare | CU §Expert mode, §Performance tweaks mode | verified | — |
| PB-OTH-68 | Balance inverters | bool (off) | CFG | `switch.predbat_balance_inverters_enable` | ~rare | CU §Balance Inverters | verified | site_setting |
| PB-OTH-69 | Stop cross-charging | bool (on) | CFG | `switch.predbat_balance_inverters_crosscharge` | ~rare | CU | verified | site_setting |
| PB-OTH-70 | Balance while charging / discharging | bool × 2 (off) | CFG | `switch.predbat_balance_inverters_charge`, `_discharge` | ~rare | CU | verified | site_setting |
| PB-OTH-71 | Balance thresholds | % (1, 1–20) × 2 | CFG | `input_number.predbat_balance_inverters_threshold_charge`, `_threshold_discharge` | ~rare | CU | verified | site_setting |
| PB-OTH-72 | Weather alert filter | {url, event regex, severity, certainty, keep % (100), latitude, longitude} | CFG | `alerts` | ~rare; feed checked 30 min | AY §Weather Alert System; CO §alert_feed | verified | — |
| PB-OTH-73 | Active weather alerts | text; attrs `keep`, `alerts` [{severity, certainty, urgency, area, period, title}] | LIVE/OUT | `sensor.predbat_alertfeed_status` | 30 min | AY §Weather Alert System; OD §Alert data | verified | — |
| PB-OTH-74 | Export triggers | list {name, minutes, energy kWh} | CFG | `export_triggers` | ~rare | AY §Triggers | verified | — |
| PB-OTH-75 | Export trigger outputs | bool per trigger | OUT | `binary_sensor.predbat_export_trigger_<name>` | plan | AY §Triggers; OD §Export trigger | verified | — |
| PB-OTH-76 | Manual force charge | list of slot times (≤ 48 h ahead; expire after use) | CFG | `select.predbat_manual_charge` | event | CU §Manual Control | verified | — |
| PB-OTH-77 | Manual force export | slot list | CFG | `select.predbat_manual_export` | event | CU | verified | — |
| PB-OTH-78 | Manual force Demand | slot list | CFG | `select.predbat_manual_demand` | event | CU | verified | — |
| PB-OTH-79 | Manual freeze charge | slot list | CFG | `select.predbat_manual_freeze_charge` | event | CU | verified | — |
| PB-OTH-80 | Manual freeze export | slot list | CFG | `select.predbat_manual_freeze_export` | event | CU | verified | — |
| PB-OTH-81 | Manual SoC floor at a time | slot list + % (100); HH:MM=% | CFG | `select.predbat_manual_soc` + `input_number.predbat_manual_soc_value` | event | CU | verified | — |
| PB-OTH-82 | Manual SoC ceiling at a time | slot list + % (0); HH:MM=% | CFG | `select.predbat_manual_soc_max` + `input_number.predbat_manual_soc_max_value` | event | CU | verified | — |
| PB-OTH-83 | Site time zone | IANA name (Europe/London) | CFG | `timezone` | install | AY §timezone | verified | site.timezone |
| PB-OTH-84 | Site location | latitude/longitude (HA `zone.home` unless set per feature) | CFG | HA location; `alerts.latitude/longitude`; `temperature_latitude/longitude`; array postcode or lat/lon | install | AY §Weather Alert System; CO §temperature | verified | — |

### PB-PLAN-OUT: the plan and its predictions

| ID | Item | Type / unit | Dir | Origin in Predbat | Changes | Src | Status | PD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-PLAN-01 | Plan time and refresh interval | ISO time; minutes | OUT | raw plan `timestamp`, `refresh_minutes`; `predbat.status` attr "Last updated" | plan | OUT line 2046–2050; OD §Basic status | verified | plan_run.created_at |
| PB-PLAN-02 | Horizon and bounds | minutes; hours; record end; plan end | OUT | raw plan `forecast_minutes`, `end_record`, `end_plan`; `predbat.duration`; `predbat.record` (window attrs) | plan | OUT; OD §Baseline, §Prediction window | verified | plan_run.plan_start |
| PB-PLAN-03 | Plan context | SoC kWh, soc_max, reserve, mode, num_cars, iboost/carbon on, day start | OUT | raw plan `soc`, `soc_max`, `reserve`, `mode`, `num_cars`, `iboost_enable`, `carbon_enable`, `time` | plan | OUT line 1264–1280 | verified | plan_run.soc_start_kwh |
| PB-PLAN-04 | Time model | 5-min steps; 30-min slots aligned :00/:30; charge slots whole slots; export slots any 5-min multiple ending on a slot boundary; 48 h horizon, ≥ 24 h after first charge | rule | — | install | WD §Terminology; ER §Plan Interval | verified | plan_slot.slot_start, start_offset_min |
| PB-PLAN-05 | Slot row key | slot start time; slot minute | OUT | plan rows `time`, `slot_minute` | plan | OUT line 1893–1894 | verified | plan_slot.slot_start |
| PB-PLAN-06 | Slot state (planned action) | enum: Demand, Charging, Freeze charging, Hold charging, No Charge, Exporting, Freeze exporting, Hold exporting, Hold for car, both charge+export in one slot | OUT | plan rows `state`, `state_target`, `state_override` (manual), `state_mixed` | plan | PC (State column); WD §Predbat status; OUT | verified | plan_slot.action |
| PB-PLAN-07 | Slot limit | % SoC at end of slot; reduced-rate fraction (low power) | OUT | plan rows `show_limit`; Limit column | plan | PC (Limit %) | verified | plan_slot.charge_limit_pct / export_limit_pct |
| PB-PLAN-08 | Charge limit encoding | % or kWh; 0 = no charge; freeze charge = limit at reserve | rule | optimiser arrays | plan | PL line 1409, 3853 | verified | charge_limit_pct sentinel 0 |
| PB-PLAN-09 | Export instruction encoding | (mode target / freeze / idle, target %, power fraction); legacy number 99 = freeze, 100 = off | rule | export limit tuple | plan | UT §Export limit encoding; CONST | verified | export_limit_pct sentinel 100 (no freeze, no power) |
| PB-PLAN-10 | Slot reasons | code + parameters from 21 templates (e.g. charge_low_rate {target_percent, rate_kw, rate}, export_high_rate, manual_override_*, status_warning) | OUT | plan rows `reasons`; raw plan `reason_templates` | plan | OUT `REASON_TEMPLATES` | verified | — |
| PB-PLAN-11 | Slot PV forecast | kWh (central, PV10) | OUT | plan rows `pv_forecast`, `pv_forecast10` | plan | PC; OUT | verified | plan_slot.pv_kwh |
| PB-PLAN-12 | Slot load forecast | kWh (central, PV10 case) | OUT | plan rows `load_forecast`, `load_forecast10` | plan | PC; OUT | verified | plan_slot.load_kwh |
| PB-PLAN-13 | Slot external load | kWh (from `load_forecast`) | OUT | plan rows `extra_load` (Xload) | plan | PC; OUT | verified | — |
| PB-PLAN-14 | Slot SoC | % at slot start; change; direction | OUT | plan rows `soc_percent`, `soc_change`, `soc_sym` | plan | PC (SoC %); OUT | verified | plan_slot.soc_end_kwh |
| PB-PLAN-15 | Slot cost and running total | £ in slot; £ running total since midnight incl. standing charge | OUT | plan rows `cost_change`, `total_cost` | plan | PC (Cost, Total); OUT | verified | plan_slot.cost_p |
| PB-PLAN-16 | Slot carbon | g/kWh; change; kg running total | OUT | plan rows `carbon_intensity`, `carbon_change`, `total_carbon` | plan | PC (CO2); OUT | verified | — |
| PB-PLAN-17 | Split slot | time an export starts inside a slot | OUT | plan rows `split` | plan | OUT; REASON_TEMPLATES demand_before_export_* | verified | plan_slot.start_offset_min |
| PB-PLAN-18 | Plan totals | total cost, PV, load, clipped, extra load, car, end SoC %, iBoost, carbon | OUT | raw plan `totals` | plan | OUT line 2043 | verified | — |
| PB-PLAN-19 | Best charge windows | next start, end, limit % and kWh; attrs all future windows and limits | OUT | `predbat.best_charge_start`, `best_charge_end`, `best_charge_limit`, `best_charge_limit_kw` | plan | OD §Best Prediction data | verified | (derived from plan_slot) |
| PB-PLAN-20 | Best export windows | next start, end, limit % and kWh; attrs all future exports | OUT | `predbat.best_export_start`, `best_export_end`, `best_export_limit`, `best_export_limit_kw` | plan | OD §Best Prediction data | verified | (derived) |
| PB-PLAN-21 | Base windows (what the inverter is set to now) | same fields | OUT | `predbat.charge_start`, `charge_end`, `charge_limit`, `charge_limit_kw`, `export_start`, `export_end`, `export_limit`, `export_limit_kw` | plan | OD §Baseline data; source entity list | verified | — |
| PB-PLAN-22 | Status debug arrays | windows and limits in kWh | OUT | `predbat.status` attr `Debug` | plan | OD §Basic status | verified | — |
| PB-PLAN-23 | Cost metric per scenario | p total + 5-min series: base, best, base10, best10 | OUT | `predbat.metric`, `best_metric`, `base10_metric`, `best10_metric` | plan | OD §Baseline, §Best, §PV 10% | verified | plan_run.metric_base / metric_best / metric_best10 |
| PB-PLAN-24 | Predicted SoC series | kWh, 5-min (base, best, base10, best10) | OUT | `predbat.soc_kw`, `soc_kw_best`, `soc_kw_base10`, `soc_kw_best10` | plan | OD | verified | plan_slot.soc_end_kwh |
| PB-PLAN-25 | SoC checkpoints | kWh at +1 h, +8 h, +12 h | OUT/HIST | `predbat.soc_kw_best_h1`, `_h8`, `_h12` | plan | OD §Best Prediction data | verified | — |
| PB-PLAN-26 | Lowest SoC and when | kWh + time (base, best) | OUT | `predbat.soc_min_kwh`, `best_soc_min_kwh` | plan | OD | verified | — |
| PB-PLAN-27 | Battery hours left | hours (base, best) | OUT | `predbat.battery_hours_left`, `best_battery_hours_left` | plan | OD | verified | — |
| PB-PLAN-28 | Import and export energy | kWh + slot attrs (base, best, base10, best10) | OUT | `predbat.import_energy`, `export_energy`, `best_*`, `base10_*`, `best10_*` | plan | OD | verified | plan_slot.import_kwh / export_kwh |
| PB-PLAN-29 | Import split | kWh into battery vs used by house | OUT | `predbat.import_energy_battery`, `import_energy_house`, `best_import_energy_battery`, `best_import_energy_house` | plan | OD | verified | — |
| PB-PLAN-30 | PV energy | kWh (base, best, base10, best10) | OUT | `predbat.pv_energy`, `best_pv_energy`, `base10_pv_energy`, `best10_pv_energy` | plan | OD | verified | plan_slot.pv_kwh |
| PB-PLAN-31 | Power series | W now + kW per 5 min | OUT | `predbat.battery_power_best`, `grid_power_best`, `pv_power_best`, `load_power_best` | plan | OD §Best Prediction data | verified | — |
| PB-PLAN-32 | Battery throughput | kWh (base, best) | OUT | `predbat.battery_cycle`, `battery_cycle_best` | plan | OD | verified | — |
| PB-PLAN-33 | Carbon predicted and actual | g; g/kWh now; today, yesterday, total | OUT/HIST | `predbat.carbon`, `carbon_best`, `carbon_now`, `carbon_today`, `carbon_yesterday`, `carbon_total` | plan / daily | OD §Carbon data | verified | — |
| PB-PLAN-34 | Actual cost so far | p today (net, import, export); last hour; p/kWh today and last hour | OUT/HIST | `predbat.cost_today`, `cost_today_import`, `cost_today_export`, `cost_hour`, `ppkwh_today`, `ppkwh_hour` | 5m | OD §Other rate entities | verified | — |
| PB-PLAN-35 | Yesterday's cost | p | OUT/HIST | `predbat.cost_yesterday` | daily | OD §Cost saving data | verified | — |
| PB-PLAN-36 | Savings | p yesterday vs baseline (real and adjusted), vs no PV/battery; running totals; carried baseline SoC | OUT/HIST/STATE | `predbat.savings_yesterday_predbat` (`saving_real`, `saving_adjusted`), `savings_yesterday_pvbat`, `savings_total_actual`, `savings_total_predbat`, `savings_total_pvbat`, `savings_total_soc` | daily | OD §Cost saving data | verified | — |
| PB-PLAN-37 | "Yesterday without Predbat" simulation | per-slot plan for the baseline | OUT | Plan view, 'Yesterday without Predbat' | daily | WI §Plan View | verified | — |
| PB-PLAN-38 | Marginal cost matrix | p/kWh per extra-load level (1, 2, 4, 8 kWh) × time window; grid import/export per window; baseline metric | OUT | `sensor.predbat_marginal_energy_costs` | plan | OD §Marginal energy cost data | verified | — |
| PB-PLAN-39 | Marginal cheap / moderate flags | bool × 8 (thresholds 1.2 × min; max(0.5 × max, 1.5 × min)) | OUT | `binary_sensor.predbat_marginal_rate_now_{low,med,high,ev}_is_{cheap,moderate}` | plan | OD | verified | — |
| PB-PLAN-40 | Current activity flags | bool | OUT | `binary_sensor.predbat_charging`, `binary_sensor.predbat_exporting`, `binary_sensor.predbat_demand` (code only) | 5m | AY §Triggers; OD §Battery status; source entity list | verified | — |
| PB-PLAN-41 | Raw plan JSON | rows + totals (fields above) | OUT | `predbat.plan_html` attribute `raw` | plan | OD §Viewing the Predbat plan; OUT line 2051 | verified | plan_run + plan_slot |

### PB-CTRL: commands issued, read-back, write limits

| ID | Item | Type / unit | Dir | Origin in Predbat | Changes | Src | Status | PD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-CTRL-01 | Mode gates writes | Monitor: no control; SoC only: target only; Control charge: no export windows; Control charge & discharge: all | CTRL rule | `select.predbat_mode` | ~rare | CU §Predbat mode | verified | site.mode |
| PB-CTRL-02 | Read-only and hand-back | bool; changing mode or read-only resets the inverter (charge and discharge disabled, full rates, default reserve) | CTRL | `switch.predbat_set_read_only` | ~rare | CU §Predbat mode | verified | site.mode 'read_only' |
| PB-CTRL-03 | Charge window write | start/end; enable | CTRL | `adjust_charge_window` → PB-INV-64/65 | on change | INV; AY §Schedule | verified | inverter_command.desired.charge_window |
| PB-CTRL-04 | Target SoC write | % | CTRL | `adjust_battery_target` → `charge_limit` (+ `charge_limit_enable`) | on change | INV; AY | verified | desired.target_soc |
| PB-CTRL-05 | Reserve write | % (capped by `inverter_reserve_max`) | CTRL | `adjust_reserve` → `reserve` | on change | INV; AY | verified | desired.reserve |
| PB-CTRL-06 | Charge and discharge rate write | W (or A via `battery_voltage`, `current_dp`) | CTRL | `adjust_charge_rate`, `adjust_discharge_rate` | on change | INV; IS §output_charge_control | verified | desired.charge_rate_w |
| PB-CTRL-07 | Export window write | start/end; enable; target % | CTRL | `adjust_force_export` → PB-INV-66/67/68 | on change | INV; AY | verified | desired.export_window |
| PB-CTRL-08 | Work mode write | enum | CTRL | `adjust_inverter_mode` | on change | INV | verified | desired.mode |
| PB-CTRL-09 | Pause write | mode; start/end | CTRL | `adjust_pause_mode` | on change | INV; IS §has_timed_pause | verified | desired.freeze |
| PB-CTRL-10 | Idle window write | start/end | CTRL | `adjust_idle_time` | on change | INV; IS §has_idle_time | verified | — |
| PB-CTRL-11 | Immediate current control | A | CTRL | `adjust_charge_immediate`, `adjust_export_immediate` | on change | INV; IS §charge_control_immediate | verified | — |
| PB-CTRL-12 | Commit button | button / switch entity | CTRL | `charge_discharge_update_button`, `charge_update_button`, `discharge_update_button`, `schedule_write_button` | on change | AY §Schedule | verified | — |
| PB-CTRL-13 | HA service calls | service + data {device_id, power, target_soc, charge_start_time, charge_end_time}, `target`, `repeat` | CTRL | `charge_start_service`, `charge_stop_service`, `charge_freeze_service`, `discharge_start_service`, `discharge_stop_service`, `discharge_freeze_service` | on change | AY §Service API; IS §has_service_api | verified | — |
| PB-CTRL-14 | MQTT commands | topics `<topic>/set/reserve`, `target_soc`, `charge_rate`, `discharge_rate`, `charge`, `discharge`, `auto` with payloads | CTRL | `mqtt_topic` | on change | AY §MQTT API; IS §has_mqtt_api | verified | — |
| PB-CTRL-15 | Read-back after write | poll delay s (GE 10); retries and backoff; rate tolerance (step % of capacity; 5 % of ceiling) | CTRL | `write_and_poll_*` methods; PB-CAP-29/30/31 | per write | IS §write_and_poll_sleep, §rate_step_percent_of_capacity; INV | verified | inverter_command.status 'acked' |
| PB-CTRL-16 | Cloud write limits | min seconds between writes (AlphaESS 300; endpoints 1 per 24 h); API delay s; 15-min grid snapping; 1–5 min apply lag | CTRL | `alphaess_min_write_interval`, `alphaess_api_delay`, `hanchu_min_write_interval`, `hanchu_api_delay` | install | AY §AlphaESS Cloud Configuration | verified | — |
| PB-CTRL-17 | Register write counter | int, lifetime, all inverters | OUT | `predbat.inverter_register_writes` | per write | OD §Inverter data | verified | — |
| PB-CTRL-18 | Control conflicts | count (24 h); per change: control, what Predbat set, what it now reads; sustained controls | OUT | `predbat.control_conflicts` | 5m | WI §Metrics View; PB line 1403 | verified | — |
| PB-CTRL-19 | Control failures | count (24 h) + events {inverter, mode, slot times, requested W, measured W, minutes not following}; `by_mode`; lifetime total | OUT | `predbat.control_failures`, `predbat.control_failures_total` | per slot | OD §Control failure data | verified | — |
| PB-CTRL-20 | Failure rule | check 5 min into slot; < 25 % of requested rate, or > 200 W wrong way in freeze; 3 readings in a row | rule | — | install | OD §Control failure data | verified | — |
| PB-CTRL-21 | Balance writes | rate change only if ≥ 5 % of max | CTRL rule | balance inverters | 5m | CU §Balance Inverters | verified | — |
| PB-CTRL-22 | Battery hold for car / diverter | discharge rate 0 while car charges (unless allowed) or iBoost active (if set) | CTRL | `car_charging_from_battery`, `iboost_prevent_discharge` | event | CC §Additional; CU §iBoost | verified | — |
| PB-CTRL-23 | EV charger start/stop | command per charger | CTRL | `ohme_control`, `wallbox_control`, `hypervolt_control`, `ge_cloud_evc_control`, `myenergi_zappi_control` | event | AY §Car Charging Integration; CO | verified | — |
| PB-CTRL-24 | Axle stand-aside | read-only for the event | CTRL | `axle_control` | event | ER §Axle VPP | verified | — |
| PB-CTRL-25 | Calibration pause | no control for that inverter while calibrating | CTRL rule | `battery_calibration` | event | AY §Battery Information | verified | — |
| PB-CTRL-26 | Clock check | skew minutes; warn ≥ 5, error ≥ 30 (triggers auto-restart) | CTRL | `inverter_time` vs host | 5m | AY §Clock skew | verified | — |
| PB-CTRL-27 | Auto-restart commands | list of {shell} or {service, app, entity_id} | CTRL | `auto_restart` | install | AY §Automatic restarts | verified | — |
| PB-CTRL-28 | Re-plan triggers | entity list; `car_charging_now` polled 15 s | CTRL | `watch_list` | install | AY §Watch List | verified | — |
| PB-CTRL-29 | Force a run now | bool (also shows busy) | CTRL | `switch.predbat_active` | event | OD §Basic status | verified | — |
| PB-CTRL-30 | Override apps.yaml values at runtime | command strings `cmd(index)?k=v&…`; allowed keys: `rates_import_override`, `rates_export_override`, `inverter_limit`, `export_limit`, `days_previous`, `days_previous_weight`, `inverter_battery_rate_min`, `inverter_reserve_max`, `battery_rate_max`, `car_charging_soc`, `car_charging_limit`, `car_charging_battery_size`, `battery_scaling`, `forecast_hours`, `import_export_scaling`, `inverter_limit_charge`, `inverter_limit_charge_dc`, `inverter_limit_discharge` | CFG/CTRL | `select.predbat_manual_api` | event | MA; CFG `CONFIG_API_OVERRIDE` | verified | — |

### PB-DIAG: status, logs, history of predictions vs actuals

| ID | Item | Type / unit | Dir | Origin in Predbat | Changes | Src | Status | PD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-DIAG-01 | Run status | text; attrs Last updated, Version, Error, `run_state`, Debug | OUT | `predbat.status` | 5m | OD §Basic status | verified | plan_run.status |
| PB-DIAG-02 | Status vocabulary | Demand, Demand (Holiday), Charging, Freeze charging, Hold charging, No Charge, Exporting, Freeze exporting, Demand [Freeze exporting], Hold exporting, Cross-charging, Hold for car, Hold for iBoost, Read-Only, Read-Only (Axle), Calibration, Error, "Warn: … [state]", "[Alert]" suffix | OUT | `predbat.status` | event | WD §Predbat status | verified | — |
| PB-DIAG-03 | Executed status per past slot | per slot since midnight yesterday; warning flag | HIST | Plan "History" view | 5m | WI §Plan View | verified | — |
| PB-DIAG-04 | Where the History view gets its data | HA recorder history of Predbat entities (assumed) | HIST | — | — | not stated in fetched docs | unverified | — |
| PB-DIAG-05 | Prediction checkpoints for accuracy | SoC +1/+8/+12 h; PV forecast now vs actual; Load ML now/+1 h/+8 h | HIST | `soc_kw_best_h1/_h8/_h12`, `sensor.predbat_pv_forecast_h0`, Load ML chart | 5m | OD; WI §Charts View (PVAccuracy, PV7, Load ML) | verified | forecast_fact 'core_plan' (PD1) |
| PB-DIAG-06 | Debug dump | full config + inputs + outputs as YAML, secrets removed; switch auto-off after 2 h | OUT | `switch.predbat_debug_enable`; `debug/predbat_debug_HH_MM_SS.yaml` | event | CU §Debug | verified | — |
| PB-DIAG-07 | Rolling debug history | enable (on); count (15, 1–500); interval h (3, 1–24); force capture; 2–5 MB per snapshot | CFG/OUT | `switch.predbat_debug_history_enable`, `input_number.predbat_debug_history_count`, `_interval`, `switch.predbat_debug_history_force_capture`; `predbat_debug_<timestamp>.yaml.txt` | 3 h | CU §Debug history | verified | — |
| PB-DIAG-08 | Log file | `predbat.log`, rotated at 10 MB; files kept (10, 2–100) | OUT | `log_count` | continuous | AY §log_count | verified | event_log |
| PB-DIAG-09 | API health | requests, failures, last call per provider; Solcast calls | OUT | Metrics view; e.g. Kraken `account_status` attrs `requests_total`, `failures_total` | 30 s view refresh | WI §Metrics View; CO §kraken | verified | — |
| PB-DIAG-10 | Component health | bool | OUT | `binary_sensor.predbat_components_healthy` | 5m | CO §kraken | verified | — |
| PB-DIAG-11 | Dispatch timeline | per car, 30-min characters −4 h…+24 h; SoC/target; plugged | OUT | log line "Octopus: Dispatch timeline" | 30 min + on change | CC §Reading the dispatch timeline | verified | — |
| PB-DIAG-12 | Last start time | timestamp | OUT | `predbat.last_started` | event | OUT line 2971 | verified | — |
| PB-DIAG-13 | Settings snapshots | YAML files in `/config/predbat_save/`; `previous.yaml` before restore | STATE | `select.predbat_saverestore` | event | CU §Saving and restoring | verified | — |
| PB-DIAG-14 | Predbat's own history database | enable; days kept (30); mirror HA; use as primary | CFG | `db_enable`, `db_days`, `db_mirror_ha`, `db_primary` | install | CO §db, §ha | verified | — |
| PB-DIAG-15 | Log redaction list | list of strings; name→value map | CFG | `redact_strings`, `redact_strings_labelled` | ~rare | CFG; APY | verified | — |

---

## 3. PredHeat catalogue

PredHeat is configured in a `predheat:` block inside Predbat's `apps.yaml` and switched on by `switch.predbat_predheat_enable`. It runs every 5 minutes, simulates the house in 5-minute steps for `forecast_days`, and publishes predictions. **It issues no commands** (PH: "Future versions will also offer … master mode").

| ID | Item | Type / unit | Dir | Origin | Changes | Src | Status | PD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PH-CFG-01 | PredHeat on/off | bool (off) | CFG | `switch.predbat_predheat_enable` | ~rare | PH §Installation guide; CFG | verified | — |
| PH-CFG-02 | Heat source type | enum gas / pump (code default pump; template gas) | CFG | `predheat.mode` | install | PH §Configuration guide; PHPY line 591 | verified | — |
| PH-CFG-03 | Forecast length | days (2) | CFG | `predheat.forecast_days` | ~rare | PHT; PHPY line 566 | verified | — |
| PH-CFG-04 | Run interval | minutes (5) | CFG | `predheat.run_every` | ~rare | PH; PHT | verified | — |
| PH-CFG-05 | History days | list of int ([7]) | CFG | `predheat.days_previous` | ~rare | PHT; PHPY line 575 | verified | — |
| PH-CFG-06 | History day weights | list of float (1 each) | CFG | `predheat.days_previous_weight` | ~rare | PHPY line 576 | verified | — |
| PH-CFG-07 | Entity prefix | string ("predheat") | CFG | `predheat.prefix` | install | PHPY line 181 | verified | — |
| PH-CFG-08 | Time zone | IANA (Europe/London), from Predbat top level | CFG | `timezone` | install | PHPY line 564 | verified | site.timezone |
| PH-SEN-01 | Outside temperature | °C, history (smoothed) | LIVE/HIST | `predheat.external_temperature` | ~5m | PH; PHPY line 583 | verified | — |
| PH-SEN-02 | Inside temperature | °C, one or more sensors, averaged; history | LIVE/HIST | `predheat.internal_temperature` (list) | ~5m | PH; PHPY line 584 | verified | — |
| PH-SEN-03 | Thermostat set-point | °C history (sensor or fixed); future set-points are replayed from `days_previous` days ago (default 20 °C) | HIST | `predheat.target_temperature` | event | PH; PHPY line 263–290, 585 | verified | — |
| PH-SEN-04 | Heating energy | kWh, incrementing; scaling factor (code 1.0, template 1.4) | HIST | `predheat.heating_energy`, `predheat.heating_energy_scaling` | ~5m | PH; PHT; PHPY line 581, 586 | verified | — |
| PH-SEN-05 | Heating on now | bool (sensor or value; used for the first step only) | LIVE | `predheat.heating_active` | event | PHT; PHPY line 609, 388 | verified | — |
| PH-SEN-06 | Flow temperature set-point | °C (sensor or fixed; default 40) | LIVE/CFG | `predheat.flow_temp` | ~rare | PH; PHPY line 592 | verified | — |
| PH-SEN-07 | Radiator water temperature | °C sensor near the internal sensor (optional) | LIVE | `volume_temp` (read from top level, see 1.4) | ~5m | PH; PHPY line 610 | verified | — |
| PH-SEN-08 | History available | days (min over the four sensors) | STATE | computed `minute_data_age` | 5m | PHPY line 587 | verified | — |
| PH-WX-01 | Weather forecast entity | HA `weather.*`; service `weather/get_forecasts` type hourly; fields `temperature`, `datetime` | LIVE | `predheat.weather` | fetched each run (5m); hourly resolution | PH §Weather install; PHPY line 186–201 | verified | — |
| PH-WX-02 | Weather compensation curve | map outside °C → flow °C; must include −20 and 20 | CFG | `predheat.weather_compensation` | install | PH §Weather Compensation; PHPY line 147–151 | verified | — |
| PH-MOD-01 | House heat loss | W per °C inside-outside (code 100; template 120) | CFG | `predheat.heat_loss_watts` | ~rare | PH; PHT; PHPY line 598 | verified | — |
| PH-MOD-02 | Cooling rate | °C per hour per °C difference (code 0.02; template 0.03) | CFG | `predheat.heat_loss_degrees` | ~rare | PH; PHPY line 599 | verified | — |
| PH-MOD-03 | House thermal capacity (derived) | Wh per °C = heat_loss_watts / heat_loss_degrees | STATE | `watt_per_degree` | plan | PHPY line 601 | verified | — |
| PH-MOD-04 | Static heat gains | W (0; template 200) | CFG | `predheat.heat_gain_static` | ~rare | PH; PHPY line 600 | verified | — |
| PH-MOD-05 | Radiator output at ΔT50 | W (code 7000; template 17000) | CFG | `predheat.heat_output` | install | PH; PHPY line 602 | verified | — |
| PH-MOD-06 | Water volume (radiators + pipes) | litres (code 200; template 75) | CFG | `predheat.heat_volume` | install | PH; PHPY line 603 | verified | — |
| PH-MOD-07 | Heat source max output | W (30000) | CFG | `predheat.heat_max_power` | install | PH; PHPY line 604 | verified | — |
| PH-MOD-08 | Heat source min output | W (7000) | CFG | `predheat.heat_min_power` | install | PH; PHPY line 605 | verified | — |
| PH-MOD-09 | Nominal COP / efficiency | factor (code 0.9; gas 1.0, pump ~4.0) | CFG | `predheat.heat_cop` (docs say `heating_cop`) | install | PH; PHT; PHPY line 606 | verified | — |
| PH-MOD-10 | Flow difference for full power | °C (code 20 gas / 5 pump; template 40) | CFG | `predheat.flow_difference_target` | install | PH; PHPY line 593–596 | verified | — |
| PH-MOD-11 | Thermostat hysteresis on / off | °C (0.5 / 0.1) | CFG | `predheat.hysteresis`, `predheat.hysteresis_off` | ~rare | PH; PHPY line 131–132 | verified | — |
| PH-MOD-12 | Smart thermostat (pre-heat) | bool (code off; template on) | CFG | `predheat.smart_thermostat` | ~rare | PH; PHPY line 607 | verified | — |
| PH-MOD-13 | Max pre-heat lead time | minutes (unset = uncapped) | CFG | `predheat.smart_thermostat_max_minutes` | ~rare | PH; PHPY line 544–556 | verified | — |
| PH-MOD-14 | ΔT correction table | map ΔT °C → factor (16 default points 0–75) | CFG | `predheat.delta_correction` | ~rare | PH; PHT; PHPY line 76 | verified | — |
| PH-MOD-15 | Gas boiler efficiency table | map return °C → efficiency (11 default points) | CFG | `predheat.gas_efficiency` | ~rare | PH; PHT; PHPY line 77 | verified | — |
| PH-MOD-16 | Heat pump COP table | map outside °C → COP (21 default points, −20…20) | CFG | `predheat.heat_pump_efficiency` | ~rare | PH; PHT; PHPY line 78 | verified | — |
| PH-MOD-17 | Model constants | 5-min step; 1.16 Wh per litre per °C; max increment 100 | rule | code constants | install | PHPY line 28–29, 308 | verified | — |
| PH-RATE-01 | Energy price used | p/kWh per minute: Predbat gas rates in gas mode, Predbat import rates in pump mode | LIVE | Predbat `rate_gas` (PB-RATE-05/12) or `rate_import` | per Predbat cycle | PH §Configuration guide; PHPY line 621–624 | verified | tariff_rate |
| PH-RATE-02 | Standalone rate keys (archived only) | `metric_octopus_import` (gas), `metric_standing_charge`, `rates_import`, `rates_import_octopus_url` | CFG | archived `pred_heat:` block | n/a | PHA `apps.yaml`, `predheat.py` | verified (archived) | — |
| PH-STATE-01 | Carried water temperature | °C (−20…40, 20) | STATE | `input_number.predbat_next_volume_temp` (`expose_config`) | 5m | PH; CFG; PHPY line 632–635 | verified | — |
| PH-STATE-02 | Heating energy so far today | kWh | STATE | computed from `heating_energy` | 5m | PHPY line 589 | verified | — |
| PH-OUT-01 | Predicted inside temperature | °C now + `results` series (10-min) | OUT | `predheat.internal_temp` | 5m | PHPY line 481–485 | verified | — |
| PH-OUT-02 | Outside temperature used | °C + `results` | OUT | `predheat.external_temp` | 5m | PHPY line 486–490 | verified | — |
| PH-OUT-03 | Set-point used (incl. pre-heat) | °C + `results` | OUT | `predheat.target_temp` | 5m | PHPY line 491–493 | verified | — |
| PH-OUT-04 | Heating demand flag as temperature | °C target while heating, 0 when off; `results` | OUT | `predheat.heat_to_temp` | 5m | PHPY line 494 | verified | — |
| PH-OUT-05 | Inside temperature checkpoints | °C at +1, +2, +8 h | OUT | `predheat.internal_temp_h1`, `_h2`, `_h8` | 5m | PHPY line 495–497 | verified | — |
| PH-OUT-06 | Predicted heating energy | kWh today + `results`; `external` list [{last_updated, energy}] for Predbat | OUT | `predheat.heat_energy` | 5m | PHPY line 498–502; PH §Link Predheat to Predbat | verified | — |
| PH-OUT-07 | Energy checkpoints | kWh at +1, +2, +8 h | OUT | `predheat.heat_energy_h1`, `_h2`, `_h8` | 5m | PHPY line 503–505 | verified | — |
| PH-OUT-08 | Water temperature series | °C next + `results` | OUT | `predheat.volume_temp` | 5m | PHPY line 506 | verified | — |
| PH-OUT-09 | Predicted heating cost | p + `results`; +1, +2, +8 h | OUT | `predheat.cost`, `cost_h1`, `cost_h2`, `cost_h8` | 5m | PHPY line 507–510 | verified | — |
| PH-OUT-10 | Heating cost so far today | p + `results` | OUT/HIST | `predheat.cost_today` | 5m | PHPY line 540 | verified | — |
| PH-LINK-01 | Feed heating energy into Predbat load | `sensor$attribute` | CFG | Predbat `load_forecast: predheat.heat_energy$external` | install | PH §Link Predheat to Predbat; AY §Load Forecast | verified | — |
| PH-LINK-02 | Remove heat-pump energy from house load history | kWh incrementing sensor | CFG | Predbat `car_charging_energy` | install | PH §Exclude Heat Pump load | verified | load_history.car_kwh |
| PH-CTRL-01 | Heating control | none: PredHeat writes nothing to the heating system | — | — | — | PH §Operation | verified | — |
| PH-DIAG-01 | Warnings | status text when weather or history cannot be fetched; log lines per run | OUT | Predbat `record_status` / log | 5m | PHPY line 199–201, 240–241 | verified | event_log |
| PH-DIAG-02 | Standalone status entity (archived only) | text | OUT | `predheat.status` | n/a | PHA `predheat.py` | verified (archived) | — |

**Asked for but not found in PredHeat** (not catalogued as requirements): degree days; an explicit heating schedule (the schedule is only the replayed `target_temperature` history); an explicit thermal-mass parameter (only the derived PH-MOD-03); heat-pump flow/return or outdoor-unit sensors; hot-water (DHW) modelling; gas standing charge in the integrated version.

---

## 4. Entity relationship of requirements (plain text)

```text
SITE  (time zone, location, currency, slot length, horizon, plan-length, mode, read-only)
 |
 +-- INVERTER 1..N  (type -> CAPABILITY PROFILE; serial; AC/export/charge/discharge/DC limits;
 |    |              clock skew; sign conventions; endpoints; CREDENTIAL)
 |    +-- BATTERY   (capacity + scaling + measured capacity; losses; rate scalings;
 |    |              charge/discharge curves; temperature curves; reserve min/max)
 |    +-- LIVE TELEMETRY every 5 min (SoC kWh/%, battery/PV/load/grid power, temperature,
 |    |              calibration flag, inverter clock)  -> kept as HISTORY (curves, capacity)
 |    +-- CONTROL REGISTERS (reserve, rates, target SoC, charge/export windows + enables,
 |                   mode, pause, idle)  read every cycle, written on change
 |                   -> COMMAND (desired vs read-back, write count, conflicts, failures)
 |
 +-- ENERGY HISTORY (load/import/export/PV today, incrementing kWh, >= days_previous days;
 |                   energy to subtract: EV, heat pump, diverter; holiday-days history)
 |
 +-- TARIFF  import / export / gas  (sensor, URL, bands, Kraken; standing charge; region)
 |    +-- RATE per slot, versioned by fetch (+ overrides, manual slot rates, future offsets,
 |    |                  Nord Pool / AgilePredict estimates, provenance flag)
 |    +-- EVENTS (saving session, free session, Axle, IOG dispatch planned/completed,
 |                EDF free hours) -> change rates and load scaling for their slots
 |
 +-- PV ARRAY 1..K (kWp, azimuth, tilt, efficiency, location, provider + key)
 |    +-- PV FORECAST issue per fetch: per-slot PV10/PV50/PV90 (+ calibrated)
 |    +-- CALIBRATION: 7 days of provider forecast vs actual -> scaling factors
 |
 +-- CAR 1..M (battery size, limit, SoC, rate, loss, ready time, plug/charging sensors,
 |             charger integration, IOG target)  -> CAR PLAN slots, car cost, tracked SoC
 |
 +-- DIVERTER (iBoost settings, energy sensor)  -> diverter plan, active signal
 |
 +-- SETTINGS (~180 Predbat entities: weights, scalings, thresholds, toggles; each with
 |             default, range, expert gating) + MANUAL SLOT OVERRIDES (+ value) + MANUAL API
 |
 +-- REGION FEEDS (carbon intensity, weather alerts, outside temperature forecast)
 |
 +-- PLAN RUN every ~10 min (time, horizon, context, metrics base/best/base10/best10, status)
 |    +-- PLAN SLOT (time, rates + provenance, state, limit, reasons, PV, load, extra load,
 |    |              car, diverter, SoC, cost, running total, carbon, split time)
 |    +-- WINDOWS (best/base charge + export start/end/limit) -> drive COMMANDS
 |    +-- SERIES (SoC, power, energy totals per scenario) + CHECKPOINTS (+1/+8/+12 h)
 |
 +-- OUTCOMES daily (cost, savings vs baselines, carbon, car cost, compare-tariff results)
 |
 +-- DIAGNOSTICS (status history, log, debug snapshots, API health, control failures)
 |
 +-- HEAT MODEL (PredHeat, optional)
      HOUSE (heat loss W/degC, cooling degC/h/degC, static gains)
      EMITTERS (radiator output at dT50, water volume, dT correction table)
      HEAT SOURCE (gas/pump, max/min output, COP, efficiency tables, flow temp,
                   weather compensation curve)
      SENSORS (inside, outside, set-point, heating energy, heating on) + WEATHER forecast
      -> HEAT RUN outputs (temperatures, energy, cost series; carried water temp)
      -> feeds SITE load forecast; heat-pump energy is subtracted from ENERGY HISTORY
```

---

## 5. Not data: excluded items

| Item | Origin | Why excluded |
| --- | --- | --- |
| Entity prefix, `template: true` guard | `prefix`, `template` | Home Assistant naming and a "not configured yet" switch |
| HA connection | `ha_url`, `ha_key` | Plumbing to Home Assistant |
| Web port, web interface views, dark mode, Docs view | `web_port`; WI | UI |
| Plan HTML and text, colours, symbols, plan card, Apex charts | `predbat.plan_html` `html`/`text` attrs; PC; creating-charts | Presentation of data already listed in PB-PLAN (raw JSON kept) |
| Plan debug columns | `switch.predbat_plan_debug` | UI debug view |
| Notifications | `notify_devices`, `switch.predbat_set_status_notify`, `_inverter_notify`, `_event_notify`, `_system_notify` | Messaging, not planning data |
| Threads and C++ kernel | `threads`, `prediction_kernel_enable` | Speed only; docs say results are identical |
| Config validation retries | `validate_config_retries`, `validate_config_retry_minutes` | Start-up plumbing |
| Software update | `update` entity, `select.predbat_update`, `switch.predbat_auto_update`, `predbat_repository` | Software lifecycle |
| AI chat and MCP | `chat` block, `switch.predbat_chat_confirm_writes`, `_chat_web_search`, `_ai_ha_state_enable`, MCP component | Assistant UI |
| Regex auto-discovery and template notation | `re:` patterns, `{geserial}`, `{}`/`+[]` in `watch_list` | How HA entity names are found, not data |
| Dummy and mirrored entities | `sensor.predbat_ge_N_*`, `sensor.predbat_givtcp_<n>_*` | Copies of inverter values Predbat itself does not read |
| GivTCP energy dashboard totals | `sensor.predbat_givtcp_<n>_*_total` | Docs: "Nothing in Predbat reads these" |
| Debug-mode convenience | `battery_power_debug` etc. entities | Internal debug mirrors (not documented) |
| What-If annual tool, hub live display, discovery catalogue, plugins, REST API page | docs pages | Out of scope for the planner (not read) |
| Kraken API key generator, alphaess bind/unbind switches | WI; AY | One-off account actions |

---

## Appendix A: planning-design fields with no Predbat source

These are in PD1–PD3 but I found no Predbat equivalent in the fetched sources. They may still be good design; they are listed so the schema check does not mistake them for Predbat requirements.

| ID | Field | PD source | Status |
| --- | --- | --- | --- |
| PD-01 | `tenant` (id, name, plan_tier) | PD3 Configuration | unverified (PD only) |
| PD-02 | `site.deployment_mode` (edge / cloud / hybrid), `site.is_active`, `site.next_run_at` | PD3 | unverified (PD only) |
| PD-03 | `credential.secret_ref` (vault pointer), `credential.expires_at` (Predbat has `*_token_expires_at` for some vendors only) | PD3 | unverified (PD only) |
| PD-04 | `edge_agent` (last_seen_at, plan_run_synced, version) | PD3 | unverified (PD only) |
| PD-05 | `plan_run.facts_as_of`, `method_version`, `plan_hash` / `inputs_hash`, `duration_ms` | PD1, PD3 | unverified (PD only) |
| PD-06 | `plan_run.status` values ok / stale_inputs / error and the freshness gate (inputs older than 60 min → Demand-only plan) | PD3 | unverified (PD only) |
| PD-07 | `inverter_command` status pending/sent/acked/failed/skipped, attempts, error, acked_at, `readback_raw_id`, `valid_until` | PD1, PD3 | unverified (PD only; Predbat counts writes and failures instead, PB-CTRL-17/19) |
| PD-08 | `event_log` (level, kind, detail) as a table | PD3 | unverified (PD only; Predbat uses a log file) |
| PD-09 | MQTT topic tree `eb/{tenant}/{site}/{device}/…` | PD1 | unverified (PD only) |
| PD-10 | Release-on-teardown command (cloud) | PD3 | unverified (PD only; nearest Predbat behaviour is the reset in PB-CTRL-02) |
| PD-11 | `plan_slot.rate_w` requested power (null = max) | PD2, PD3 | unverified (PD only; Predbat carries a power fraction in the export tuple, PB-PLAN-09, and low-power rates) |

## Appendix B: counts

| Group | Rows | verified | unverified |
| --- | --- | --- | --- |
| PB-INV | 75 | 75 | 0 |
| PB-CAP | 31 | 31 | 0 |
| PB-RATE | 46 | 46 | 0 |
| PB-PV | 23 | 23 | 0 |
| PB-LOAD | 42 | 42 | 0 |
| PB-CAR | 29 | 29 | 0 |
| PB-OTHER | 84 | 84 | 0 |
| PB-PLAN-OUT | 41 | 41 | 0 |
| PB-CTRL | 30 | 30 | 0 |
| PB-DIAG | 15 | 14 | 1 |
| **Predbat total** | **416** | **415** | **1** |
| **PredHeat total** | **54** | **54** (2 of them archived-only) | **0** |
| Appendix A (planning design only) | 11 | 0 | 11 |
