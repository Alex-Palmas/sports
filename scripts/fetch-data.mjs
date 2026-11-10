#!/usr/bin/env node
/**
 * Builds site/data.json with real player data.
 *
 *  - Schedules, rosters and game logs: ESPN's public site API (free, no key).
 *  - Sportsbook prop lines (DraftKings, FanDuel, BetMGM, Caesars, ...): The Odds API
 *    (https://the-odds-api.com), only when ODDS_API_KEY is set. One request returns
 *    every book in a region for the same credit cost.
 *  - Kalshi prediction-market prices: Kalshi's public market-data API (free, no key).
 *  Props with no market anywhere get a projected line, labeled as such in the app.
 *
 * Env:
 *   ODDS_API_KEY        optional. The Odds API key.
 *   FETCH_ODDS=1        actually spend Odds API credits on this run (otherwise
 *                       lines come from the cached odds file, if any).
 *   ODDS_MAX_CREDITS    max credits to spend per run (default 16 ≈ 480/month).
 *   ODDS_REGIONS        Odds API regions (default "us"; e.g. "us,us2" adds Hard Rock,
 *                       Fliff, ... at 2x the credit cost).
 *   KALSHI=0            skip Kalshi.
 *   ODDS_CACHE          path of the odds cache file (default .cache/odds.json).
 *   OUT                 output path (default site/data.json).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";
const PropModel = createRequire(import.meta.url)("../site/model.js");

const OUT = process.env.OUT || "site/data.json";
const ODDS_KEY = process.env.ODDS_API_KEY || "";
const FETCH_ODDS = process.env.FETCH_ODDS === "1" || process.env.FETCH_ODDS === "true";
const ODDS_MAX_CREDITS = +(process.env.ODDS_MAX_CREDITS || 16);
const ODDS_CACHE = process.env.ODDS_CACHE || ".cache/odds.json";
const HISTORY = process.env.HISTORY || ".cache/history.json";   // opening lines + daily line history (kept between runs)
const TRACK = process.env.TRACK || ".cache/track.json";         // live model-vs-market ledger (kept between runs)
const ODDS_REGIONS = (process.env.ODDS_REGIONS || "us").split(",").map(x => x.trim()).filter(Boolean);
const KALSHI = process.env.KALSHI !== "0";

const SITE = "https://site.api.espn.com/apis/site/v2/sports";
const WEB = "https://site.web.api.espn.com/apis/common/v3/sports";

// ---------------------------------------------------------------- http
async function getJSON(url, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "proplab-data/1.0" } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return { json: await r.json(), headers: r.headers };
    } catch (e) {
      if (i >= tries - 1) { console.warn("fetch failed:", e.message); return null; }
      await new Promise(res => setTimeout(res, 800 * 2 ** i));
    }
  }
}
const get = async url => (await getJSON(url))?.json ?? null;

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------------------------------------------------------------- helpers
const num = v => { if (v == null || v === "" || v === "--") return 0; const n = parseFloat(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
const made = v => num(String(v ?? "").split("-")[0]);
const toi = v => { const [m, s] = String(v ?? "0:0").split(":").map(Number); return Math.round((m || 0) + (s || 0) / 60); };
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
// Projected line: the x.5 value the player went over in ~50% of the sample (ties → nearest the mean),
// i.e. roughly where a book would hang it, so hit rates reflect form rather than soft lines.
const fairLine = vals => {
  const m = mean(vals); let best = null;
  for (let k = 0; k <= Math.ceil(Math.max(...vals)); k++) {
    const L = k + 0.5, r = vals.filter(v => v > L).length / vals.length;
    const score = Math.abs(r - 0.5) + Math.abs(L - m) / (m + 1) * 0.01;
    if (!best || score < best.score) best = { L, score };
  }
  return best ? best.L : 0.5;
};
export const normName = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");

// ---------------------------------------------------------------- sport config
const SPORTS = {
  nba: {
    name: "NBA", path: "basketball/nba", lookAheadDays: 1, oddsKey: "basketball_nba",
    stats: [["pts", "Points"], ["reb", "Rebounds"], ["ast", "Assists"], ["fg3", "3PT Made"], ["pr", "Pts+Reb"], ["pa", "Pts+Ast"], ["ra", "Reb+Ast"], ["pra", "Pts+Reb+Ast"], ["stl", "Steals"], ["blk", "Blocks"]],
    row: g => { const p = num(g.points), r = num(g.totalRebounds), a = num(g.assists);
      return { pts: p, reb: r, ast: a, fg3: made(g["threePointFieldGoalsMade-threePointFieldGoalsAttempted"]), stl: num(g.steals), blk: num(g.blocks), pr: p + r, pa: p + a, ra: r + a, pra: p + r + a }; },
    minutes: g => num(g.minutes), played: g => num(g.minutes) > 0,
    // keep rotation players
    select: (players) => players.filter(p => p.recentMin >= 18 && p.recentGames >= 3).sort((a, b) => b.recentMin - a.recentMin).slice(0, 9),
    propStats: () => ["pts", "reb", "ast", "fg3", "pr", "pa", "ra", "pra", "stl", "blk"],
    markets: { player_points: "pts", player_rebounds: "reb", player_assists: "ast", player_threes: "fg3", player_points_rebounds: "pr", player_points_assists: "pa", player_rebounds_assists: "ra", player_points_rebounds_assists: "pra", player_steals: "stl", player_blocks: "blk" },
    oddsMarkets: ["player_points", "player_rebounds", "player_assists"],
    kalshiGames: { ml: "KXNBAGAME", spread: "KXNBASPREAD", total: "KXNBATOTAL" },
    kalshi: { KXNBAPTS: "pts", KXNBAREB: "reb", KXNBAAST: "ast", KXNBA3PT: "fg3", KXNBAPR: "pr", KXNBAPA: "pa", KXNBARA: "ra", KXNBAPRA: "pra", KXNBASTL: "stl", KXNBABLK: "blk" },
  },
  nfl: {
    name: "NFL", path: "football/nfl", lookAheadDays: 7, oddsKey: "americanfootball_nfl",
    stats: [["pass_yds", "Pass Yds"], ["pass_td", "Pass TDs"], ["rush_yds", "Rush Yds"], ["rec_yds", "Rec Yds"], ["rec", "Receptions"], ["td", "Anytime TD"]],
    row: g => ({ pass_yds: num(g.passingYards), pass_td: num(g.passingTouchdowns), rush_yds: num(g.rushingYards), rec_yds: num(g.receivingYards), rec: num(g.receptions), td: num(g.rushingTouchdowns) + num(g.receivingTouchdowns), _att: num(g.passingAttempts), _car: num(g.rushingAttempts), _tgt: num(g.receivingTargets) }),
    minutes: () => null, played: g => true,
    rosterFilter: a => ["QB", "RB", "WR", "TE"].includes(a.position?.abbreviation),
    select: (players) => {
      const vol = p => p.pos === "QB" ? p.avg._att : p.avg._car + p.avg._tgt * 1.5;
      const take = { QB: 1, RB: 2, WR: 3, TE: 1 }; const out = [];
      for (const pos of Object.keys(take)) out.push(...players.filter(p => p.pos === pos && p.recentGames >= 2 && vol(p) >= (pos === "QB" ? 15 : 3)).sort((a, b) => vol(b) - vol(a)).slice(0, take[pos]));
      return out;
    },
    propStats: p => p.pos === "QB" ? ["pass_yds", "pass_td", "rush_yds"] : p.pos === "RB" ? ["rush_yds", "rec_yds", "rec", "td"] : ["rec_yds", "rec", "td"],
    markets: { player_pass_yds: "pass_yds", player_pass_tds: "pass_td", player_rush_yds: "rush_yds", player_reception_yds: "rec_yds", player_receptions: "rec", player_anytime_td: "td" },
    oddsMarkets: ["player_pass_yds", "player_rush_yds", "player_reception_yds"],
    kalshiGames: { ml: "KXNFLGAME", spread: "KXNFLSPREAD", total: "KXNFLTOTAL" },
    kalshi: { KXNFLPASSYDS: "pass_yds", KXNFLRSHYDS: "rush_yds", KXNFLRECYDS: "rec_yds", KXNFLREC: "rec", KXNFLANYTD: "td" },
  },
  nhl: {
    name: "NHL", path: "hockey/nhl", lookAheadDays: 1, oddsKey: "icehockey_nhl",
    stats: [["sog", "Shots on Goal"], ["pts", "Points"], ["g", "Goals"], ["ast", "Assists"]],
    row: g => ({ sog: num(g.shotsTotal), pts: num(g.points), g: num(g.goals), ast: num(g.assists) }),
    minutes: g => toi(g.timeOnIcePerGame), played: g => true,
    rosterFilter: a => a.position?.abbreviation !== "G",
    select: (players) => players.filter(p => p.recentGames >= 3 && p.recentMin >= 12).sort((a, b) => (b.avg.sog + b.avg.pts * 3) - (a.avg.sog + a.avg.pts * 3)).slice(0, 8),
    propStats: () => ["sog", "pts", "g", "ast"],
    markets: { player_shots_on_goal: "sog", player_points: "pts", player_goals: "g", player_assists: "ast" },
    oddsMarkets: ["player_shots_on_goal", "player_points"],
    kalshiGames: { ml: "KXNHLGAME", spread: "KXNHLSPREAD", total: "KXNHLTOTAL" },
    kalshi: { KXNHLPTS: "pts", KXNHLAST: "ast", KXNHLANYGOAL: "g", KXNHLGOAL: "g" },
  },
  mlb: {
    name: "MLB", path: "baseball/mlb", lookAheadDays: 1, oddsKey: "baseball_mlb",
    stats: [["hits", "Hits"], ["tb", "Total Bases"], ["rbi", "RBIs"], ["runs", "Runs"], ["hrr", "Hits+Runs+RBIs"], ["hr", "Home Runs"], ["so", "Strikeouts (bat)"]],
    row: g => { const h = num(g.hits), d = num(g.doubles), t = num(g.triples), hr = num(g.homeRuns); return { hits: h, tb: h + d + 2 * t + 3 * hr, rbi: num(g.RBIs), runs: num(g.runs), hrr: h + num(g.runs) + num(g.RBIs), hr, so: num(g.strikeouts), _ab: num(g.atBats) }; },
    minutes: () => null, played: g => num(g.atBats) + num(g.walks) > 0,
    rosterFilter: a => !["SP", "RP", "P"].includes(a.position?.abbreviation),
    select: (players) => players.filter(p => p.recentGames >= 5 && p.avg._ab >= 2.5).sort((a, b) => b.avg._ab - a.avg._ab).slice(0, 9),
    propStats: () => ["hits", "tb", "rbi", "runs", "hrr", "hr", "so"],
    markets: { batter_hits: "hits", batter_total_bases: "tb", batter_rbis: "rbi", batter_runs_scored: "runs", batter_hits_runs_rbis: "hrr", batter_home_runs: "hr", batter_strikeouts: "so" },
    oddsMarkets: ["batter_hits", "batter_total_bases"],
    kalshi: { KXMLBTB: "tb", KXMLBHR: "hr", KXMLBRBI: "rbi" },
  },
};

// ---------------------------------------------------------------- ESPN
/** Position group for defense-vs-position. */
export function posGroup(league, pos) {
  pos = String(pos || "").toUpperCase();
  if (league === "nba") return /C/.test(pos) && !/G|F/.test(pos.replace("C", "")) ? "C" : /F/.test(pos) ? "F" : "G";
  if (league === "nfl") return ["QB", "RB", "WR", "TE"].includes(pos) ? pos : "OTHER";
  if (league === "nhl") return pos === "D" ? "D" : "F";
  return "ALL";
}

