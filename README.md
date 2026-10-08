# Miner Bridge

Pramoninio lygio IoT mikroservisas ~100+ ASIC kasyklų stebėjimui ir valdymui:
tinklo skenavimas → telemetrija į **TimescaleDB** → **Home Assistant** per MQTT (EMQX) su Auto-Discovery.
Struktūra paruošta HA Local Add-on įpakavimui.

## Architektūra

```
                 ┌──────────────────────── Miner Bridge (Node.js / Express :3000) ────────────────────────┐
 Dashboard  ───► │ public/ (SPA)  ──►  /api/*  ──►  Scanner ──► drivers (cgminer TCP / http-json) ──►     │ ──► kasyklos (LAN)
 (HA Ingress)    │                      /api/stream (SSE) ◄── event bus ◄── Poller (kas 15 s, batch) ──►  │
                 │                                                    │                 │                  │
                 └────────────────────────────────────────────────────┼─────────────────┼──────────────────┘
                                                                      ▼                 ▼
                                                          TimescaleDB (hypertable)   EMQX ◄──► Home Assistant
                                                                                     (discovery, state, komandos)
```

## Failų struktūra

```
config.json            HA add-on manifestas (options/schema, ingress :3000, host_network)
Dockerfile             multi-stage build (node:22-alpine) – add-on ir standalone image
run.sh                 add-on entrypoint
docker-compose.yml     TIK lokaliam kūrimui: TimescaleDB + EMQX
migrations/            NNNN_name.sql – taikomos automatiškai starto metu
public/                Dashboard (vanilla HTML/JS/CSS, santykiniai URL dėl Ingress)
tools/mock-miners.ts   kasyklų simuliatorius (20 vnt. ant 127.0.0.x)
src/
  index.ts             bootstrap: DB → migracijos → MQTT → HTTP → poller, graceful shutdown
  config.ts            env (.env) → /data/options.json → numatytos reikšmės
  api/                 Express serveris, maršrutai, SSE
  db/                  pool, migracijų vykdyklė, repozitorijos
  miners/              driver'iai: cgminer (TCP 4028), http-json; registras
  scanner/             IP rėžio skenavimas su progreso įvykiais
  poller/              polling ciklas, alert'ai, batch įrašymas
  mqtt/                MQTT tiltas + HA discovery payload'ai
  relays/              relių valdymas (HTTP / MQTT)
  services/            DeviceService – įrenginių registras ir komandos
  net/                 IP rėžių parseris, ARP (MAC) paieška
```

## Lokalus paleidimas

Reikia: **Node.js ≥ 20.12** (rekomenduojama 22), **Docker Desktop**.

```bash
npm install
cp .env.example .env          # jau sukonfigūruota lokaliems konteineriams
npm run deps:up               # TimescaleDB (localhost:5442) + EMQX (localhost:1883, UI :18083 admin/public)

# Kitame terminale – kasyklų simuliatorius (pasirinktinai):
npm run mock                  # 20 kasyklų 127.0.0.11–30 (lyginės http-json :8080, nelyginės cgminer :4028)

npm run dev                   # serveris su hot-reload → http://localhost:3000
```

Dashboarde įveskite rėžį `127.0.0.11-30` (arba tikrą, pvz. `192.168.1.1-254`), protokolas **Auto** → **Skenuoti**.
Po ~15 s matrica užsipildys realaus laiko duomenimis.

> macOS: loopback'as turi tik 127.0.0.1 – prieš `npm run mock` pridėkite alias'us:
> `for i in $(seq 11 30); do sudo ifconfig lo0 alias 127.0.0.$i up; done`

Kitos komandos:

| Komanda | Paskirtis |
|---|---|
| `npm run build` / `npm start` | produkcinis build (`dist/`) ir paleidimas |
| `npm run typecheck` | TypeScript patikra |
| `npm run migrate` | migracijos rankiniu būdu (įprastai vyksta automatiškai starte) |
| `npm run deps:down` | sustabdyti DB/EMQX konteinerius |
| `docker build -t miner-bridge .` | add-on image build'as |

MQTT srauto stebėjimas: EMQX dashboard → <http://localhost:18083> → WebSocket Client, prenumeruoti `minerbridge/#` ir `homeassistant/#`.

## Dashboard

Atidaromas per HA Ingress (add-on) arba <http://localhost:3000> (lokaliai). Veikia be interneto: jokių CDN, grafikai yra savas SVG.

