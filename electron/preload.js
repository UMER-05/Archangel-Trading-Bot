const { contextBridge, ipcRenderer } = require("electron");

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electron", {
  // App info
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getAppPath: (name) => ipcRenderer.invoke("get-app-path", name),

  // Backend control
  restartBackend: () => ipcRenderer.invoke("restart-backend"),

  // Platform info
  platform: process.platform,
  isElectron: true,
});

// Expose a limited API for the renderer
contextBridge.exposeInMainWorld("api", {
  send: (channel, data) => {
    // Whitelist channels
    const validChannels = ["toMain"];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  receive: (channel, func) => {
    const validChannels = ["fromMain"];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => func(...args));
    }
  },
});
