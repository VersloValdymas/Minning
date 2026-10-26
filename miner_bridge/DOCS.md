# Miner Bridge

ASIC kasyklų stebėjimas ir valdymas Home Assistant'e: tinklo skenavimas, sveikatos vertinimas
(perkaitimas, aušinimo debitas, hashrate % nuo nominalo), istorija TimescaleDB, valdymas per MQTT.

## Pirmas paleidimas

1. Įdiekite add-on'ą ir spauskite **Start**. Rekomenduojama įjungti **Watchdog** ir **Show in sidebar**.
2. Atidarykite **Miners** šoniniame meniu (arba **Open Web UI**).
3. Skirtukas **Aptikimas** → įveskite tinklo rėžį (pvz. `192.168.100.1-254`) → **Skenuoti**.
4. Skirtukas **Konteineris** → kasyklas priskirkite vietoms (mygtukas **Rasti (LED)** įjungia kasyklos LED mirksėjimą).
5. Skirtukas **Nustatymai** → aušinimo skystis (glikolis, koncentracija), konteinerio išdėstymas.

Duomenų bazė yra įmontuota (PostgreSQL + TimescaleDB, duomenys `/data/postgres`) – atskiro DB add-on'o nereikia.
HA atsarginė kopija yra „šalta“: kopijos metu add-on'as trumpam sustabdomas, kad DB kopija būtų nesugadinta.

## Nustatymai (Configuration)

| Nustatymas | Aprašymas |
|---|---|
| `mqtt_host`, `mqtt_port`, `mqtt_username`, `mqtt_password` | MQTT brokeris, prie kurio prijungtas HA. **Palikite tuščią**, jei naudojate oficialų Mosquitto add-on'ą – prisijungimas paimamas automatiškai. EMQX ar kitam brokeriui įveskite adresą ir prisijungimą. |
| `vnish_api_key` | Vnish API raktas (Vnish UI → API keys). Reikalingas komandoms: paleisti / stabdyti kasimą, restart, reboot, LED. Stebėjimui nereikalingas. |
| `retention_days` | Kiek dienų laikyti istoriją (0 = neriboti). |
| `db_mode` | `embedded` (numatyta) arba `external` – tada nustatykite paslėptus `db_host`, `db_port`, `db_name`, `db_user`, `db_password`. |

Išplėstiniai nustatymai (slenksčiai, apklausos dažnis ir kt.) matomi įjungus **Show unused optional configuration options**.

## Licencija

Reikalinga galiojanti licencija. Pirmą kartą atidarius rodomas užrakto langas su **įrenginio ID** – jį nurodykite tiekėjui licencijai gauti, tada gautą raktą įklijuokite lange (arba Configuration → `license_key`). Be licencijos dashboard'as užrakintas.

**Tiekėjui (vieną kartą):** `cd miner_bridge && npm run license:genkeys` sukuria raktų porą; `npm run license:issue -- --cust "Vardas" --id ID --days 365 [--hwid ĮRENGINIO_ID]` išrašo licenciją.

## Saugumas

Pirmą kartą atidarius dashboard'ą reikia susikurti **administratoriaus slaptažodį** (min. 12 simbolių; galima sugeneruoti).
Sesija galioja 30 dienų nuo paskutinio apsilankymo. **Pamiršus slaptažodį:** Configuration → `admin_password_reset` = įjungta → Save → Restart,
tada dashboard'e sukurkite naują (nustatymas pats išsijungia).


Dashboard'as pasiekiamas **tik per Home Assistant Ingress** (su HA prisijungimu). Tiesioginiai kreipiniai į prievadą 3000
iš tinklo atmetami (`ingress_only`, numatyta įjungta).

## Home Assistant integracija

Kiekviena kasykla automatiškai atsiranda kaip MQTT įrenginys (zona = spinta): hashrate, % nominalo, galia, efektyvumas,
lustų ir vandens temperatūros, apskaičiuotas aušinimo debitas, sveikata, būsena, klaidos ir mygtukai
(Start / Stop mining, Restart, Reboot, Identify).
