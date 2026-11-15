#!/usr/bin/env node
/**
 * Deep NFL study on Kalshi: every per-game NFL series (game lines, props, specials), the YES bid/ask in the
 * last hour before kickoff, and Kalshi's own result. Then pre-registered rule families are scored after
 * fees, split by week halves, with week-level bootstrap and a final holdout of the last weeks.
 *
 *   node scripts/nfl-deep.mjs discover            → .cache/nfl-series.json (game-level series with history)
 *   node scripts/nfl-deep.mjs collect [--max 60]  → .cache/nfl-deep.json (resumable)
 *   node scripts/nfl-deep.mjs report               → rule tables
 *
 * Public data, no key. Results come from Kalshi's `result`, never from a join on the outcome.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const API = "https://api.elections.kalshi.com/trade-api/v2", ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const SINCE = "2026-09-08", MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const sleep = ms => new Promise(r => setTimeout(r, ms)); let last = 0;
async function get(url) {
  for (let i = 0; i < 7; i++) {
    const w = last + 60 - Date.now(); if (w > 0) await sleep(w); last = Date.now();
    const r = await fetch(url).catch(() => null);
    if (r?.ok) return r.json();
    if (r && r.status !== 429 && r.status < 500) throw new Error(`${r.status} ${url}`);
    await sleep(800 * 2 ** i);
  }
  throw new Error(`gave up ${url}`);
}
const evDate = t => { const m = /-(\d\d)([A-Z]{3})(\d\d)/.exec(t); return m ? `20${m[1]}-${MON[m[2]]}-${m[3]}` : null; };
const read = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100;
const mode = process.argv[2];

if (mode === "discover") {
  let cursor = "", all = [];
  const j = await get(`${API}/series?category=Sports`); all = (j.series || []).filter(s => /^KXNFL/.test(s.ticker));
  const out = [];
  for (const s of all) {
    let n = 0, sample = null;
    try {
      const e = await get(`${API}/events?series_ticker=${s.ticker}&status=settled&limit=200`);
      const g = (e.events || []).filter(x => { const d = evDate(x.event_ticker); return d && d >= SINCE && /-\d\d[A-Z]{3}\d\d[A-Z]{4,}/.test(x.event_ticker); });
      n = g.length; sample = g[0]?.event_ticker || null;
    } catch {}
    if (n >= 15) out.push({ series: s.ticker, title: s.title, events: n, sample });
    process.stdout.write(".");
  }
  out.sort((a, b) => b.events - a.events);
  mkdirSync(".cache", { recursive: true }); writeFileSync(".cache/nfl-series.json", JSON.stringify(out, null, 1));
  console.log(`\n${out.length} per-game series with ≥15 settled events since ${SINCE}`); for (const s of out) console.log(`  ${s.series.padEnd(24)} ${String(s.events).padStart(4)}  ${s.title}`);
}

if (mode === "collect") {
  // --part i/n: this process takes every n-th series and writes its own file (run several at once)
  const [pi, pn] = (process.argv[process.argv.indexOf("--part") + 1] || "0/1").split("/").map(Number), OUTF = pn > 1 ? `.cache/nfl-deep-${pi}.json` : ".cache/nfl-deep.json";
  const series = read(".cache/nfl-series.json", []).filter((_, i) => i % pn === pi), db = read(OUTF, { events: {} }), tips = {};
  const skip = new Set(["KXNFLPASSYDS", "KXNFLRSHYDS", "KXNFLRECYDS", "KXNFLREC", "KXNFLPASSTDS"]);   // already in kalshi-history-nfl.json
  const kick = async date => {
    if (tips[date]) return tips[date];
    const days = [date, new Date(Date.parse(date) + 86400e3).toISOString().slice(0, 10)];
    const out = [];
    for (const d of days) { const j = await get(`${ESPN}?dates=${d.replace(/-/g, "")}`).catch(() => ({})); for (const e of j.events || []) out.push({ t: Date.parse(e.date) / 1000, teams: e.competitions?.[0]?.competitors?.map(c => c.team?.abbreviation) || [] }); }
    return (tips[date] = out);
  };
  for (const s of series) {
    if (skip.has(s.series)) continue;
    let cursor = "", added = 0, stop = false;
    do {
      const j = await get(`${API}/events?series_ticker=${s.series}&status=settled&with_nested_markets=true&limit=100${cursor ? `&cursor=${cursor}` : ""}`);
      for (const e of j.events || []) {
        const date = evDate(e.event_ticker); if (!date) continue; if (date < SINCE) { stop = true; continue; }
        if (db.events[e.event_ticker]) continue;
        const ms = (e.markets || []).filter(m => m.result === "yes" || m.result === "no");
        if (!ms.length) continue;
        const suffix = e.event_ticker.split("-")[1].slice(7);
        const g = (await kick(date)).find(x => x.teams.filter(a => a && suffix.includes(a.slice(0, 2))).length === 2);
        const rec = { series: s.series, date, title: e.title, sub: e.sub_title, kick: g?.t ?? null, markets: ms.map(m => ({ tk: m.ticker, yt: m.yes_sub_title, strike: m.floor_strike ?? null, y: m.result === "yes" ? 1 : 0, tv: +(m.volume_fp || 0) })) };
        if (g) {
          try {
            const c = await get(`${API}/series/${s.series}/events/${e.event_ticker}/candlesticks?start_ts=${g.t - 8 * 3600}&end_ts=${g.t}&period_interval=60`);
            (c.market_tickers || []).forEach((tk, i) => {
              const k = (c.market_candlesticks?.[i] || []).filter(x => x.end_period_ts <= g.t + 60), m = rec.markets.find(x => x.tk === tk), lc = k.at(-1);
              if (!m || !lc) return;
              const b = lc.yes_bid?.close_dollars, a = lc.yes_ask?.close_dollars; if (b != null && a != null) { m.bid = +b; m.ask = +a; }
              const f = k.find(x => x.yes_bid?.close_dollars != null && x.yes_ask?.close_dollars != null); if (f && f !== lc) m.mid0 = (+f.yes_bid.close_dollars + +f.yes_ask.close_dollars) / 2;
              m.vol = k.reduce((a2, x) => a2 + (+x.volume_fp || 0), 0);
            });
          } catch (err) { rec.err = err.message; }
        }
        db.events[e.event_ticker] = rec; added++;
      }
      cursor = j.cursor; writeFileSync(OUTF, JSON.stringify(db));
    } while (cursor && !stop);
    console.log(s.series, "added", added);
  }
  const ev = Object.values(db.events); console.log(`total ${ev.length} events, ${ev.reduce((a, e) => a + e.markets.filter(m => m.bid != null).length, 0)} priced markets`);
}

export { fee, read };

if (mode === "report") {
  const db = { events: Object.assign({}, read(".cache/nfl-deep.json", { events: {} }).events, ...Array.from({ length: 8 }, (_, i) => read(`.cache/nfl-deep-${i}.json`, { events: {} }).events)) }, H = read(".cache/kalshi-history-nfl.json", { events: {} });
  const week = d => Math.floor((Date.parse(d) - Date.parse(SINCE)) / (7 * 86400e3));
  const rows = [];
  const add = (series, ev, date, m) => { if (m.bid == null || m.ask == null || m.ask - m.bid > 0.10) return; const mid = (m.bid + m.ask) / 2; if (mid <= 0.02 || mid >= 0.98) return;
    rows.push({ series, ev, w: week(date), y: m.y, bid: m.bid, ask: m.ask, mid, mid0: m.mid0 ?? null }); };
  for (const [ev, e] of Object.entries(db.events)) for (const m of e.markets) add(e.series, ev, e.date, m);
  for (const [ev, e] of Object.entries(H.events)) for (const m of e.markets) add(e.series, ev, e.date, m);
  // "main" strike per event: the one priced closest to 50¢
  const byEv = new Map(); for (const r of rows) { const o = byEv.get(r.ev); if (!o || Math.abs(r.mid - 0.5) < Math.abs(o.mid - 0.5)) byEv.set(r.ev, r); }
  for (const r of byEv.values()) r.main = true;
  const weeks = [...new Set(rows.map(r => r.w))].sort((a, b) => a - b), HOLD = weeks.slice(-4), isHold = r => HOLD.includes(r.w);
  console.log(`${rows.length} priced NFL markets in ${new Set(rows.map(r => r.ev)).size} events, ${new Set(rows.map(r => r.series)).size} series, weeks ${weeks[0]}–${weeks.at(-1)}; discovery = weeks before ${HOLD[0]}, holdout = last 4 weeks`);
  const bet = (r, side) => { const c = side === "yes" ? r.ask : 1 - r.bid; return { c: c + fee(c), win: side === "yes" ? r.y : 1 - r.y, w: r.w }; };
  const roi = b => { const s = b.reduce((a, x) => a + x.c, 0); return s ? (b.reduce((a, x) => a + x.win, 0) - s) / s : null; };
  const boot = b => { const ws = [...new Set(b.map(x => x.w))], g = new Map(ws.map(w => [w, b.filter(x => x.w === w)])), out = [];
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 2000; i++) { const s = []; for (let j = 0; j < ws.length; j++) s.push(...g.get(ws[Math.floor(rnd() * ws.length)])); out.push(roi(s)); }
    out.sort((a, b2) => a - b2); return [out[100], out[1900]]; };
  const BUCKETS = [[0.03, 0.15], [0.15, 0.35], [0.35, 0.65], [0.65, 0.85], [0.85, 0.97]];
  const rules = [];
  const groups = { ...Object.fromEntries([...new Set(rows.map(r => r.series))].map(s => [s, r => r.series === s])),
    "ALL quarter/half markets": r => /1Q|2Q|3Q|4Q|1H|2H/.test(r.series), "ALL player props": r => /PASS|RSH|REC|RRYDS|FFPTS|TD$|FIRSTTD|LONG|MOST/.test(r.series) && !/TEAM/.test(r.series), "ALL markets": () => true };
  for (const [g, f] of Object.entries(groups)) {
    const R = rows.filter(f);
    for (const [a, b] of BUCKETS) for (const side of ["yes", "no"]) rules.push({ name: `${g}: ${side.toUpperCase()} when YES ${Math.round(a * 100)}–${Math.round(b * 100)}¢`, R: R.filter(r => r.mid >= a && r.mid < b), side: () => side });
    rules.push({ name: `${g}: main line YES`, R: R.filter(r => r.main), side: () => "yes" }, { name: `${g}: main line NO`, R: R.filter(r => r.main), side: () => "no" });
    const mv = R.filter(r => r.mid0 != null && Math.abs(r.mid - r.mid0) >= 0.04 && r.mid > 0.1 && r.mid < 0.9);
    rules.push({ name: `${g}: follow the pre-game move (≥4¢)`, R: mv, side: r => r.mid > r.mid0 ? "yes" : "no" }, { name: `${g}: fade the pre-game move (≥4¢)`, R: mv, side: r => r.mid > r.mid0 ? "no" : "yes" });
  }
  const scored = rules.map(u => { const B = u.R.map(r => bet(r, u.side(r))), D = B.filter((_, i) => !isHold(u.R[i])), Ho = B.filter((_, i) => isHold(u.R[i]));
    return { name: u.name, nD: D.length, rD: roi(D), nH: Ho.length, rH: roi(Ho), B }; });
  if (process.argv.includes("--pooled")) for (const s of scored.filter(s => s.name.startsWith("ALL"))) console.log(`  ${s.name.padEnd(64)} disc ${String(s.nD).padStart(6)} ${(s.rD * 100).toFixed(1).padStart(6)}% | hold ${String(s.nH).padStart(6)} ${(s.rH * 100).toFixed(1).padStart(6)}%`);
  const cand = scored.filter(s => s.nD >= 60 && s.rD > 0.05 && s.nH >= 30).sort((a, b) => b.rD - a.rD);
  console.log(`\n${scored.length} rules scored. ${cand.length} look good in discovery (≥60 bets, ROI > +5%, ≥30 holdout bets).`);
  const posH = cand.filter(s => s.rH > 0).length; console.log(`Of those, ${posH} are still positive in the 4 holdout weeks (chance alone would give about half).`);
  console.log("\nrule".padEnd(70) + "discovery          holdout            holdout 90% range (week bootstrap)");
  for (const s of cand.slice(0, 40)) { const Ho = s.B.slice(-s.nH); const [lo, hi] = s.nH ? boot(s.B.filter(x => HOLD.includes(x.w))) : [null, null];
    console.log(`  ${s.name.slice(0, 66).padEnd(68)}${String(s.nD).padStart(5)} ${((s.rD) * 100).toFixed(1).padStart(6)}%   ${String(s.nH).padStart(5)} ${(s.rH * 100).toFixed(1).padStart(6)}%   ${(lo * 100).toFixed(0)}% … ${(hi * 100).toFixed(0)}%`); }
  const strong = cand.filter(s => s.rH > 0.03).map(s => ({ ...s, ci: boot(s.B) })).filter(s => s.ci[0] > 0);
  console.log(`\nRules positive in discovery AND holdout AND whose all-weeks 90% range stays above 0: ${strong.length}`);
  for (const s of strong) console.log(`  ${s.name} · all weeks ${s.B.length} bets ROI ${(roi(s.B) * 100).toFixed(1)}% (90% ${(s.ci[0] * 100).toFixed(0)}% … ${(s.ci[1] * 100).toFixed(0)}%)`);
}
