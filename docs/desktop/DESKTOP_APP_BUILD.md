# ArchAngel Desktop App - Build Guide

## 📦 Converting to Desktop App (.exe)

This guide shows how to build ArchAngel Trading Bot as a standalone desktop application.

---

## Prerequisites

Before building, ensure you have:

1. **Node.js 20.x** installed
2. **All dependencies installed** in both frontend and backend
3. **Backend and frontend built** at least once
4. **Icon files** in `electron/resources/` (see below)

---

## Step 1: Install Root Dependencies

From the **root directory** of the project:

```bash
npm install
```

This installs Electron and electron-builder.

---

## Step 2: Install Backend & Frontend Dependencies

```bash
# Install backend dependencies
cd backend
npm install
cd ..

# Install frontend dependencies
cd frontend
npm install
cd ..
```

---

## Step 3: Add Icon Files

Create or add icon files to `electron/resources/`:

- **icon.ico** - Windows icon (256x256 or 512x512)
- **icon.icns** - macOS icon (optional)
- **icon.png** - Linux icon (512x512, optional)

You can use online tools to convert PNG to ICO:

- https://cloudconvert.com/png-to-ico
- https://convertio.co/png-ico/

Or use a placeholder for testing (skip this for now).

---

## Step 4: Build the Application

### Option A: Quick Build (Test without installer)

```bash
npm run pack
```

This creates an unpacked app in `dist-electron/` for testing.

### Option B: Full Windows Build (.exe installer)

```bash
npm run dist:win
```

This creates:

- `ArchAngel Trading Bot Setup 1.0.0.exe` - Installer
- Portable .exe in `dist-electron/win-unpacked/`

**Build time:** 5-10 minutes (first build is slow)

---

## Step 5: Test the Application

### Development Mode

Test Electron without building:

```bash
npm run electron:dev
```

This opens the app window loading from your local dev servers.

### Production Mode

After building, find the installer in:

```
dist-electron/
  └── ArchAngel Trading Bot Setup 1.0.0.exe
```

Double-click to install and run!

---

## What Gets Packaged?

The final `.exe` includes:

✅ **Backend Server**

- All compiled TypeScript (`backend/dist/`)
- All node_modules
- Configuration files

✅ **Frontend**

- Next.js production build (`frontend/.next/`)
- Static assets (`frontend/public/`)
- All node_modules

✅ **Electron Shell**

- Desktop window wrapper
- System tray integration
- Auto-start backend/frontend

---

## App Features

When the user runs `ArchAngel.exe`:

1. **Backend starts automatically** on port 4000
2. **Frontend starts automatically** on port 3000
3. **Desktop window opens** showing the trading dashboard
4. **System tray icon** for quick access
5. **No terminal windows** - everything runs hidden

---

## Build Scripts Explained

| Script                   | Description                       |
| ------------------------ | --------------------------------- |
| `npm run electron`       | Run Electron with current code    |
| `npm run electron:dev`   | Run Electron in dev mode          |
| `npm run build:backend`  | Build backend TypeScript          |
| `npm run build:frontend` | Build frontend Next.js            |
| `npm run build:all`      | Build both backend and frontend   |
| `npm run pack`           | Create unpacked app (for testing) |
| `npm run dist`           | Create installer (cross-platform) |
| `npm run dist:win`       | Create Windows installer only     |

---

## Customization

### Change App Name

Edit `package.json` in root:

```json
{
  "build": {
    "productName": "Your App Name"
  }
}
```

### Change Window Size

Edit `electron/main.js`:

```javascript
mainWindow = new BrowserWindow({
  width: 1600, // Change width
  height: 1000, // Change height
  // ...
});
```

### Change Ports

Edit `electron/main.js`:

```javascript
const BACKEND_PORT = 4000; // Your backend port
const FRONTEND_PORT = 3000; // Your frontend port
```

---

## Troubleshooting

### Build fails with "Cannot find module"

**Solution:** Make sure all dependencies are installed:

```bash
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
npm install
```

### App opens but shows blank screen

**Solution:** Check if backend/frontend are built:

```bash
npm run build:all
```

### Backend doesn't start in packaged app

**Solution:** Ensure `backend/dist/` exists and contains compiled JS files.

### "mainnet.json not found" error

**Solution:** The `mainnet.json` file needs to be in `backend/config/`. It's excluded from git due to size. Users must download it separately (see main README).

### Icon not showing

**Solution:** Add `icon.ico` to `electron/resources/` and rebuild.

---

## Distribution

### For End Users

Give them:

1. `ArchAngel Trading Bot Setup 1.0.0.exe` - The installer
2. Instructions to download `mainnet.json` (if not included)
3. `.env` configuration template

### Installation Steps for Users

1. Download `ArchAngel Trading Bot Setup 1.0.0.exe`
2. Run installer
3. Configure `.env` file (see README)
4. Download `mainnet.json` to config folder
5. Launch ArchAngel from desktop shortcut

---

## File Size

Expected installer size:

- **~200-300 MB** compressed
- **~500-700 MB** installed

This includes:

- Electron runtime (~150 MB)
- Node.js dependencies (~200 MB)
- Your app code (~50 MB)
- Frontend build (~100 MB)

---

## Advanced: Code Signing (Optional)

To remove "Unknown Publisher" warnings on Windows:

1. Get a code signing certificate
2. Add to `package.json`:

```json
{
  "build": {
    "win": {
      "certificateFile": "path/to/cert.pfx",
      "certificatePassword": "your_password"
    }
  }
}
```

---

## Platform-Specific Builds

### macOS (.dmg)

```bash
npm run dist -- --mac
```

### Linux (.AppImage)

```bash
npm run dist -- --linux
```

---

## Auto-Update (Future Enhancement)

To add auto-update functionality:

1. Install `electron-updater`
2. Configure in `electron/main.js`
3. Host releases on GitHub releases or your own server

---

## Summary

```bash
# Quick start:
npm install
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
npm run build:all
npm run dist:win

# Result:
# dist-electron/ArchAngel Trading Bot Setup 1.0.0.exe
```

Double-click the installer → Install → Run!

🎉 **You now have a standalone desktop app!**

---

## Support

If you encounter issues:

1. Check `dist-electron/builder-debug.yml` for build logs
2. Run `npm run electron:dev` to test before building
3. Ensure all builds complete: `npm run build:all`

For questions, open an issue on GitHub.
