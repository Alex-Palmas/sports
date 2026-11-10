/* Demo data generator. Everything here is fictional and deterministic (seeded).
 * To use real data, replace window.PROPLAB_DATA with the same shape:
 * { sports: { [key]: { name, teams:[{abbr,name,color}], stats:[{key,label}], players:[...] } } }
 * player: { id, name, team, pos, opp, home, gameTime, lines:{stat:number}, odds:{stat:{over,under}},
 *           logs:[{date, opp, home, min, stats:{stat:number}}] (most recent first), oppRank:{stat:1..N} } */
(function () {
  let seed = 20261110;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const poisson = l => { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
  const halfLine = x => Math.max(0.5, Math.round(x - 0.5) + 0.5);

  const FIRST = ["Marcus","Jalen","Tyrese","Devin","Andre","Caleb","Luka","Nico","Rafael","Owen","Theo","Isaiah","Malik","Elijah","Jordan","Cameron","Dante","Xavier","Mateo","Kai","Bryce","Zion","Trey","Cole","Silas","Rowan","Emil","Jasper","Quinn","Reggie","Darius","Felix"];
  const LAST = ["Holloway","Brennan","Okafor","Castillo","Whitmore","Adeyemi","Sorensen","Vance","Delacroix","Mbeki","Hartley","Romero","Kowalski","Fairbanks","Ashford","Nakamura","Pruitt","Calloway","Ferreira","Lindqvist","Boateng","Mercer","Talbot","Quintero","Ellison","Drummond","Petrov","Okoro","Wexler","Abernathy","Langford","Strickland"];
  const CITIES = [["AUS","Austin Comets","#f97316"],["BAL","Baltimore Harbor","#7c3aed"],["CLT","Charlotte Monarchs","#0ea5e9"],["DEN","Denver Summit","#eab308"],["HOU","Houston Flares","#ef4444"],["KCY","Kansas City Plains","#14b8a6"],["LVG","Las Vegas Aces High","#a855f7"],["MEM","Memphis Rhythm","#3b82f6"],["MIA","Miami Tides","#ec4899"],["MIN","Minnesota Frost","#22c55e"],["NSH","Nashville Strings","#f43f5e"],["OAK","Oakland Redwoods","#16a34a"],["PDX","Portland Pines","#84cc16"],["SAC","Sacramento Gold","#ca8a04"],["SEA","Seattle Squall","#06b6d4"],["STL","St. Louis Arch","#6366f1"]];

  const SPORTS = {
    nba: { name: "NBA", games: 30, pos: ["PG","SG","SF","PF","C"], minutes: [24, 38],
      stats: [["pts","Points",8,30,"g"],["reb","Rebounds",3,12,"g"],["ast","Assists",2,10,"g"],["fg3","3PT Made",0.8,4,"p"],["pra","Pts+Reb+Ast",null,null,"sum:pts,reb,ast"],["stl","Steals",0.6,1.8,"p"]] },
    nfl: { name: "NFL", games: 17, pos: ["QB","RB","WR","TE"], minutes: [40, 70],
      stats: [["pass_yds","Pass Yds",0,0,"g"],["rush_yds","Rush Yds",0,0,"g"],["rec_yds","Rec Yds",0,0,"g"],["rec","Receptions",0,0,"p"],["td","Anytime TD",0,0,"p"]] },
    mlb: { name: "MLB", games: 30, pos: ["1B","2B","SS","3B","LF","CF","RF","C","DH"], minutes: null,
      stats: [["hits","Hits",0.6,1.6,"p"],["tb","Total Bases",1,2.6,"p"],["rbi","RBIs",0.3,1.2,"p"],["runs","Runs",0.3,1.1,"p"],["hrr","Hits+Runs+RBIs",null,null,"sum:hits,runs,rbi"]] },
    nhl: { name: "NHL", games: 30, pos: ["C","LW","RW","D"], minutes: [14, 24],
      stats: [["sog","Shots on Goal",1.4,4.2,"p"],["pts","Points",0.3,1.3,"p"],["ast","Assists",0.2,0.9,"p"],["blk","Blocked Shots",0.3,2.2,"p"]] },
  };
  const NFL_PROFILE = {
    QB: { pass_yds: [190, 300], rush_yds: [5, 40], td: [0.3, 0.6] },
    RB: { rush_yds: [45, 100], rec_yds: [10, 40], rec: [1.5, 4.5], td: [0.4, 0.8] },
    WR: { rec_yds: [40, 100], rec: [3.5, 7.5], td: [0.3, 0.7] },
    TE: { rec_yds: [25, 65], rec: [2.5, 6], td: [0.2, 0.5] },
  };

  const today = new Date("2026-11-10T00:00:00");
  const fmtDate = d => d.toISOString().slice(0, 10);
  const out = { generated: fmtDate(today), sports: {} };
  let pid = 0;

  for (const [key, cfg] of Object.entries(SPORTS)) {
    const teams = CITIES.map(([abbr, name, color]) => ({ abbr, name, color }));
    const stats = cfg.stats.map(([k, label]) => ({ key: k, label }));
    // tonight's slate: pair teams
    const order = teams.map(t => t.abbr).sort(() => rnd() - 0.5);
    const slate = {};
    for (let i = 0; i < order.length; i += 2) {
      const time = pick(["7:00 PM","7:30 PM","8:00 PM","9:00 PM","10:00 PM","10:30 PM"]);
      slate[order[i]] = { opp: order[i + 1], home: true, time };
      slate[order[i + 1]] = { opp: order[i], home: false, time };
    }
    const oppRanks = {};
    teams.forEach(t => { oppRanks[t.abbr] = {}; });
    stats.forEach(s => {
      const shuffled = teams.map(t => t.abbr).sort(() => rnd() - 0.5);
      shuffled.forEach((abbr, i) => { oppRanks[abbr][s.key] = i + 1; });
    });

    const players = [];
    const perTeam = key === "nfl" ? 2 : 3;
    const used = new Set();
    for (const t of teams) {
      for (let j = 0; j < perTeam; j++) {
        let name; do { name = pick(FIRST) + " " + pick(LAST); } while (used.has(name)); used.add(name);
        const pos = key === "nfl" ? ["QB","RB","WR","TE"][(teams.indexOf(t) + j * 2) % 4] : pick(cfg.pos);
        const means = {}, dist = {};
        cfg.stats.forEach(([k, , lo, hi, type]) => {
          if (type.startsWith("sum")) return;
          if (key === "nfl") { const r = NFL_PROFILE[pos][k]; if (!r) return; means[k] = r[0] + rnd() * (r[1] - r[0]); }
          else means[k] = lo + rnd() * (hi - lo);
          dist[k] = type;
        });
        const trend = (rnd() - 0.5) * 0.4; // recent form shift
        const logs = [];
        const n = cfg.games;
        const step = key === "nfl" ? 7 : key === "mlb" ? 1 : 2;
        for (let g = 0; g < n; g++) {
          const d = new Date(today); d.setDate(d.getDate() - (g + 1) * step);
          const opp = pick(teams.filter(x => x.abbr !== t.abbr)).abbr;
          const formMul = 1 + trend * Math.max(0, 1 - g / 10);
          const st = {};
          for (const [k, m] of Object.entries(means)) {
            const oppAdj = 1 + (oppRanks[opp][k] - 8.5) / 40;
            const mu = Math.max(0.05, m * formMul * oppAdj);
            st[k] = dist[k] === "p" ? poisson(mu) : Math.max(0, Math.round(mu + gauss() * mu * 0.28));
          }
          cfg.stats.forEach(([k, , , , type]) => {
            if (type.startsWith("sum")) st[k] = type.slice(4).split(",").reduce((a, s) => a + (st[s] || 0), 0);
          });
          logs.push({ date: fmtDate(d), opp, home: rnd() > 0.5, min: cfg.minutes ? Math.round(cfg.minutes[0] + rnd() * (cfg.minutes[1] - cfg.minutes[0])) : null, stats: st });
        }
        const lines = {}, odds = {};
        cfg.stats.forEach(([k, , , , type]) => {
          if (logs[0].stats[k] === undefined) return;
          const season = logs.reduce((a, l) => a + l.stats[k], 0) / logs.length;
          lines[k] = k === "td" ? 0.5 : halfLine(season * (0.92 + rnd() * 0.16));
          const o = -110 + Math.round((rnd() - 0.5) * 50 / 5) * 5;
          odds[k] = { over: o, under: -220 - o };
        });
        // demo line-shopping quotes from a few books (fictional prices)
        const market = {};
        for (const [k, L] of Object.entries(lines)) {
          market[k] = ["DraftKings", "FanDuel", "BetMGM", "Caesars", "Kalshi"].filter(() => rnd() > 0.25).map(b => {
            const l = L + (rnd() < 0.25 ? (rnd() < 0.5 ? -1 : 1) : 0), o = -110 + Math.round((rnd() - 0.5) * 40 / 5) * 5;
            return { b, k: b.toLowerCase(), l: Math.max(0.5, l), o, u: -220 - o + Math.round((rnd() - 0.5) * 10) };
          });
        }
        const g = slate[t.abbr];
        players.push({ id: key + "-" + (++pid), name, team: t.abbr, pos, opp: g.opp, home: g.home, gameTime: g.time, lines, odds, market, logs, oppRank: oppRanks[g.opp] });
      }
    }
    out.sports[key] = { name: cfg.name, teams, stats, players, teamCount: teams.length };
  }
  window.PROPLAB_DATA = out;
})();
