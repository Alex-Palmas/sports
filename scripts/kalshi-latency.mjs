#!/usr/bin/env node
/**
 * Kalshi latency study: NBA and NFL.
 *
 * While games are live, follows ESPN's play-by-play and EVERY Kalshi market for each game
 * (moneyline, spread, total, quarters/halves, player props, specials) and records how the
 * prices move. Two analyses come out of it:
 *
 * 1. Prop latency. For every play that settles a Kalshi player prop (a basket that takes a
 *    player past 20 points; a catch that takes a receiver past 60 yards):
 *      play time   – when it happened (ESPN's wallclock stamp)
 *      feed delay  – when the feed delivered it, minus the play time
 *      Kalshi time – when Kalshi's YES bid first reached 90¢ (or it closed the market)
 *      stale ask   – what Kalshi still asked when the feed delivered the play, and the
 *                    after-fee profit per contract if bought then
 *      trajectory  – the implied probability from −10s to +2 min: total move, when it started,
 *                    when it was 50%/90% done, price steps, contracts traded, and how much
 *                    of the move was left when the feed delivered the play
 *
 * 2. Game tracker. For each game, every Kalshi market's pre-game price, final price, range,
 *    contracts traded and number of moves, how fast each market type reprices after key plays
 *    (scores and, in the NFL, turnovers), and the win-probability path.
 *
 * Kalshi is polled by series (one request covers that market type for every game), with the
 * main markets (moneyline, spread, total, core props) about once a second and the rest in
 * rotation, within a request budget. Each game's markets are found from its moneyline event
 * (one request per league), not by scanning all of Kalshi.
 *
 * Output: site/latency/<date>-<HHMM>-<feed>.json and site/latency/index.json for the app's
 * "Kalshi Latency Study" tab, plus site/latency/live.json every LIVE_EVERY seconds while games
 * are on (the workflow publishes it for the live view).
 *
 * Env: LEAGUES (default "nba,nfl"), FEED (espn | nba: the NBA's own CDN, home connection only),
 *      POLL_MS (1000), REQS_PER_SEC (4), MAX_MINUTES (340), LIVE_EVERY (120), OUT_DIR (site/latency).
 * 3. Live paper trading (feasibility test). The moment the feed delivers a play, the recorder
 *    asks Kalshi for the market's current price and records a paper fill at the real ask:
 *      settled  – the line the play just settled: buy YES, hold to the $1 payout
 *      rung     – after any player stat change: buy his next line up, sell at the bid after PAPER_HOLD s
 *      gameline – after a score: buy the scoring team's moneyline, sell at the bid after PAPER_HOLD s
 *    PAPER_QTY contracts (capped by the size offered), never above PAPER_MAX, after Kalshi's
 *    taker fee. Nothing is ever sent to Kalshi but public price lookups.
 *
 * Read-only: it never places orders.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";

const FEED = process.env.FEED || "espn";
const POLL_MS = +(process.env.POLL_MS || 1000);
const REQS_PER_SEC = +(process.env.REQS_PER_SEC || 4);
const MAX_MINUTES = +(process.env.MAX_MINUTES || 340);
const LIVE_EVERY = +(process.env.LIVE_EVERY || 120);
const OUT_DIR = process.env.OUT_DIR || "site/latency";
const PAPER = process.env.PAPER !== "0";
const PAPER_QTY = +(process.env.PAPER_QTY || 10), PAPER_MAX = +(process.env.PAPER_MAX || 0.90), PAPER_HOLD = +(process.env.PAPER_HOLD || 30);
const PAPER_MAX_PENDING = 6;          // skip trades rather than starve the market polling
const LEAGUE_KEYS = (process.env.LEAGUES || "nba,nfl").split(",").map(s => s.trim()).filter(Boolean);
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";
const NBA_CDN = "https://cdn.nba.com/static/json/liveData";

const REACT_BID = 0.90;            // "Kalshi has adjusted" = best YES bid ≥ 90¢ on a market that just settled YES
const fee = p => Math.ceil(0.07 * p * (1 - p) * 100) / 100;

// Every per-game Kalshi series for each league (from Kalshi's event list). `fast` series are
// polled about once a second; the rest rotate within the request budget.
export const LEAGUES = {
  nba: {
    name: "NBA", espn: "basketball/nba", game: "KXNBAGAME",
    fast: ["KXNBAGAME", "KXNBASPREAD", "KXNBATOTAL", "KXNBAPTS"],
    medium: ["KXNBAREB", "KXNBAAST", "KXNBA3PT", "KXNBAPRA"],
    slow: ["KXNBA1Q", "KXNBA2Q", "KXNBA3Q", "KXNBA4Q", "KXNBA1H", "KXNBA2H", "KXNBAOT", "KXNBA1QSPREAD", "KXNBA2QSPREAD", "KXNBA3QSPREAD", "KXNBA4QSPREAD",
      "KXNBA1HSPREAD", "KXNBA2HSPREAD", "KXNBA1QTOTAL", "KXNBA2QTOTAL", "KXNBA3QTOTAL", "KXNBA4QTOTAL", "KXNBA1HTOTAL", "KXNBA2HTOTAL", "KXNBATEAMTOTAL",
      "KXNBA1HTEAMTOTAL", "KXNBAWINMARGIN", "KXNBARACE", "KXNBASTL", "KXNBABLK", "KXNBASTOCK", "KXNBA2D", "KXNBA3D", "KXNBAPTSLEADER",
      "KXNBAPTSPROT", "KXNBAREBPROT", "KXNBAASTPROT", "KXNBA3PTPROT", "KXNBAPRAPROT"],
    props: { KXNBAPTS: "pts", KXNBAREB: "reb", KXNBAAST: "ast", KXNBA3PT: "fg3" },
    // ESPN abbreviation → Kalshi code
    alias: { GS: "GSW", NO: "NOP", NY: "NYK", SA: "SAS", UTAH: "UTA", WSH: "WAS" },
  },
  nfl: {
    name: "NFL", espn: "football/nfl", game: "KXNFLGAME",
    fast: ["KXNFLGAME", "KXNFLSPREAD", "KXNFLTOTAL", "KXNFLTD"],
    medium: ["KXNFLPASSYDS", "KXNFLRSHYDS", "KXNFLRECYDS", "KXNFLREC"],
    slow: ["KXNFLTEAMTOTAL", "KXNFL1HTEAMTOTAL", "KXNFL1Q", "KXNFL2Q", "KXNFL3Q", "KXNFL4Q", "KXNFL1H", "KXNFL2H", "KXNFLOT", "KXNFLTIE",
      "KXNFL1QSPREAD", "KXNFL2QSPREAD", "KXNFL3QSPREAD", "KXNFL4QSPREAD", "KXNFL1HSPREAD", "KXNFL2HSPREAD", "KXNFL1QTOTAL", "KXNFL2QTOTAL", "KXNFL3QTOTAL",
      "KXNFL4QTOTAL", "KXNFL1HTOTAL", "KXNFL2HTOTAL", "KXNFL1HFT", "KXNFLWINMARGIN", "KXNFLRACE", "KXNFLBOTH", "KXNFL1QBTTS", "KXNFL2QBTTS", "KXNFL3QBTTS",
      "KXNFL4QBTTS", "KXNFLEQBTTS", "KXNFLFIRSTTD", "KXNFLFIRSTTDTEAM", "KXNFLTEAMFIRSTTD", "KXNFLFG", "KXNFLSFTY", "KXNFLDSTTD", "KXNFLTEAMSACK",
      "KXNFLTEAMYDS", "KXNFLPASSTDS", "KXNFLPASSINT", "KXNFLPASSCOMP", "KXNFLPASSATT", "KXNFLRSHATT", "KXNFLRRYDS", "KXNFLLONGRSH", "KXNFLLONGREC",
      "KXNFLFFPTS", "KXNFLFFPTSLADDER", "KXNFLLADDERRECYDS", "KXNFLLADDERREC", "KXNFLLADDERRSHYDS", "KXNFLESCALATORRSHYDS", "KXNFLESCALATORRECYDS",
      "KXNFLESCALATORREC", "KXNFLPASSYDSPROT", "KXNFLRSHYDSPROT", "KXNFLRECYDSPROT", "KXNFLRECPROT", "KXNFLTDPROT", "KXNFLPASSTDSPROT", "KXNFLDELAY"],
    props: { KXNFLPASSYDS: "pass_yds", KXNFLRSHYDS: "rush_yds", KXNFLRECYDS: "rec_yds", KXNFLREC: "rec", KXNFLTD: "td" },
    alias: { WSH: "WAS", JAX: "JAC" },
  },
};
/**
 * Which live stat a player-prop series tracks. "Protected" variants (…PROT) track the same stat as the
 * plain series; NBA points+rebounds+assists ladders track "pra" (summed from the box score).
 */
