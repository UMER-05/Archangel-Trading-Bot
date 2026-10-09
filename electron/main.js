const { app, BrowserWindow, ipcMain, Menu, Tray } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const isDev = require("electron-is-dev");
const Store = require("electron-store");
const fs = require("fs");
const { pathToFileURL } = require("url");

const store = new Store();

let mainWindow;
let backendProcess;
let tray;

// Backend server configuration
const BACKEND_PORT = 4000;
const FRONTEND_PORT = 3000;

/**
 * Start the backend Express server
 */
async function startBackend() {
  console.log("🚀 Starting backend server...");

  if (isDev) {
    // In development, spawn as a separate process
    const backendPath = path.join(
      __dirname,
      "..",
      "backend",
      "dist",
      "index.js"
    );

    backendProcess = spawn("node", [backendPath], {
      env: {
        ...process.env,
        PORT: BACKEND_PORT,
        NODE_ENV: "development",
      },
      cwd: path.join(__dirname, "..", "backend"),
    });

    backendProcess.stdout.on("data", (data) => {
      console.log(`[Backend] ${data.toString().trim()}`);
    });

    backendProcess.stderr.on("data", (data) => {
      console.error(`[Backend Error] ${data.toString().trim()}`);
    });

    backendProcess.on("close", (code) => {
      console.log(`Backend process exited with code ${code}`);
    });

    // Give backend time to start
    return new Promise((resolve) => setTimeout(resolve, 3000));
  } else {
    // In production, require the backend directly
    try {
      process.env.PORT = BACKEND_PORT;
      process.env.NODE_ENV = "production";

      const backendPath = path.join(
        __dirname,
        "..",
        "backend",
        "dist",
        "index.js"
      );
      // backend is an ES module build; use dynamic import in production
      await import(pathToFileURL(backendPath).href);

      console.log(`✅ Backend started on port ${BACKEND_PORT}`);
    } catch (error) {
      console.error("Failed to start backend:", error);
    }

    // Give backend time to start
    return new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * Start the Next.js frontend server (only in dev mode)
 */
function startFrontend() {
  // In production, we'll use static file serving instead
  if (!isDev) {
    console.log("📦 Production mode - using static files");
    return Promise.resolve();
  }

  console.log("🚀 Starting frontend dev server...");

  const frontendPath = path.join(__dirname, "..", "frontend");

  // Use next.cmd on Windows, next on Unix
  const isWindows = process.platform === "win32";
  const nextScript = isWindows ? "next.cmd" : "next";
  const nextPath = path.join(frontendPath, "node_modules", ".bin", nextScript);

  frontendProcess = spawn(nextPath, ["dev", "-p", FRONTEND_PORT], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      NEXT_PUBLIC_BACKEND_URL: `http://localhost:${BACKEND_PORT}`,
      NEXT_PUBLIC_SOCKET_URL: `http://localhost:${BACKEND_PORT}`,
    },
    cwd: frontendPath,
    shell: true,
  });

  frontendProcess.stdout.on("data", (data) => {
    console.log(`[Frontend] ${data.toString().trim()}`);
  });

  frontendProcess.stderr.on("data", (data) => {
    console.error(`[Frontend Error] ${data.toString().trim()}`);
  });

  frontendProcess.on("close", (code) => {
    console.log(`Frontend process exited with code ${code}`);
  });

  // Give frontend time to start
  return new Promise((resolve) => setTimeout(resolve, 5000));
}

/**
 * Create the main application window
 */