| Skirtukas | Paskirtis |
|---|---|
| **Apžvalga** | Parko KPI (hashrate ir % nominalo, kW, J/TH, kasa/kraunasi/offline, kritinės ir įspėjimai, vanduo in→out), 24 h parko hashrate ir galia, „Reikia dėmesio“ sąrašas, kasyklų kortelės. Problemos rodomos raudonai arba gintariškai, su ikona ir priežastimi |
| **Konteineris** | Fizinis planas: spintos (kiekviena – atskiras kontūras su siurbliu) × lentynos (1 – viršuje) × vietos (1 – kairėje). Kiekvienai spintai: hashrate, šilumos apkrova, kontūro įėjimas → išėjimas, **Σ apskaičiuotas debitas prieš reikalaujamą**. Langeliai spalvinami pagal pasirinktą rodiklį. Nepriskirtoms kasykloms: **„Rasti (LED)“** (Vnish `find-miner`) ir „Priskirti vietą…“. Išdėstymas (spintų skaičius, lentynos, vietos, pavadinimai) keičiamas „Nustatymuose“; spintos pavadinimas tampa HA zona (`suggested_area`). |
| **Lentelė** | Visos kasyklos tankiai, rūšiuojama pagal bet kurį stulpelį (tinka 100+ vnt.) |
| **Šilumėlapis** | Visas parkas vienu žvilgsniu: sveikata, % nominalo, hashrate, lustų temp., vanduo out, ΔT, J/TH, galia |
| **Įvykiai** | Būsenų pokyčiai, komandos, klaidos |
| **Aptikimas** | IP rėžio skenavimas |

Paspaudus kasyklą atsidaro detalių langas: 24 h grafikai su slenksčiais (hashrate prieš nominalą, galia, lustų temp., vanduo in/out), grandinių (hash board) lentelė ir veiksmai (restart, reboot, power cycle, pervadinimas, relė).

## Sveikatos vertinimas (health engine)

[src/health/health.ts](src/health/health.ts) yra vienintelė vieta, kur nusprendžiama, kas „blogai“. Jos rezultatą naudoja ir dashboard'as, ir HA
(jutikliai `Health`, `Miner state`, `Hashrate of nominal`, `Errors`). Slenksčiai konfigūruojami (`.env` arba add-on opcijos):

| Taisyklė | Įspėjimas | Kritinė | Kintamieji |
|---|---|---|---|
| Offline, `failure`, grandinė `failure`/`disconnected` | – | ✔ | – |
| Hashrate % nominalo (kasykla ir kiekviena grandinė) po `HASHRATE_GRACE_S` kasimo | < 90 % | < 75 % | `HASHRATE_WARN_PCT`, `HASHRATE_CRIT_PCT` |
| Lustų temperatūra | ≥ 75 °C | ≥ 85 °C | `TEMP_WARN_C`, `TEMP_CRITICAL_C` |
| Vanduo išėjime / įėjime | ≥ 45 °C / ≥ 35 °C | ≥ 50 °C | `WATER_OUT_*`, `WATER_IN_WARN_C` |
| Vandens ΔT (mažas debitas) | ≥ 15 °C | – | `WATER_DELTA_WARN_C` |
| Atmesti share'ai (kai ≥ 100 share'ų) | ≥ 1 % | ≥ 3 % | `REJECT_*` |
| Įstrigo `initializing`/`starting` | > 15 min | – | `STUCK_STARTING_S` |

**Aušinimo debitas (Hydro).** Kasykla debito nematuoja (Vnish turi tik vandens įėjimo ir išėjimo temperatūras), todėl jis
apskaičiuojamas iš šilumos balanso ([src/health/coolant.ts](src/health/coolant.ts)):

`debitas [l/min] = galia [W] / (cp × ρ × ΔT) × 60` (vandeniui cp = 4186 J/(kg·K), ρ = 1 kg/l; etilenglikoliui 30 % – 3730 ir 1,04).

- Skaičiuojama tik kasant, kai galia ≥ `FLOW_MIN_POWER_W` (1000 W) ir ΔT ≥ `FLOW_MIN_DELTA_C` (2 °C). Sustabdyta kasykla šilumos negamina, todėl
  rodoma paskutinė kasant apskaičiuota reikšmė („pask.“, 6 h lange).
- **Privalomas debitas** nustatomas pagal modelį: S21+ / S21 XP / S21 XP+ Hyd. – 8 l/min (Bitmain specifikacija 8,0–10,0 l/min).
  Nežinomiems modeliams naudojama `FLOW_REQUIRED_DEFAULT_LPM` (8), visiems galima nustatyti `FLOW_REQUIRED_LPM`.
