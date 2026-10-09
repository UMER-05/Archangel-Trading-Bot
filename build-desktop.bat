@echo off
echo ==========================================
echo   ArchAngel Trading Bot - Quick Builder
echo ==========================================
echo.

echo Installing dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 goto error

cd backend
call npm install
if %ERRORLEVEL% NEQ 0 goto error
cd ..

cd frontend
call npm install
if %ERRORLEVEL% NEQ 0 goto error
cd ..

echo.
echo Building backend...
cd backend
call npm run build
if %ERRORLEVEL% NEQ 0 goto error
cd ..

echo.
echo Building frontend...
cd frontend
call npm run build
if %ERRORLEVEL% NEQ 0 goto error
cd ..

echo.
echo Creating Windows installer...
echo (This may take 5-10 minutes...)
call npm run dist:win
if %ERRORLEVEL% NEQ 0 goto error

echo.
echo ==========================================
echo BUILD COMPLETE!
echo ==========================================
echo.
echo Your installer is at:
echo dist-electron\ArchAngel Trading Bot Setup 1.0.0.exe
echo.
pause
exit /b 0

:error
echo.
echo ==========================================
echo ERROR: Build failed!
echo ==========================================
pause
exit /b 1