async function upcomingGames(cfg) {
  const now = new Date(), end = new Date(now.getTime() + cfg.lookAheadDays * 86400e3);
  // ESPN scoreboards are keyed by US-local day and don't accept ranges for every league: fetch day by day.
  const days = []; for (let t = now.getTime() - 86400e3; t <= end.getTime() + 86400e3; t += 86400e3) days.push(ymd(new Date(t)));
  const boards = await pool(days, 4, d => get(`${SITE}/${cfg.path}/scoreboard?dates=${d}&limit=200`));
  const seen = new Set(), games = [];
  for (const e of boards.flatMap(b => b?.events || [])) {
    if (seen.has(e.id)) continue; seen.add(e.id);
    if (e.status?.type?.state !== "pre") continue;
    const t = new Date(e.date);
    if (t < now || t > new Date(now.getTime() + (cfg.lookAheadDays + 0.5) * 86400e3)) continue;
    const c = e.competitions?.[0]; if (!c) continue;
    const home = c.competitors.find(x => x.homeAway === "home"), away = c.competitors.find(x => x.homeAway === "away");
    if (!home || !away) continue;
    // ESPN's consensus line: "BOS -5.5" and the total
    const o = c.odds?.[0]; let fav = null, spread = null;
    const m = /^([A-Z]{2,4})\s+(-?\d+(?:\.\d+)?)$/.exec(o?.details || "");
    let moneyline = null;
    if (m) { fav = m[1]; spread = Math.abs(+m[2]); if (spread >= 100) { moneyline = -spread; spread = null; } } // NHL/MLB: "MIN -130" is a moneyline
    games.push({ id: e.id, date: e.date, name: e.shortName, home: home.team, away: away.team, odds: o ? { details: o.details || null, total: o.overUnder ?? null, fav, spread, moneyline } : null, lines: parseDK(o) });
  }
  return games;
}

