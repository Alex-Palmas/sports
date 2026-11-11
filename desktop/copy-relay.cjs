// Copies the shared relay rules (relay/kalshi-relay-worker.mjs) into the app so it can be packaged.
const fs = require("node:fs"), path = require("node:path");
fs.copyFileSync(path.join(__dirname, "..", "relay", "kalshi-relay-worker.mjs"), path.join(__dirname, "relay.mjs"));
console.log("copied relay/kalshi-relay-worker.mjs -> desktop/relay.mjs");
