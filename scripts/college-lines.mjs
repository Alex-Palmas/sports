#!/usr/bin/env node
/**
 * Kalshi game lines vs results for college sports (and anything else with the same market shape).
 *
 * For every settled Kalshi total / spread event since --since, finds the game on ESPN's scoreboard
 * (by date, team names and final score), takes each strike's YES bid/ask in the last hour before the
 * start, and stores the result. scripts/lines-backtest.mjs then checks whether simple rules (unders,
 * favorites, ...) beat the price after Kalshi's fee.
 *
 *   node scripts/college-lines.mjs --league ncaaf [--since 2026-08-22] [--out .cache/lines-ncaaf.json]
 *   node scripts/college-lines.mjs --league ncaamb [--since 2026-11-02]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const LEAGUES = {
  ncaaf: { espn: "football/college-football", groups: [80, 81], total: "KXNCAAFTOTAL", spread: "KXNCAAFSPREAD", since: "2026-08-22" },
  ncaamb: { espn: "basketball/mens-college-basketball", groups: [50], total: "KXNCAAMBTOTAL", spread: "KXNCAAMBSPREAD", since: "2026-11-02" },
  nba: { espn: "basketball/nba", groups: [], total: "KXNBATOTAL", spread: "KXNBASPREAD", since: "2026-10-20" },
  nfl: { espn: "football/nfl", groups: [], total: "KXNFLTOTAL", spread: "KXNFLSPREAD", since: "2026-09-08" },
  nhl: { espn: "hockey/nhl", groups: [], total: "KXNHLTOTAL", spread: "KXNHLSPREAD", since: "2026-10-06" },
};
const API = "https://api.elections.kalshi.com/trade-api/v2", ESPN = "https://site.api.espn.com/apis/site/v2/sports";
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
export const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\bst\.?\b/g, "state").replace(/[^a-z0-9]/g, "");
const eventDate = t => { const m = /-(\d\d)([A-Z]{3})(\d\d)/.exec(t); return m ? `20${m[1]}-${MON[m[2]]}-${m[3]}` : null; };
const addDay = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);

/** Does a Kalshi team name ("Sacramento St.", "USC") refer to this ESPN team? */
export function sameTeam(name, t) {
  const n = norm(name); if (!n) return false;
  const c = [t.location, t.shortDisplayName, t.displayName, t.name, t.abbreviation, t.nickname].map(norm).filter(Boolean);
  return c.some(x => x === n) || c.some(x => x.length > 3 && n.length > 3 && (x.startsWith(n) || n.startsWith(x)));
}

async function scoreboard(cfg, day, cache) {
  if (cache[day]) return cache[day];
  const groups = cfg.groups.length ? cfg.groups : [null];
  const games = [];
  for (const g of groups) {
    const j = await get(`${ESPN}/${cfg.espn}/scoreboard?dates=${day.replace(/-/g, "")}&limit=500${g ? `&groups=${g}` : ""}`).catch(() => null);
    for (const e of j?.events || []) {
      const c = e.competitions?.[0]; if (!c?.status?.type?.completed) continue;
      const h = c.competitors.find(x => x.homeAway === "home"), a = c.competitors.find(x => x.homeAway === "away");
      const sc = x => +(x?.score?.value ?? x?.score);
      if (h && a && Number.isFinite(sc(h)) && Number.isFinite(sc(a))) games.push({ id: e.id, t: e.date, home: h.team, away: a.team, hs: sc(h), as: sc(a) });
    }
  }
  return (cache[day] = games);
}

async function main() {
  const lg = arg("--league", "ncaaf"), cfg = LEAGUES[lg]; if (!cfg) throw new Error(`unknown league ${lg}`);
  const since = arg("--since", cfg.since), OUT = arg("--out", `.cache/lines-${lg}.json`);
  let db = { events: {} }; try { db = JSON.parse(readFileSync(OUT, "utf8")); } catch {}
  const sb = {};
  for (const kind of ["total", "spread"]) {
    const series = cfg[kind]; let cursor = "", n = 0, miss = 0, stop = false;
    do {
      const j = await get(`${API}/events?series_ticker=${series}&status=settled&with_nested_markets=true&limit=100${cursor ? `&cursor=${cursor}` : ""}`);
      for (const ev of j.events || []) {
        const day = eventDate(ev.event_ticker); if (!day) continue;
        if (day < since) { stop = true; continue; }
        if (db.events[ev.event_ticker]) continue;
        const [na, nb] = String(ev.title || "").replace(/:.*$/, "").split(/\s+(?:vs\.?|at|@)\s+/i);
        if (!na || !nb) { miss++; continue; }
        let g = null;
        for (const d of [day, addDay(day, 1), addDay(day, -1)]) {
          g = (await scoreboard(cfg, d, sb)).find(x => (sameTeam(na, x.home) && sameTeam(nb, x.away)) || (sameTeam(na, x.away) && sameTeam(nb, x.home)));
          if (g) break;
        }
        if (!g) { miss++; continue; }
        const start = Math.round(Date.parse(g.t) / 1000);
        let c; try { c = await get(`${API}/series/${series}/events/${ev.event_ticker}/candlesticks?start_ts=${start - 6 * 3600}&end_ts=${start}&period_interval=60`); } catch { miss++; continue; }
        const q = {};
        (c.market_tickers || []).forEach((tk, i) => { const k = (c.market_candlesticks?.[i] || []).filter(x => x.end_period_ts <= start + 60).at(-1);
          if (k?.yes_bid?.close_dollars != null && k?.yes_ask?.close_dollars != null) q[tk] = { bid: +k.yes_bid.close_dollars, ask: +k.yes_ask.close_dollars }; });
        const strikes = (ev.markets || []).filter(m => q[m.ticker] && (m.result === "yes" || m.result === "no")).map(m => {
          const s = { x: m.floor_strike, y: m.result === "yes" ? 1 : 0, ...q[m.ticker] };
          if (kind === "spread") {   // "TEAM wins by over X": which side of the game
            const who = String(m.yes_sub_title || "").replace(/\s+wins by.*$/i, "");
            s.home = sameTeam(who, g.home) ? 1 : sameTeam(who, g.away) ? 0 : null;
          }
          return s;
        }).filter(s => kind !== "spread" || s.home != null);
        if (!strikes.length) { miss++; continue; }
        db.events[ev.event_ticker] = { lg, kind, day, start: g.t, home: g.home.displayName, away: g.away.displayName, hs: g.hs, as: g.as, strikes };
        n++;
      }
      cursor = j.cursor;
      mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(db));
    } while (cursor && !stop);
    console.log(`${lg} ${kind}: ${n} games priced, ${miss} skipped (no ESPN match or no pre-game quote)`);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
