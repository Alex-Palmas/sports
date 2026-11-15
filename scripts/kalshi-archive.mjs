#!/usr/bin/env node
/**
 * Older settled Kalshi markets move to the historical API: the events listing still shows the event, but its
 * nested markets are empty. This fills them in for a league in kalshi-history.mjs's format: markets from
 * /historical/markets?event_ticker=…, and each market's pre-game quote from its historical candlesticks
 * (the last hourly candle before the scheduled start from ESPN).
 *
 *   node scripts/kalshi-archive.mjs --league wnba --since 2026-05-01 --part 0/6     (then --merge)
 *   node scripts/kalshi-archive.mjs --league wnba --merge --out .cache/kalshi-history-wnba.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const API = "https://api.elections.kalshi.com/trade-api/v2";
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const LEAGUE = arg("--league", "wnba"), SINCE = arg("--since", "2026-05-01"), OUT = arg("--out", `.cache/kalshi-history-${LEAGUE}.json`);
const ESPN = { wnba: "basketball/wnba", nba: "basketball/nba", nhl: "hockey/nhl", nfl: "football/nfl", mlb: "baseball/mlb" }[LEAGUE];
const { SERIES, eventDate, parseSub } = await import("./kalshi-history.mjs");   // reads --league from argv
const sleep = ms => new Promise(r => setTimeout(r, ms)); let last = 0;
async function get(url) {
  for (let i = 0; i < 8; i++) {
    const w = last + 90 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
    const r = await fetch(url).catch(() => null);
    if (r?.ok) return r.json();
    if (r && r.status !== 429 && r.status < 500) throw new Error(`${r.status} ${url}`);
    await sleep(1000 * 2 ** i);
  }
  throw new Error(`gave up ${url}`);
}
const num = x => x == null || x === "" ? null : +x;
const read = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };

if (process.argv.includes("--merge")) {
  const db = read(OUT, { events: {} }); let n = 0;
  for (let i = 0; i < 16; i++) { const f = `${OUT}.part${i}`; if (!existsSync(f)) continue; for (const [k, e] of Object.entries(read(f, {}))) { if (!db.events[k]?.markets?.length) { db.events[k] = e; n++; } } }
  writeFileSync(OUT, JSON.stringify(db)); console.log(`merged ${n} archived events → ${OUT} (${Object.keys(db.events).length} events)`); process.exit(0);
}
const [pi, pn] = arg("--part", "0/1").split("/").map(Number), PART = `${OUT}.part${pi}`;
const have = read(OUT, { events: {} }).events, done = read(PART, {});
// every settled event since SINCE without usable markets in the main file
const todo = [];
for (const series of Object.keys(SERIES)) {
  let cursor = "";
  do {
    const j = await get(`${API}/events?series_ticker=${series}&status=settled&limit=200${cursor ? `&cursor=${cursor}` : ""}`);
    for (const e of j.events || []) { const d = eventDate(e.event_ticker); if (d && d >= SINCE && !have[e.event_ticker]?.markets?.length) todo.push({ tk: e.event_ticker, series, date: d }); }
    cursor = j.cursor;
  } while (cursor);
}
const mine = todo.filter((_, i) => i % pn === pi).filter(e => !done[e.tk]);
console.log(`part ${pi}: ${mine.length} archived events to fetch (${todo.length} in all)`);
const tips = {};
for (const e of mine) {
  try {
    if (!tips[e.date]) { const j = await get(`https://site.api.espn.com/apis/site/v2/sports/${ESPN}/scoreboard?dates=${e.date.replace(/-/g, "")}`); tips[e.date] = (j.events || []).map(x => ({ t: Date.parse(x.date) / 1000, teams: x.competitions?.[0]?.competitors?.map(c => c.team?.abbreviation) || [] })); }
    const suffix = e.tk.split("-")[1].slice(7), g = tips[e.date].find(x => x.teams.filter(a => a && suffix.includes(a.slice(0, 2))).length === 2);
    const h = await get(`${API}/historical/markets?event_ticker=${e.tk}&limit=200`);
    const ms = (h.markets || []).filter(m => m.result === "yes" || m.result === "no").map(m => ({ tk: m.ticker, ...parseSub(m.yes_sub_title), strike: m.floor_strike ?? (parseSub(m.yes_sub_title)?.n ?? 1) - 0.5, y: m.result === "yes" ? 1 : 0, value: num(m.expiration_value), tv: num(m.volume_fp) })).filter(m => m.name);
    if (g) for (const m of ms) {
      const c = await get(`${API}/historical/markets/${m.tk}/candlesticks?start_ts=${g.t - 6 * 3600}&end_ts=${g.t}&period_interval=60`);
      const k = (c.candlesticks || []).filter(x => x.end_period_ts <= g.t + 60), lc = k.at(-1); if (!lc) continue;
      m.bid = num(lc.yes_bid?.close); m.ask = num(lc.yes_ask?.close); m.vol = k.reduce((a, x) => a + (num(x.volume) || 0), 0);   // pre-game volume only
      const f = k.find(x => x.yes_bid?.close != null && x.yes_ask?.close != null); if (f && f !== lc) m.mid0 = (+f.yes_bid.close + +f.yes_ask.close) / 2;
    }
    done[e.tk] = { series: e.series, stat: SERIES[e.series], date: e.date, tip: g?.t ?? null, markets: ms, v: 2, archived: true };
  } catch (err) { console.warn(e.tk, err.message); }
  if (Object.keys(done).length % 20 === 0) writeFileSync(PART, JSON.stringify(done));
}
writeFileSync(PART, JSON.stringify(done)); console.log(`part ${pi} done: ${Object.keys(done).length} events`);
