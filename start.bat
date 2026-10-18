@echo off
REM ============================================================================
REM  AI'A NOT: start.bat - AstroVector'u tek tikla ayaga kaldirir.
REM  Once portlari (8081/8090) tutan eski node sureclerini kapatir, sonra serveri ayri
REM  pencerede baslatir, sonra client sayfalarini acar.
REM
REM  !!! BU DOSYA SAF ASCII + CRLF OLMAK ZORUNDA !!!
REM  Turkce karakter veya UTF-8 ok isareti koyarsan cmd baytlari bozuk okur, script
REM  PARSE asamasinda patlar ve pencere ANINDA kapanir (M3e olayi: "start.bat hemen
REM  kapaniyor"). Yorumlari Ingilizce harflerle yaz.
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo  ============================================
echo   AstroVector - baslatiliyor
echo  ============================================
echo.

REM --- 1) Eski server'lari temizle (port 8081 + 8090) -------------------------
set FOUND_OLD=0
for %%P in (8081 8090) do call :killport %%P

REM AI'A NOT: oldurdukten sonra portun BOSALMASINI BEKLE. Aksi halde kapanmakta olan
REM surec portu bir an daha tutar, yeni server EADDRINUSE ile duser ve kullanici
REM "yeniden baslattim" sanip ESKI kodla oynamaya devam eder.
if "!FOUND_OLD!"=="1" goto waitports
echo  [temizlik] portlar zaten bos.
goto startserver

:waitports
set WAITN=0
:waitloop
netstat -ano | findstr ":8081 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto waited
set /a WAITN+=1
if !WAITN! GEQ 8 goto waited
ping -n 2 127.0.0.1 >nul
goto waitloop
:waited
REM AI'A NOT: oldurme SONRASI DOGRULAMA. Kill basarisiz olabilir (yetki, farkli oturum) ve
REM eskiden sessizce geciliyordu -> kullanici HAM EADDRINUSE yigin izi goruyordu ve sebebini
REM anlamiyordu. Artik port hala doluysa ACIKCA soylenir.
netstat -ano | findstr ":8081 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto cleaned
echo  [temizlik] DIKKAT: port 8081 HALA DOLU - eski surec kapatilamadi.
echo  [temizlik] Cozum: gorev yoneticisinden node.exe sureclerini kapat, ya da bu dosyayi
echo  [temizlik] "Yonetici olarak calistir". Yine de deniyorum (hata mesajini bana gonder).
goto startserver
:cleaned
echo  [temizlik] eski surec(ler) kapatildi, portlar bosaldi. (bekleme: !WAITN! sn)

:startserver
REM --- 2) Server'i ayri pencerede baslat (o pencere kapanmaz) ------------------
echo  [server] node backend\server.js baslatiliyor...
start "AstroVector Server" cmd /k "cd /d "%~dp0" && node backend\server.js"

REM --- 3) Port hazir olana kadar bekle (max ~12 sn) ---------------------------
set READY=
for /l %%I in (1,1,12) do (
  if not defined READY (
    ping -n 2 127.0.0.1 >nul
    netstat -ano | findstr ":8081 " | findstr "LISTENING" >nul 2>&1 && set READY=1
  )
)
if defined READY goto ready
echo  [server] UYARI: 12 sn icinde acilmadi. "AstroVector Server" penceresine bak.
echo  [server] Port dolu hatasi varsa: bu pencereyi kapat, 5 sn bekle, start.bat tekrar calistir.
goto adminkey

:ready
echo  [server] HAZIR - ws://localhost:8081  (admin: 8090)
echo  [server] KONTROL: "AstroVector Server" penceresinde (SURUM ...) yazmali.
echo  [server] Oyun sayfasinda Ctrl+F5 yap; log satirinda "SURUM 2026-..." gorunmeli.

:adminkey
REM --- 4) ADMIN ANAHTARINI PANOYA KOPYALA ------------------------------------
REM Admin paneli localhost gelistirici aracidir ve ADMIN_SECRET_KEY ister (.env).
REM Anahtari panoya aliyoruz: panelde Ctrl+V yapmak yeterli.
powershell -NoProfile -Command "$v=(Get-Content '.env' | Where-Object {$_ -match '^ADMIN_SECRET_KEY='}) -replace '^ADMIN_SECRET_KEY=',''; Set-Clipboard -Value $v" >nul 2>&1
echo  [admin] ADMIN_SECRET_KEY panoya kopyalandi - panelde Ctrl+V yap (bir kez sorulur).

REM --- 5) Clientlari ac ------------------------------------------------------
REM game-client file:// ile de acilabilir; starmap.json i serverdan (CORS acik) ceker.
if exist "game-client\index.html"  start "" "game-client\index.html"
if exist "admin-client\index.html" start "" "admin-client\index.html"

echo.
echo  Bitti. Kontroller: WASD hareket, M harita, E tarama, C envanter, Y yakit cekme
echo.
endlocal
exit /b 0

REM ============================================================================
REM  ALT YORDAM: verilen portu tutan PID(leri) kapatir, FOUND_OLD isaretini koyar.
REM  Ic ice parantezli blok yerine `call :killport <port>` kullanilir: cmd ic ice
REM  bloklarda kirilgan davraniyor ve hatayi GIZLIYOR (script sessizce kapaniyordu).
REM ============================================================================
:killport
for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%~1 " ^| findstr "LISTENING" ^| findstr "0.0.0.0"') do call :killpid %%A %~1
exit /b 0

REM AI'A NOT: taskkill ciktisi ARTIK GIZLENMIYOR (log dosyasina gider). Eskiden `>nul 2>&1`
REM idi: kill yetki/oturum yuzunden basarisiz olsa bile script "kapatiliyor..." deyip geciyordu.
:killpid
if "%~1"=="0" exit /b 0
echo  [temizlik] port %~2 kullanan PID %~1 kapatiliyor...
REM AI'A NOT (GERCEK HATA): once `taskkill ... >>"%%TEMP%%\log"` + `if errorlevel 1` yazmistim.
REM Cikti yonlendirmesi bir sekilde calismadi (log dosyasi hic olusmadi), taskkill de kosmadi,
REM errorlevel 0 kaldi ve script ELSE dalina girip "PID kapatildi" diye YALAN SOYLEDI; port
REM doluydu ve yeni server EADDRINUSE ile dustu. Artik taskkill'in cikis koduna DEGIL,
REM SONUCA bakiliyor: port hala LISTENING mi? Tek dogru olcu bu.
taskkill /PID %~1 /F >nul 2>&1
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr ":%~2 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
  echo  [temizlik] PID %~1 kapatildi, port %~2 bosaldi.
  set FOUND_OLD=1
) else (
  echo  [temizlik] UYARI: PID %~1 kapatilamadi - port %~2 HALA DOLU.
  echo  [temizlik] UYARI: gorev yoneticisinden node.exe kapat ya da "Yonetici olarak calistir".
)
exit /b 0

