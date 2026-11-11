/* PropLab sportsbook odds from The Odds API, with each user's own key.
 *
 * The key is saved in this browser only (Settings → Sportsbook odds) and requests go straight from the
 * browser to api.the-odds-api.com (it allows web pages), so every person uses their own credits.
 * Results are cached in the browser and merged into the props as extra quotes (DraftKings, FanDuel,
 * BetMGM, Caesars, Hard Rock with the us2 region, ...). Listing events is free; each game's odds cost
 * (number of markets × number of regions) credits, capped per refresh by the user's setting. */
(function (root) {
  const NS = () => (root.PROPLAB_NS || "proplab:");
  const API = "https://api.the-odds-api.com/v4";
  // per league: The Odds API sport key, market → our stat, and which markets a refresh buys
  const SPORTS = {
    nba: { key: "basketball_nba", markets: { player_points: "pts", player_rebounds: "reb", player_assists: "ast", player_threes: "fg3", player_points_rebounds: "pr", player_points_assists: "pa", player_rebounds_assists: "ra", player_points_rebounds_assists: "pra", player_steals: "stl", player_blocks: "blk" },
      buy: ["player_points", "player_rebounds", "player_assists"] },
    nfl: { key: "americanfootball_nfl", markets: { player_pass_yds: "pass_yds", player_pass_tds: "pass_td", player_rush_yds: "rush_yds", player_reception_yds: "rec_yds", player_receptions: "rec", player_anytime_td: "td" },
      buy: ["player_pass_yds", "player_rush_yds", "player_reception_yds"] },
    nhl: { key: "icehockey_nhl", markets: { player_shots_on_goal: "sog", player_points: "pts", player_goals: "g", player_assists: "ast" },
      buy: ["player_shots_on_goal", "player_points"] },
    mlb: { key: "baseball_mlb", markets: { batter_hits: "hits", batter_total_bases: "tb", batter_rbis: "rbi", batter_runs_scored: "runs", batter_hits_runs_rbis: "hrr", batter_home_runs: "hr", batter_strikeouts: "so" },
      buy: ["batter_hits", "batter_total_bases"] },
  };
  const DEFAULTS = { key: "", regions: "us", maxCredits: 15, autoHours: 24 };
  const ls = { get(k, d) { try { const v = localStorage.getItem(NS() + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(NS() + k, JSON.stringify(v)); } catch {} } };
  const settings = () => ({ ...DEFAULTS, ...ls.get("odds", {}) });
  const saveSettings = s => ls.set("odds", { ...settings(), ...s });
  const cache = () => ls.get("oddsCache", null);

  const normName = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");

  /** One event's odds → quotes keyed "league|name|stat" (same rules as scripts/fetch-data.mjs). */
  function parseEvent(lg, ev, quotes) {
    const cfg = SPORTS[lg];
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
      const groups = {};
      for (const q of Object.values(byPlayerLine)) (groups[q.name] ||= []).push(q);
      for (const [name, qs] of Object.entries(groups)) {
        const juice = q => Math.abs((q.o ?? -110) - (q.u ?? -110)) + (q.o == null || q.u == null ? 50 : 0);
        qs.sort((a, b) => juice(a) - juice(b));   // a book's main line = closest to even money
        qs.forEach((q, i) => { delete q.name; if (i) q.alt = 1; (quotes[`${lg}|${normName(name)}|${stat}`] ||= []).push(q); });
      }
    }
  }

  async function get(url) {
    let r;
    try { r = await fetch(url); } catch { throw new Error("Couldn't reach The Odds API. Check your connection."); }
    const remaining = r.headers.get("x-requests-remaining"), used = r.headers.get("x-requests-used");
    const j = await r.json().catch(() => null);
    if (r.status === 401) throw new Error("The Odds API says this key isn't valid. Check it in Settings.");
    if (r.status === 429) throw new Error(j?.message?.includes("quota") ? "Your Odds API credits for this month are used up." : "The Odds API is rate limiting; try again in a minute.");
    if (!r.ok) throw new Error(`The Odds API ${r.status}: ${j?.message || r.statusText}`);
    return { json: j, remaining: remaining != null ? +remaining : null, used: used != null ? +used : null };
  }

  /** Free check of a key: lists sports (0 credits) and returns the credits left this month. */
  async function test(key) {
    const r = await get(`${API}/sports?apiKey=${encodeURIComponent(key)}`);
    return { remaining: r.remaining, used: r.used };
  }

  /**
   * Buy odds for the upcoming games in DATA, soonest first and round-robin across leagues, without
   * going past the per-refresh credit cap. Saves the result in the browser.
   */
  async function refresh(DATA) {
    const s = settings(); if (!s.key) throw new Error("Add your Odds API key in Settings first.");
    const regions = s.regions.split(",").map(x => x.trim()).filter(Boolean);
    const leagues = Object.keys(SPORTS).filter(lg => DATA?.sports?.[lg]?.players?.length);
    const now = Date.now(), soon = now + 36 * 3600e3;
    let remaining = null, used = null;
    const lists = await Promise.all(leagues.map(async lg => {
      const r = await get(`${API}/sports/${SPORTS[lg].key}/events?apiKey=${encodeURIComponent(s.key)}`);   // free
      remaining = r.remaining ?? remaining; used = r.used ?? used;
      return (r.json || []).filter(e => { const t = Date.parse(e.commence_time); return t > now && t < soon; }).map(e => ({ ...e, lg }));
    }));
    const bySport = lists.map(l => l.sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time)));
    const queue = []; for (let i = 0; bySport.some(a => a[i]); i++) for (const a of bySport) if (a[i]) queue.push(a[i]);
    const quotes = {}; let spent = 0, games = 0;
    for (const e of queue) {
      const cfg = SPORTS[e.lg], cost = cfg.buy.length * regions.length;
      if (spent + cost > s.maxCredits) break;
      const r = await get(`${API}/sports/${cfg.key}/events/${e.id}/odds?apiKey=${encodeURIComponent(s.key)}&regions=${regions.join(",")}&markets=${cfg.buy.join(",")}&oddsFormat=american`);
      spent += cost; games++; remaining = r.remaining ?? remaining; used = r.used ?? used;
      parseEvent(e.lg, r.json || {}, quotes);
    }
    const out = { at: new Date().toISOString(), quotes, spent, games, of: queue.length, remaining, used, regions: s.regions };
    ls.set("oddsCache", out);
    return out;
  }

  /**
   * Merge the cached book quotes into DATA's players (replacing earlier ones from this browser and
   * the same books' quotes from the site's own feed, which are older). Props that only had a projected
   * line get the books' consensus line.
   */
  function apply(DATA) {
    const c = cache(); if (!c?.quotes || !DATA?.sports) return 0;
    let n = 0;
    for (const [lg, sp] of Object.entries(DATA.sports)) for (const p of sp.players || []) {
      const gameT = Date.parse(p.gameDate || "") || 0;
      for (const stat of Object.keys(SPORTS[lg]?.markets ? Object.fromEntries(Object.values(SPORTS[lg].markets).map(s => [s, 1])) : {})) {
        const mine = (c.quotes[`${lg}|${normName(p.name)}|${stat}`] || []).filter(q => !q.t || !gameT || Math.abs(Date.parse(q.t) - gameT) < 16 * 3600e3);
        const cur = (p.market?.[stat] || []).filter(q => !q.user);
        if (!mine.length) { if (p.market?.[stat]?.length !== cur.length) p.market[stat] = cur; continue; }
        const books = new Set(mine.map(q => q.k));
        (p.market ||= {})[stat] = [...cur.filter(q => q.k === "kalshi" || !books.has(q.k)), ...mine.map(({ t, ...q }) => ({ ...q, user: 1 }))];
        n++;
        // the prop's line came from a projection or Kalshi alone: use the books' consensus instead
        if (p.lines && p.lines[stat] != null && !cur.some(q => q.k !== "kalshi")) {
          const mains = mine.filter(q => !q.alt).map(q => q.l).sort((a, b) => a - b);
          if (mains.length) { p.lines[stat] = mains[Math.floor((mains.length - 1) / 2)]; (p.lineSource ||= {})[stat] = "book"; }
        }
      }
    }
    return n;
  }

  /** Refresh automatically when the cache is older than the user's "every N hours" (0 = manual only). */
  function due() { const s = settings(), c = cache(); return !!s.key && s.autoHours > 0 && (!c?.at || Date.now() - Date.parse(c.at) > s.autoHours * 3600e3); }

  const api = { SPORTS, settings, saveSettings, cache, test, refresh, apply, due, parseEvent, normName, forget: () => { ls.set("odds", { ...settings(), key: "" }); ls.set("oddsCache", null); } };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PropOdds = api;
})(typeof window !== "undefined" ? window : globalThis);
