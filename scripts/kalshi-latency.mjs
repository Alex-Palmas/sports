#!/usr/bin/env node
/**
 * Kalshi latency study (NBA).
 *
 * While NBA games are live, polls a play-by-play feed and Kalshi's public market data
 * about once a second, then measures, for every play that settles a Kalshi player-prop
 * market (e.g. a basket that takes a player from 19 to 21 points settles "20+ points"
 * as YES):
 *
 *   play time   – when it happened on the court (the feed's wallclock stamp)
 *   feed delay  – when our feed delivered it, minus the play time
 *   Kalshi time – when Kalshi's best bid first reached 90¢ (the market "knew"), minus the play time
 *   stale ask   – what Kalshi was still asking for YES when our feed delivered the play,
 *                 and the profit per contract after fees if you had bought it then
 *
 * plus, for every scoring play, how long Kalshi's game-winner market took to move.
 * Results go to site/latency/<date>.json and site/latency/index.json for the app's
 * "Kalshi Latency Study" tab.
 *
 * Feeds:
 *   FEED=espn (default) ESPN's live play-by-play. Works from cloud servers (GitHub Actions).
 *   FEED=nba            NBA's official CDN play-by-play. Usually faster, but blocks cloud
 *                       servers, so run it from a home connection.
 * Env: POLL_MS (default 1000), MAX_MINUTES (default 340), OUT_DIR (default site/latency).
 * This only reads public data. It never places orders.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";

const FEED = process.env.FEED || "espn";
const POLL_MS = +(process.env.POLL_MS || 1000);
const MAX_MINUTES = +(process.env.MAX_MINUTES || 340);
const OUT_DIR = process.env.OUT_DIR || "site/latency";
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const NBA_CDN = "https://cdn.nba.com/static/json/liveData";

// Kalshi series → stat tracked from the play-by-play
export const PROP_SERIES = { KXNBAPTS: "pts", KXNBAREB: "reb", KXNBAAST: "ast", KXNBA3PT: "fg3" };
const GAME_SERIES = "KXNBAGAME";
const REACT_BID = 0.90;            // "Kalshi has adjusted" = best YES bid ≥ 90¢ on a market that just settled YES
const fee = p => Math.ceil(0.07 * p * (1 - p) * 100) / 100;

// ESPN team abbreviations → NBA tricodes (used in Kalshi event tickers)
const TRI = { GS: "GSW", NO: "NOP", NY: "NYK", SA: "SAS", UTAH: "UTA", WSH: "WAS" };
export const tricode = a => TRI[a] || a;
export const normName = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "").replace(/[^a-z]/g, "");
/** Kalshi event suffix for a game, e.g. 26NOV10BOSPHI (date is the US-Eastern game date). */
export function eventSuffix(startIso, awayAbbr, homeAbbr) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "2-digit", month: "short", day: "2-digit" }).formatToParts(new Date(startIso)).map(x => [x.type, x.value]));
  return `${p.year}${p.month.toUpperCase()}${p.day}${tricode(awayAbbr)}${tricode(homeAbbr)}`;
}

