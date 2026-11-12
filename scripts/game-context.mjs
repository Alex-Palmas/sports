#!/usr/bin/env node
/**
 * Game context for the market backtest (NBA): every game this season with
 *  - the final score (ESPN team schedules), for point-in-time team pace and defense, and
 *  - the market's pre-game total and spread (Kalshi KXNBATOTAL / KXNBASPREAD ladders, YES mid in the
 *    last hour before tip, interpolated to the 50% point), for each team's implied points.
 *
 *   node scripts/game-context.mjs [--since 2026-10-20] [--out .cache/nba-games.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { KALSHI_ALIAS } from "./fetch-data.mjs";

const SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const API = "https://api.elections.kalshi.com/trade-api/v2";
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
const kCodes = a => [a, ...(KALSHI_ALIAS[a] || [])];
const eventDate = t => { const m = /-(\d\d)([A-Z]{3})(\d\d)/.exec(t); return m ? `20${m[1]}-${MON[m[2]]}-${m[3]}` : null; };
const etDay = iso => new Date(Date.parse(iso) - 5 * 3600e3).toISOString().slice(0, 10);   // ET (standard time) date of a UTC start

/** Line where the YES price crosses 50%, from (strike, P(yes)) points on a decreasing ladder. */
export function fiftyPoint(pts) {
  const s = pts.filter(p => p.p != null).sort((a, b) => a.x - b.x);
  for (let i = 0; i + 1 < s.length; i++) if (s[i].p >= 0.5 && s[i + 1].p <= 0.5) {
    const a = s[i], b = s[i + 1]; return a.p === b.p ? (a.x + b.x) / 2 : a.x + (a.p - 0.5) / (a.p - b.p) * (b.x - a.x);
  }
  return null;
}

async function main() {
  const since = arg("--since", "2026-10-20"), OUT = arg("--out", ".cache/nba-games.json");
  // 1) results from every team's schedule
  const teams = ((await get(`${SITE}/teams`))?.sports?.[0]?.leagues?.[0]?.teams || []).map(t => t.team);
  const games = new Map();
  for (const t of teams) {
    const r = await get(`${SITE}/teams/${t.id}/schedule`);
    for (const e of r?.events || []) {
      const c = e.competitions?.[0]; if (!c?.status?.type?.completed) continue;
      const [h, a] = [c.competitors.find(x => x.homeAway === "home"), c.competitors.find(x => x.homeAway === "away")];
      const sc = x => x?.score?.value ?? parseFloat(x?.score?.displayValue);
      if (!h || !a || !Number.isFinite(sc(h)) || !Number.isFinite(sc(a))) continue;
      games.set(e.id, { id: e.id, t: e.date, day: etDay(e.date), home: h.team.abbreviation, away: a.team.abbreviation, hs: sc(h), as: sc(a) });
    }
  }
  const list = [...games.values()].filter(g => g.day >= since);
  console.log(`espn: ${list.length} finished games since ${since}`);
  // 2) market total and spread before tip
  const find = (day, pair) => list.find(g => g.day === day && kCodes(g.home).some(h => kCodes(g.away).some(a => pair === a + h || pair === h + a)));
  for (const series of ["KXNBATOTAL", "KXNBASPREAD"]) {
    let cursor = "", n = 0, stop = false;
    do {
      const j = await get(`${API}/events?series_ticker=${series}&status=settled&with_nested_markets=true&limit=100${cursor ? `&cursor=${cursor}` : ""}`);
      for (const ev of j.events || []) {
        const day = eventDate(ev.event_ticker); if (!day) continue;
        if (day < since) { stop = true; continue; }
        const g = find(day, ev.event_ticker.split("-")[1].slice(7)); if (!g) continue;
        const tip = Math.round(Date.parse(g.t) / 1000);
        let c; try { c = await get(`${API}/series/${series}/events/${ev.event_ticker}/candlesticks?start_ts=${tip - 6 * 3600}&end_ts=${tip}&period_interval=60`); } catch { continue; }
        const mid = {};
        (c.market_tickers || []).forEach((tk, i) => { const k = (c.market_candlesticks?.[i] || []).filter(x => x.end_period_ts <= tip + 60).at(-1);
          const b = +k?.yes_bid?.close_dollars, a = +k?.yes_ask?.close_dollars; if (b >= 0 && a > 0 && a - b <= 0.15) mid[tk] = (a + b) / 2; });
        if (series === "KXNBATOTAL") g.total = fiftyPoint(ev.markets.map(m => ({ x: m.floor_strike, p: mid[m.ticker] })));
        else {
          // "TEAM wins by over X": each team's ladder gives its median margin when that team is favored
          const byTeam = {};
          for (const m of ev.markets) { const code = m.ticker.split("-").pop().replace(/\d+$/, ""); (byTeam[code] ||= []).push({ x: m.floor_strike, p: mid[m.ticker] }); }
          for (const [code, pts] of Object.entries(byTeam)) {
            const med = fiftyPoint(pts); if (med == null) continue;
            const isHome = kCodes(g.home).includes(code);
            g.homeMargin = isHome ? med : -med; break;
          }
        }
        n++;
      }
      cursor = j.cursor;
    } while (cursor && !stop);
    console.log(`${series}: ${n} games priced`);
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(list));
  console.log(`wrote ${OUT}: ${list.filter(g => g.total != null).length} with a market total, ${list.filter(g => g.homeMargin != null).length} with a market spread`);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