export function propStatOf(series, league) {
  const props = LEAGUES[league]?.props || {};
  if (props[series]) return props[series];
  const plain = series.replace(/PROT$/, "");
  if (props[plain]) return props[plain];
  if (league === "nba" && /^KXNBAPRA(PROT)?$/.test(series)) return "pra";
  return null;
}
/** Display group for a series, used to compare market types. */
export function seriesGroup(series, league) {
  const s = series.replace(/^KXNBA|^KXNFL/, "");
  if (s === "GAME") return "Moneyline";
  if (s === "SPREAD" || s === "WINMARGIN") return "Spread & margin";
  if (s === "TOTAL" || s === "TEAMTOTAL") return "Totals";
  if (/^[1-4][QH]|^OT$|^TIE$|1HFT|1HTEAMTOTAL/.test(s)) return "Quarters & halves";
  if (LEAGUES[league]?.props["KX" + league.toUpperCase() + s] || /PROT$|PRA|STL|BLK|STOCK|PTSLEADER|2D|3D|PASS|RSH|REC|RRYDS|LONG|FFPTS|LADDER|ESCALATOR|^TD$/.test(s)) return "Player props";
  return "Game specials";
}
/** Kalshi team code for an ESPN abbreviation. */
export const kalshiCode = (league, a) => LEAGUES[league]?.alias[a] || a;
/** Back-compat for the NBA-only helpers/tests. */
export const tricode = a => LEAGUES.nba.alias[a] || a;
export const PROP_SERIES = LEAGUES.nba.props;
export const normName = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "").replace(/[^a-z]/g, "");
const etDate = iso => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "2-digit", month: "short", day: "2-digit" }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
/** Kalshi event suffix for a game, e.g. 26NOV10BOSPHI (date is the US-Eastern game date). */
export function eventSuffix(startIso, awayAbbr, homeAbbr, league = "nba") {
  const p = etDate(startIso);
  return `${p.year}${p.month.toUpperCase()}${p.day}${kalshiCode(league, awayAbbr)}${kalshiCode(league, homeAbbr)}`;
}
/**
 * Find a game's Kalshi event suffix among the league's moneyline events. Kalshi subtitles
 * look like "MIL vs NYK (Nov 10)"; match on the ET date and both team codes, in either order.
 */
export function matchEvent(league, game, events) {
  const p = etDate(game.start); const date = `${p.year}${p.month.toUpperCase()}${p.day}`;
  const want = new Set([kalshiCode(league, game.away), kalshiCode(league, game.home)]);
  for (const e of Array.isArray(events) ? events : []) {
    const sfx = e.event_ticker.split("-")[1] || ""; if (!sfx.startsWith(date)) continue;
    const codes = String(e.sub_title || "").replace(/\(.*\)/, "").split(/\s+(?:vs|at|@)\s+/i).map(x => x.trim()).filter(Boolean);
    if (codes.length === 2 && codes.every(c => want.has(c))) return sfx;
    if (sfx === date + [...want].join("") || sfx === date + [...want].reverse().join("")) return sfx;
  }
  return null;
}

