#!/usr/bin/env node
/**
 * Early prices for Kalshi NFL player props: the YES bid/ask at fixed times before kickoff (6 days … 1 hour),
 * from hourly candlesticks, for every settled prop event already in .cache (kalshi-history-nfl.json and
 * nfl-deep*.json). Tests whether early prices are softer than the price at kickoff.
 *
 *   node scripts/nfl-early.mjs collect --part 0/8      (resumable; writes .cache/nfl-early-<part>.json)
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
const API = "https://api.elections.kalshi.com/trade-api/v2";
export const OFFSETS = [144, 96, 72, 48, 36, 24, 12, 6, 3, 1];   // hours before kickoff
const PROPS = new Set(["KXNFLPASSYDS", "KXNFLRSHYDS", "KXNFLRECYDS", "KXNFLREC", "KXNFLPASSTDS", "KXNFLPASSATT", "KXNFLPASSCOMP", "KXNFLRSHATT", "KXNFLRRYDS", "KXNFLTD", "KXNFLPASSINT", "KXNFLLONGREC", "KXNFLLONGRSH"]);
const read = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const sleep = ms => new Promise(r => setTimeout(r, ms)); let last = 0;
async function get(url) {
  for (let i = 0; i < 7; i++) {
    const w = last + 70 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
    const r = await fetch(url).catch(() => null);
    if (r?.ok) return r.json();
    if (r && r.status !== 429 && r.status < 500) throw new Error(`${r.status}`);
    await sleep(800 * 2 ** i);
  }
  throw new Error("gave up");
}
export function events() {
  const ev = {};
  for (const f of readdirSync(".cache").filter(f => /^nfl-deep(-\d)?\.json$/.test(f))) for (const [k, e] of Object.entries(read(`.cache/${f}`, { events: {} }).events)) if (PROPS.has(e.series) && e.kick) ev[k] = { series: e.series, kick: e.kick };
  for (const [k, e] of Object.entries(read(".cache/kalshi-history-nfl.json", { events: {} }).events)) if (e.tip) ev[k] = { series: e.series, kick: e.tip };
  return ev;
}
if (process.argv[2] === "collect") {
  const [pi, pn] = (process.argv[process.argv.indexOf("--part") + 1] || "0/1").split("/").map(Number), OUT = `.cache/nfl-early-${pi}.json`;
  const db = read(OUT, {}), list = Object.entries(events()).filter((_, i) => i % pn === pi);
  let n = 0;
  for (const [tk, e] of list) {
    if (db[tk]) continue;
    try {
      const c = await get(`${API}/series/${e.series}/events/${tk}/candlesticks?start_ts=${e.kick - 150 * 3600}&end_ts=${e.kick}&period_interval=60`);
      const snap = {};
      (c.market_tickers || []).forEach((m, i) => {
        const k = (c.market_candlesticks?.[i] || []).filter(x => x.yes_bid?.close_dollars != null && x.yes_ask?.close_dollars != null);
        snap[m] = OFFSETS.map(h => { const x = k.filter(z => z.end_period_ts <= e.kick - h * 3600 + 60).at(-1); return x && x.end_period_ts > e.kick - (h + 6) * 3600 ? [+x.yes_bid.close_dollars, +x.yes_ask.close_dollars] : null; });
      });
      db[tk] = snap;
    } catch (err) { db[tk] = { err: err.message }; }
    if (++n % 50 === 0) { writeFileSync(OUT, JSON.stringify(db)); console.log(pi, n, "/", list.length); }
  }
  writeFileSync(OUT, JSON.stringify(db)); console.log(`part ${pi}: ${Object.keys(db).length} events`);
}
