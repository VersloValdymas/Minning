@echo off
rem ============================================================
rem  Miner Bridge - licencijos issrasymas
rem  Dukart spustelekite si faila. Paklaus duomenu, paprasys is KeePass
rem  nukopijuoti privatu rakta (i iskarpine), issiras licencija ir ja
rem  nukopijuos i iskarpine. Privatus raktas niekur neirasomas i diska.
rem  Reikia: Node.js. Privataus rakto failo diske NEREIKIA.
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
chcp 65001 >nul
title Miner Bridge - licencijos issrasymas

echo.
echo  ================================================
echo   Miner Bridge - naujos licencijos issrasymas
echo  ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [KLAIDA] Nerastas Node.js. Idiekite ji is https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\tsx" (
  echo  Diegiamos priklausomybes ^(viena karta^)...
  call npm install
  echo.
)

set "CUST="
set /p "CUST=  Kliento vardas (pvz. Eurofondas): "
if "!CUST!"=="" set "CUST=Klientas"

set "ID="
set /p "ID=  Uzsakymo/kliento ID (pvz. OBJ-001): "
if "!ID!"=="" set "ID=OBJ-001"

set "DAYS="
set /p "DAYS=  Galiojimas dienomis [365] (0 = neterminuota): "
if "!DAYS!"=="" set "DAYS=365"

set "HWID="
set /p "HWID=  Irenginio ID (is uzrakto lango; Enter = bet koks): "

set "MAXM="
set /p "MAXM=  Kasyklu limitas (Enter = be limito): "

set "EXTRA="
if not "!HWID!"=="" set "EXTRA=!EXTRA! --hwid !HWID!"
if not "!MAXM!"=="" set "EXTRA=!EXTRA! --max-miners !MAXM!"

for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set "TODAY=%%d"
set "OUTFILE=licenses/!ID!_!TODAY!.txt"

echo.
echo  ------------------------------------------------
echo   PRIVATUS RAKTAS - IS ISKARPINES (nieko klijuoti nereikia):
echo.
echo    1. Atidarykite KeePass.
echo    2. Nukopijuokite privatu rakta ^(Copy^) - visa teksta nuo
echo       -----BEGIN iki -----END PRIVATE KEY-----
echo    3. Griskite i si langa ir spauskite bet koki klavisa.
echo.
echo   Scenarijus rakta paims IS ISKARPINES automatiskai.
echo  ------------------------------------------------
echo.
pause

echo.
echo  Issrasoma licencija...
echo.
powershell -NoProfile -Command "Get-Clipboard -Raw" | node --import tsx "tools/issue-license.ts" --key-stdin --cust "!CUST!" --id "!ID!" --days !DAYS!!EXTRA! --out "!OUTFILE!"
if errorlevel 1 (
  echo.
  echo  [KLAIDA] Nepavyko issrasyti licencijos ^(ar nukopijavote teisinga rakta?^).
  echo.
  pause
  exit /b 1
)

if exist "!OUTFILE!" (
  rem Perrasom iskarpine licencija - taip privatus raktas is iskarpines dingsta
  clip < "!OUTFILE!"
  echo.
  echo  ------------------------------------------------
  echo   Licencija issaugota: !OUTFILE!
  echo   Licencijos raktas nukopijuotas i iskarpine ^(Ctrl+V^).
  echo   ^(Privatus raktas is iskarpines pasalintas.^)
  echo   Iklijuokite HA uzrakto lange arba
  echo   Configuration -^> license_key.
  echo  ------------------------------------------------
)

echo.
pause
endlocal