/**
 * Full game lines from ESPN's odds block (DraftKings): moneyline, spread and total, current and at open.
 * Exported for tests.
 */
export function parseDK(o) {
  if (!o) return null;
  const am = x => { if (x == null || x === "") return null; if (/^even$/i.test(x)) return 100; const v = parseFloat(String(x).replace(/[^0-9.+-]/g, "")); return Number.isFinite(v) && Math.abs(v) >= 100 ? v : null; };
  const ln = x => { if (x == null || x === "") return null; const v = parseFloat(String(x).replace(/^[ou]/i, "")); return Number.isFinite(v) ? v : null; };
  const ml = o.moneyline, ps = o.pointSpread, tt = o.total;
  const out = {
    book: o.provider?.name || "DraftKings",
    ml: ml ? { home: am(ml.home?.close?.odds), away: am(ml.away?.close?.odds), openHome: am(ml.home?.open?.odds), openAway: am(ml.away?.open?.odds) } : null,
    spread: ps ? { home: ln(ps.home?.close?.line), homeOdds: am(ps.home?.close?.odds), away: ln(ps.away?.close?.line), awayOdds: am(ps.away?.close?.odds),
      openHome: ln(ps.home?.open?.line), openHomeOdds: am(ps.home?.open?.odds), openAwayOdds: am(ps.away?.open?.odds) } : null,
    total: tt || o.overUnder != null ? { line: ln(tt?.over?.close?.line) ?? o.overUnder ?? null, over: am(tt?.over?.close?.odds), under: am(tt?.under?.close?.odds),
      openLine: ln(tt?.over?.open?.line), openOver: am(tt?.over?.open?.odds), openUnder: am(tt?.under?.open?.odds) } : null,
  };
  if (out.spread && out.spread.home == null && o.spread != null) out.spread.home = +o.spread;
  return out;
}

// Kalshi team codes that differ from ESPN's abbreviations
const KALSHI_ALIAS = { UTAH: ["UTA"], NY: ["NYK"], GS: ["GSW"], NO: ["NOP", "NOR"], SA: ["SAS"], WSH: ["WAS"], PHX: ["PHO"], BKN: ["BRK", "BKN"], CHA: ["CHO"],
  NJ: ["NJD"], LA: ["LAK", "LAR", "LA"], SJ: ["SJS"], TB: ["TBL", "TB"], JAX: ["JAC"], LAR: ["LA"], VGK: ["VEG", "VGS", "VGK"], CBJ: ["CLB", "CBJ"], MTL: ["MON", "MTL"], NSH: ["NAS", "NSH"] };
const kCodes = abbr => [abbr, ...(KALSHI_ALIAS[abbr] || [])];
const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const etDay = iso => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
/**
 * Attach Kalshi game markets (winner / spread ladder / total ladder) to the ESPN games they belong to.
 * Event tickers look like KXNBASPREAD-26NOV10LACPHX: date (ET) + the two team codes. Exported for tests.
 */
export function matchKalshiGames(games, markets, slugs = {}) {
  const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100;
  for (const g of games) g.kalshi = { ml: {}, spread: [], total: [] };
  for (const [kind, list] of Object.entries(markets)) for (const m of list || []) {
    const ev = String(m.event_ticker || ""), mm = /^[A-Z0-9]+-(\d{2})([A-Z]{3})(\d{2})([A-Z]+)$/.exec(ev); if (!mm) continue;
    const kday = `20${mm[1]}-${String(MON[mm[2]] || 0).padStart(2, "0")}-${mm[3]}`, pair = mm[4];
    // same two teams, nearest date (teams can meet on back-to-back days)
    const g = games.filter(x => kCodes(x.away.abbreviation).some(a => kCodes(x.home.abbreviation).some(h => pair === a + h || pair === h + a)))
      .map(x => ({ x, d: Math.abs(Date.parse(etDay(x.date)) - Date.parse(kday)) })).filter(c => c.d <= 86400e3).sort((p, q) => p.d - q.d)[0]?.x;
    if (!g) continue;
    const ya = parseFloat(m.yes_ask_dollars), na = parseFloat(m.no_ask_dollars);
    if (!(ya > 0.02 && ya < 0.98 && na > 0.02 && na < 0.98) || ya + na > 1.12) continue;
    const series = ev.split("-")[0].toLowerCase();
    const q = { ya: +ya.toFixed(4), na: +na.toFixed(4), o: toAmerican(Math.min(0.99, ya + fee(ya))), u: toAmerican(Math.min(0.99, na + fee(na))), vol: Math.round(parseFloat(m.volume_fp || 0)), tk: m.ticker,
      href: slugs[series] ? `https://kalshi.com/markets/${series}/${slugs[series]}/${ev.toLowerCase()}` : `https://kalshi.com/markets/${series}` };
    const suffix = String(m.ticker).slice(ev.length + 1), code = suffix.replace(/\d+$/, "");
    const team = [g.home.abbreviation, g.away.abbreviation].find(t => kCodes(t).includes(code));
    if (kind === "ml") { if (team) g.kalshi.ml[team] = q; }
    else if (kind === "spread") { if (team && m.floor_strike != null) g.kalshi.spread.push({ team, l: +m.floor_strike, ...q }); }
    else if (kind === "total") { if (m.floor_strike != null) g.kalshi.total.push({ l: +m.floor_strike, ...q }); }
  }
  for (const g of games) { g.kalshi.spread.sort((a, b) => a.team.localeCompare(b.team) || a.l - b.l); g.kalshi.total.sort((a, b) => a.l - b.l); }
  return games;
}

