# ArchAngel Desktop Build Script
# This script helps build the desktop application

Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  ArchAngel Trading Bot - Desktop Builder" -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

# Check if Node.js is installed
Write-Host "Checking Node.js installation..." -ForegroundColor Yellow
$nodeVersion = node --version 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Node.js is not installed!" -ForegroundColor Red
    Write-Host "Please install Node.js 20.x from: https://nodejs.org/" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Node.js $nodeVersion found" -ForegroundColor Green
Write-Host ""

# Step 1: Install root dependencies
Write-Host "Step 1: Installing root dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to install root dependencies" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Root dependencies installed" -ForegroundColor Green
Write-Host ""

# Step 2: Install backend dependencies
Write-Host "Step 2: Installing backend dependencies..." -ForegroundColor Yellow
Set-Location backend
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to install backend dependencies" -ForegroundColor Red
    Set-Location ..
    exit 1
}
Set-Location ..
Write-Host "✓ Backend dependencies installed" -ForegroundColor Green
Write-Host ""

# Step 3: Install frontend dependencies
Write-Host "Step 3: Installing frontend dependencies..." -ForegroundColor Yellow
Set-Location frontend
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to install frontend dependencies" -ForegroundColor Red
    Set-Location ..
    exit 1
}
Set-Location ..
Write-Host "✓ Frontend dependencies installed" -ForegroundColor Green
Write-Host ""

# Step 4: Build backend
Write-Host "Step 4: Building backend..." -ForegroundColor Yellow
Set-Location backend
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to build backend" -ForegroundColor Red
    Set-Location ..
    exit 1
}
Set-Location ..
Write-Host "✓ Backend built successfully" -ForegroundColor Green
Write-Host ""

# Step 5: Build frontend
Write-Host "Step 5: Building frontend..." -ForegroundColor Yellow
Set-Location frontend
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to build frontend" -ForegroundColor Red
    Set-Location ..
    exit 1
}
Set-Location ..
Write-Host "✓ Frontend built successfully" -ForegroundColor Green
Write-Host ""

# Step 6: Check for icon files
Write-Host "Step 6: Checking for icon files..." -ForegroundColor Yellow
$iconPath = "electron\resources\icon.ico"
if (Test-Path $iconPath) {
    Write-Host "✓ Icon file found: $iconPath" -ForegroundColor Green
} else {
    Write-Host "⚠ Warning: Icon file not found at $iconPath" -ForegroundColor Yellow
    Write-Host "  The app will use a default icon. Add icon.ico for custom branding." -ForegroundColor Yellow
}
Write-Host ""

# Step 7: Ask user which build to create
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "Select build type:" -ForegroundColor Cyan
Write-Host "1. Quick build (test, no installer)" -ForegroundColor White
Write-Host "2. Full Windows build (.exe installer)" -ForegroundColor White
Write-Host "3. Test in Electron (dev mode)" -ForegroundColor White
Write-Host "===========================================" -ForegroundColor Cyan
$choice = Read-Host "Enter choice (1, 2, or 3)"

switch ($choice) {
    "1" {
        Write-Host ""
        Write-Host "Creating quick build..." -ForegroundColor Yellow
        npm run pack
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "✓ Build complete!" -ForegroundColor Green
            Write-Host "Location: dist-electron\win-unpacked\" -ForegroundColor Cyan
        }
    }
    "2" {
        Write-Host ""
        Write-Host "Creating Windows installer..." -ForegroundColor Yellow
        Write-Host "(This may take 5-10 minutes...)" -ForegroundColor Yellow
        npm run dist:win
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "✓ Build complete!" -ForegroundColor Green
            Write-Host "Installer location: dist-electron\ArchAngel Trading Bot Setup 1.0.0.exe" -ForegroundColor Cyan
        }
    }
    "3" {
        Write-Host ""
        Write-Host "Starting Electron in dev mode..." -ForegroundColor Yellow
        Write-Host "Press Ctrl+C to stop" -ForegroundColor Yellow
        npm run electron:dev
    }
    default {
        Write-Host "Invalid choice. Exiting." -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "Build process complete!" -ForegroundColor Green
Write-Host "===========================================" -ForegroundColor Cyan
