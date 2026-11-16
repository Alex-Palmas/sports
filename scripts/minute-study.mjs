#!/usr/bin/env node
/**
 * Minute-by-minute test of "grab it the moment it shows a big EV". For settled NBA props since --since, the
 * 1-minute YES bid/ask from the moment Kalshi listed each market until tip-off (event candlesticks, period 1,
 * forward-filled), then the bot's rule replayed at every minute: the Conservative layer's EV after fees at
 * that minute's price, buy the first time it clears --min (cost 20–80¢, two-sided market only), one bet per
 * player/stat/game. Scored on Kalshi's own result.
 *
 *   node scripts/minute-study.mjs collect [--since 2026-11-03] [--part 0/8]   → .cache/nba-minutes-<part>.json
 *   node scripts/minute-study.mjs report [--min 0.10]
 * Caveat: a candle is the top of the book only; the size there can be a few contracts.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
const M = createRequire(import.meta.url)("../site/model.js");
const API = "https://api.elections.kalshi.com/trade-api/v2";
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const read = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const SERIES = { KXNBAPTS: "pts", KXNBAREB: "reb", KXNBAAST: "ast", KXNBA3PT: "fg3", KXNBAPR: "pr", KXNBAPA: "pa", KXNBARA: "ra", KXNBAPRA: "pra" };
const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100;
const sleep = ms => new Promise(r => setTimeout(r, ms)); let last = 0;
async function get(url) {
  for (let i = 0; i < 8; i++) {
    const w = last + 80 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
    const r = await fetch(url).catch(() => null);
    if (r?.ok) return r.json();
    if (r && r.status !== 429 && r.status < 500) throw new Error(`${r.status}`);
    await sleep(1000 * 2 ** i);
  }
  throw new Error("gave up");
}

if (process.argv[2] === "collect") {
  // --ingame: the game itself instead (tip → tip + 3.5 h), saved to .cache/nba-live-<part>.json
  const LIVE = process.argv.includes("--ingame");
  const since = arg("--since", "2026-11-03"), [pi, pn] = arg("--part", "0/1").split("/").map(Number), OUT = `.cache/nba-${LIVE ? "live" : "minutes"}-${pi}.json`;
  const hist = read(".cache/kalshi-history.json", { events: {} }).events, db = read(OUT, {});
  const todo = Object.entries(hist).filter(([k, e]) => SERIES[e.series] && e.date >= since && e.tip && !e.archived).filter((_, i) => i % pn === pi);
  console.log(`part ${pi}: ${todo.length} events`);
  for (const [tk, e] of todo) {
    if (db[tk]) continue;
    try {
      // when the event's markets were listed: earliest open_time (from the live listing)
      if (LIVE) { const out = {}; const c = await get(`${API}/series/${e.series}/events/${tk}/candlesticks?start_ts=${e.tip}&end_ts=${e.tip + 210 * 60}&period_interval=1`);
        (c.market_tickers || []).forEach((m, i) => { for (const x of c.market_candlesticks?.[i] || []) { const b = x.yes_bid?.close_dollars, k = x.yes_ask?.close_dollars; if (b == null && k == null) continue; (out[m] ||= []).push([x.end_period_ts, b == null ? null : +b, k == null ? null : +k, +(x.volume_fp || 0)]); } });
        db[tk] = out; if (Object.keys(db).length % 10 === 0) writeFileSync(OUT, JSON.stringify(db)); continue; }
      const ev = await get(`${API}/events/${tk}?with_nested_markets=true`);
      const opens = (ev.markets || ev.event?.markets || []).map(m => Date.parse(m.open_time) / 1000).filter(Boolean);
      const start = Math.max(Math.floor(Math.min(...opens, e.tip - 20 * 3600)), e.tip - 30 * 3600), out = {};
      for (let a = start; a < e.tip; a += 5 * 3600) {   // 5-hour windows of 1-minute candles
        const c = await get(`${API}/series/${e.series}/events/${tk}/candlesticks?start_ts=${a}&end_ts=${Math.min(e.tip, a + 5 * 3600)}&period_interval=1`);
        (c.market_tickers || []).forEach((m, i) => { for (const x of c.market_candlesticks?.[i] || []) { const b = x.yes_bid?.close_dollars, k = x.yes_ask?.close_dollars; if (b == null && k == null) continue; (out[m] ||= []).push([x.end_period_ts, b == null ? null : +b, k == null ? null : +k]); } });
      }
      db[tk] = out;
    } catch (err) { db[tk] = { err: err.message }; }
    if (Object.keys(db).length % 10 === 0) writeFileSync(OUT, JSON.stringify(db));
  }
  writeFileSync(OUT, JSON.stringify(db)); console.log(`part ${pi} done: ${Object.keys(db).length}`);
}

if (process.argv[2] === "report") {
  const MIN = +arg("--min", "0.10"), hist = read(".cache/kalshi-history.json", { events: {} }).events;
  const mins = {}; for (const f of readdirSync(".cache").filter(f => /^nba-minutes-\d+\.json$/.test(f))) Object.assign(mins, read(`.cache/${f}`, {}));
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  const bets = new Map(); let markets = 0, quotedMin = 0;
  for (const [tk, cs] of Object.entries(mins)) {
    const e = hist[tk]; if (!e || cs.err) continue;
    for (const m of e.markets) {
      const k = cs[m.tk]; if (!k?.length) continue; markets++;
      k.sort((a, b) => a[0] - b[0]); let bid = null, ask = null;
      for (const [t, b, a] of k) {
        if (b != null) bid = b; if (a != null) ask = a;
        if (t > e.tip - 120) break;   // only before tip-off
        if (bid == null || ask == null || !(ask > 0.03 && ask < 0.97 && bid > 0.03 && bid < 0.97) || ask + (1 - bid) > 1.12) continue;   // two-sided market only
        quotedMin++;
        const q = M.edgeOver({ b: "Kalshi", ya: ask, na: 1 - bid }, { stat: e.stat, league: "nba" }); if (q == null) continue;
        for (const side of ["yes", "no"]) {
          const c = side === "yes" ? ask : 1 - bid; if (c < 0.2 || c > 0.8) continue;
          const cost = c + fee(c), ev = (side === "yes" ? q : 1 - q) / cost - 1; if (ev < MIN) continue;
          const key = `${tk.split("-")[1]}|${norm(m.name)}|${e.stat}`;
          if (!bets.has(key)) bets.set(key, { ev, cost, hit: side === "yes" ? m.y : 1 - m.y, side, minsBefore: Math.round((e.tip - t) / 60), spread: +(ask - bid).toFixed(2), date: e.date, name: m.name, stat: e.stat, line: m.strike, c });
        }
      }
    }
  }
  const B = [...bets.values()], cost = B.reduce((a, x) => a + x.cost, 0), won = B.reduce((a, x) => a + x.hit, 0);
  console.log(`${Object.keys(mins).length} events, ${markets} markets with 1-minute quotes, ${quotedMin} two-sided market-minutes before tip; rule: first minute with EV ≥ ${MIN * 100}%`);
  console.log(`bets ${B.length} · won ${B.length ? (won / B.length * 100).toFixed(1) : "—"}% · expected ${B.length ? (B.reduce((a, x) => a + (x.ev + 1) * x.cost, 0) / B.length * 100).toFixed(1) : "—"}% · ROI ${cost ? ((won - cost) / cost * 100).toFixed(1) : "—"}%`);
  const bucket = (f, labs) => labs.map(([lab, g]) => { const s = B.filter(g); const c = s.reduce((a, x) => a + x.cost, 0), w = s.reduce((a, x) => a + x.hit, 0); return `${lab}: ${s.length} bets ${c ? ((w - c) / c * 100).toFixed(1) : "—"}%`; }).join(" | ");
  console.log("by time before tip:", bucket(null, [["> 8 h", x => x.minsBefore > 480], ["2–8 h", x => x.minsBefore > 120 && x.minsBefore <= 480], ["< 2 h", x => x.minsBefore <= 120]]));
  console.log("by spread at entry:", bucket(null, [["≤ 2¢", x => x.spread <= 0.02], ["3–6¢", x => x.spread > 0.02 && x.spread <= 0.06], ["> 6¢", x => x.spread > 0.06]]));
  console.log("examples:", B.slice(0, 8).map(x => `${x.date.slice(5)} ${x.name} ${x.stat} ${x.side === "yes" ? "over" : "under"} ${x.line} @${Math.round(x.c * 100)}¢ EV ${(x.ev * 100).toFixed(0)}% ${x.minsBefore}min pre-tip → ${x.hit ? "won" : "lost"}`).join("; "));
}