/** Each team's recent results (points for/against), reaching into last season when this one is young. */
async function teamForm(cfg, teamId) {
  const rows = r => (r?.events || []).filter(e => e.competitions?.[0]?.status?.type?.completed).map(e => {
    const c = e.competitions[0], me = c.competitors.find(x => x.team?.id === String(teamId)), op = c.competitors.find(x => x.team?.id !== String(teamId));
    const pf = me?.score?.value ?? parseFloat(me?.score?.displayValue), pa = op?.score?.value ?? parseFloat(op?.score?.displayValue);
    return me && op && Number.isFinite(pf) && Number.isFinite(pa) ? { date: e.date.slice(0, 10), opp: op.team.abbreviation, home: me.homeAway === "home", pf, pa } : null;
  }).filter(Boolean);
  const cur = await get(`${SITE}/${cfg.path}/teams/${teamId}/schedule`);
  let out = rows(cur);
  if (out.length < 10 && cur?.requestedSeason?.year) out = rows(await get(`${SITE}/${cfg.path}/teams/${teamId}/schedule?season=${cur.requestedSeason.year - 1}`)).concat(out);
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
}

async function rosterOf(cfg, teamId) {
  const r = await get(`${SITE}/${cfg.path}/teams/${teamId}/roster`);
  let list = r?.athletes || [];
  if (list[0]?.items) list = list.flatMap(g => g.items); // grouped rosters (NFL/NHL/MLB)
  return list.filter(a => (a.status?.type ?? "active") === "active" && (!cfg.rosterFilter || cfg.rosterFilter(a)))
    .map(a => ({ id: a.id, name: a.displayName, pos: a.position?.abbreviation || "", jersey: a.jersey ?? null, injury: a.injuries?.[0]?.status || null }));
}

