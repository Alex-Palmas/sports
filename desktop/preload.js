// Tells the PropLab page it is running in the Mac app and where the built-in Kalshi relay listens.
const { contextBridge } = require("electron");
const arg = process.argv.find(a => a.startsWith("--proplab-relay="));
contextBridge.exposeInMainWorld("PROPLAB_DESKTOP", { app: "mac", relay: arg ? arg.slice("--proplab-relay=".length) : null });
