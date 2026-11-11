import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const O = createRequire(import.meta.url)("../site/odds.js");

const ev = { commence_time: "2026-11-12T00:30:00Z", bookmakers: [
  { key: "draftkings", title: "DraftKings", markets: [{ key: "player_points", outcomes: [
    { name: "Over", description: "Jalen Brunson", point: 26.5, price: -115 }, { name: "Under", description: "Jalen Brunson", point: 26.5, price: -105 },
    { name: "Over", description: "Jalen Brunson", point: 30.5, price: 180 }, { name: "Under", description: "Jalen Brunson", point: 30.5, price: -240 } ] }] },
  { key: "fanduel", title: "FanDuel", markets: [{ key: "player_points", outcomes: [
    { name: "Over", description: "Jalen Brunson", point: 27.5, price: -110 }, { name: "Under", description: "Jalen Brunson", point: 27.5, price: -110 } ] }] } ] };

test("parses a book's main and alternate lines per player", () => {
  const q = {}; O.parseEvent("nba", ev, q);
  const qs = q["nba|jalenbrunson|pts"];
  assert.equal(qs.length, 3);
  const dk = qs.filter(x => x.k === "draftkings");
  assert.deepEqual(dk.map(x => [x.l, !!x.alt]), [[26.5, false], [30.5, true]]);
});

test("apply merges into the player's market, replaces older quotes from the same book, keeps Kalshi", () => {
  const q = {}; O.parseEvent("nba", ev, q);
  globalThis.localStorage = { m: {}, getItem(k) { return this.m[k] ?? null; }, setItem(k, v) { this.m[k] = String(v); } };
  globalThis.localStorage.setItem("proplab:oddsCache", JSON.stringify({ at: new Date().toISOString(), quotes: q }));
  const p = { name: "Jalen Brunson", gameDate: "2026-11-12T00:30:00Z", lines: { pts: 25.5 }, lineSource: { pts: "book" },
    market: { pts: [{ b: "Kalshi", k: "kalshi", l: 25.5, o: -105, u: -115 }, { b: "DraftKings", k: "draftkings", l: 25.5, o: -110, u: -110 }] } };
  const D = { sports: { nba: { players: [p] } } };
  assert.equal(O.apply(D), 1);
  const books = p.market.pts.map(x => `${x.k}:${x.l}`);
  assert.ok(books.includes("kalshi:25.5") && books.includes("draftkings:26.5") && books.includes("fanduel:27.5"));
  assert.ok(!books.includes("draftkings:25.5"), "the site's older DraftKings quote is replaced");
  assert.equal(p.lines.pts, 25.5, "a line that already came from a book stays");
  // applying again doesn't duplicate
  O.apply(D); assert.equal(p.market.pts.length, 4);
  // a Kalshi-only prop takes the books' consensus line
  const k = { name: "Jalen Brunson", gameDate: "2026-11-12T00:30:00Z", lines: { pts: 29.5 }, lineSource: { pts: "book" }, market: { pts: [{ b: "Kalshi", k: "kalshi", l: 29.5, o: 100, u: -120 }] } };
  O.apply({ sports: { nba: { players: [k] } } }); assert.equal(k.lines.pts, 26.5);
});
