#!/usr/bin/env node
/**
 * Every-sport survey: do simple price-band rules beat Kalshi after fees?
 *
 * For each series below, takes up to --max recent settled events, the YES bid/ask of every market from the
 * hourly candle ending `lead` before the market closed (markets close when the event ends, so this is a
 * pre-event price; leads are set per sport to clear the event's length), and Kalshi's result. Then, per
 * series, buying YES and buying NO in each price band (0–10¢ … 90–100¢ by YES mid) at the real ask, after
 * the taker fee, split into the earlier and later half of the dates.
 *
 *   node scripts/market-survey.mjs collect [--max 250] [--only golf,soccer]   → .cache/survey.json
 *   node scripts/market-survey.mjs report [--min 80]                          → per-series results + consistent winners
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const API = "https://api.elections.kalshi.com/trade-api/v2", OUT = ".cache/survey.json";
const H = 3600, D = 86400;
// [series, sport, what, lead before close, since]
export const SERIES = [
  ["KXPGATOUR", "golf", "tournament winner", 4.2 * D, "2026-05-01"], ["KXPGATOP10", "golf", "top 10 finish", 4.2 * D, "2026-05-01"],
  ["KXPGATOP20", "golf", "top 20 finish", 4.2 * D, "2026-05-01"], ["KXPGAMAKECUT", "golf", "make the cut", 2.5 * D, "2026-05-01"],
  ["KXPGAH2H", "golf", "round head-to-head", 7 * H, "2026-05-01"], ["KXPGA3BALL", "golf", "3-ball (round)", 7 * H, "2026-05-01"],
  ["KXDPWTH2H", "golf", "DP World round matchup", 7 * H, "2026-05-01"], ["KXLIVTOUR", "golf", "LIV winner", 3.2 * D, "2026-04-01"],
  ["KXEPLGAME", "soccer", "EPL result (1X2)", 3 * H, "2026-08-10"], ["KXEPLTOTAL", "soccer", "EPL total goals", 3 * H, "2026-08-10"],
  ["KXEPLBTTS", "soccer", "EPL both teams score", 3 * H, "2026-08-10"], ["KXEPLSPREAD", "soccer", "EPL spread", 3 * H, "2026-08-10"],
  ["KXEPLANYGOAL", "soccer", "EPL anytime scorer", 3 * H, "2026-08-10"], ["KXUCLGAME", "soccer", "Champions League result", 3 * H, "2026-09-01"],
  ["KXUCLTOTAL", "soccer", "Champions League total", 3 * H, "2026-09-01"], ["KXLALIGAGAME", "soccer", "La Liga result", 3 * H, "2026-08-10"],
  ["KXSERIEAGAME", "soccer", "Serie A result", 3 * H, "2026-08-10"], ["KXBUNDESLIGAGAME", "soccer", "Bundesliga result", 3 * H, "2026-08-10"],
  ["KXLIGUE1GAME", "soccer", "Ligue 1 result", 3 * H, "2026-08-10"], ["KXMLSGAME", "soccer", "MLS result", 3 * H, "2026-07-01"],
  ["KXLALIGATOTAL", "soccer", "La Liga total", 3 * H, "2026-08-10"], ["KXBUNDESLIGATOTAL", "soccer", "Bundesliga total", 3 * H, "2026-08-10"],
  ["KXNFLGAME", "nfl", "winner", 4.5 * H, "2026-09-08"], ["KXNFLSPREAD", "nfl", "spread", 4.5 * H, "2026-09-08"], ["KXNFLTOTAL", "nfl", "total", 4.5 * H, "2026-09-08"],
  ["KXNFLPASSYDS", "nfl", "passing yards prop", 4.5 * H, "2026-09-08"], ["KXNFLRECYDS", "nfl", "receiving yards prop", 4.5 * H, "2026-09-08"],
  ["KXNFLREC", "nfl", "receptions prop", 4.5 * H, "2026-09-08"], ["KXNFLANYTD", "nfl", "anytime TD", 4.5 * H, "2026-09-08"],
  ["KXNHLGAME", "nhl", "winner", 4 * H, "2026-10-06"], ["KXNHLSPREAD", "nhl", "spread", 4 * H, "2026-10-06"], ["KXNHLTOTAL", "nhl", "total", 4 * H, "2026-10-06"],
  ["KXNHLANYGOAL", "nhl", "anytime goal", 4 * H, "2026-10-06"], ["KXNHLPTS", "nhl", "points prop", 4 * H, "2026-10-06"], ["KXNHLSAVES", "nhl", "saves prop", 4 * H, "2026-10-06"],
  ["KXMLBGAME", "mlb", "winner", 4.5 * H, "2026-08-01"], ["KXMLBTOTAL", "mlb", "total runs", 4.5 * H, "2026-08-01"], ["KXMLBSPREAD", "mlb", "run line", 4.5 * H, "2026-08-01"],
  ["KXMLBHIT", "mlb", "hits prop", 4.5 * H, "2026-08-01"], ["KXMLBHR", "mlb", "home run prop", 4.5 * H, "2026-08-01"], ["KXMLBKS", "mlb", "strikeouts prop", 4.5 * H, "2026-08-01"],
  ["KXMLBTB", "mlb", "total bases prop", 4.5 * H, "2026-08-01"],
  ["KXWNBAGAME", "wnba", "winner", 4 * H, "2026-06-01"], ["KXWNBAPTS", "wnba", "points prop", 4 * H, "2026-06-01"], ["KXWNBAREB", "wnba", "rebounds prop", 4 * H, "2026-06-01"],
  ["KXUFCFIGHT", "mma", "UFC fight winner", 3 * H, "2026-05-01"],
  ["KXF1RACE", "motor", "F1 race winner", 5 * H, "2026-04-01"], ["KXF1RACEPODIUM", "motor", "F1 podium", 5 * H, "2026-04-01"], ["KXF1H2H", "motor", "F1 head-to-head", 5 * H, "2026-04-01"],
  ["KXNASCARRACE", "motor", "NASCAR race winner", 6 * H, "2026-04-01"], ["KXNASCARTOP10", "motor", "NASCAR top 10", 6 * H, "2026-04-01"], ["KXNASCARH2H", "motor", "NASCAR head-to-head", 6 * H, "2026-04-01"],
  ["KXT20MATCH", "cricket", "T20 match", 5 * H, "2026-06-01"], ["KXCRICKETT20IMATCH", "cricket", "T20I match", 5 * H, "2026-06-01"], ["KXODIMATCH", "cricket", "ODI match", 10 * H, "2026-06-01"],
  ["KXCS2GAME", "esports", "CS2 match", 5 * H, "2026-07-01"], ["KXLOLGAME", "esports", "LoL match", 5 * H, "2026-07-01"],
  ["KXVALORANTGAME", "esports", "Valorant match", 5 * H, "2026-07-01"], ["KXDOTA2GAME", "esports", "Dota 2 match", 5 * H, "2026-07-01"],
];
const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;
async function get(url) {
  for (let i = 0; i < 7; i++) {
    const w = last + 150 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
    const r = await fetch(url).catch(() => null);
    if (r?.ok) return r.json();
    if (r && r.status !== 429 && r.status < 500) throw new Error(`${r.status} ${url}`);
    await sleep(800 * 2 ** i);
  }
  throw new Error(`gave up ${url}`);
}
const eventDate = (t, iso) => { const m = /-(\d\d)([A-Z]{3})(\d\d)/.exec(t); return m ? `20${m[1]}-${MON[m[2]]}-${m[3]}` : (iso || "").slice(0, 10) || null; };

async function collect() {
  const max = +arg("--max", 250), only = arg("--only", "") ? arg("--only").split(",") : null;
  let db = { events: {} }; try { db = JSON.parse(readFileSync(OUT, "utf8")); } catch {}
  for (const [series, sport, what, lead, since] of SERIES) {
    if (only && !only.includes(sport)) continue;
    let cursor = "", n = Object.values(db.events).filter(e => e.series === series).length, skip = 0, stop = false;
    try {
      do {
        const j = await get(`${API}/events?series_ticker=${series}&status=settled&with_nested_markets=true&limit=100${cursor ? `&cursor=${cursor}` : ""}`);
        for (const ev of j.events || []) {
          if (n >= max) { stop = true; break; }
          if (db.events[ev.event_ticker]) continue;
          const ms = (ev.markets || []).filter(m => m.result === "yes" || m.result === "no");
          if (!ms.length) { skip++; continue; }
          const close = Math.max(...ms.map(m => Math.round(Date.parse(m.close_time) / 1000)));
          const day = eventDate(ev.event_ticker, ms[0].close_time);
          if (day && day < since) { stop = true; break; }
          const open = Math.min(...ms.map(m => Math.round(Date.parse(m.open_time) / 1000)));
          const at = Math.round(close - lead);
          if (!(at > open + 1800)) { skip++; continue; }
          let c; try { c = await get(`${API}/series/${series}/events/${ev.event_ticker}/candlesticks?start_ts=${at - 24 * 3600}&end_ts=${at}&period_interval=60`); } catch { skip++; continue; }
          const q = {};
          (c.market_tickers || []).forEach((tk, i) => { const k = (c.market_candlesticks?.[i] || []).filter(x => x.end_period_ts <= at + 60).at(-1);
            if (k?.yes_bid?.close_dollars != null && k?.yes_ask?.close_dollars != null) q[tk] = [+k.yes_bid.close_dollars, +k.yes_ask.close_dollars]; });
          const m = ms.filter(x => q[x.ticker]).map(x => [...q[x.ticker], x.result === "yes" ? 1 : 0]);
          if (!m.length) { skip++; continue; }
          db.events[ev.event_ticker] = { series, sport, what, day: eventDate(ev.event_ticker, new Date(close * 1000).toISOString()), m };
          n++;
        }
        cursor = j.cursor;
        mkdirSync(".cache", { recursive: true }); writeFileSync(OUT, JSON.stringify(db));
      } while (cursor && !stop);
    } catch (e) { console.log(`${series}: error ${e.message}`); }
    console.log(`${sport} · ${what} (${series}): ${n} events, ${skip} skipped`);
  }
}

const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100;
/** Per series: bands × side → [half0, half1] of {n, cost, ret}; plus calibration per band. */
export function analyze(events) {
  const out = {};
  const bySeries = {}; for (const e of events) (bySeries[e.series] ||= []).push(e);
  for (const [series, evs] of Object.entries(bySeries)) {
    const days = [...new Set(evs.map(e => e.day))].sort(), cut = days[Math.floor(days.length / 2)];
    const R = {}, cal = {};
    for (const e of evs) for (const [bid, ask, y] of e.m) {
      if (!(ask >= bid) || ask - bid > 0.1 || ask <= 0 || bid >= 1) continue;
      const mid = (bid + ask) / 2, band = Math.min(9, Math.floor(mid * 10)), half = e.day < cut ? 0 : 1;
      const c = (cal[band] ||= { n: 0, y: 0, p: 0 }); c.n++; c.y += y; c.p += mid;
      for (const side of ["yes", "no"]) {
        const cost = side === "yes" ? ask : 1 - bid; if (cost < 0.02 || cost > 0.98) continue;
        const r = ((R[`${side}|${band}`] ||= [{ n: 0, c: 0, r: 0 }, { n: 0, c: 0, r: 0 }])[half]); r.n++; r.c += cost + fee(cost); r.r += side === "yes" ? y : 1 - y;
      }
    }
    out[series] = { sport: evs[0].sport, what: evs[0].what, events: evs.length, markets: evs.reduce((a, e) => a + e.m.length, 0), cut, R, cal };
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "collect") await collect();
  else {
    const min = +arg("--min", 80), A = analyze(Object.values(JSON.parse(readFileSync(OUT, "utf8")).events)), winners = [];
    for (const [s, a] of Object.entries(A).sort((x, y) => x[1].sport.localeCompare(y[1].sport))) {
      const cal = Object.entries(a.cal).sort((x, y) => x[0] - y[0]).filter(([, c]) => c.n >= 30).map(([b, c]) => `${b * 10}¢:${Math.round(c.y / c.n * 100)}%`).join(" ");
      let best = null;
      for (const [k, h] of Object.entries(a.R)) {
        const [side, band] = k.split("|"); if (h[0].n < min || h[1].n < min) continue;
        const roi = h.map(x => (x.r - x.c) / x.c);
        if (!best || Math.min(...roi) > Math.min(...best.roi)) best = { side, band: +band, roi, n: h[0].n + h[1].n };
        if (roi[0] > 0 && roi[1] > 0) winners.push({ s, a, side, band: +band, roi, n: h[0].n + h[1].n });
      }
      console.log(`${a.sport.padEnd(8)} ${a.what.padEnd(26)} ${String(a.events).padStart(4)} events ${String(a.markets).padStart(6)} mkts | hit rate by YES price ${cal}${best ? ` | best: ${best.side.toUpperCase()} at ${best.band * 10}–${best.band * 10 + 10}¢ ${best.roi.map(r => (r * 100).toFixed(1) + "%").join(" / ")} (${best.n})` : ""}`);
    }
    console.log(`\nRules positive in BOTH halves (≥${min} bets each half):`);
    for (const w of winners.sort((x, y) => Math.min(...y.roi) - Math.min(...x.roi))) console.log(`  ${w.a.sport} · ${w.a.what}: buy ${w.side.toUpperCase()} when YES is ${w.band * 10}–${w.band * 10 + 10}¢ → ${w.roi.map(r => (r * 100).toFixed(1) + "%").join(" / ")} on ${w.n} bets`);
  }
}
