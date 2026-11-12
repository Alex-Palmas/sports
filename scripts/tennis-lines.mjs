#!/usr/bin/env node
/**
 * Tennis on Kalshi vs results: match winners (ATP, WTA, Challenger, ITF) and total games (ATP, WTA).
 *
 * Kalshi's tennis "occurrence" times are placeholders, so the pre-match price is taken from the hourly
 * candle that ends 4 hours before the market closed. A match market closes when the match ends, and a
 * best-of-3 match almost never runs 4 hours, so that price is from before the first serve (sometimes a
 * few hours before). Results come from Kalshi's own settlement.
 *
 *   node scripts/tennis-lines.mjs collect [--since 2026-10-01]      → .cache/tennis.json
 *   node scripts/tennis-lines.mjs report                            → rule ROI by half
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const API = "https://api.elections.kalshi.com/trade-api/v2";
export const MATCH = { KXATPMATCH: "ATP", KXWTAMATCH: "WTA", KXATPCHALLENGERMATCH: "ATP Challenger", KXWTACHALLENGERMATCH: "WTA Challenger", KXITFMATCH: "ITF men", KXITFWMATCH: "ITF women" };
export const TOTALS = { KXATPGTOTAL: "ATP total games", KXWTAGTOTAL: "WTA total games" };
const OUT = ".cache/tennis.json", LEAD = 4 * 3600;
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
const eventDate = t => { const m = /-(\d\d)([A-Z]{3})(\d\d)/.exec(t); return m ? `20${m[1]}-${MON[m[2]]}-${m[3]}` : null; };

async function collect() {
  const since = arg("--since", "2026-10-01");
  let db = { events: {} }; try { db = JSON.parse(readFileSync(OUT, "utf8")); } catch {}
  for (const [series, label] of Object.entries({ ...MATCH, ...TOTALS })) {
    let cursor = "", n = 0, skip = 0, stop = false;
    do {
      const j = await get(`${API}/events?series_ticker=${series}&status=settled&with_nested_markets=true&limit=100${cursor ? `&cursor=${cursor}` : ""}`);
      for (const ev of j.events || []) {
        const day = eventDate(ev.event_ticker); if (!day) continue;
        if (day < since) { stop = true; continue; }
        if (db.events[ev.event_ticker]) continue;
        const ms = (ev.markets || []).filter(m => m.result === "yes" || m.result === "no");
        if (!ms.length) { skip++; continue; }
        const close = Math.max(...ms.map(m => Math.round(Date.parse(m.close_time) / 1000)));
        const open = Math.min(...ms.map(m => Math.round(Date.parse(m.open_time) / 1000)));
        const at = close - LEAD;
        if (!(at > open + 1800)) { skip++; continue; }   // market wasn't open long enough before the match
        let c; try { c = await get(`${API}/series/${series}/events/${ev.event_ticker}/candlesticks?start_ts=${at - 12 * 3600}&end_ts=${at}&period_interval=60`); } catch { skip++; continue; }
        const q = {};
        (c.market_tickers || []).forEach((tk, i) => { const k = (c.market_candlesticks?.[i] || []).filter(x => x.end_period_ts <= at + 60).at(-1);
          if (k?.yes_bid?.close_dollars != null && k?.yes_ask?.close_dollars != null) q[tk] = { bid: +k.yes_bid.close_dollars, ask: +k.yes_ask.close_dollars }; });
        const strikes = ms.filter(m => q[m.ticker]).map(m => ({ name: m.yes_sub_title, x: m.floor_strike ?? null, y: m.result === "yes" ? 1 : 0, ...q[m.ticker], vol: +(m.volume_fp || 0) }));
        if (!strikes.length) { skip++; continue; }
        db.events[ev.event_ticker] = { series, label, kind: TOTALS[series] ? "total" : "match", day, title: ev.title, strikes };
        n++;
      }
      cursor = j.cursor;
      mkdirSync(".cache", { recursive: true }); writeFileSync(OUT, JSON.stringify(db));
    } while (cursor && !stop);
    console.log(`${label}: ${n} events added, ${skip} skipped`);
  }
}

const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100;
const mid = s => (s.bid + s.ask) / 2;
const ok = s => s.ask > s.bid - 1e-9 && s.ask - s.bid <= 0.1 && s.ask > 0.02 && s.bid < 0.98;

/** Rule results by label, split into earlier/later half of the dates. */
export function report(events) {
  const days = [...new Set(events.map(e => e.day))].sort(), cut = days[Math.floor(days.length / 2)];
  const R = {}, cal = {};
  const add = (lab, rule, half, s, side) => { if (!ok(s)) return; const c = side === "yes" ? s.ask : 1 - s.bid; if (c < 0.05 || c > 0.95) return;
    const r = ((R[lab] ||= {})[rule] ||= [{ n: 0, c: 0, r: 0 }, { n: 0, c: 0, r: 0 }])[half]; r.n++; r.c += c + fee(c); r.r += side === "yes" ? s.y : 1 - s.y; };
  for (const e of events) {
    const half = e.day < cut ? 0 : 1, st = e.strikes.filter(ok); if (!st.length) continue;
    if (e.kind === "match") {
      // the favorite's market (YES priced ≥ 50%), one per match
      const f = st.slice().sort((a, b) => mid(b) - mid(a))[0]; if (mid(f) < 0.5) continue;
      const b = Math.min(9, Math.floor(mid(f) * 10)); const k = ((cal[e.label] ||= {})[b] ||= { n: 0, y: 0, p: 0 }); k.n++; k.y += f.y; k.p += mid(f);
      add(e.label, "favorite wins", half, f, "yes"); add(e.label, "underdog wins", half, f, "no");
      if (mid(f) >= 0.8) { add(e.label, "heavy favorite (≥80¢) wins", half, f, "yes"); add(e.label, "big underdog (≤20¢) wins", half, f, "no"); }
      if (mid(f) < 0.6) { add(e.label, "slight favorite (50–60¢) wins", half, f, "yes"); add(e.label, "slight underdog (40–50¢) wins", half, f, "no"); }
    } else {
      const m = st.slice().sort((a, b) => Math.abs(mid(a) - 0.5) - Math.abs(mid(b) - 0.5))[0];
      add(e.label, "under the main line", half, m, "no"); add(e.label, "over the main line", half, m, "yes");
    }
  }
  return { cut, R, cal };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "collect") await collect();
  else {
    const ev = Object.values(JSON.parse(readFileSync(OUT, "utf8")).events);
    const { cut, R, cal } = report(ev);
    const days = [...new Set(ev.map(e => e.day))].sort();
    console.log(`${ev.length} settled tennis events, ${days[0]} … ${days.at(-1)}; halves split at ${cut}`);
    for (const [lab, rules] of Object.entries(R)) {
      const n = ev.filter(e => e.label === lab).length;
      console.log(`\n== ${lab} (${n} events)`);
      if (cal[lab]) console.log("  favorite calibration: " + Object.entries(cal[lab]).sort().map(([b, k]) => `${b * 10}–${b * 10 + 10}¢: won ${(k.y / k.n * 100).toFixed(0)}% (n=${k.n}, priced ${(k.p / k.n * 100).toFixed(0)}%)`).join(" | "));
      for (const [rule, h] of Object.entries(rules)) {
        const f = x => x.n ? `${String(x.n).padStart(5)} bets ${((x.r - x.c) / x.c * 100).toFixed(1).padStart(6)}%` : "      -";
        console.log(`  ${rule.padEnd(32)} ${f(h[0])} | ${f(h[1])}`);
      }
    }
  }
}
