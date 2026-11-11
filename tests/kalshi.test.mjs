import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, verify, constants, createPublicKey } from "node:crypto";
import { createRequire } from "node:module";
import { start } from "../scripts/kalshi-relay.mjs";
const K = createRequire(import.meta.url)("../site/kalshi.js");

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = rsa.privateKey.export({ type: "pkcs1", format: "pem" });   // what Kalshi hands out
const pkcs8 = rsa.privateKey.export({ type: "pkcs8", format: "pem" });
const okSig = (pub, ts, method, path, sig) => verify("sha256", Buffer.from(ts + method + path), { key: pub, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(sig, "base64"));

test("browser signing matches Kalshi's RSA-PSS scheme (PKCS#1 and PKCS#8 keys), key not extractable", async () => {
  for (const pem of [pkcs1, pkcs8]) {
    const c = await K.importPem(pem); assert.equal(c.alg, "RSA-PSS"); assert.equal(c.key.extractable, false);
    const h = await K.authHeaders({ ...c, keyId: "abc" }, "post", "/trade-api/v2/portfolio/events/orders?x=1", 1700000000000);
    assert.equal(h["KALSHI-ACCESS-KEY"], "abc"); assert.equal(h["KALSHI-ACCESS-TIMESTAMP"], "1700000000000");
    assert.ok(okSig(rsa.publicKey, "1700000000000", "POST", "/trade-api/v2/portfolio/events/orders", h["KALSHI-ACCESS-SIGNATURE"]));
  }
  const ed = generateKeyPairSync("ed25519"), c = await K.importPem(ed.privateKey.export({ type: "pkcs8", format: "pem" }));
  assert.equal(c.alg, "Ed25519");
  const h = await K.authHeaders({ ...c, keyId: "k" }, "GET", "/trade-api/v2/portfolio/balance", 5);
  assert.ok(verify(null, Buffer.from("5GET/trade-api/v2/portfolio/balance"), ed.publicKey, Buffer.from(h["KALSHI-ACCESS-SIGNATURE"], "base64")));
  await assert.rejects(K.importPem("not a key"), /private key/);
});

test("order body: over buys YES as a bid; under buys NO as a YES ask at 1 - price; IOC", () => {
  const y = K.orderBody({ ticker: "KXNBAPTS-X-25", buy: "yes", contracts: 7.9, price: 0.56, clientId: "c1" });
  assert.deepEqual(y, { ticker: "KXNBAPTS-X-25", client_order_id: "c1", side: "bid", count: "7", price: "0.56", time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross" });
  const n = K.orderBody({ ticker: "T", buy: "no", contracts: 3, price: 0.41, clientId: "c2" });
  assert.equal(n.side, "ask"); assert.equal(n.price, "0.59");
  assert.throws(() => K.orderBody({ ticker: "T", buy: "yes", contracts: 0, price: 0.5 }));
  assert.throws(() => K.orderBody({ ticker: "T", buy: "yes", contracts: 1, price: 1 }));
});

test("sizing never exceeds the stake or the max per order, fees included", () => {
  assert.equal(K.takerFee(10, 0.5), 0.18);
  const z = K.size(100, 0.5, 25); assert.ok(z.cost <= 25 && z.contracts === 48, JSON.stringify(z));
  assert.equal(K.size(0.3, 0.5, 25).contracts, 0);
});

test("relay forwards signed requests to Kalshi, strips Origin, and refuses other origins and paths", async () => {
  const seen = [];
  const mock = createServer(async (req, res) => { let b = ""; for await (const c of req) b += c; seen.push({ url: req.url, method: req.method, h: req.headers, b });
    const ok = okSig(rsa.publicKey, req.headers["kalshi-access-timestamp"], req.method, req.url.split("?")[0], req.headers["kalshi-access-signature"] || "");
    res.writeHead(ok ? 201 : 401, { "content-type": "application/json" }); res.end(JSON.stringify(ok ? { order_id: "o1", fill_count: "2.00", average_fill_price: "0.56" } : { error: "bad sig" })); });
  await new Promise(r => mock.listen(0, "127.0.0.1", r));
  const up = `http://127.0.0.1:${mock.address().port}`;
  const relay = await start(0, { upstream: up, allowed: ["https://alex-palmas.github.io"] });
  const base = `http://127.0.0.1:${relay.address().port}`, origin = "https://alex-palmas.github.io";
  try {
    const c = { ...(await K.importPem(pkcs1)), keyId: "kid" }, path = "/trade-api/v2/portfolio/events/orders";
    const body = K.orderBody({ ticker: "T", buy: "yes", contracts: 2, price: 0.56, clientId: "x" });
    const r = await fetch(base + path, { method: "POST", headers: { origin, "content-type": "application/json", ...(await K.authHeaders(c, "POST", path)) }, body: JSON.stringify(body) });
    assert.equal(r.status, 201); assert.equal(r.headers.get("access-control-allow-origin"), origin);
    assert.equal((await r.json()).order_id, "o1");
    assert.equal(seen[0].h.origin, undefined); assert.equal(seen[0].h["kalshi-access-key"], "kid"); assert.deepEqual(JSON.parse(seen[0].b), body);
    const pre = await fetch(base + path, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
    assert.equal(pre.status, 204); assert.match(pre.headers.get("access-control-allow-headers"), /kalshi-access-signature/);
    assert.equal((await fetch(base + path, { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(base + "/elsewhere", { headers: { origin } })).status, 404);
    assert.equal(seen.length, 1);
  } finally { relay.close(); mock.close(); }
});

test("links to the market's event page on kalshi.com", async () => {
  const { kalshiHref, parseKalshiMarket } = await import("../scripts/fetch-data.mjs");
  assert.equal(kalshiHref("KXNBAPTS-26NOV10ORLSAC-SACDSABONIS11-25", "KXNBAPTS-26NOV10ORLSAC", "nba-player-points"),
    "https://kalshi.com/markets/kxnbapts/nba-player-points/kxnbapts-26nov10orlsac");
  assert.equal(kalshiHref("KXNBAPTS-26NOV10ORLSAC-X-25", null, null), "https://kalshi.com/markets/kxnbapts");
  const quotes = {};
  parseKalshiMarket("nba", "pts", { ticker: "KXNBAPTS-26NOV10ORLSAC-SACDSABONIS11-25", event_ticker: "KXNBAPTS-26NOV10ORLSAC", title: "Domantas Sabonis: 25+ points",
    yes_ask_dollars: "0.40", no_ask_dollars: "0.62", floor_strike: 24.5, strike_type: "greater" }, quotes, "nba-player-points");
  const q = Object.values(quotes)[0][0];
  assert.equal(q.href, "https://kalshi.com/markets/kxnbapts/nba-player-points/kxnbapts-26nov10orlsac");
  // browser fallback from just the ticker
  assert.equal(K.href({ tk: "KXNBAREB-26NOV10ORLSAC-X-7" }), "https://kalshi.com/markets/kxnbareb/nba-player-rebounds/kxnbareb-26nov10orlsac");
  assert.equal(K.href({ href: "https://kalshi.com/x" }), "https://kalshi.com/x");
  assert.match(K.link({ tk: "KXNBAPTS-A-B-1" }), /target="_blank" rel="noopener"/);
});

test("Ed25519 keys: PKCS#8 PEM and the bare 32-byte key (base64 or hex) both sign correctly", async () => {
  const ed = generateKeyPairSync("ed25519");
  const der = ed.privateKey.export({ type: "pkcs8", format: "der" }), seed = der.subarray(der.length - 32);
  const msg = (ts, path) => Buffer.from(ts + "GET" + path);
  for (const input of [ed.privateKey.export({ type: "pkcs8", format: "pem" }), seed.toString("base64"), seed.toString("hex"), "  " + seed.toString("base64") + "\n"]) {
    const c = await K.importPem(input);
    assert.equal(c.alg, "Ed25519"); assert.equal(c.key.extractable, false);
    const h = await K.authHeaders({ ...c, keyId: "k" }, "GET", "/trade-api/v2/portfolio/balance?x=1", 7);
    assert.ok(verify(null, msg("7", "/trade-api/v2/portfolio/balance"), ed.publicKey, Buffer.from(h["KALSHI-ACCESS-SIGNATURE"], "base64")));
  }
  await assert.rejects(K.importPem("hello"), /doesn't look like a private key/);
  await assert.rejects(K.importPem("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----"), /OpenSSH/);
});