- **Debitas mažesnis už privalomą – iš karto kritinė (raudona).** HA jutikliai: `Coolant flow (est.)` ir `Coolant flow required`.
- Tikslumas: įvertis (jutikliai rodo sveikus °C, galia apskaičiuota firmware, laikoma, kad 100 % šilumos patenka į vandenį, todėl debitas
  šiek tiek pervertinamas).
- **Nustatymai dashboard'e** (skirtukas „Nustatymai“): skysčio tipas (vanduo / etilenglikolis / propilenglikolis), koncentracija, tikslios cp ir ρ
  reikšmės (nebūtina), privalomas debitas. Prieš išsaugant rodoma gyva peržiūra (kaip pasikeis kiekvienos kasyklos debitas). Išsaugota reikšmė
  laikoma DB lentelėje `settings`, turi pirmenybę prieš `.env` / add-on opcijas, o 7 dienų debito istorija automatiškai perskaičiuojama.
- **Aušinimo skystis (numatytieji):** `COOLANT_TYPE` (`water` | `ethylene_glycol` | `propylene_glycol`) ir `COOLANT_GLYCOL_PCT` (tūrio %).
  cp ir tankis parenkami iš lentelės (~25 °C, tiesinė interpoliacija). Tikslias skysčio duomenų lapo reikšmes galima nurodyti per
  `COOLANT_CP` / `COOLANT_DENSITY` (0 = automatiškai). Naudojamos savybės rodomos `/api/info` ir debito patarimuose dashboard'e.

**Firmware žurnalas.** Apsaugos suveikimai (perkaitimas, grandinės nutrūkimas) įvyksta ir praeina per sekundes, tarp 15 s apklausų.
Todėl kas `FW_LOG_INTERVAL_S` (60 s) skaitomas kasyklos žurnalas (Vnish `/api/v1/logs/status`). Įvykiai įrašomi į `device_events`
(`source = 'firmware'`, be dublikatų), o per `FW_EVENT_WINDOW_H` (6 h) langą taikomos taisyklės:

| Firmware įvykiai per langą | Lygis |
|---|---|
| 1 perkaitimas | įspėjimas |
| ≥ 2 perkaitimai | kritinė („Kartotinis perkaitimas“) |
| Perkaitimas, o kasykla dabar sustabdyta / failure arba bandymai išnaudoti | kritinė („Sustabdyta po perkaitimo“) |
| Grandinės nutrūkimas 1–2× / ≥ 3× | įspėjimas / kritinė |

Taip sustabdyta ar besiperkraunanti kasykla rodoma raudonai su priežastimi, o ne tik kaip „sustabdyta“.

`auto-tuning`, `initializing` ir `stopped` yra informacinės būsenos (ne klaida). Nominalas yra grandinių `ideal` hashrate suma esamam tuning profiliui.

Simuliatorius (`npm run mock`) turi įmontuotus gedimų scenarijus: autotuning, sugedusią grandinę, degradavusią grandinę, mažą vandens debitą,
perkaitimą ir didelį atmetimų procentą. Taip dashboard'ą galima išbandyti be tikrų gedimų.

## Konfigūracija

Kiekvienas parametras skaitomas tokia tvarka: aplinkos kintamasis (`DB_HOST`) → add-on opcija (`db_host` iš `/data/options.json`) → numatyta reikšmė.
DB galima nurodyti pilnu `DATABASE_URL` (turi pirmenybę) arba atskirais `DB_*` kintamaisiais. Pilnas sąrašas – [.env.example](.env.example).
`MQTT_HOST` nenurodytas → servisas veikia be MQTT (tik DB + dashboard).

## Duomenų bazė

