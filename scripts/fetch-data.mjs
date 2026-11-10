#!/usr/bin/env node
/**
 * Builds site/data.json with real player data.
 *
 *  - Schedules, rosters and game logs: ESPN's public site API (free, no key).
 *  - Sportsbook prop lines: The Odds API (https://the-odds-api.com), only when
 *    ODDS_API_KEY is set. Without it, every line is a projection built from the
 *    player's recent games and is labeled as such in the app.
 *
 * Env:
 *   ODDS_API_KEY        optional. The Odds API key.
 *   FETCH_ODDS=1        actually spend Odds API credits on this run (otherwise
 *                       lines come from the cached odds file, if any).
 *   ODDS_MAX_CREDITS    max credits to spend per run (default 16 ≈ 480/month).
 *   ODDS_CACHE          path of the odds cache file (default .cache/odds.json).
 *   OUT                 output path (default site/data.json).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const OUT = process.env.OUT || "site/data.json";
const ODDS_KEY = process.env.ODDS_API_KEY || "";
const FETCH_ODDS = process.env.FETCH_ODDS === "1" || process.env.FETCH_ODDS === "true";
const ODDS_MAX_CREDITS = +(process.env.ODDS_MAX_CREDITS || 16);
const ODDS_CACHE = process.env.ODDS_CACHE || ".cache/odds.json";

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
    stats: [["pts", "Points"], ["reb", "Rebounds"], ["ast", "Assists"], ["fg3", "3PT Made"], ["pra", "Pts+Reb+Ast"], ["stl", "Steals"], ["blk", "Blocks"]],
    row: g => ({ pts: num(g.points), reb: num(g.totalRebounds), ast: num(g.assists), fg3: made(g["threePointFieldGoalsMade-threePointFieldGoalsAttempted"]), stl: num(g.steals), blk: num(g.blocks), pra: num(g.points) + num(g.totalRebounds) + num(g.assists) }),
    minutes: g => num(g.minutes), played: g => num(g.minutes) > 0,
    // keep rotation players
    select: (players) => players.filter(p => p.recentMin >= 18 && p.recentGames >= 3).sort((a, b) => b.recentMin - a.recentMin).slice(0, 9),
    propStats: () => ["pts", "reb", "ast", "fg3", "pra", "stl", "blk"],
    markets: { player_points: "pts", player_rebounds: "reb", player_assists: "ast", player_threes: "fg3", player_points_rebounds_assists: "pra", player_steals: "stl", player_blocks: "blk" },
    oddsMarkets: ["player_points", "player_rebounds", "player_assists"],
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
  },
};

// ---------------------------------------------------------------- ESPN
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
    games.push({ id: e.id, date: e.date, name: e.shortName, home: home.team, away: away.team });
  }
  return games;
}

async function rosterOf(cfg, teamId) {
  const r = await get(`${SITE}/${cfg.path}/teams/${teamId}/roster`);
  let list = r?.athletes || [];
  if (list[0]?.items) list = list.flatMap(g => g.items); // grouped rosters (NFL/NHL/MLB)
  return list.filter(a => (a.status?.type ?? "active") === "active" && (!cfg.rosterFilter || cfg.rosterFilter(a)))
    .map(a => ({ id: a.id, name: a.displayName, pos: a.position?.abbreviation || "", injury: a.injuries?.[0]?.status || null }));
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
          min: cfg.minutes(raw), season: seasonLabel, post: post || undefined, result: meta.gameResult || undefined,
          stats: cfg.row(raw),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- Odds API
async function loadOddsCache() { try { return JSON.parse(await readFile(ODDS_CACHE, "utf8")); } catch { return { fetched: null, lines: {} }; } }

async function fetchOdds(cache) {
  const O = "https://api.the-odds-api.com/v4";
  let spent = 0; const lines = {}; let remaining = null;
  const evLists = await pool(Object.entries(SPORTS), 2, async ([key, cfg]) => {
    const r = await getJSON(`${O}/sports/${cfg.oddsKey}/events?apiKey=${ODDS_KEY}`, 2); // events list costs 0 credits
    return (r?.json || []).map(e => ({ ...e, sport: key }));
  });
  const soon = Date.now() + 36 * 3600e3;
  const events = evLists.flat().filter(e => new Date(e.commence_time) > Date.now() && new Date(e.commence_time) < soon)
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
  // round-robin across sports so one league doesn't eat the whole budget
  const bySport = {}; events.forEach(e => (bySport[e.sport] ||= []).push(e));
  const queue = []; for (let i = 0; Object.values(bySport).some(a => a[i]); i++) for (const a of Object.values(bySport)) if (a[i]) queue.push(a[i]);
  for (const e of queue) {
    const cfg = SPORTS[e.sport]; const markets = cfg.oddsMarkets;
    if (spent + markets.length > ODDS_MAX_CREDITS) break;
    const r = await getJSON(`${O}/sports/${cfg.oddsKey}/events/${e.id}/odds?apiKey=${ODDS_KEY}&regions=us&markets=${markets.join(",")}&oddsFormat=american`, 1);
    spent += markets.length;
    if (!r) continue;
    remaining = r.headers.get("x-requests-remaining") ?? remaining;
    // prefer one consistent book per player/market: first book in the list that has it
    for (const bk of r.json.bookmakers || []) for (const m of bk.markets || []) {
      const stat = cfg.markets[m.key]; if (!stat) continue;
      for (const o of m.outcomes || []) {
        if (!o.description) continue;
        const id = `${e.sport}|${normName(o.description)}|${stat}`;
        const cur = lines[id] ||= { book: bk.title, line: o.point ?? 0.5 };
        if (cur.book !== bk.title) continue;
        if (o.name === "Over" || o.name === "Yes") cur.over = o.price;
        if (o.name === "Under" || o.name === "No") cur.under = o.price;
        if (o.point != null) cur.line = o.point;
      }
    }
  }
  console.log(`odds: ${queue.length} upcoming events, spent ~${spent} credits, ${Object.keys(lines).length} lines, remaining=${remaining}`);
  return { fetched: new Date().toISOString(), lines };
}

// ---------------------------------------------------------------- build
async function buildSport(key, cfg, odds) {
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
    for (const p of cfg.select(withLogs)) {
      // add last season for a deeper sample
      let logs = p.logs;
      if (logs.length < 30) {
        const cur = logs[0]?.season || "";
        const yr = parseInt(cur, 10) || new Date().getFullYear();
        const prev = await gameLog(cfg, p.id, key === "nba" || key === "nhl" ? yr : yr - 1); // ESPN: NBA/NHL season=2026 → 2025-26
        logs = logs.concat(prev.filter(l => !logs.some(x => x.date === l.date)));
      }
      logs.sort((x, y) => y.date.localeCompare(x.date));
      logs = logs.slice(0, 40);
      if (!logs.length) continue;
      const lines = {}, oddsOut = {}, src = {};
      for (const s of cfg.propStats(p)) {
        const book = odds.lines[`${key}|${normName(p.name)}|${s}`];
        if (book) { lines[s] = book.line; oddsOut[s] = { over: book.over ?? null, under: book.under ?? null, book: book.book }; src[s] = "book"; continue; }
        const sample = logs.slice(0, 20).map(l => l.stats[s]);
        const m = mean(sample);
        if (s === "td" || s === "hr" || s === "g") { if (m < 0.15) continue; lines[s] = 0.5; }
        else { if (m < 0.4) continue; lines[s] = fairLine(sample); }
        src[s] = "proj";
      }
      if (!Object.keys(lines).length) continue;
      for (const l of logs) for (const k of Object.keys(l.stats)) if (k.startsWith("_")) delete l.stats[k];
      players.push({
        id: `${key}-${p.id}`, espnId: p.id, name: p.name, team: side.team.abbreviation, pos: p.pos, injury: p.injury,
        opp: side.opp.abbreviation, home: side.home, gameDate: side.g.date,
        headshot: `https://a.espncdn.com/i/headshots/${key}/players/full/${p.id}.png`,
        lines, odds: oddsOut, lineSource: src, logs,
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
  return { name: cfg.name, teams, stats, players, teamCount: teams.length };
}

async function main() {
  let odds = await loadOddsCache();
  if (ODDS_KEY && FETCH_ODDS) {
    try { odds = await fetchOdds(odds); await mkdir(dirname(ODDS_CACHE), { recursive: true }); await writeFile(ODDS_CACHE, JSON.stringify(odds)); }
    catch (e) { console.warn("odds fetch failed, using cache:", e.message); }
  }
  const out = { generated: new Date().toISOString(), live: true, oddsFetched: odds.fetched, sports: {} };
  const only = (process.env.SPORTS || "nba,nfl,nhl,mlb").split(",");
  for (const key of only) {
    try { out.sports[key] = await buildSport(key, SPORTS[key], odds); }
    catch (e) { console.warn(`${key} failed:`, e); }
    console.log(`${key}: ${out.sports[key]?.players.length ?? 0} players`);
  }
  if (!Object.values(out.sports).some(s => s.players.length)) { console.error("No players fetched; not writing data.json"); process.exit(1); }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`wrote ${OUT}`);
}

main();
