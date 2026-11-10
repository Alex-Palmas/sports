/**
 * Kalshi relay for placing orders from PropLab — one self-contained file.
 *
 * Kalshi rejects requests that come from web pages, so the browser sends its already-signed
 * requests here and they're forwarded unchanged to Kalshi. The relay holds no secrets: it only
 * passes through the KALSHI-ACCESS-* headers your browser created (your private key never leaves
 * the browser). It only forwards Kalshi trade-api/v2 requests, only for allowed page origins.
 *
 * Use it two ways:
 *  - From your phone: deploy to Cloudflare Workers (free). dash.cloudflare.com → Workers & Pages →
 *    Create → Hello World → Edit code → replace everything with this file → Deploy. Optional
 *    variable ALLOWED_ORIGIN (comma-separated) if your site isn't https://alex-palmas.github.io.
 *    Paste the worker URL (https://<name>.<you>.workers.dev) into PropLab → Settings → Relay URL.
 *  - On a computer: `node scripts/kalshi-relay.mjs` (uses this same code, on http://localhost:8787).
 */
export const KALSHI = "https://api.elections.kalshi.com";
const PASS = ["content-type", "kalshi-access-key", "kalshi-access-signature", "kalshi-access-timestamp"];
const METHODS = ["GET", "POST", "DELETE"];

export async function relay(req, { allowed = ["https://alex-palmas.github.io"], upstream = KALSHI, fetchImpl = fetch } = {}) {
  const origin = req.headers.get("origin") || "";
  const ok = allowed.includes(origin) || allowed.includes("*");
  const cors = {
    "access-control-allow-origin": ok ? origin || "*" : allowed[0] || "null",
    "access-control-allow-methods": METHODS.join(", "),
    "access-control-allow-headers": PASS.join(", "),
    "access-control-max-age": "600",
    "vary": "origin",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: ok ? 204 : 403, headers: cors });
  if (!ok) return new Response(JSON.stringify({ error: `origin ${origin || "(none)"} not allowed` }), { status: 403, headers: { ...cors, "content-type": "application/json" } });
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/trade-api/v2/") || !METHODS.includes(req.method))
    return new Response(JSON.stringify({ error: "only Kalshi trade-api/v2 requests are relayed" }), { status: 404, headers: { ...cors, "content-type": "application/json" } });
  const headers = new Headers();
  for (const h of PASS) { const v = req.headers.get(h); if (v) headers.set(h, v); }
  const body = req.method === "POST" ? await req.text() : undefined;
  const r = await fetchImpl(upstream + url.pathname + url.search, { method: req.method, headers, body });
  return new Response(await r.text(), { status: r.status, headers: { ...cors, "content-type": r.headers.get("content-type") || "application/json" } });
}

export default {
  fetch(req, env) {
    const allowed = String(env?.ALLOWED_ORIGIN || "https://alex-palmas.github.io").split(",").map(s => s.trim()).filter(Boolean);
    return relay(req, { allowed });
  },
};
