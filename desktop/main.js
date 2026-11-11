/**
 * PropLab for Mac.
 *
 * Shows the live website (so the app is always exactly the web version — nothing to update) and runs
 * the Kalshi relay inside the app, so placing Kalshi orders works without a Terminal relay. The page
 * finds the relay through window.PROPLAB_DESKTOP (set by preload.js). Links to other sites (Kalshi,
 * ESPN, …) open in the default browser.
 */
const { app, BrowserWindow, shell, session } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SITE = process.env.PROPLAB_URL || "https://alex-palmas.github.io/sports/";
const ORIGIN = new URL(SITE).origin;
let relayURL = null, win = null;

async function startRelay() {
  try {
    const { startRelay } = await import(pathToFileURL(path.join(__dirname, "relay-server.mjs")).href);
    relayURL = (await startRelay({ allowed: [ORIGIN] })).url;
  } catch (e) { console.error("relay failed to start:", e); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 900, minWidth: 380, minHeight: 500, title: "PropLab", backgroundColor: "#0a101d",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, sandbox: true,
      additionalArguments: relayURL ? [`--proplab-relay=${relayURL}`] : [],
    },
  });
  // stay on the PropLab site; everything else opens in the browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(SITE) && !url.startsWith("file:")) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3 && url.startsWith(ORIGIN)) win.loadFile(path.join(__dirname, "offline.html"), { query: { u: SITE } });
  });
  win.loadURL(SITE);
}

app.whenReady().then(async () => {
  await session.defaultSession.clearCache();   // always load the newest web version
  await startRelay();
  createWindow();
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on("window-all-closed", () => app.quit());
