# Changelog

## 0.6.0

- **Ekonomika ir atsiperkamumas (ROI).** Elektros kaina ir viso objekto galia imama is Home Assistant (dinamiskai); pelnas = pajamos - visa objekto elektra (kasyklos + pridetines: ausinimas, siurbliai). Pridetines rodomos atskira eilute.
- Kaupiamas dienos pelnas (daily_earnings); investicija (bendra) ir pradine susigrazinta suma -> susigrazinta %, liko atsipirkti, kada atsipirks.
- Dienos pelno grafikas; istoriniai laikotarpiai iki 30 d.
- Rezultatai skelbiami atgal i HA (MQTT): parko pajamos/sanaudos/pelnas/atsiperkamumas kaip jutikliai.
- Nauji nustatymai: ha_price_entity, ha_total_power_entity; homeassistant_api.

## 0.5.0

- **Uždarbis ir pelnas:** tikslus viso parko BTC uždarbis iš F2Pool API (šiandien, vakar, nepanaudotas balansas, iš viso); BTC/EUR kaina iš CoinGecko. Kiekvienai kasyklai padalijama proporcingai pagal hashrate. Pelnas = pajamos − elektra (kaina nustatoma dashboard'e / add-on nustatymuose).
- KPI „Pajamos/para“ ir „Pelnas/para“; kortelėse ir lentelėje – €/d bei BTC/d (sat); šilumėlapyje – pelno rodiklis.
- Istoriniai laikotarpiai 7 d. ir 30 d. (duomenys kaupiami visą parą, 90 d.).
- Nauji add-on nustatymai: f2pool_account, f2pool_token, electricity_eur_kwh.

## 0.4.0

- **Licencijavimas.** Pasirašytas (Ed25519) licencijos raktas: be galiojančios licencijos dashboard'as užrakintas (rodomas tik licencijos langas su įrenginio ID). Lengvatos periodas po pabaigos – 7 d. (`license_grace_days`).
- Raktai generuojami vietoje (`npm run license:genkeys`), licencijos išrašomos `npm run license:issue`. Privatus raktas niekada nepatenka į repo. Ateityje tą patį darys licencijų serveris.
- Apsauga: licencija gali būti pririšta prie įrenginio ID (nenukopijuojama), tikrinamas laikrodžio pasukimas atgal.
- Licenciją galima įvesti add-on nustatyme `license_key` arba dashboard užrakto lange / Nustatymuose.

## 0.3.0

- **Administratoriaus slaptažodis dashboard'ui.** Pirmą kartą atidarius – slaptažodžio sukūrimas (arba sugeneravimas). Saugomas tik scrypt hash.
- Sesija galioja 30 d. nuo paskutinio apsilankymo (`session_idle_days`), kaskart pratęsiama. Slapukas HttpOnly, SameSite=Strict.
- Apsauga nuo perrinkimo: 10 bandymų / 15 min iš IP; užrakinimas 5 klaidos → 15 min, 10 → 1 h, 15 → 24 h. Audit žurnalas.
- Nustatymai → „Saugumas“: slaptažodžio keitimas (kitos sesijos atjungiamos), atsijungimas, atsijungimas visur.
- Pamiršus slaptažodį: add-on nustatymas `admin_password_reset` (po paleidimo automatiškai išjungiamas).
- Saugumo antraštės (CSP, nosniff).

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