- `devices` – įrenginių registras (ID = MAC be skirtukų → serijinis nr. → `driver_ip` kaip paskutinė išeitis).
- `miner_metrics` – **hypertable** (1 d. chunk'ai, indeksas `(device_id, time DESC)`), suspaudimas po 7 d.,
  retention pagal `RETENTION_DAYS` (taikoma kaskart startuojant).
- `device_events` – būsenų pokyčiai, komandos, klaidos.

Migracijos: naujas failas `migrations/000N_aprasymas.sql` (kitas numeris), idempotentiškas SQL. Taikoma automatiškai
starto metu advisory-lock'u apsaugotoje transakcijoje; jei migracija nepavyksta, serveris **nestartuoja**.

## Home Assistant MQTT

| Topic | Paskirtis |
|---|---|
| `homeassistant/sensor/minerbridge_<id>_<metrika>/config` | discovery (retained); visos metrikos priskirtos vienam `device` |
| `homeassistant/binary_sensor/…_online/config`, `button/…_restart/config`, `switch/…_power/config` | online, komandos, relė |
| `minerbridge/<id>/state` | JSON su visomis metrikomis (kiekvieno poll ciklo metu) |
| `minerbridge/<id>/availability` | `online` / `offline` |
| `minerbridge/bridge/status` | serviso LWT |
| `minerbridge/<id>/command` ← | `restart`, `reboot`, `power_cycle` |
| `minerbridge/<id>/relay/set` ← | `ON` / `OFF` |

Jutikliai kuriami tik toms metrikoms, kurias įrenginys realiai pateikia. Discovery perpublikuojama
prisijungus prie brokerio ir kai HA paskelbia `homeassistant/status = online`.

## Kasyklų protokolai (drivers)

- **vnish** (HTTP :80) – Vnish firmware `xminer-api` (spec: `http://<kasykla>/docs/api-doc.json`). Patikrinta su
  **Antminer S21+ Hydro, Vnish 1.2.7**. Skaitymas be autentifikacijos (`/info`, `/summary`): hashrate, galia, J/TH,
  čipų ir **vandens įėjimo/išėjimo** temperatūros, grandinių būsenos. `restart` (`/mining/restart`) ir `reboot`
  (`/system/reboot`) reikalauja `VNISH_API_KEY` (32 simb., sukuriamas Vnish UI → API keys; rekomenduojama) arba
  `VNISH_PASSWORD` (→ `/unlock` JWT). Aliarmas: grandinė < 90 % idealaus hashrate po 10 min. kasimo
  (Vnish čipų „red“ įvertinimas po starto nepatikimas, todėl nenaudojamas).
- **cgminer** (TCP 4028) – Antminer, Whatsminer, Avalon ir kt. (atsarginis variantas, veikia ir su Vnish). Laukų pavadinimai skiriasi pagal gamintoją/firmware,
  todėl parseris best-effort ([src/miners/cgminer.ts](src/miners/cgminer.ts)) – pritaikykite pagal savo modelius.
  `restart` reikalauja API rašymo teisių (Antminer: `api-allow` su `W:`).
- **http-json** – bendras HTTP kontraktas (žr. [src/miners/http-json.ts](src/miners/http-json.ts)); naudoja simuliatorius,
  tinka custom firmware ar ESP tiltams.
- Naujas driver'is: implementuokite `MinerDriver` ([src/miners/types.ts](src/miners/types.ts)) ir užregistruokite
  [src/miners/index.ts](src/miners/index.ts).

Relė konfigūruojama dashboarde (mygtukas „Relė“), pvz. Shelly Gen1:
`{"type":"http","on_url":"http://10.0.0.50/relay/0?turn=on","off_url":"http://10.0.0.50/relay/0?turn=off"}`
arba Tasmota per MQTT: `{"type":"mqtt","command_topic":"cmnd/relay1/POWER"}`.

## Diegimas kaip HA Local Add-on

1. Nukopijuokite visą katalogą į HA `/addons/miner_bridge/` (per Samba / SSH add-on).
2. HA → Settings → Add-ons → Add-on Store → ⋮ → **Check for updates** → „Local add-ons“ → Miner Bridge → Install.
3. Configuration skiltyje nurodykite DB ir MQTT parametrus:
   - TimescaleDB add-on (expaso) hostname dažniausiai `77b2833f-timescaledb` – patikrinkite add-on puslapyje;
     DB `miners` sukurkite iš anksto (arba nurodykite esamą).
   - `mqtt_host` – EMQX add-on hostname arba HA host IP (add-on veikia `host_network` režimu, todėl tinka ir `127.0.0.1`,
     jei EMQX prievadas 1883 atvertas į host'ą).
4. Start → **Open Web UI** (atsidaro per Ingress).

`host_network: true` reikalingas, kad skenuojant būtų matoma ARP lentelė (MAC adresai) ir pasiekiamas visas LAN.
`ingress_only: true` blokuoja tiesioginius kreipinius į :3000 iš LAN – dashboardas pasiekiamas tik per HA Ingress
(HA autentifikacija). Išjunkite tik jei suprantate riziką: API leidžia valdyti kasyklų reles be autentifikacijos.