// ---------------------------------------------------------------- http
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "proplab-latency-study/1.0", "Cache-Control": "no-cache" } });
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
export function median(a) { const s = a.filter(x => x != null && Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// ---------------------------------------------------------------- recorder
class Recorder {
  constructor() {
    this.games = new Map();       // espnId → game
    this.timelines = new Map();   // kalshi ticker → [{t, bid, ask, askSize}]
    this.markets = new Map();     // ticker → { series, stat, name, line, event }
    this.crossings = [];          // raw crossings (measured at the end)
    this.scoring = [];            // { gameId, playT, seenT }
    this.feedDelays = [];         // every play's feed delay (s)
    this.started = Date.now();
  }

  async refreshGames() {
    const days = [0, -1].map(o => { const d = new Date(Date.now() + o * 86400e3); return d.toISOString().slice(0, 10).replace(/-/g, ""); });
    for (const day of days) {
      const sb = await getJSON(`${ESPN}/scoreboard?dates=${day}`);
      for (const e of sb?.events || []) {
        const c = e.competitions?.[0]; if (!c) continue;
        const home = c.competitors.find(x => x.homeAway === "home")?.team, away = c.competitors.find(x => x.homeAway === "away")?.team;
        const state = e.status?.type?.state;
        const g = this.games.get(e.id) || { id: e.id, name: e.shortName, start: e.date, home: home.abbreviation, away: away.abbreviation,
          suffix: eventSuffix(e.date, away.abbreviation, home.abbreviation), seen: new Set(), totals: {}, names: {}, nbaId: null };
        g.state = state; this.games.set(e.id, g);
      }
    }
    if (FEED === "nba") {
      const sb = await getJSON(`${NBA_CDN}/scoreboard/todaysScoreboard_00.json`);
      for (const ng of sb?.scoreboard?.games || []) for (const g of this.games.values())
        if (tricode(g.home) === ng.homeTeam.teamTricode && tricode(g.away) === ng.awayTeam.teamTricode) g.nbaId = ng.gameId;
    }
  }

  live() { return [...this.games.values()].filter(g => g.state === "in"); }
  pending() { return [...this.games.values()].filter(g => g.state === "pre" && new Date(g.start) - Date.now() < 4 * 3600e3); }

  async pollKalshi() {
    const now = Date.now(), prevPoll = this.lastKalshiPoll || now - POLL_MS;
    const series = [...Object.keys(PROP_SERIES), GAME_SERIES];
    const suffixes = new Set(this.live().map(g => g.suffix));
    if (!suffixes.size) return;
    for (const s of series) {
      let cursor = "", complete = false; const seenTickers = new Set();
      for (let page = 0; page < 5; page++) {
        const r = await getJSON(`${KALSHI}/markets?series_ticker=${s}&status=open&limit=200${cursor ? `&cursor=${cursor}` : ""}`);
        if (!r) break;
        for (const m of r.markets || []) {
          const suffix = m.event_ticker.split("-")[1]; if (!suffixes.has(suffix)) continue;
          seenTickers.add(m.ticker);
          if (!this.markets.has(m.ticker)) this.markets.set(m.ticker, {
            series: s, stat: PROP_SERIES[s] || null, event: m.event_ticker, suffix,
            name: s === GAME_SERIES ? m.yes_sub_title : String(m.title).split(":")[0].trim(), line: m.floor_strike,
          });
          const bid = m.yes_bid_dollars != null ? +m.yes_bid_dollars : null, ask = m.yes_ask_dollars != null ? +m.yes_ask_dollars : null;
          const tl = this.timelines.get(m.ticker) || []; const last = tl[tl.length - 1];
          if (!last || last.bid !== bid || last.ask !== ask) {
            // The change happened after our previous poll and before this one. Kalshi's own
            // updated_time narrows it down, but only trust it inside that window.
            const kt = m.updated_time ? Date.parse(m.updated_time) : NaN;
            const t = last && Number.isFinite(kt) && kt > prevPoll && kt <= now ? kt : now;
            tl.push({ t, polled: now, bid, ask, askSize: m.yes_ask_size_fp != null ? +m.yes_ask_size_fp : null });
            this.timelines.set(m.ticker, tl);
          }
        }
        cursor = r.cursor; if (!cursor) { complete = true; break; }
      }
      // A tracked market that left the open list was closed by Kalshi (e.g. the prop was decided):
      // count that as Kalshi having adjusted. Only trusted after a complete listing.
      if (complete) for (const [ticker, m] of this.markets) {
        if (m.series !== s || !suffixes.has(m.suffix) || seenTickers.has(ticker)) continue;
        const tl = this.timelines.get(ticker) || []; const last = tl[tl.length - 1];
        if (last && !last.closed) tl.push({ t: now, polled: now, bid: 1, ask: 1, closed: true });
      }
    }
    this.lastKalshiPoll = now;
  }

  async pollFeed(g) {
    const now = Date.now();
    if (FEED === "nba" && g.nbaId) {
      const pbp = await getJSON(`${NBA_CDN}/playbyplay/playbyplay_${g.nbaId}.json`);
      const box = Object.keys(g.names).length ? null : await getJSON(`${NBA_CDN}/boxscore/boxscore_${g.nbaId}.json`);
      for (const side of ["homeTeam", "awayTeam"]) for (const p of box?.game?.[side]?.players || []) g.names[String(p.personId)] = p.name;
      for (const a of pbp?.game?.actions || []) {
        const key = "n" + a.actionNumber; if (g.seen.has(key)) continue; g.seen.add(key);
        if (!g.primed) continue; // ignore the backlog present when we start
        const playT = Date.parse(a.timeActual); this.onPlay(g, playT, now, nbaIncrements(a), a.shotResult === "Made");
      }
    } else {
      const s = await getJSON(`${ESPN}/summary?event=${g.id}`);
      if (!s) return;
      for (const team of s.boxscore?.players || []) for (const a of team.statistics?.[0]?.athletes || []) g.names[a.athlete.id] = a.athlete.displayName;
      for (const p of s.plays || []) {
        if (g.seen.has(p.id)) continue; g.seen.add(p.id);
        if (!g.primed) { for (const i of espnIncrements(p)) this.add(g, i); continue; } // backlog: just build totals
        const playT = Date.parse(p.wallclock); this.onPlay(g, playT, now, espnIncrements(p), !!p.scoringPlay);
      }
    }
    if (!g.primed) {
      g.primed = true;
      // NBA feed backlog: seed totals from the box score instead
      if (FEED === "nba" && g.nbaId) {
        const box = await getJSON(`${NBA_CDN}/boxscore/boxscore_${g.nbaId}.json`);
        for (const side of ["homeTeam", "awayTeam"]) for (const p of box?.game?.[side]?.players || []) {
          const st = p.statistics || {}; const id = String(p.personId);
          g.totals[id] = { pts: st.points || 0, reb: st.reboundsTotal || 0, ast: st.assists || 0, fg3: st.threePointersMade || 0 };
        }
      }
    }
  }

  add(g, i) { const t = (g.totals[i.id] ||= { pts: 0, reb: 0, ast: 0, fg3: 0 }); const before = t[i.stat]; t[i.stat] += i.n; return [before, t[i.stat]]; }

  onPlay(g, playT, seenT, incs, scoring) {
    if (!Number.isFinite(playT)) return;
    this.feedDelays.push((seenT - playT) / 1000);
    if (scoring) this.scoring.push({ suffix: g.suffix, playT, seenT });
    for (const i of incs) {
      const [before, after] = this.add(g, i);
      const name = g.names[i.id]; if (!name) continue;
      // every Kalshi strike this play pushed the player over settles YES
      for (const [ticker, m] of this.markets) {
        if (m.suffix !== g.suffix || m.stat !== i.stat || normName(m.name) !== normName(name)) continue;
        if (before <= m.line && after > m.line) this.crossings.push({ ticker, game: g.name, player: name, stat: i.stat, line: m.line, playT, seenT });
      }
    }
  }

  results() {
    const crossings = this.crossings.map(c => measureCrossing(c, this.timelines.get(c.ticker) || []));
    const games = [...this.games.values()].filter(g => g.seen.size).map(g => ({ id: g.id, name: g.name, suffix: g.suffix }));
    const scoreReactions = this.scoring.map(s => {
      const tls = [...this.markets].filter(([, m]) => m.series === GAME_SERIES && m.suffix === s.suffix).map(([t]) => this.timelines.get(t) || []);
      return { ...s, kalshiDelay: measureScoreReaction(s.playT, tls), feedDelay: (s.seenT - s.playT) / 1000 };
    });
    const measured = crossings.filter(c => !c.alreadyPriced);
    const stale = measured.filter(c => c.feedFirst && c.staleEdge != null && c.staleEdge > 0);
    return {
      date: new Date(this.started).toISOString().slice(0, 10), started: new Date(this.started).toISOString(), ended: new Date().toISOString(),
      feed: FEED, pollMs: POLL_MS, games,
      summary: {
        plays: this.feedDelays.length, crossings: crossings.length, measured: measured.length,
        medianFeedDelay: median(this.feedDelays), medianKalshiDelay: median(measured.map(c => c.kalshiDelay)),
        feedFirstShare: measured.length ? measured.filter(c => c.feedFirst).length / measured.length : null,
        staleChances: stale.length, medianStaleEdge: median(stale.map(c => c.staleEdge)),
        scoringPlays: scoreReactions.length, medianGameLineDelay: median(scoreReactions.map(r => r.kalshiDelay)),
      },
      crossings: crossings.map(({ seenT, playT, ...c }) => ({ ...c, play: new Date(playT).toISOString() })),
      scoreReactions: scoreReactions.map(r => ({ play: new Date(r.playT).toISOString(), feedDelay: r.feedDelay, kalshiDelay: r.kalshiDelay })),
    };
  }
}

async function save(rec) {
  const res = rec.results();
  await mkdir(OUT_DIR, { recursive: true });
  const hhmm = res.started.slice(11, 16).replace(":", "");
  const file = `${res.date}-${hhmm}-${FEED}.json`;
  await writeFile(`${OUT_DIR}/${file}`, JSON.stringify(res));
  let index = []; try { index = JSON.parse(await readFile(`${OUT_DIR}/index.json`, "utf8")); } catch {}
  index = index.filter(x => x.file !== file).concat({ file, date: res.date, started: res.started, feed: res.feed, games: res.games.length, ...res.summary }).sort((a, b) => (b.started || b.date).localeCompare(a.started || a.date));
  await writeFile(`${OUT_DIR}/index.json`, JSON.stringify(index, null, 1));
  return res;
}

async function main() {
  const rec = new Recorder(); const deadline = Date.now() + MAX_MINUTES * 60e3;
  let lastGames = 0, lastSave = Date.now(), everLive = false;
  const stop = async () => {
    if ([...rec.games.values()].some(g => g.seen.size)) { const r = await save(rec); console.log("saved", JSON.stringify(r.summary)); }
    else console.log("Nothing recorded; no file written.");
    process.exit(0);
  };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  console.log(`Kalshi latency study: feed=${FEED}, poll=${POLL_MS}ms, max ${MAX_MINUTES} min`);
  while (Date.now() < deadline) {
    if (Date.now() - lastGames > 60e3) {
      await rec.refreshGames(); lastGames = Date.now();
      const live = rec.live(), pend = rec.pending();
      console.log(`${new Date().toISOString()} live: ${live.map(g => g.name).join(", ") || "none"} | upcoming: ${pend.length} | markets: ${rec.markets.size} | crossings: ${rec.crossings.length}`);
      if (live.length) everLive = true;
      if (!live.length && !pend.length) { if (everLive) break; console.log("No NBA games live or starting within 4 hours."); break; }
    }
    const t0 = Date.now();
    await Promise.all([rec.pollKalshi(), ...rec.live().map(g => rec.pollFeed(g))]);
    if (Date.now() - lastSave > 10 * 60e3) { await save(rec); lastSave = Date.now(); }
    await sleep(Math.max(0, POLL_MS - (Date.now() - t0)));
  }
  await stop();
}

if (import.meta.url === `file://${process.argv[1]}`) main();
