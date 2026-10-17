# Quick Start: Build Desktop App

## Fastest Way to Build

```powershell
# Run this script - it does everything for you!
.\build-desktop.ps1
```

The script will:

1. ✅ Install all dependencies (root, backend, frontend)
2. ✅ Build backend TypeScript
3. ✅ Build frontend Next.js
4. ✅ Ask you which build type you want
5. ✅ Create the .exe file

---

## Manual Build (If you prefer)

```powershell
# Step 1: Install everything
npm install
cd backend && npm install && cd ..
cd frontend && npm install && cd ..

# Step 2: Build everything
npm run build:all

# Step 3: Create Windows installer
npm run dist:win
```

Output: `dist-electron\ArchAngel Trading Bot Setup 1.0.0.exe`

---

## Test Before Building

```powershell
# Run in Electron (faster for testing)
npm run electron:dev
```

This opens the app without creating an installer.

---

## What You Need

Before building:

- ✅ Node.js 20.x installed
- ✅ Icon file (optional): Add `electron/resources/icon.ico`
- ✅ Backend `.env` configured
- ✅ `mainnet.json` in `backend/config/` (892MB file)

---

## After Building

Find your installer at:

```
dist-electron/
  └── ArchAngel Trading Bot Setup 1.0.0.exe
```

Give this file to users. They:

1. Double-click to install
2. Configure their `.env` file
3. Launch from desktop shortcut
4. Done! ✅

---

## Build Time

- First build: ~5-10 minutes
- Subsequent builds: ~2-3 minutes

---

## Need Help?

- 📖 Full guide: [DESKTOP_APP_BUILD.md](DESKTOP_APP_BUILD.md)
- 🐛 Issues? Check the troubleshooting section in the full guide
- 💬 Questions? Open a GitHub issue

---

## TL;DR

```powershell
.\build-desktop.ps1
# Select option 2 (Full Windows build)
# Wait 5-10 minutes
# Get your .exe in dist-electron/
```

That's it! 🎉
