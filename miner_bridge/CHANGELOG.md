# Changelog

## 0.2.3

- **Autotuning:** profilis (pvz. 5940 W ≈ 396 TH/s) ir ar jis suderintas, sesijos trukmė, derinimo ratai, progresas pagal grandines, nutraukimų skaičius (iš Vnish tuner žurnalo).
- Įspėjimai: autotuning ilgiau nei `tuning_warn_h` (12 h), derinimas nutrauktas ≥ `tuning_interruptions_warn` (3) kartų.
- Kasyklos detalėse – paaiškinimas „Kas vyksta / Ką daryti / Į ką atkreipti dėmesį“ pagal gyvus duomenis; apžvalgoje – informacinė juosta.
- Lentelėje stulpelis „Profilis“ (nukrypimai nuo dažniausio paryškinami).
- **Valdymo prieiga:** Nustatymuose – kortelė su kasyklomis, kurios nepriima Vnish API rakto (vieta, IP, nuoroda į Vnish), mygtukas „Patikrinti dabar“; filtras „Be valdymo“.
- Nustatymų peržiūra kompaktiška: suvestinė, tik probleminės kasyklos, pilnas sąrašas išskleidžiamas.

## 0.2.2

- „Kasyklos“ KPI skaičiuoja visas kasančias (hashrate > 0), įskaitant autotuning; parodo, kiek nekasa ir kodėl.
- Nauji filtrai: **Nekasa**, **Autotuning**, **Kraunasi**. Paspaudus KPI „Kasyklos“ – rodomos nekasančios.
- Parko grafikai iš karto po įdiegimo (intervalas prisitaiko prie turimų duomenų).

## 0.2.1

- Šoninio meniu punktas „Miners“ matomas tik administratoriams (`panel_admin: true`).

## 0.2.0

- Įmontuota PostgreSQL 18 + TimescaleDB duomenų bazė (`db_mode: embedded`) – nereikia atskiro DB add-on'o.
- MQTT brokeris automatiškai paimamas iš Home Assistant (Mosquitto add-on), jei nenurodytas rankiniu būdu.
- Konteinerio planas: spintos × lentynos × vietos, kontūro (siurblio) suvestinė, LED „Rasti“.
- Aušinimo debito įvertis ir privalomas debitas pagal modelį; glikolio nustatymai dashboard'e.
- Firmware žurnalo analizė: perkaitimai, grandinių nutrūkimai.
- Sveikatos variklis, dashboard'as, HA MQTT auto-discovery.

## 0.1.0

- Pirmoji versija: skenavimas, apklausa, TimescaleDB istorija, MQTT.