// ---------------------------------------------------------------- http
const sleep = ms => new Promise(r => setTimeout(r, ms));
let backoffUntil = 0, kalshiNext = 0;
async function getJSON(url) {
  const kalshi = url.startsWith(KALSHI);
  if (kalshi) {
    // pace Kalshi requests evenly (REQS_PER_SEC), and pause after a rate-limit answer
    const now = Date.now(), at = Math.max(now, kalshiNext, backoffUntil);
    kalshiNext = at + 1000 / REQS_PER_SEC;
    if (at > now) await sleep(at - now);
  }
  try {
    const r = await fetch(url, { headers: { "User-Agent": "proplab-latency-study/1.0", "Cache-Control": "no-cache" } });
    if (r.status === 429 && kalshi) { backoffUntil = Date.now() + 2000; console.warn("Kalshi rate limit hit; backing off 2s"); return null; }
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ---------------------------------------------------------------- play parsing
/**
 * Turn a feed's play into stat increments: [{ athleteKey, stat, n }].
 * ESPN play: { scoringPlay, scoreValue, type:{text}, participants:[{athlete:{id}}], wallclock }
 */
export function espnIncrements(play) {
  const inc = []; const who = play.participants?.map(p => p.athlete?.id) || [];
  const t = play.type?.text || "";
  if (play.scoringPlay && who[0]) {
    inc.push({ id: who[0], stat: "pts", n: play.scoreValue || 0 });
    if (play.scoreValue === 3) inc.push({ id: who[0], stat: "fg3", n: 1 });
    if (who[1] && play.scoreValue >= 2 && !/free throw/i.test(t)) inc.push({ id: who[1], stat: "ast", n: 1 });
  }
  if (/rebound/i.test(t) && who[0] && !/team/i.test(t)) inc.push({ id: who[0], stat: "reb", n: 1 });
  return inc.filter(x => x.n > 0);
}
/** NBA CDN action: { actionType, shotResult, shotValue?, personId, assistPersonId, timeActual } */
export function nbaIncrements(a) {
  const inc = [];
  if (a.shotResult === "Made" && a.personId) {
    const pts = a.actionType === "freethrow" ? 1 : a.actionType === "3pt" ? 3 : 2;
    inc.push({ id: String(a.personId), stat: "pts", n: pts });
    if (pts === 3) inc.push({ id: String(a.personId), stat: "fg3", n: 1 });
    if (a.assistPersonId) inc.push({ id: String(a.assistPersonId), stat: "ast", n: 1 });
  }
  if (a.actionType === "rebound" && a.personId && a.personId !== 0 && a.qualifiers?.includes?.("team") !== true) inc.push({ id: String(a.personId), stat: "reb", n: 1 });
  return inc;
}

// ---------------------------------------------------------------- analysis (pure; tested)
/** Price state of a timeline [{t, bid, ask, askSize}] at time t (last point at or before t). */
export function stateAt(timeline, t) {
  let s = null; for (const p of timeline) { if (p.t <= t) s = p; else break; } return s;
}
/** First time ≥ from when bid ≥ level. */
export function firstReach(timeline, from, level) {
  for (const p of timeline) if (p.t >= from && p.bid != null && p.bid >= level) return p.t;
  return null;
}
/** Measure one settled-YES crossing. */
export function measureCrossing(c, timeline) {
  const before = stateAt(timeline, c.playT - 1);              // market just before the play
  if (before && before.bid != null && before.bid >= REACT_BID) return { ...c, alreadyPriced: true };
  const react = firstReach(timeline, c.playT - 30e3, REACT_BID); // allow small clock skew
  const atSeen = stateAt(timeline, c.seenT);
  const ask = atSeen?.ask ?? null;
  const edge = ask != null && ask < 0.99 ? +(1 - ask - fee(ask)).toFixed(4) : null;
  return {
    ...c,
    feedDelay: (c.seenT - c.playT) / 1000,
    kalshiDelay: react != null ? (react - c.playT) / 1000 : null,
    askAtSeen: ask, askSizeAtSeen: atSeen?.askSize ?? null, bidAtSeen: atSeen?.bid ?? null,
    staleEdge: edge,
    feedFirst: react == null ? true : c.seenT < react,          // our feed beat Kalshi's adjustment
  };
}
/** How long Kalshi's game-winner market took to move after a scoring play. */
export function measureScoreReaction(playT, timelines) {
  let first = null;
  for (const tl of timelines) {
    const s0 = stateAt(tl, playT - 1);
    for (const p of tl) {
      if (p.t < playT - 2000) continue; if (p.t > playT + 90e3) break;
      if (!s0 || p.bid !== s0.bid || p.ask !== s0.ask) { if (first == null || p.t < first) first = p.t; break; }
    }
  }
  return first == null ? null : (first - playT) / 1000;
}
/** Implied probability of a price point: mid of bid/ask (or whichever side exists). */
export const midOf = p => p == null ? null : p.closed ? 1 : p.bid != null && p.ask != null ? (p.bid + p.ask) / 2 : (p.bid ?? p.ask ?? null);
export const OFFSETS = [-10, -5, 0, 1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120]; // seconds after the play
/**
 * The price path after a play.
 *   final: the value the market must end at (1 for a prop the play settled), or null to use
 *          the mid WINDOW seconds later (game lines, which keep moving with the game).
 * Returns times in seconds after the play; `path` is the mid at each OFFSET (null if unknown);
 * `done` is the share of the total move completed at each OFFSET.
 */
export function trajectory(timeline, playT, { final = null, window = 120, seenT = null } = {}) {
  const pre = midOf(stateAt(timeline, playT - 1));
  if (pre == null) return null;
  const at = t => midOf(stateAt(timeline, t));
  const end = final ?? at(playT + window * 1e3);
  const move = end - pre;
  const path = OFFSETS.map(o => { if (o > window) return null; const v = at(playT + o * 1e3); return v == null ? null : +v.toFixed(4); });
  const out = { pre: +pre.toFixed(4), end: +end.toFixed(4), move: +move.toFixed(4), path };
  const inWin = timeline.filter(p => p.t >= playT - 2e3 && p.t <= playT + window * 1e3);
  const v0 = stateAt(timeline, playT - 1)?.vol, v1 = stateAt(timeline, playT + window * 1e3)?.vol;
  out.traded = v0 != null && v1 != null ? Math.max(0, Math.round(v1 - v0)) : null;
  if (Math.abs(move) < 0.01) return { ...out, flat: true };
  let tStart = null, t50 = null, t90 = null, steps = 0, last = pre;
  for (const p of inWin) {
    const m = midOf(p); if (m == null || m === last) continue;
    steps++; last = m;
    const dt = (p.t - playT) / 1000, frac = (m - pre) / move;
    if (tStart == null) tStart = dt;
    if (t50 == null && frac >= 0.5) t50 = dt;
    if (t90 == null && frac >= 0.9) t90 = dt;
  }
  out.tStart = tStart; out.t50 = t50; out.t90 = t90; out.steps = steps;
  out.done = path.map(v => v == null ? null : +Math.max(-0.5, Math.min(1.5, (v - pre) / move)).toFixed(3));
  if (seenT != null) { const m = at(seenT); out.leftAtSeen = m == null ? null : +Math.max(0, Math.min(1, 1 - (m - pre) / move)).toFixed(3); }
  return out;
}
/**
 * Raw top of the order book around a play, for the trading simulator:
 * [[secondsAfterPlay, bid, ask, askSize]] from `from` to `to` seconds; the first point is the state at `from`.
 */
export function bookWindow(tl, playT, from = -10, to = 120) {
  const s0 = stateAt(tl, playT + from * 1e3); const out = [];
  const pt = (p, dt) => [+dt.toFixed(2), p.bid ?? null, p.ask ?? null, p.askSize != null ? Math.round(p.askSize) : null];
  if (s0) out.push(pt(s0, from));
  for (const p of tl) { const dt = (p.t - playT) / 1000; if (dt > from && dt <= to) out.push(pt(p, dt)); }
  return out.length ? out : null;
}
/** Seconds until the next scoring play (1s before it), between 3 and 120. */
export const windowFor = (playT, nextT) => nextT == null ? 120 : Math.max(3, Math.min(120, Math.floor((nextT - playT) / 1000) - 1));
/** Median share-of-move-done curve across many trajectories. */
export function medianCurve(trajs) {
  return OFFSETS.map((o, i) => median(trajs.map(t => t?.done?.[i])));
}
export function median(a) { const s = a.filter(x => x != null && Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }


// ---------------------------------------------------------------- ESPN parsing
/** All plays from an ESPN summary, oldest first (NBA: plays[]; NFL: drives). */
export function espnPlays(summary) {
  if (Array.isArray(summary?.plays) && summary.plays.length) return summary.plays;
  const d = summary?.drives; if (!d) return [];
  return [...(d.previous || []), ...(d.current ? [d.current] : [])].flatMap(x => x.plays || []);
}
const NFL_BOX = { passing: { passingYards: "pass_yds" }, rushing: { rushingYards: "rush_yds", rushingTouchdowns: "td" }, receiving: { receivingYards: "rec_yds", receptions: "rec", receivingTouchdowns: "td" } };
/** NFL player totals from an ESPN box score: { athleteId: { name, pass_yds, rush_yds, rec_yds, rec, td } }. */
export function nflTotals(summary) {
  const out = {};
  for (const team of summary?.boxscore?.players || []) for (const cat of team.statistics || []) {
    const map = NFL_BOX[cat.name]; if (!map) continue;
    for (const a of cat.athletes || []) {
      const t = (out[a.athlete.id] ||= { name: a.athlete.displayName, pass_yds: 0, rush_yds: 0, rec_yds: 0, rec: 0, td: 0 });
      cat.keys.forEach((k, i) => { if (map[k]) t[map[k]] += parseFloat(a.stats[i]) || 0; });
    }
  }
  return out;
}
/** Key play summary for the game tracker (scores, NFL turnovers). */
function keyPlay(league, p, teamById, prev) {
  const t = p.type?.text || "";
  const turnover = league === "nfl" && /interception|fumble/i.test(t + " " + (p.text || "")) && !/no play|overturned/i.test(p.text || "");
  const scoring = !!p.scoringPlay;
  if (!scoring && !turnover) return null;
  const home = +p.homeScore, away = +p.awayScore;
  const pts = scoring ? Math.abs((home + away) - (prev.home + prev.away)) || p.scoreValue || null : 0;
  const [mm, ss] = String(p.clock?.displayValue || "").split(":").map(Number);
  return {
    id: p.id, type: scoring ? (league === "nfl" ? (t.match(/touchdown|field goal|safety|two-point|extra point/i)?.[0] || "Score") : "Score") : "Turnover",
    team: teamById[p.team?.id] || teamById[p.start?.team?.id] || null, points: pts, period: p.period?.number,
    secsLeft: Number.isFinite(mm) ? mm * 60 + (ss || 0) : null, home, away, text: String(p.text || "").slice(0, 120),
  };
}

// ---------------------------------------------------------------- live paper trading
export const takerFee = (p, qty) => Math.ceil(0.07 * qty * p * (1 - p) * 100 - 1e-9) / 100;
/** Paper trader: real-time price lookups, simulated fills. Never places orders. */
export class PaperTrader {
  constructor({ fetchMarket = t => getJSON(`${KALSHI}/markets/${t}`).then(r => r?.market ?? null), now = () => Date.now(), wait = sleep } = {}) {
    this.fetchMarket = fetchMarket; this.now = now; this.wait = wait;
    this.trades = []; this.pending = 0; this.open = new Set(); this.skipped = { busy: 0, noPrice: 0, tooExpensive: 0, duplicate: 0 };
  }
  /** Act on a play the moment the feed delivered it. Returns the trade promise (for tests). */
  enter(strategy, ticker, info) {
    const key = `${strategy}|${ticker}`;
    if (this.open.has(key)) { this.skipped.duplicate++; return null; }
    if (this.pending >= PAPER_MAX_PENDING) { this.skipped.busy++; return null; }
    this.open.add(key); this.pending++;
    return this.run(strategy, ticker, info).finally(() => { this.open.delete(key); this.pending--; });
  }
  async run(strategy, ticker, info) {
    const decided = this.now();
    const m = await this.fetchMarket(ticker); const filledAt = this.now();
    const ask = m?.yes_ask_dollars != null ? +m.yes_ask_dollars : null, size = m?.yes_ask_size_fp != null ? +m.yes_ask_size_fp : null;
    if (m && m.status && !/active|open/i.test(m.status)) { this.skipped.noPrice++; return; } // already closed/decided
    if (ask == null || ask <= 0 || ask >= 0.995) { this.skipped.noPrice++; return; }
    if (ask > PAPER_MAX) { this.skipped.tooExpensive++; return; }
    const qty = Math.max(1, Math.min(PAPER_QTY, size || PAPER_QTY));
    const t = { strategy, ticker, ...info, play: new Date(info.playT).toISOString(), feedDelay: (info.seenT - info.playT) / 1000,
      lookupMs: filledAt - decided, entry: ask, qty, entryFee: takerFee(ask, qty), status: "open" };
    delete t.playT; delete t.seenT;
    this.trades.push(t);
    if (strategy === "settled") { // the play already decided it: settles at $1
      t.exit = 1; t.exitFee = 0; t.status = "settled"; t.pnl = +(qty * (1 - ask) - t.entryFee).toFixed(2); return t;
    }
    await this.wait(PAPER_HOLD * 1000);
    const m2 = await this.fetchMarket(ticker);
    let bid = m2?.yes_bid_dollars != null ? +m2.yes_bid_dollars : null;
    if (m2?.status && /settled|finalized|determined/i.test(m2.status) && m2.result) bid = m2.result === "yes" ? 1 : 0;
    if (bid == null) { t.status = "no exit price"; t.pnl = +(-qty * ask - t.entryFee).toFixed(2); return t; }
    t.exit = bid; t.exitFee = bid > 0 && bid < 1 ? takerFee(bid, qty) : 0; t.status = "closed";
    t.pnl = +(qty * (bid - ask) - t.entryFee - t.exitFee).toFixed(2);
    return t;
  }
  report() {
    const done = this.trades.filter(t => t.pnl != null);
    const by = {}; for (const t of done) { const x = (by[t.strategy] ||= { strategy: t.strategy, trades: 0, wins: 0, pnl: 0, staked: 0 }); x.trades++; x.wins += t.pnl > 0; x.pnl += t.pnl; x.staked += t.entry * t.qty; }
    const pnl = done.reduce((a, t) => a + t.pnl, 0), staked = done.reduce((a, t) => a + t.entry * t.qty, 0);
    return { rules: { qty: PAPER_QTY, maxPrice: PAPER_MAX, hold: PAPER_HOLD }, open: this.trades.length - done.length, skipped: this.skipped,
      summary: { trades: done.length, wins: done.filter(t => t.pnl > 0).length, pnl: +pnl.toFixed(2), staked: +staked.toFixed(2), roi: staked ? pnl / staked : null,
        medianFeedDelay: median(done.map(t => t.feedDelay)), medianLookupMs: median(done.map(t => t.lookupMs)) },
      byStrategy: Object.values(by).map(x => ({ ...x, pnl: +x.pnl.toFixed(2), staked: +x.staked.toFixed(2) })),
      trades: this.trades.slice(-300) };
  }
}

// ---------------------------------------------------------------- recorder
export class Recorder {
  constructor() {
    this.games = new Map();       // `${league}:${espnId}` → game
    this.timelines = new Map();   // kalshi ticker → [{t, bid, ask, vol, askSize}]
    this.markets = new Map();     // ticker → { league, series, group, suffix, title, sub, name, line, stat }
    this.seriesPolls = new Map(); // series → [poll times] (sampling interval)
    this.crossings = [];
    this.scoring = [];            // NBA scoring plays for the game-line trajectory analysis
    this.feedDelays = [];
    this.playerEvents = [];       // every stat change for a player who has Kalshi markets on that stat
    this.paper = PAPER ? new PaperTrader() : null;
    this.started = Date.now();
    this.slowPtr = 0;
    this.emptySeries = new Map(); // series → time it last had no markets for live games
  }

  async refreshGames() {
    const days = [-1, 0, 1].map(o => new Date(Date.now() + o * 86400e3).toISOString().slice(0, 10).replace(/-/g, ""));
    for (const lk of LEAGUE_KEYS) {
      const L = LEAGUES[lk]; if (!L) continue;
      let gameEvents = null;
      for (const day of days) {
        const sb = await getJSON(`${ESPN_BASE}/${L.espn}/scoreboard?dates=${day}`);
        for (const e of sb?.events || []) {
          const c = e.competitions?.[0]; if (!c) continue;
          const home = c.competitors.find(x => x.homeAway === "home"), away = c.competitors.find(x => x.homeAway === "away");
          const key = `${lk}:${e.id}`;
          const g = this.games.get(key) || { key, league: lk, id: e.id, name: e.shortName, start: e.date, home: home.team.abbreviation, away: away.team.abbreviation,
            homeName: home.team.displayName, awayName: away.team.displayName, suffix: null, seen: new Set(), totals: {}, names: {}, keyPlays: [], lastScore: { home: 0, away: 0 } };
          g.state = e.status?.type?.state; g.detail = e.status?.type?.shortDetail; g.score = { home: +home.score || 0, away: +away.score || 0 };
          g.teamById = { [home.team.id]: home.team.abbreviation, [away.team.id]: away.team.abbreviation };
          if (g.state === "in" && !g.tipT) g.tipT = Date.now();
          if (g.state === "post" && g.tipT && !g.endT) g.endT = Date.now();
          this.games.set(key, g);
        }
      }
      // match games that are live or about to start to their Kalshi events (one request per league)
      for (const g of this.games.values()) {
        if (g.league !== lk || g.suffix || !(g.state === "in" || (g.state === "pre" && new Date(g.start) - Date.now() < 3 * 3600e3))) continue;
        gameEvents ||= (await getJSON(`${KALSHI}/events?series_ticker=${L.game}&limit=200`))?.events || [];
        g.suffix = matchEvent(lk, g, gameEvents);
        if (!g.suffix) console.log(`no Kalshi moneyline event found for ${lk.toUpperCase()} ${g.name}`);
      }
    }
  }

  live() { return [...this.games.values()].filter(g => g.state === "in"); }
  pending() { return [...this.games.values()].filter(g => g.state === "pre" && new Date(g.start) - Date.now() < 4 * 3600e3); }

  /**
   * Next series to poll. Three priority levels share the request budget in the pattern
   * fast, fast, medium, fast, fast, slow: moneyline/spread/total/headline prop most often,
   * other props next, quarters/halves/specials in rotation. Series with no markets for live
   * games are skipped for 5 minutes. Price changes are still timed with Kalshi's own
   * updated_time, so a slower refresh mostly costs intermediate steps, not timing precision.
   */
  nextSeries() {
    const leagues = [...new Set(this.live().filter(g => g.suffix).map(g => g.league))];
    if (!leagues.length) return null;
    const now = Date.now(), ok = s => !(this.emptySeries.get(s) > now - 300e3);
    const lists = { fast: leagues.flatMap(l => LEAGUES[l].fast), medium: leagues.flatMap(l => LEAGUES[l].medium).filter(ok), slow: leagues.flatMap(l => LEAGUES[l].slow).filter(ok) };
    const pattern = ["fast", "fast", "medium", "fast", "fast", "slow"];
    this.ptr ||= { fast: 0, medium: 0, slow: 0 };
    for (let i = 0; i < pattern.length; i++) {
      const tier = pattern[(this.tick = (this.tick || 0) + 1) % pattern.length];
      const list = lists[tier]; if (list.length) return list[(this.ptr[tier]++) % list.length];
    }
    return lists.fast[0];
  }

  async pollSeries(series) {
    const now = Date.now(), lastPoll = this.seriesPolls.get(series)?.at(-1) ?? now - POLL_MS;
    const league = series.startsWith("KXNFL") ? "nfl" : "nba";
    const suffixes = new Set(this.live().filter(g => g.league === league && g.suffix).map(g => g.suffix));
    if (!suffixes.size) return;
    let cursor = "", complete = false, any = false; const seenTickers = new Set();
    for (let page = 0; page < 6; page++) {
      const r = await getJSON(`${KALSHI}/markets?series_ticker=${series}&status=open&limit=200${cursor ? `&cursor=${cursor}` : ""}`);
      if (!r) break;
      for (const m of r.markets || []) {
        const suffix = m.event_ticker.split("-")[1]; if (!suffixes.has(suffix)) continue;
        any = true; seenTickers.add(m.ticker);
        if (!this.markets.has(m.ticker)) {
          const stat = propStatOf(series, league);
          this.markets.set(m.ticker, { league, series, group: seriesGroup(series, league), suffix, title: m.title, sub: m.yes_sub_title,
            stat, name: stat ? String(m.title).split(":")[0].trim() : (series === LEAGUES[league].game ? m.yes_sub_title : null),
            line: m.floor_strike ?? null, team: series === LEAGUES[league].game ? m.ticker.split("-").at(-1) : null });
        }
        const bid = m.yes_bid_dollars != null ? +m.yes_bid_dollars : null, ask = m.yes_ask_dollars != null ? +m.yes_ask_dollars : null;
        const vol = m.volume_fp != null ? +m.volume_fp : null;
        const tl = this.timelines.get(m.ticker) || []; const last = tl[tl.length - 1];
        if (!last || last.bid !== bid || last.ask !== ask || last.vol !== vol) {
          // the change happened after our previous poll of this series; Kalshi's updated_time narrows it down
          const kt = m.updated_time ? Date.parse(m.updated_time) : NaN;
          const t = last && Number.isFinite(kt) && kt > lastPoll && kt <= now ? kt : now;
          tl.push({ t, polled: now, bid, ask, vol, askSize: m.yes_ask_size_fp != null ? +m.yes_ask_size_fp : null });
          this.timelines.set(m.ticker, tl);
        }
      }
      cursor = r.cursor; if (!cursor) { complete = true; break; }
    }
    if (complete) {
      if (!any) this.emptySeries.set(series, now); else this.emptySeries.delete(series);
      // a tracked market that left the open list was closed (e.g. decided): count it as settled
      for (const [ticker, m] of this.markets) {
        if (m.series !== series || !suffixes.has(m.suffix) || seenTickers.has(ticker)) continue;
        const tl = this.timelines.get(ticker) || []; const last = tl[tl.length - 1];
        if (last && !last.closed) tl.push({ t: now, polled: now, bid: 1, ask: 1, vol: last.vol, closed: true });
      }
    }
    const polls = this.seriesPolls.get(series) || []; polls.push(now); if (polls.length > 400) polls.splice(0, 200); this.seriesPolls.set(series, polls);
  }

  async pollFeed(g) {
    const now = Date.now();
    const L = LEAGUES[g.league];
    if (g.league === "nba" && FEED === "nba") return this.pollNbaCdn(g, now);
    const s = await getJSON(`${ESPN_BASE}/${L.espn}/summary?event=${g.id}`);
    if (!s) return;
    if (g.league === "nba") for (const team of s.boxscore?.players || []) for (const a of team.statistics?.[0]?.athletes || []) g.names[a.athlete.id] = a.athlete.displayName;
    let newestPlayT = null;
    for (const p of espnPlays(s)) {
      if (g.seen.has(p.id)) continue; g.seen.add(p.id);
      const playT = Date.parse(p.wallclock);
      const kp = keyPlay(g.league, p, g.teamById, g.lastScore);
      if (p.homeScore != null) g.lastScore = { home: +p.homeScore, away: +p.awayScore };
      if (!g.primed) { if (g.league === "nba") for (const i of espnIncrements(p)) { this.add(g, i); if (["pts", "reb", "ast"].includes(i.stat)) this.add(g, { ...i, stat: "pra" }); } continue; } // backlog
      if (!Number.isFinite(playT)) continue;
      newestPlayT = Math.max(newestPlayT ?? 0, playT);
      this.feedDelays.push({ league: g.league, d: (now - playT) / 1000 });
      if (kp) g.keyPlays.push({ ...kp, playT, seenT: now });
      if (g.league === "nba") {
        if (p.scoringPlay && kp?.team) {
          this.scoring.push({ league: "nba", suffix: g.suffix, game: g.name, playT, seenT: now, team: kp.team, points: p.scoreValue, period: kp.period, secsLeft: kp.secsLeft, home: kp.home, away: kp.away });
          this.paperGameLine(g, this.scoring[this.scoring.length - 1]);
        }
        this.applyIncrements(g, espnIncrements(p), playT, now);
      }
      // NFL scores feed the game-line simulator
      if (g.league === "nfl" && kp?.type !== "Turnover" && kp?.team && kp.points) {
        this.scoring.push({ league: "nfl", suffix: g.suffix, game: g.name, playT, seenT: now, team: kp.team, points: kp.points, period: kp.period, secsLeft: kp.secsLeft, home: kp.home, away: kp.away });
        this.paperGameLine(g, this.scoring[this.scoring.length - 1]);
      }
    }
    if (g.league === "nfl") {
      // NFL props: compare box-score totals with the previous poll; a crossing is timed to the newest play
      const tot = nflTotals(s);
      if (g.primed && newestPlayT) for (const [id, t] of Object.entries(tot)) {
        const before = g.totals[id] || {};
        for (const stat of ["pass_yds", "rush_yds", "rec_yds", "rec", "td"]) if ((t[stat] || 0) > (before[stat] || 0)) this.checkCrossings(g, t.name, stat, before[stat] || 0, t[stat], newestPlayT, now);
      }
      g.totals = tot;
    }
    g.primed = true;
  }

  async pollNbaCdn(g, now) {
    if (!g.nbaId) {
      const sb = await getJSON(`${NBA_CDN}/scoreboard/todaysScoreboard_00.json`);
      for (const ng of sb?.scoreboard?.games || []) if (tricode(g.home) === ng.homeTeam.teamTricode && tricode(g.away) === ng.awayTeam.teamTricode) g.nbaId = ng.gameId;
      if (!g.nbaId) return;
    }
    const pbp = await getJSON(`${NBA_CDN}/playbyplay/playbyplay_${g.nbaId}.json`);
    if (!g.primed) {
      const box = await getJSON(`${NBA_CDN}/boxscore/boxscore_${g.nbaId}.json`);
      for (const side of ["homeTeam", "awayTeam"]) for (const p of box?.game?.[side]?.players || []) {
        const st = p.statistics || {}; const id = String(p.personId); g.names[id] = p.name;
        g.totals[id] = { pts: st.points || 0, reb: st.reboundsTotal || 0, ast: st.assists || 0, fg3: st.threePointersMade || 0 }; g.totals[id].pra = g.totals[id].pts + g.totals[id].reb + g.totals[id].ast;
      }
    }
    for (const a of pbp?.game?.actions || []) {
      const key = "n" + a.actionNumber; if (g.seen.has(key)) continue; g.seen.add(key);
      if (!g.primed) continue;
      const playT = Date.parse(a.timeActual); if (!Number.isFinite(playT)) continue;
      this.feedDelays.push({ league: "nba", d: (now - playT) / 1000 });
      const clk = /PT(\d+)M([\d.]+)S/.exec(a.clock || "");
      if (a.shotResult === "Made") {
        const kp = { type: "Score", team: a.teamTricode, points: a.actionType === "freethrow" ? 1 : a.actionType === "3pt" ? 3 : 2, period: a.period,
          secsLeft: clk ? +clk[1] * 60 + +clk[2] : null, home: +a.scoreHome, away: +a.scoreAway, text: a.description };
        g.keyPlays.push({ ...kp, playT, seenT: now });
        this.scoring.push({ league: "nba", suffix: g.suffix, game: g.name, playT, seenT: now, ...kp });
        this.paperGameLine(g, this.scoring[this.scoring.length - 1]);
      }
      this.applyIncrements(g, nbaIncrements(a), playT, now);
    }
    g.primed = true;
  }

  add(g, i) { const t = (g.totals[i.id] ||= { pts: 0, reb: 0, ast: 0, fg3: 0, pra: 0 }); t.pra ??= 0; const before = t[i.stat]; t[i.stat] += i.n; return [before, t[i.stat]]; }
  applyIncrements(g, incs, playT, seenT) {
    for (const i of incs) {
      const name = g.names[i.id];
      const [before, after] = this.add(g, i); if (name) this.checkCrossings(g, name, i.stat, before, after, playT, seenT);
      // points, rebounds and assists also move the PRA ladder
      if (["pts", "reb", "ast"].includes(i.stat)) { const [b2, a2] = this.add(g, { ...i, stat: "pra" }); if (name) this.checkCrossings(g, name, "pra", b2, a2, playT, seenT); }
    }
  }
  /** Every Kalshi strike a stat change pushed the player over settles YES. */
  checkCrossings(g, name, stat, before, after, playT, seenT) {
    let has = false;
    for (const [ticker, m] of this.markets) {
      if (m.suffix !== g.suffix || m.stat !== stat || m.line == null || normName(m.name || "") !== normName(name)) continue;
      has = true;
      if (before <= m.line && after > m.line) {
        this.crossings.push({ ticker, league: g.league, game: g.name, player: name, stat, line: m.line, playT, seenT });
        this.paper?.enter("settled", ticker, { league: g.league, game: g.name, label: `${name} ${Math.ceil(m.line)}+ ${stat}`, playT, seenT });
      }
    }
    // every stat change is a player event, crossing or not (it moves the player's higher lines too)
    if (has) {
      this.playerEvents.push({ league: g.league, suffix: g.suffix, game: g.name, player: name, stat, before, after, playT, seenT });
      // paper trade: the player's next line up
      const next = [...this.markets].filter(([, m]) => m.suffix === g.suffix && m.stat === stat && m.line != null && m.line >= after && normName(m.name || "") === normName(name)).sort((a, b) => a[1].line - b[1].line)[0];
      if (next) this.paper?.enter("rung", next[0], { league: g.league, game: g.name, label: `${name} ${Math.ceil(next[1].line)}+ ${stat} after ${before}→${after}`, playT, seenT });
    }
  }
  paperGameLine(g, sc) {
    if (!this.paper || !sc || sc.suffix !== g.suffix) return;
    const own = [...this.markets].find(([t, m]) => m.series === LEAGUES[g.league].game && m.suffix === g.suffix && t.endsWith("-" + kalshiCode(g.league, sc.team)));
    if (own) this.paper.enter("gameline", own[0], { league: g.league, game: g.name, label: `${sc.team} +${sc.points}`, playT: sc.playT, seenT: sc.seenT });
  }
  /** A player event with the price path of the player's next two lines it did not settle. */
  playerEventReport(e) {
    const rungs = [...this.markets].filter(([, m]) => m.suffix === e.suffix && m.stat === e.stat && m.line != null && m.line >= e.after && normName(m.name || "") === normName(e.player))
      .sort((a, b) => a[1].line - b[1].line).slice(0, 2)
      .map(([ticker, m]) => { const tl = this.timelines.get(ticker) || []; return { ticker, line: m.line, traj: trajectory(tl, e.playT, { seenT: e.seenT }), book: bookWindow(tl, e.playT) }; })
      .filter(r => r.book);
    const { playT, seenT, suffix, ...rest } = e;
    return { ...rest, play: new Date(playT).toISOString(), feedDelay: (seenT - playT) / 1000, rungs };
  }
  /** Players with Kalshi markets in a game: live stats and every line, from the market rows. */
  playersReport(g, rows) {
    const totals = {}, ids = {};
    for (const [id, name] of Object.entries(g.names || {})) ids[normName(name)] = id;
    for (const [id, t] of Object.entries(g.totals || {})) { const name = t.name || g.names[id]; if (name) { totals[normName(name)] = t; ids[normName(name)] ||= id; } }
    const players = {};
    for (const r of rows) {
      if (r.group !== "Player props" || !String(r.label).includes(":")) continue;
      const [who, what] = String(r.label).split(/:(.*)/s);
      const key = normName(who); const P = (players[key] ||= { player: who.trim(), espnId: ids[key] && /^\d+$/.test(ids[key]) ? ids[key] : null, stats: null, lines: [], traded: 0, events: 0 });
      const m = this.markets.get(r.ticker) || {};
      const tt = totals[key], cur = !m.stat || !tt ? null : m.stat === "pra" ? (tt.pts ?? 0) + (tt.reb ?? 0) + (tt.ast ?? 0) : tt[m.stat];
      P.lines.push({ ticker: r.ticker, label: what.trim(), stat: m.stat || null, line: r.line, pre: r.pre, end: r.end, change: r.change, traded: r.traded, closed: r.closed,
        settled: cur != null && r.line != null ? cur > r.line : null });
      P.traded += r.traded || 0;
    }
    for (const e of this.playerEvents) if (e.suffix === g.suffix && players[normName(e.player)]) players[normName(e.player)].events++;
    for (const [key, P] of Object.entries(players)) {
      const t = totals[key]; if (t) P.stats = Object.fromEntries(Object.entries(t).filter(([k, v]) => k !== "name" && typeof v === "number"));
      P.lines.sort((a, b) => String(a.stat ?? a.label).localeCompare(String(b.stat ?? b.label)) || (a.line ?? 0) - (b.line ?? 0));
    }
    return Object.values(players).sort((a, b) => b.traded - a.traded);
  }

  /** Per-game comparison of every Kalshi market. */
  gameReport(g) {
    const tip = g.tipT ? Math.min(g.tipT, g.keyPlays[0]?.playT ?? Infinity) : g.keyPlays[0]?.playT ?? this.started;
    const markets = [...this.markets].filter(([, m]) => m.suffix === g.suffix && m.league === g.league);
    const keyTs = g.keyPlays.map(k => k.playT).sort((a, b) => a - b);
    const sampling = s => { const p = this.seriesPolls.get(s) || []; return p.length > 2 ? median(p.slice(1).map((t, i) => t - p[i])) / 1000 : null; };
    const rows = markets.map(([ticker, m]) => {
      const tl = this.timelines.get(ticker) || [];
      const inGame = tl.filter(p => p.t >= tip);
      const mids = inGame.map(midOf).filter(v => v != null);
      const pre = midOf(stateAt(tl, tip - 1)) ?? midOf(tl[0]);
      const end = midOf(tl[tl.length - 1]);
      let moves = 0, lastMid = pre; for (const p of inGame) { const v = midOf(p); if (v != null && v !== lastMid) { moves++; lastMid = v; } }
      const v0 = stateAt(tl, tip - 1)?.vol ?? tl[0]?.vol, v1 = tl[tl.length - 1]?.vol;
      // reaction to key plays: when did this market start moving / get 50% of its move (window to next key play)
      const reacts = [];
      if (moves) keyTs.forEach((t, i) => { const tr = trajectory(tl, t, { window: windowFor(t, keyTs[i + 1] ?? null) }); if (tr && !tr.flat) reacts.push(tr); });
      const row = { ticker, group: m.group, series: m.series, label: marketLabel(m), line: m.line,
        pre: pre != null ? +pre.toFixed(3) : null, end: end != null ? +end.toFixed(3) : null,
        high: mids.length ? Math.max(...mids) : null, low: mids.length ? Math.min(...mids) : null, moves,
        traded: v0 != null && v1 != null ? Math.max(0, Math.round(v1 - v0)) : null, closed: !!tl[tl.length - 1]?.closed,
        samplingSec: sampling(m.series), reactN: reacts.length, reactStart: median(reacts.map(r => r.tStart)), reactT50: median(reacts.map(r => r.t50)) };
      row.change = row.pre != null && row.end != null ? +(row.end - row.pre).toFixed(3) : null;
      row.spark = sparkline(tl, tip, Date.now(), 40);
      return row;
    });
    // keep the file small: price path only for markets that moved
    rows.sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0) || (b.traded ?? 0) - (a.traded ?? 0));
    rows.forEach((r, i) => { if (!r.moves || i >= 150) delete r.spark; });
    const groups = {};
    for (const r of rows) (groups[r.group] ||= []).push(r);
    const groupSummary = Object.entries(groups).map(([group, rs]) => ({ group, markets: rs.length, moved: rs.filter(r => r.moves).length,
      medianAbsChange: median(rs.filter(r => r.moves).map(r => Math.abs(r.change ?? 0))), traded: rs.reduce((a, r) => a + (r.traded || 0), 0),
      medianReactStart: median(rs.map(r => r.reactStart)), medianReactT50: median(rs.map(r => r.reactT50)), samplingSec: median(rs.map(r => r.samplingSec)) }))
      .sort((a, b) => b.traded - a.traded);
    // home team's win probability through the game
    const homeTicker = markets.find(([, m]) => m.series === LEAGUES[g.league].game && m.team === kalshiCode(g.league, g.home))?.[0];
    const wp = homeTicker ? sparkline(this.timelines.get(homeTicker) || [], tip - 10 * 60e3, Date.now(), 400) : null;
    return { league: g.league, id: g.id, name: g.name, home: g.home, away: g.away, homeName: g.homeName, awayName: g.awayName, start: g.start,
      state: g.state, detail: g.detail, score: g.score, suffix: g.suffix, tip: new Date(tip).toISOString(),
      winProb: wp, keyPlays: g.keyPlays.map(({ playT, seenT, ...k }) => ({ ...k, t: new Date(playT).toISOString(), feedDelay: (seenT - playT) / 1000 })),
      groupSummary, players: this.playersReport(g, rows), markets: rows };
  }

  results() {
    const crossings = this.crossings.map(c => {
      const tl = this.timelines.get(c.ticker) || [];
      const r = measureCrossing(c, tl);
      if (!r.alreadyPriced) { r.traj = trajectory(tl, c.playT, { final: 1, seenT: c.seenT }); r.book = bookWindow(tl, c.playT); }
      return r;
    });
    const games = [...this.games.values()].filter(g => g.suffix && g.seen.size);
    // game-line trajectory after NBA scores (window ends at the next score)
    const nextScore = new Map();
    const byGame = {}; for (const s of this.scoring) (byGame[s.suffix] ||= []).push(s);
    for (const list of Object.values(byGame)) { list.sort((a, b) => a.playT - b.playT); list.forEach((s, i) => nextScore.set(s, list[i + 1]?.playT ?? null)); }
    const scoreReactions = this.scoring.map(s => {
      const lg = s.league || "nba", gameSeries = LEAGUES[lg].game;
      const own = [...this.markets].find(([t, m]) => m.series === gameSeries && m.suffix === s.suffix && t.endsWith("-" + kalshiCode(lg, s.team)));
      const tls = [...this.markets].filter(([, m]) => m.series === gameSeries && m.suffix === s.suffix).map(([t]) => this.timelines.get(t) || []);
      const tl = own ? this.timelines.get(own[0]) || [] : [];
      const margin = s.home != null && s.away != null ? Math.abs(s.home - s.away) : null;
      const window = windowFor(s.playT, nextScore.get(s));
      return {
        league: lg, game: s.game, team: s.team, points: s.points, period: s.period, secsLeft: s.secsLeft, margin,
        clutch: s.period >= 4 && s.secsLeft != null && s.secsLeft <= 300 && margin != null && margin <= 8,
        playT: s.playT, feedDelay: (s.seenT - s.playT) / 1000, window,
        kalshiDelay: measureScoreReaction(s.playT, tls),
        traj: own ? trajectory(tl, s.playT, { seenT: s.seenT, window }) : null,
        book: own ? bookWindow(tl, s.playT) : null,   // for the trading simulator (not cut at the next score)
      };
    });
    const measured = crossings.filter(c => !c.alreadyPriced);
    const stale = measured.filter(c => c.feedFirst && c.staleEdge != null && c.staleEdge > 0);
    const pTraj = measured.map(c => c.traj).filter(t => t && !t.flat);
    const nbaReactions = scoreReactions.filter(r => r.league === "nba");
    const gTraj = nbaReactions.map(r => r.traj).filter(t => t && !t.flat);
    const groups = {};
    for (const r of nbaReactions) {
      if (!r.traj) continue;
      (groups[`${r.clutch ? "Last 5 min, within 8" : "Rest of game"}|${r.points}`] ||= []).push(r.traj);
    }
    const gameBySituation = Object.entries(groups).map(([k, ts]) => {
      const [situation, points] = k.split("|"); const moving = ts.filter(t => !t.flat);
      return { situation, points: +points, plays: ts.length, moved: moving.length,
        medianMove: median(ts.map(t => Math.abs(t.move))), medianT50: median(moving.map(t => t.t50)), medianT90: median(moving.map(t => t.t90)) };
    }).sort((a, b) => a.situation.localeCompare(b.situation) || a.points - b.points);
    const fd = this.feedDelays.map(x => x.d);
    return {
      date: new Date(this.started).toISOString().slice(0, 10), started: new Date(this.started).toISOString(), ended: new Date().toISOString(),
      feed: FEED, pollMs: POLL_MS, offsets: OFFSETS, leagues: [...new Set(games.map(g => g.league))],
      games: games.map(g => ({ league: g.league, id: g.id, name: g.name, suffix: g.suffix })),
      summary: {
        plays: fd.length, crossings: crossings.length, measured: measured.length,
        medianFeedDelay: median(fd), medianFeedDelayNba: median(this.feedDelays.filter(x => x.league === "nba").map(x => x.d)),
        medianFeedDelayNfl: median(this.feedDelays.filter(x => x.league === "nfl").map(x => x.d)),
        medianKalshiDelay: median(measured.map(c => c.kalshiDelay)),
        feedFirstShare: measured.length ? measured.filter(c => c.feedFirst).length / measured.length : null,
        staleChances: stale.length, medianStaleEdge: median(stale.map(c => c.staleEdge)),
        scoringPlays: nbaReactions.length, medianGameLineDelay: median(nbaReactions.map(r => r.kalshiDelay)),
        propMove: median(pTraj.map(t => t.move)), propStart: median(pTraj.map(t => t.tStart)), propT50: median(pTraj.map(t => t.t50)),
        propT90: median(pTraj.map(t => t.t90)), propSteps: median(pTraj.map(t => t.steps)), propTraded: median(pTraj.map(t => t.traded)),
        propLeftAtSeen: median(pTraj.map(t => t.leftAtSeen)),
        gameMoved: gTraj.length, gameMove: median(gTraj.map(t => Math.abs(t.move))), gameStart: median(gTraj.map(t => t.tStart)),
        gameT50: median(gTraj.map(t => t.t50)), gameT90: median(gTraj.map(t => t.t90)), gameSteps: median(gTraj.map(t => t.steps)),
        gameTraded: median(gTraj.map(t => t.traded)), gameLeftAtSeen: median(gTraj.map(t => t.leftAtSeen)),
        markets: this.markets.size,
      },
      curves: { props: medianCurve(pTraj), game: medianCurve(gTraj) },
      gameBySituation,
      gameReports: games.map(g => this.gameReport(g)),
      crossings: crossings.map(({ seenT, playT, ...c }) => ({ ...c, play: new Date(playT).toISOString() })),
      playerEvents: this.playerEvents.slice(-4000).map(e => this.playerEventReport(e)),
      paper: this.paper?.report() ?? null,
      scoreReactions: scoreReactions.map(({ playT, ...r }) => ({ ...r, play: new Date(playT).toISOString() })),
    };
  }

  /** Small snapshot of live games for the live view. */
  liveSnapshot() {
    const games = [...this.games.values()].filter(g => g.suffix && (g.state === "in" || (g.state === "post" && g.endT > Date.now() - 30 * 60e3)));
    return { updated: new Date().toISOString(), paper: this.paper?.report(), games: games.map(g => { const r = this.gameReport(g); r.markets = r.markets.slice(0, 120); return r; }) };
  }
}

/** Readable market name: Kalshi's own market title ("Jalen Brunson: 25+ points", "Boston wins"). */
export const marketLabel = m => String(m.title || m.sub || "");
/** Mid price sampled at `n` evenly spaced times between from and to (for charts). */
export function sparkline(tl, from, to, n) {
  if (!tl.length || to <= from) return null;
  const out = []; let j = 0, cur = null;
  for (let i = 0; i < n; i++) {
    const t = from + (to - from) * i / (n - 1);
    while (j < tl.length && tl[j].t <= t) cur = tl[j++];
    const v = midOf(cur); out.push(v == null ? null : Math.round(v * 1000) / 1000);
  }
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), v: out };
}