async function createWindow() {
  // Start backend and frontend servers
  await startBackend();
  await startFrontend();

  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    icon: path.join(__dirname, "resources", "icon.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, "preload.js"),
    },
    backgroundColor: "#1a1a2e",
    show: false, // Don't show until ready
    frame: true,
    titleBarStyle: "default",
  });

  // Remove default menu
  Menu.setApplicationMenu(null);

  // Load the frontend
  if (isDev) {
    const frontendUrl = `http://localhost:${FRONTEND_PORT}`;
    console.log(`📡 Loading frontend from: ${frontendUrl}`);
    mainWindow.loadURL(frontendUrl);
  } else {
    // In production, load from asar package (static export)
    const buildDir = path.join(__dirname, "..", "frontend", "build");

    // Intercept file:// requests so absolute paths (e.g. /trading or /_next/...) map
    // to files inside the exported `build` folder instead of the filesystem root.
    try {
      const sess = mainWindow.webContents.session;
      sess.protocol.interceptFileProtocol("file", (request, callback) => {
        try {
          let urlPath = decodeURIComponent(new URL(request.url).pathname);
          // On Windows URLs are like /C:/trading - trim leading slash
          if (process.platform === "win32" && urlPath.startsWith("/")) {
            urlPath = urlPath.slice(1);
          }

          // Normalize root requests to index.html
          if (urlPath === "" || urlPath === "/" || urlPath === "/index.html") {
            return callback({ path: path.join(buildDir, "index.html") });
          }

          // Remove leading slash if present
          if (urlPath.startsWith("/")) urlPath = urlPath.slice(1);

          // Map common static folders/files directly into build folder
          if (
            urlPath.startsWith("_next") ||
            urlPath.startsWith("next") ||
            urlPath.startsWith("icons") ||
            urlPath === "manifest.json" ||
            urlPath === "logo.jpg"
          ) {
            const mapped = path.join(buildDir, urlPath);
            if (fs.existsSync(mapped)) return callback({ path: mapped });
          }

          // If user requested a route like /trading, map to trading.html (static export)
          const possibleHtml = path.join(buildDir, urlPath + ".html");
          if (fs.existsSync(possibleHtml))
            return callback({ path: possibleHtml });

          // If the exact file exists in build, serve it
          const filePath = path.join(buildDir, urlPath);
          if (fs.existsSync(filePath)) return callback({ path: filePath });

          // Fallback to index.html (SPA-style routing)
          return callback({ path: path.join(buildDir, "index.html") });
        } catch (e) {
          console.error("[Protocol Intercept] error:", e);
          return callback({ path: path.join(buildDir, "index.html") });
        }
      });
    } catch (e) {
      console.error("Failed to register protocol interceptor:", e);
    }

    const indexPath = path.join(buildDir, "index.html");
    console.log(`📡 Loading frontend from: ${indexPath}`);
    mainWindow.loadFile(indexPath);
  }

  // Show window when ready
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    console.log("✅ ArchAngel Trading Bot is ready!");
  });

  // Open DevTools to debug issues
  mainWindow.webContents.openDevTools();

  // Log any console messages from the renderer
  mainWindow.webContents.on(
    "console-message",
    (event, level, message, line, sourceId) => {
      console.log(`[Renderer Console] ${message}`);
    }
  );

  // Handle window close
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Create system tray icon
  createTray();
}

/**
 * Create system tray icon
 */
function createTray() {
  const iconPath = path.join(__dirname, "resources", "icon.png");
  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show ArchAngel",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        }
      },
    },
    {
      label: "Hide to Tray",
      click: () => {
        if (mainWindow) {
          mainWindow.hide();
        }
      },
    },
    { type: "separator" },
    {
      label: "Restart Backend",
      click: () => {
        restartBackend();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setToolTip("ArchAngel Trading Bot");
  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

/**
 * Restart the backend server
 */
function restartBackend() {
  console.log("🔄 Restarting backend...");
  if (backendProcess) {
    backendProcess.kill();
  }
  setTimeout(() => startBackend(), 1000);
}

/**
 * Cleanup processes before quit
 */
function cleanup() {
  console.log("🧹 Cleaning up...");

  if (backendProcess) {
    console.log("Stopping backend...");
    backendProcess.kill();
  }

  if (frontendProcess) {
    console.log("Stopping frontend...");
    frontendProcess.kill();
  }
}

// App lifecycle events
app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    cleanup();
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  cleanup();
});

// IPC handlers
ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

ipcMain.handle("get-app-path", (event, name) => {
  return app.getPath(name);
});

ipcMain.handle("restart-backend", () => {
  restartBackend();
  return { success: true };
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});
