/**
 * The PropLab app's built-in Kalshi relay: the same forwarding rules as relay/kalshi-relay-worker.mjs
 * (copied next to this file as relay.mjs at build time), served on a random free port on 127.0.0.1.
 * It only forwards requests the page already signed; it never sees the Kalshi key.
 */
import { createServer } from "node:http";
import { relay } from "./relay.mjs";

export function startRelay({ allowed, port = 0, upstream } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length && !["GET", "HEAD", "OPTIONS"].includes(req.method) ? Buffer.concat(chunks) : undefined;
      const r = await relay(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, body }), { allowed, ...(upstream ? { upstream } : {}) });
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(e.message || e) })); }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