async function save(rec) {
  const res = rec.results();
  await mkdir(OUT_DIR, { recursive: true });
  const hhmm = res.started.slice(11, 16).replace(":", "");
  const file = `${res.date}-${hhmm}-${FEED}.json`;
  await writeFile(`${OUT_DIR}/${file}`, JSON.stringify(res));
  let index = []; try { index = JSON.parse(await readFile(`${OUT_DIR}/index.json`, "utf8")); } catch {}
  index = index.filter(x => x.file !== file).concat({ file, date: res.date, started: res.started, feed: res.feed, leagues: res.leagues, games: res.games.length,
    gameNames: res.games.map(g => `${g.league.toUpperCase()} ${g.name}`), ...res.summary })
    .sort((a, b) => (b.started || b.date).localeCompare(a.started || a.date));
  await writeFile(`${OUT_DIR}/index.json`, JSON.stringify(index, null, 1));
  return res;
}

async function main() {
  const rec = new Recorder(); const deadline = Date.now() + MAX_MINUTES * 60e3;
  let lastGames = 0, lastSave = Date.now(), lastLive = 0, everLive = false, running = true;
  const stop = async () => {
    running = false;
    if ([...rec.games.values()].some(g => g.suffix && g.seen.size)) { const r = await save(rec); console.log("saved", JSON.stringify(r.summary)); }
    else console.log("Nothing recorded; no file written.");
    process.exit(0);
  };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  console.log(`Kalshi latency study: leagues=${LEAGUE_KEYS}, feed=${FEED}, poll=${POLL_MS}ms, Kalshi ${REQS_PER_SEC} req/s, max ${MAX_MINUTES} min`);
  // Kalshi: a steady paced loop over series (getJSON spaces the requests)
  (async () => { while (running) { const s = rec.nextSeries(); if (s) await rec.pollSeries(s); else await sleep(1000); } })();
  // feed + housekeeping: about once a second
  while (Date.now() < deadline) {
    if (Date.now() - lastGames > 60e3) {
      await rec.refreshGames(); lastGames = Date.now();
      const live = rec.live(), pend = rec.pending();
      console.log(`${new Date().toISOString()} live: ${live.map(g => `${g.league} ${g.name}${g.suffix ? "" : " (no Kalshi event)"}`).join(", ") || "none"} | upcoming: ${pend.length} | markets: ${rec.markets.size} | crossings: ${rec.crossings.length}`);
      if (live.length) everLive = true;
      if (!live.length && !pend.length) { if (!everLive) console.log("No NBA/NFL games live or starting within 4 hours."); break; }
    }
    const t0 = Date.now();
    await Promise.all(rec.live().filter(g => g.suffix).map(g => rec.pollFeed(g)));
    if (Date.now() - lastLive > LIVE_EVERY * 1e3 && rec.live().length) {
      lastLive = Date.now(); await mkdir(OUT_DIR, { recursive: true }); await writeFile(`${OUT_DIR}/live.json`, JSON.stringify(rec.liveSnapshot()));
    }
    if (Date.now() - lastSave > 10 * 60e3) { await save(rec); lastSave = Date.now(); }
    await sleep(Math.max(0, POLL_MS - (Date.now() - t0)));
  }
  await stop();
}

if (import.meta.url === `file://${process.argv[1]}`) main();
