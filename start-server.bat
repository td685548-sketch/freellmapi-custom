@echo off
title FreeLLMAPI Server
cd /d "%~dp0"

rem --- 1. Node.js phai ton tai -------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [LOI] Khong tim thay Node.js. Cai Node.js 20+ roi chay lai file nay.
  echo       https://nodejs.org/
  pause
  exit /b 1
)

rem --- 2. Build server neu chua co dist (clone moi) ----------------------
if not exist "server\dist\index.js" (
  echo [INFO] Chua co server\dist\index.js (clone moi) - dang build server...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [LOI] Khong tim thay npm. Cai Node.js kem npm roi chay lai, hoac chay "npm run build" bang tay.
    pause
    exit /b 1
  )
  call npm run build -w server
  if errorlevel 1 (
    echo [LOI] Build server that bai. Kiem tra loi o tren roi chay lai.
    pause
    exit /b 1
  )
  if not exist "server\dist\index.js" (
    echo [LOI] Build xong nhung van khong co server\dist\index.js. Chay "npm run build" bang tay de kiem tra.
    pause
    exit /b 1
  )
)

rem --- 3. Doc PORT tu .env neu co (mac dinh 3001) ------------------------
rem Server khong tu doc .env, nen export PORT cho tien trinh node.
rem Chi nhan dong dung dinh dang PORT=3001 (khong khoang trang quanh dau =).
set "APP_PORT=3001"
if exist ".env" (
  for /f "usebackq tokens=1* delims==" %%A in (".env") do if /i "%%A"=="PORT" set "APP_PORT=%%B"
)
set "PORT=%APP_PORT%"

echo ===================================================
echo     DANG KHOI CHAY FREELMMAPI TAI PORT %APP_PORT%
echo ===================================================
echo Dashboard: http://localhost:%APP_PORT%
echo Endpoint:  http://localhost:%APP_PORT%/v1
echo.
node server/dist/index.js
pause