async function gameLog(cfg, athleteId, season) {
  const g = await get(`${WEB}/${cfg.path}/athletes/${athleteId}/gamelog${season ? `?season=${season}` : ""}`);
  if (!g || !g.names) return [];
  const out = [];
  for (const st of g.seasonTypes || []) {
    if (/preseason|spring|pro bowl|all-star/i.test(st.displayName)) continue;
    const post = /post/i.test(st.displayName);
    const seasonLabel = st.displayName.replace(/\s*(Regular Season|Postseason)\s*/i, "").trim();
    for (const cat of st.categories || []) {
      if (cat.type === "total") continue;
      for (const ev of cat.events || []) {
        const meta = g.events?.[ev.eventId]; if (!meta || !ev.stats) continue;
        const raw = Object.fromEntries(g.names.map((n, i) => [n, ev.stats[i]]));
        if (!cfg.played(raw)) continue;
        out.push({
          date: meta.gameDate.slice(0, 10), opp: meta.opponent?.abbreviation || "?", home: meta.atVs !== "@",
          min: cfg.minutes(raw), season: seasonLabel, post: post || undefined, result: meta.gameResult || undefined, score: meta.score || undefined,
          stats: cfg.row(raw),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- markets
// Every quote is normalized to { b: book title, k: book key, l: line, o: over price, u: under price,
// t: game start ISO } (American odds), stored under quotes["sport|normalizedName|stat"].
export const toAmerican = p => p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
const addQuote = (quotes, id, q) => (quotes[id] ||= []).push(q);

async function loadOddsCache() { try { return JSON.parse(await readFile(ODDS_CACHE, "utf8")); } catch { return { fetched: null, quotes: {} }; } }

/** Parse one Odds API event-odds response into quotes (exported for tests). */
export function parseOddsEvent(sport, cfg, ev, quotes) {
  for (const bk of ev.bookmakers || []) for (const m of bk.markets || []) {
    const stat = cfg.markets[m.key]; if (!stat) continue;
    const byPlayerLine = {};
    for (const o of m.outcomes || []) {
      if (!o.description) continue;
      const line = o.point ?? 0.5;
      const q = byPlayerLine[`${o.description}|${line}`] ||= { b: bk.title, k: bk.key, l: line, t: ev.commence_time, name: o.description };
      if (o.name === "Over" || o.name === "Yes") q.o = o.price;
      if (o.name === "Under" || o.name === "No") q.u = o.price;
    }
    // a book can list several lines for a player; keep its main one (closest to even money) as "main"
    const groups = {};
    for (const q of Object.values(byPlayerLine)) (groups[q.name] ||= []).push(q);
    for (const [name, qs] of Object.entries(groups)) {
      const juice = q => Math.abs((q.o ?? -110) - (q.u ?? -110)) + (q.o == null || q.u == null ? 50 : 0);
      qs.sort((a, b) => juice(a) - juice(b));
      qs.forEach((q, i) => { delete q.name; if (i) q.alt = 1; addQuote(quotes, `${sport}|${normName(name)}|${stat}`, q); });
    }
  }
}

async function fetchOdds() {
  const O = "https://api.the-odds-api.com/v4";
  let spent = 0, remaining = null; const quotes = {};
  const evLists = await pool(Object.entries(SPORTS), 2, async ([key, cfg]) => {
    const r = await getJSON(`${O}/sports/${cfg.oddsKey}/events?apiKey=${ODDS_KEY}`, 2); // listing events costs 0 credits
    return (r?.json || []).map(e => ({ ...e, sport: key }));
  });
  const soon = Date.now() + 36 * 3600e3;
  const events = evLists.flat().filter(e => new Date(e.commence_time) > Date.now() && new Date(e.commence_time) < soon)
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
  // round-robin across sports so one league doesn't eat the whole budget
  const bySport = {}; events.forEach(e => (bySport[e.sport] ||= []).push(e));
  const queue = []; for (let i = 0; Object.values(bySport).some(a => a[i]); i++) for (const a of Object.values(bySport)) if (a[i]) queue.push(a[i]);
  for (const e of queue) {
    const cfg = SPORTS[e.sport]; const cost = cfg.oddsMarkets.length * ODDS_REGIONS.length;
    if (spent + cost > ODDS_MAX_CREDITS) break;
    const r = await getJSON(`${O}/sports/${cfg.oddsKey}/events/${e.id}/odds?apiKey=${ODDS_KEY}&regions=${ODDS_REGIONS.join(",")}&markets=${cfg.oddsMarkets.join(",")}&oddsFormat=american`, 1);
    spent += cost;
    if (!r) continue;
    remaining = r.headers.get("x-requests-remaining") ?? remaining;
    parseOddsEvent(e.sport, cfg, r.json, quotes);
  }
  console.log(`odds api: ${queue.length} upcoming events, spent ~${spent} credits, ${Object.keys(quotes).length} player props, remaining=${remaining}`);
  return { fetched: new Date().toISOString(), quotes };
}

// Kalshi: each market is "Player: N+ stat" (strike N-0.5). Buying YES = over, NO = under.
// Prices are converted to American odds after Kalshi's taker fee (~0.07·p·(1-p) per contract).
const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";
export const kalshiFee = p => Math.ceil(0.07 * p * (1 - p) * 100) / 100;
/** kalshi.com page for a market's event, e.g. https://kalshi.com/markets/kxnbapts/nba-player-points/kxnbapts-26nov10orlsac */
export function kalshiHref(ticker, eventTicker, slug) {
  const ev = (eventTicker || String(ticker || "").split("-").slice(0, 2).join("-")).toLowerCase(), series = ev.split("-")[0];
  if (!series) return null;
  return slug ? `https://kalshi.com/markets/${series}/${slug}/${ev}` : `https://kalshi.com/markets/${series}`;
}
const slugify = t => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function parseKalshiMarket(sport, stat, m, quotes, slug) {
  const ya = parseFloat(m.yes_ask_dollars), na = parseFloat(m.no_ask_dollars);
  if (!(ya > 0.03 && ya < 0.97 && na > 0.03 && na < 0.97)) return;      // no real two-sided market
  if (ya + na > 1.12) return;                                          // too thin / wide
  const name = String(m.title || "").split(":")[0].trim(); if (!name) return;
  const line = m.floor_strike != null ? +m.floor_strike : (parseFloat(String(m.title).split(":")[1]) || 1) - 0.5;
  if (m.strike_type && m.strike_type !== "greater") return;
  addQuote(quotes, `${sport}|${normName(name)}|${stat}`, {
    b: "Kalshi", k: "kalshi", l: line, o: toAmerican(ya + kalshiFee(ya)), u: toAmerican(na + kalshiFee(na)),
    t: m.expected_expiration_time || m.close_time, vol: Math.round(parseFloat(m.volume_fp || 0)),
    tk: m.ticker, ya: +ya.toFixed(4), na: +na.toFixed(4),   // market ticker + raw asks, for placing orders
    href: kalshiHref(m.ticker, m.event_ticker, slug),        // the market's page on kalshi.com (opens the app on phones)
  });
}

/** Kalshi game markets (winner, spread ladder, total ladder) for every league, plus each series' URL slug. */
async function fetchKalshiGames() {
  const out = {}, slugs = {};
  for (const [sport, cfg] of Object.entries(SPORTS)) for (const [kind, series] of Object.entries(cfg.kalshiGames || {})) {
    try { slugs[series.toLowerCase()] = String((await get(`${KALSHI_API}/series/${series}`))?.series?.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); } catch {}
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const r = await get(`${KALSHI_API}/markets?series_ticker=${series}&status=open&limit=200${cursor ? `&cursor=${cursor}` : ""}`);
      await new Promise(res => setTimeout(res, 150));
      ((out[sport] ||= {})[kind] ||= []).push(...(r?.markets || []));
      cursor = r?.cursor; if (!cursor) break;
    }
  }
  return { markets: out, slugs };
}

async function fetchKalshi() {
  const quotes = {}; let n = 0;
  for (const [sport, cfg] of Object.entries(SPORTS)) for (const [series, stat] of Object.entries(cfg.kalshi || {})) {
    let cursor = "", slug = null;
    try { slug = slugify((await get(`${KALSHI_API}/series/${series}`))?.series?.title); } catch {}
    for (let page = 0; page < 20; page++) {
      const r = await get(`${KALSHI_API}/markets?series_ticker=${series}&status=open&limit=200${cursor ? `&cursor=${cursor}` : ""}`);
      await new Promise(res => setTimeout(res, 120)); // stay well under Kalshi's public rate limit
      for (const m of r?.markets || []) { parseKalshiMarket(sport, stat, m, quotes, slug); n++; }
      cursor = r?.cursor; if (!cursor) break;
    }
  }
  console.log(`kalshi: scanned ${n} markets, ${Object.keys(quotes).length} player props with a two-sided market`);
  return quotes;
}

// ---------------------------------------------------------------- build
async function buildSport(key, cfg, quotes, gameMarkets) {
  const teamsRes = await get(`${SITE}/${cfg.path}/teams`);
  const teams = (teamsRes?.sports?.[0]?.leagues?.[0]?.teams || []).map(({ team: t }) => ({ id: t.id, abbr: t.abbreviation, name: t.displayName, color: "#" + (t.color || "64748b"), logo: t.logos?.[0]?.href }));
  const games = await upcomingGames(cfg);
  console.log(`${key}: ${games.length} upcoming games`);
  if (!games.length) return { name: cfg.name, teams, stats: cfg.stats.map(([k, label]) => ({ key: k, label })), players: [], teamCount: teams.length, note: "No games scheduled in the next few days." };

  const sides = games.flatMap(g => [{ team: g.home, opp: g.away, home: true, g }, { team: g.away, opp: g.home, home: false, g }]);
  const players = [];
  await pool(sides, 3, async side => {
    const roster = await rosterOf(cfg, side.team.id);
    const withLogs = await pool(roster, 6, async a => {
      const logs = await gameLog(cfg, a.id);
      const recent = logs.slice().sort((x, y) => y.date.localeCompare(x.date)).slice(0, 10);
      const avg = {}; for (const k of Object.keys(recent[0]?.stats || {})) avg[k] = mean(recent.map(l => l.stats[k]));
      return { ...a, logs, recentGames: recent.length, recentMin: mean(recent.map(l => l.min ?? 0)), avg };
    });
    // teammates ruled out (or doubtful) tonight: kept off the board, used for with/without splits
    // (rotation players only where minutes exist: a 6-minute bench player being out moves nothing)
    const out = withLogs.filter(a => /out|doubtful|suspension/i.test(a.injury || "") && a.recentGames >= 3 && (key === "nfl" || key === "mlb" || (a.recentMin || 0) >= 15))
      .sort((x, y) => (y.recentMin || 0) - (x.recentMin || 0)).slice(0, 3);
    const questionable = withLogs.filter(a => /questionable|day-to-day/i.test(a.injury || "") && a.recentGames >= 3).map(a => ({ name: a.name, status: a.injury }));
    for (const p of cfg.select(withLogs.filter(a => !/out|doubtful|suspension/i.test(a.injury || "")))) {
      // add last season for a deeper sample
      let logs = p.logs;
      if (logs.length < 30) {
        const cur = logs[0]?.season || "";
        const yr = parseInt(cur, 10) || new Date().getFullYear();
        const prev = await gameLog(cfg, p.id, key === "nba" || key === "nhl" ? yr : yr - 1); // ESPN: NBA/NHL season=2026 → 2025-26
        logs = logs.concat(prev.filter(l => !logs.some(x => x.date === l.date)));
      }
      logs.sort((x, y) => y.date.localeCompare(x.date));
      // head to head: every game against tonight's opponent, reaching two more seasons back
      const opp = side.opp.abbreviation;
      let h2hPool = logs.slice();
      const oldest = logs[logs.length - 1]?.season;
      if (oldest) {
        const param = (parseInt(oldest, 10) || new Date().getFullYear()) - (key === "nba" || key === "nhl" ? 0 : 1); // ESPN param for the season before `oldest`
        for (const yr of [param, param - 1]) {
          const older = await gameLog(cfg, p.id, yr);
          h2hPool = h2hPool.concat(older.filter(l => l.opp === opp && !h2hPool.some(x => x.date === l.date)));
        }
      }
      const h2h = h2hPool.filter(l => l.opp === opp).sort((x, y) => y.date.localeCompare(x.date)).slice(0, 15)
        .map(({ date, season, home, min, post, result, score, stats }) => ({ date, season, home, min, post, result, score, stats: { ...stats } }));
      logs = logs.slice(0, 40).map(({ score, ...l }) => l);
      if (!logs.length) continue;
      const lines = {}, oddsOut = {}, src = {}, market = {};
      const gameT = new Date(side.g.date).getTime();
      for (const s of cfg.propStats(p)) {
        // quotes for this player/stat whose game is this one (Kalshi lists finished/live games too)
        const qs = (quotes[`${key}|${normName(p.name)}|${s}`] || []).filter(q => !q.t || Math.abs(new Date(q.t).getTime() - gameT) < 16 * 3600e3);
        if (qs.length) {
          market[s] = qs.map(({ t, ...q }) => q);
          const books = qs.filter(q => q.k !== "kalshi" && !q.alt).map(q => q.l).sort((a, b) => a - b);
          let line;
          if (books.length) line = books[Math.floor((books.length - 1) / 2)];               // consensus (median) book line
          else { // Kalshi only: the strike priced closest to 50/50
            const imp = a => a < 0 ? -a / (100 - a) : 100 / (a + 100);
            line = qs.slice().sort((a, b) => Math.abs(imp(a.o) - 0.5) - Math.abs(imp(b.o) - 0.5))[0].l;
          }
          lines[s] = line; src[s] = "book";
          const at = qs.filter(q => q.l === line);
          const best = side => at.reduce((m, q) => (q[side] != null && (m == null || q[side] > m[side]) ? q : m), null);
          const bo = best("o"), bu = best("u");
          oddsOut[s] = { over: bo?.o ?? null, under: bu?.u ?? null, overBook: bo?.b, underBook: bu?.b };
          continue;
        }
        const sample = logs.slice(0, 20).map(l => l.stats[s]);
        const m = mean(sample);
        if (s === "td" || s === "hr" || s === "g") { if (m < 0.15) continue; lines[s] = 0.5; }
        else { if (m < 0.4) continue; lines[s] = fairLine(sample); }
        src[s] = "proj";
      }
      if (!Object.keys(lines).length) continue;
      for (const l of [...logs, ...h2h]) for (const k of Object.keys(l.stats)) if (k.startsWith("_")) delete l.stats[k];
      // with/without each teammate who is out tonight (this season's games only)
      const season = logs[0]?.season, curLogs = logs.filter(l => l.season === season);
      const withWithout = out.map(t => {
        const played = new Set(t.logs.filter(l => l.season === season).map(l => l.date));
        const w = curLogs.filter(l => played.has(l.date)), wo = curLogs.filter(l => !played.has(l.date));
        const avg = arr => Object.fromEntries(Object.keys(lines).map(k => [k, arr.length ? +mean(arr.map(l => l.stats[k] ?? 0)).toFixed(2) : null]));
        return { teammate: t.name, status: t.injury, pos: t.pos, gamesWith: w.length, gamesWithout: wo.length, avgWith: avg(w), avgWithout: avg(wo), datesWithout: wo.map(l => l.date) };
      }).filter(x => x.gamesWithout >= 1);
      const lastDate = logs[0]?.date; const restDays = lastDate ? Math.max(0, Math.round((Date.parse(side.g.date.slice(0, 10)) - Date.parse(lastDate)) / 86400e3) - 1) : null;
      const go = side.g.odds;
      players.push({
        id: `${key}-${p.id}`, espnId: p.id, name: p.name, jersey: p.jersey, team: side.team.abbreviation, pos: p.pos, injury: p.injury, h2h,
        opp: side.opp.abbreviation, home: side.home, gameDate: side.g.date,
        game: go ? { details: go.details, total: go.total, spread: go.spread, favorite: go.fav, moneyline: go.moneyline, teamSpread: go.spread == null ? null : (go.fav === side.team.abbreviation ? -go.spread : go.spread) } : null,
        restDays, withWithout, teammatesQuestionable: questionable.filter(q => q.name !== p.name),
        headshot: `https://a.espncdn.com/i/headshots/${key}/players/full/${p.id}.png`,
        lines, odds: oddsOut, lineSource: src, market, logs,
      });
    }
  });

  // Opponent rank: how much each team allows vs. players' own averages (from this season's logs we collected)
  const stats = cfg.stats.map(([k, label]) => ({ key: k, label }));
  const allow = {};
  for (const p of players) {
    const season = p.logs[0]?.season;
    const cur = p.logs.filter(l => l.season === season);
    for (const s of stats) {
      const m = mean(cur.map(l => l.stats[s.key] ?? 0)); if (!m) continue;
      for (const l of cur) { const a = ((allow[l.opp] ||= {})[s.key] ||= []); a.push((l.stats[s.key] ?? 0) / m); }
    }
  }
  const oppRank = {};
  for (const s of stats) {
    const ranked = teams.map(t => ({ abbr: t.abbr, v: allow[t.abbr]?.[s.key]?.length ? mean(allow[t.abbr][s.key]) : 1 })).sort((a, b) => a.v - b.v);
    ranked.forEach((r, i) => { (oppRank[r.abbr] ||= {})[s.key] = i + 1; }); // 1 = allows least (toughest)
  }
  for (const p of players) p.oppRank = oppRank[p.opp] || {};

  // Defense vs. position: how much each team allows to a position group relative to those players' own averages
  const grp = p => posGroup(key, p.pos);
  const allowPos = {};
  for (const p of players) {
    const season = p.logs[0]?.season, cur = p.logs.filter(l => l.season === season), g = grp(p);
    for (const s of stats) {
      const m = mean(cur.map(l => l.stats[s.key] ?? 0)); if (!m) continue;
      for (const l of cur) (((allowPos[g] ||= {})[l.opp] ||= {})[s.key] ||= []).push((l.stats[s.key] ?? 0) / m);
    }
  }
  for (const p of players) {
    const g = grp(p), table = allowPos[g] || {}, out = { group: g, rank: {}, factor: {}, n: {} };
    for (const s of stats) {
      const rows = teams.map(t => { const a = table[t.abbr]?.[s.key] || []; return { abbr: t.abbr, v: a.length >= 4 ? mean(a) : null, n: a.length }; }).filter(r => r.v != null).sort((a, b) => a.v - b.v);
      const i = rows.findIndex(r => r.abbr === p.opp);
      if (i >= 0) { out.rank[s.key] = i + 1; out.factor[s.key] = +rows[i].v.toFixed(3); out.n[s.key] = rows[i].n; out.of = rows.length; }
    }
    p.dvp = out;
  }
  // game lines: DraftKings (via ESPN), Kalshi game markets, and each side's recent scoring
  const formIds = [...new Set(games.flatMap(g => [g.home.id, g.away.id]))];
  const forms = Object.fromEntries(await pool(formIds, 6, async id => [id, await teamForm(cfg, id).catch(() => [])]));
  matchKalshiGames(games, gameMarkets?.markets?.[key] || {}, gameMarkets?.slugs || {});
  const gamesOut = games.map(g => ({ id: g.id, date: g.date, home: g.home.abbreviation, away: g.away.abbreviation, dk: g.lines, kalshi: g.kalshi,
    form: { [g.home.abbreviation]: forms[g.home.id] || [], [g.away.abbreviation]: forms[g.away.id] || [] } }));
  return { name: cfg.name, teams, stats, players, teamCount: teams.length, games: gamesOut };
}

async function main() {
  let odds = await loadOddsCache();
  if (ODDS_KEY && FETCH_ODDS) {
    try { odds = await fetchOdds(); await mkdir(dirname(ODDS_CACHE), { recursive: true }); await writeFile(ODDS_CACHE, JSON.stringify(odds)); }
    catch (e) { console.warn("odds fetch failed, using cache:", e.message); }
  }
  let gameMarkets = { markets: {}, slugs: {} };
  if (KALSHI) { try { gameMarkets = await fetchKalshiGames(); } catch (e) { console.warn("kalshi games failed:", e.message); } }
  let kalshi = {}, kalshiFetched = null;
  if (KALSHI) { try { kalshi = await fetchKalshi(); kalshiFetched = new Date().toISOString(); } catch (e) { console.warn("kalshi failed:", e.message); } }
  const quotes = { ...(odds.quotes || {}) };
  for (const [id, qs] of Object.entries(kalshi)) (quotes[id] ||= []).push(...qs);

  let history = { lines: {} }; try { history = JSON.parse(await readFile(HISTORY, "utf8")); } catch {}
  const out = { generated: new Date().toISOString(), live: true, sources: { espn: new Date().toISOString(), sportsbooks: odds.fetched || null, kalshi: kalshiFetched }, sports: {} };
  const only = (process.env.SPORTS || "nba,nfl,nhl,mlb").split(",");
  for (const key of only) {
    try { out.sports[key] = await buildSport(key, SPORTS[key], quotes, gameMarkets); }
    catch (e) { console.warn(`${key} failed:`, e); }
    const ps = out.sports[key]?.players || [];
    console.log(`${key}: ${ps.length} players, ${ps.reduce((a, p) => a + Object.keys(p.market).length, 0)} props with market prices`);
  }
  if (!Object.values(out.sports).some(s => s.players.length)) { console.error("No players fetched; not writing data.json"); process.exit(1); }
  applyHistory(out, history);
  await mkdir(dirname(HISTORY), { recursive: true });
  await writeFile(HISTORY, JSON.stringify(history));
  let track = { picks: {} }; try { track = JSON.parse(await readFile(TRACK, "utf8")); } catch {}
  applyTrack(out, track);
  await writeFile(TRACK, JSON.stringify(track));
  for (const [k, t] of Object.entries(out.modelTrack || {})) console.log(`track ${k}: ${t.n} graded, model LL ${t.model?.logLoss} vs market ${t.market?.logLoss}`);
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`wrote ${OUT}`);
}

/**
 * Opening lines and line history. For every prop we remember, per game date, the first line and
 * prices we saw (the "open") and the latest; later runs resolve past entries against the player's
 * game log so the app can show "when his line was this high, he went over X of N times".
 * Mutates both `out` (adds p.lineMove, p.lineHistory, q.ol/q.oo/q.ou on quotes) and `history`.
 */
export function applyHistory(out, history, now = Date.now()) {
  history.lines ||= {};
  const keep = now - 150 * 86400e3;
  for (const [key, sport] of Object.entries(out.sports)) for (const p of sport.players || []) {
    const day = (p.gameDate || "").slice(0, 10);
    p.lineMove = {}; p.lineHistory = {};
    for (const [stat, line] of Object.entries(p.lines || {})) {
      const id = `${key}|${normName(p.name)}|${stat}`;
      const h = (history.lines[id] ||= {});
      const best = p.odds?.[stat] || {};
      const cur = { line, over: best.over ?? null, under: best.under ?? null, src: p.lineSource?.[stat] || null, t: new Date(now).toISOString() };
      const e = (h[day] ||= { open: cur, books: {} });
      e.last = cur;
      // per-book openers
      for (const q of p.market?.[stat] || []) {
        if (q.alt) continue;
        // Kalshi lists a ladder of lines per player: track each strike separately
        const bk = (e.books[q.k === "kalshi" ? `kalshi@${q.l}` : q.k] ||= { l: q.l, o: q.o ?? null, u: q.u ?? null });
        q.ol = bk.l; q.oo = bk.o; q.ou = bk.u;
      }
      p.lineMove[stat] = { openLine: e.open.line, openOver: e.open.over, openUnder: e.open.under, openSrc: e.open.src, openedAt: e.open.t };
      // resolved history: earlier dates with a game-log result
      const byDate = Object.fromEntries((p.logs || []).map(l => [l.date, l.stats?.[stat]]));
      p.lineHistory[stat] = Object.entries(h).filter(([d]) => d < day && byDate[d] != null)
        .sort((a, b) => b[0].localeCompare(a[0])).slice(0, 25)
        .map(([d, x]) => ({ date: d, line: x.last?.line ?? x.open.line, src: x.last?.src ?? x.open.src, actual: byDate[d] }));
      for (const d of Object.keys(h)) if (Date.parse(d) < keep) delete h[d];
    }
  }
  return out;
}

/**
 * Live ledger: before each game we record, at the main line, our model's P(over) and the market's
 * vig-free P(over) (the latest price before tip-off wins). Once the player's game log shows the
 * result, the pick is graded. Per league we publish how each did (log loss, Brier) and the
 * market weight that would have scored best, which the app then uses for EV once enough are in.
 */
/** Flat 1-unit results of the Edge Board's positive-EV picks, overall and by confidence grade. */
export function betSummary(bets) {
  const one = a => { const pnl = a.reduce((s, x) => s + (x.bet.won ? (x.bet.price > 0 ? x.bet.price / 100 : 100 / -x.bet.price) : -1), 0);
    return { n: a.length, won: a.filter(x => x.bet.won).length, roi: a.length ? +(pnl / a.length).toFixed(4) : null, expected: a.length ? +(a.reduce((s, x) => s + x.bet.ev, 0) / a.length).toFixed(4) : null }; };
  const by = {}; for (const x of bets) (by[x.grade || "?"] ||= []).push(x);
  return { all: one(bets), byGrade: Object.fromEntries(Object.entries(by).map(([k, a]) => [k, one(a)])) };
}

export function applyTrack(out, track, now = Date.now(), M = PropModel) {
  track.picks ||= {};
  const keep = now - 120 * 86400e3, logsById = {};
  for (const [lg, sport] of Object.entries(out.sports)) for (const p of sport.players || []) {
    logsById[`${lg}|${p.espnId}`] = p.logs || [];
    const t = Date.parse(p.gameDate || ""); if (!(t > now)) continue; // only before the game starts
    const day = p.gameDate.slice(0, 10);
    for (const [stat, line] of Object.entries(p.lines || {})) {
      const q = (p.market?.[stat] || []).find(x => x.l === line && x.o != null && x.u != null && !x.alt);
      if (!q || Number.isInteger(line)) continue;
      const proj = M.project(p, stat, lg); if (!proj) continue;
      const pr = M.probabilities(p, stat, line, proj, lg);
      const bb = M.bestBet ? M.bestBet(p, stat, lg) : null, conf = bb?.confidence, b = bb?.best;
      track.picks[`${lg}|${p.espnId}|${stat}|${day}`] = { lg, id: p.espnId, stat, day, line, model: +pr.over.toFixed(4), market: +M.marketProb(q, "over").toFixed(4), book: q.b,
        grade: conf?.grade || null, score: conf?.score ?? null, codes: (conf?.why || []).map(w => w.code).filter(Boolean),
        // the Edge Board's pick for this prop (any line/book), graded on its own line
        bet: b ? { side: b.side, line: b.line, price: b.price, book: b.book, prob: +b.prob.toFixed(4), model: +b.model.toFixed(4), market: b.market == null ? null : +b.market.toFixed(4), ev: +b.ev.toFixed(4) } : null };
    }
  }
  for (const [k, x] of Object.entries(track.picks)) {
    if (Date.parse(x.day) < keep) { delete track.picks[k]; continue; }
    if (x.y != null) continue;
    const l = (logsById[`${x.lg}|${x.id}`] || []).find(g => g.date === x.day);
    if (l && l.stats?.[x.stat] != null) {
      x.actual = l.stats[x.stat]; x.y = x.actual > x.line ? 1 : 0;
      if (x.bet) { const v = x.actual, bl = x.bet.line; x.bet.won = v === bl ? null : (x.bet.side === "over" ? v > bl : v < bl) ? 1 : 0; }
    }
  }
  const ll = (q, y) => -Math.log(y ? Math.max(q, 0.01) : Math.max(1 - q, 0.01));
  const summary = {};
  for (const lg of Object.keys(out.sports)) {
    const g = Object.values(track.picks).filter(x => x.lg === lg && x.y != null);
    if (!g.length) continue;
    const avg = f => +(g.reduce((a, x) => a + f(x), 0) / g.length).toFixed(4);
    let bestW = 0.5, bestLL = Infinity;
    for (let w = 0; w <= 1.0001; w += 0.05) { const v = avg(x => ll((1 - w) * x.model + w * x.market, x.y)); if (v < bestLL) { bestLL = v; bestW = +w.toFixed(2); } }
    summary[lg] = { n: g.length, overRate: avg(x => x.y),
      model: { logLoss: avg(x => ll(x.model, x.y)), brier: avg(x => (x.model - x.y) ** 2) },
      market: { logLoss: avg(x => ll(x.market, x.y)), brier: avg(x => (x.market - x.y) ** 2) },
      blend: { marketWeight: bestW, logLoss: bestLL },
      byGrade: Object.fromEntries(["High", "Medium", "Low"].map(gr => [gr, g.filter(x => x.grade === gr)]).filter(([, a]) => a.length).map(([gr, a]) => [gr, {
        n: a.length, model: +(a.reduce((s, x) => s + ll(x.model, x.y), 0) / a.length).toFixed(4), market: +(a.reduce((s, x) => s + ll(x.market, x.y), 0) / a.length).toFixed(4) }])),
      bets: betSummary(g.filter(x => x.bet && x.bet.won != null && x.bet.ev > 0)) };
  }
  out.modelTrack = summary;
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
