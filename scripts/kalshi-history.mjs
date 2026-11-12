#!/usr/bin/env node
/**
 * Collects settled Kalshi NBA player-prop markets with the price just before tip-off, so the edge
 * model can be scored against the real market (scripts/market-backtest.mjs) instead of only
 * against box scores.
 *
 *   node scripts/kalshi-history.mjs [--since 2026-10-20] [--out .cache/kalshi-history.json]
 *
 * For each settled event in the prop series: every strike's result and settlement value, and the
 * YES bid/ask at the last hourly candle before the scheduled start (ESPN scoreboard). Public data,
 * no key. Re-running only fetches events not already in the output file.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const API = "https://api.elections.kalshi.com/trade-api/v2";
const LEAGUES = {
  nba: { espn: "basketball/nba", series: { KXNBAPTS: "pts", KXNBAREB: "reb", KXNBAAST: "ast", KXNBA3PT: "fg3", KXNBAPR: "pr", KXNBAPA: "pa", KXNBARA: "ra", KXNBAPRA: "pra", KXNBASTL: "stl", KXNBABLK: "blk" } },
  nfl: { espn: "football/nfl", series: { KXNFLPASSYDS: "pass_yds", KXNFLRSHYDS: "rush_yds", KXNFLRECYDS: "rec_yds", KXNFLREC: "rec", KXNFLPASSTDS: "pass_td", KXNFLANYTD: "td" } },
};
const LEAGUE = (() => { const i = process.argv.indexOf("--league"); return i > 0 ? process.argv[i + 1] : "nba"; })();
const ESPN = `https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[LEAGUE].espn}/scoreboard`;
export const SERIES = LEAGUES[LEAGUE].series;
const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;
async function get(url) {
  for (let i = 0; i < 7; i++) {
    const wait = last + 120 - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
    const r = await fetch(url).catch(() => null);
    if (r?.ok) return r.json();
    if (r && r.status !== 429 && r.status < 500) throw new Error(`${r.status} ${url}`);
    await sleep(800 * 2 ** i);
  }
  throw new Error(`gave up ${url}`);
}

/** "KXNBAPTS-26NOV10MILNYK" → "2026-11-10" (the game's US date). */
export const eventDate = t => { const m = /-(\d\d)([A-Z]{3})(\d\d)/.exec(t); return m ? `20${m[1]}-${MON[m[2]]}-${m[3]}` : null; };
/** "Ryan Rollins: 25+" → { name: "Ryan Rollins", n: 25 } */
/** "Ryan Rollins: 25+" → { name, n: 25 }; anytime-TD style "Josh Allen" (no number) → { name, n: 1 } */
export const parseSub = s => { const m = /^(.*?):\s*(\d+)\+/.exec(s || ""); if (m) return { name: m[1].trim(), n: +m[2] }; const t = String(s || "").trim(); return t && !/[:+]/.test(t) && t.split(" ").length <= 4 ? { name: t, n: 1 } : null; };
const num = x => x == null || x === "" ? null : +x;

async function startTimes(date, cache) {
  if (cache[date]) return cache[date];
  const j = await get(`${ESPN}?dates=${date.replace(/-/g, "")}`);
  return (cache[date] = (j.events || []).map(e => ({ t: Date.parse(e.date) / 1000, teams: e.competitions?.[0]?.competitors?.map(c => c.team?.abbreviation) || [] })));
}

async function main() {
  const since = arg("--since", "2026-10-20"), OUT = arg("--out", ".cache/kalshi-history.json");
  let db = { events: {} }; try { db = JSON.parse(readFileSync(OUT, "utf8")); } catch {}
  const tips = {};
  for (const [series, stat] of Object.entries(SERIES)) {
    let cursor = "", n = 0, stop = false;
    do {
      const j = await get(`${API}/events?series_ticker=${series}&status=settled&with_nested_markets=true&limit=100${cursor ? `&cursor=${cursor}` : ""}`);
      for (const e of j.events || []) {
        const date = eventDate(e.event_ticker); if (!date) continue;
        if (date < since) { stop = true; continue; }
        if (db.events[e.event_ticker]?.v === 2) continue;
        const ms = (e.markets || []).filter(m => m.result === "yes" || m.result === "no").map(m => ({ tk: m.ticker, ...parseSub(m.yes_sub_title), strike: m.floor_strike ?? (parseSub(m.yes_sub_title)?.n ?? 1) - 0.5, y: m.result === "yes" ? 1 : 0, value: num(m.expiration_value), tv: num(m.volume_fp) })).filter(m => m.name);
        if (!ms.length) continue;
        // scheduled start: ESPN game on that date whose teams appear in the event ticker's suffix
        const suffix = e.event_ticker.split("-")[1].slice(7);
        const games = await startTimes(date, tips);
        const g = games.find(x => x.teams.filter(a => a && suffix.includes(a.slice(0, 2))).length === 2) || (games.length === 1 ? games[0] : null);
        const ev = { series, stat, date, tip: g?.t ?? null, markets: ms };
        if (g) {
          try {
            const c = await get(`${API}/series/${series}/events/${e.event_ticker}/candlesticks?start_ts=${g.t - 6 * 3600}&end_ts=${g.t}&period_interval=60`);
            (c.market_tickers || []).forEach((tk, i) => {
              const k = (c.market_candlesticks?.[i] || []).filter(x => x.end_period_ts <= g.t + 60);
              const lastC = k.at(-1), m = ms.find(x => x.tk === tk); if (!m || !lastC) return;
              m.bid = num(lastC.yes_bid?.close_dollars); m.ask = num(lastC.yes_ask?.close_dollars); m.last = num(lastC.price?.close_dollars ?? lastC.price?.previous_dollars);
              m.vol = k.reduce((a, x) => a + (num(x.volume_fp) || 0), 0);
              // the quote ~6 hours before tip (or when the market opened): how far the price moved since
              const first = k.find(x => x.yes_bid?.close_dollars != null && x.yes_ask?.close_dollars != null);
              if (first && first !== lastC) m.mid0 = (num(first.yes_bid.close_dollars) + num(first.yes_ask.close_dollars)) / 2;
            });
            ev.done = true; ev.v = 2;
          } catch (err) { console.warn(e.event_ticker, err.message); }
        }
        db.events[e.event_ticker] = ev; n++;
      }
      cursor = j.cursor;
      mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(db));
    } while (cursor && !stop);
    console.log(series, "events added:", n);
  }
  const all = Object.values(db.events), mk = all.flatMap(e => e.markets);
  console.log(`total: ${all.length} events, ${mk.length} markets, ${mk.filter(m => m.bid != null && m.ask != null).length} with a pre-game quote → ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
