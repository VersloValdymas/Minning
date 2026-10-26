# Changelog

## 0.2.0

- Įmontuota PostgreSQL 18 + TimescaleDB duomenų bazė (`db_mode: embedded`) – nereikia atskiro DB add-on'o.
- MQTT brokeris automatiškai paimamas iš Home Assistant (Mosquitto add-on), jei nenurodytas rankiniu būdu.
- Konteinerio planas: spintos × lentynos × vietos, kontūro (siurblio) suvestinė, LED „Rasti“.
- Aušinimo debito įvertis ir privalomas debitas pagal modelį; glikolio nustatymai dashboard'e.
- Firmware žurnalo analizė: perkaitimai, grandinių nutrūkimai.
- Sveikatos variklis, dashboard'as, HA MQTT auto-discovery.

## 0.1.0

- Pirmoji versija: skenavimas, apklausa, TimescaleDB istorija, MQTT.
