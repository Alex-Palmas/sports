#!/usr/bin/env node
/**
 * Local Kalshi relay: lets PropLab (in your browser on this computer) place Kalshi orders.
 *
 *   node scripts/kalshi-relay.mjs            # listens on http://localhost:8787
 *   PORT=9000 ALLOWED_ORIGIN=https://you.github.io node scripts/kalshi-relay.mjs
 *
 * Requests are signed in the browser; this only forwards them to Kalshi (which blocks web pages).
 * It binds to 127.0.0.1 only, holds no secrets and only forwards Kalshi trade-api/v2 requests.
 */
import { createServer } from "node:http";
import { relay } from "../relay/kalshi-relay-worker.mjs";

const PORT = +(process.env.PORT || 8787);
const allowed = String(process.env.ALLOWED_ORIGIN || "https://alex-palmas.github.io,http://localhost:8080,http://127.0.0.1:8080").split(",").map(s => s.trim()).filter(Boolean);

export function start(port = PORT, opts = {}) {
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const r = await relay(new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : body }), { allowed, ...opts });
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(e.message || e) })); }
  });
  return new Promise(res => server.listen(port, "127.0.0.1", () => res(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().then(() => console.log(`Kalshi relay on http://localhost:${PORT} (allowed origins: ${allowed.join(", ")}). Ctrl+C to stop.`));
}
