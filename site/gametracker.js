/* Game tracker for the Kalshi Latency Study tab.
 * - Today's and tomorrow's NBA and NFL games (straight from ESPN, which allows browser requests).
 * - For a live game: the recorder's snapshot of every Kalshi market for that game, published to
 *   the repo's live-data branch every few minutes (Kalshi itself refuses browser requests).
 * - For a finished game: the same breakdown from the night's recording.
 */
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const sec = x => x == null ? "—" : `${Math.abs(x) < 10 ? x.toFixed(1) : Math.round(x)}s`;
  const cents = x => x == null ? "—" : Math.round(x * 100) + "¢";
  const chg = x => x == null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(Math.round(x * 100))}¢`;
  const num = x => x == null ? "—" : Math.round(x).toLocaleString();
  const LEAGUES = { nba: { name: "NBA", path: "basketball/nba" }, nfl: { name: "NFL", path: "football/nfl" } };
  const repo = (() => { const h = location.hostname; return h.endsWith(".github.io") ? { owner: h.split(".")[0], name: location.pathname.split("/")[1] || "sports" } : { owner: "Alex-Palmas", name: "sports" }; })();

  let schedule = null, scheduleOk = true, scheduleAt = 0, live = null, liveAt = 0, sel = null, view = { group: "all", sort: "move", all: false }, timer = null;

  async function getJSON(url, opts) { try { const r = await fetch(url, opts); return r.ok ? r.json() : null; } catch { return null; } }
  const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  async function loadSchedule() {
    if (schedule && Date.now() - scheduleAt < 60e3) return schedule;
    const days = [0, 1].map(o => { const d = new Date(); d.setDate(d.getDate() + o); return d; });
    const out = []; let failed = 0;
    await Promise.all(Object.entries(LEAGUES).flatMap(([lk, L]) => days.map(async (d, di) => {
      const sb = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/${L.path}/scoreboard?dates=${ymd(d)}`);
      if (!sb) failed++;
      for (const e of sb?.events || []) {
        const c = e.competitions?.[0]; const home = c?.competitors.find(x => x.homeAway === "home"), away = c?.competitors.find(x => x.homeAway === "away");
        if (!home || !away) continue;
        out.push({ key: `${lk}:${e.id}`, league: lk, day: di, start: e.date, name: e.shortName, state: e.status?.type?.state, detail: e.status?.type?.shortDetail,
          home: home.team.abbreviation, away: away.team.abbreviation, hs: home.score, as: away.score, broadcast: c.broadcasts?.[0]?.names?.[0] || "" });
      }
    })));
    out.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start) || a.league.localeCompare(b.league));
    schedule = out; scheduleOk = failed < 4; scheduleAt = Date.now();
    return out;
  }

  async function loadLive() {
    if (live !== null && Date.now() - liveAt < 90e3) return live;
    liveAt = Date.now();
    // the latest commit on live-data, then the file at that commit (avoids a stale cached copy)
    const c = await getJSON(`https://api.github.com/repos/${repo.owner}/${repo.name}/commits/live-data`, { headers: { Accept: "application/vnd.github+json" } });
    live = c?.sha ? await getJSON(`https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${c.sha}/live.json`) : null;
    return live;
  }

  // ---- charts
  function winChart(r) {
    const wp = r.winProb; if (!wp?.v?.some(v => v != null)) return `<div class="pl-sub">No moneyline prices recorded for this game.</div>`;
    const W = 760, H = 240, P = { l: 44, r: 14, t: 14, b: 30 };
    const t0 = Date.parse(wp.from), t1 = Date.parse(wp.to), n = wp.v.length;
    const X = t => P.l + (t - t0) / (t1 - t0) * (W - P.l - P.r), Y = v => P.t + (1 - v) * (H - P.t - P.b);
    let s = `<svg class="lat-chart wp" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(r.home)} win probability on Kalshi">`;
    for (const v of [0, 0.25, 0.5, 0.75, 1]) s += `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" class="${v === 0.5 ? "zero" : "grid"}"/><text x="${P.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v * 100}%</text>`;
    const hours = []; for (let t = Math.ceil(t0 / 1800e3) * 1800e3; t <= t1; t += 1800e3) hours.push(t);
    for (const t of hours) s += `<text x="${X(t)}" y="${H - 10}" text-anchor="middle">${new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</text>`;
    const pts = wp.v.map((v, i) => v == null ? null : [X(t0 + (t1 - t0) * i / (n - 1)), Y(v)]).filter(Boolean);
    s += `<polyline fill="none" stroke="var(--accent)" stroke-width="2.5" points="${pts.map(p => p.map(x => x.toFixed(1)).join(",")).join(" ")}"/>`;
    for (const k of r.keyPlays || []) {
      const t = Date.parse(k.t); if (t < t0 || t > t1) continue;
      const home = k.team === r.home, y = home ? P.t + 2 : H - P.b - 2;
      s += `<line x1="${X(t)}" x2="${X(t)}" y1="${y}" y2="${y + (home ? 7 : -7)}" stroke="${k.type === "Turnover" ? "var(--amber)" : home ? "var(--accent)" : "var(--blue)"}" stroke-width="${k.points >= 3 || k.type !== "Score" ? 2.5 : 1.2}"><title>${esc(k.team || "")} ${esc(k.type)} ${k.points ? "+" + k.points : ""} · ${esc(k.text || "")}</title></line>`;
    }
    return s + `</svg><div class="lat-legend pl-sub"><span><i style="background:var(--accent)"></i> ${esc(r.homeName || r.home)} win probability (Kalshi mid)</span><span><i class="tick-home"></i> ${esc(r.home)} scores (top)</span><span><i class="tick-away"></i> ${esc(r.away)} scores (bottom)</span>${r.league === "nfl" ? `<span><i class="tick-to"></i> turnovers</span>` : ""}</div>`;
  }
  function spark(sp) {
    if (!sp?.v) return "";
    const v = sp.v, ok = v.filter(x => x != null); if (ok.length < 2) return "";
    const lo = Math.min(...ok), hi = Math.max(...ok), span = Math.max(hi - lo, 0.02), W = 100, H = 24;
    const pts = v.map((x, i) => x == null ? null : `${(2 + i / (v.length - 1) * (W - 4)).toFixed(1)},${(H - 3 - (x - lo) / span * (H - 6)).toFixed(1)}`).filter(Boolean);
    const up = ok[ok.length - 1] >= ok[0];
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline fill="none" stroke="${up ? "var(--hit)" : "var(--miss)"}" stroke-width="1.6" points="${pts.join(" ")}"/></svg>`;
  }

  // ---- views
  function scheduleCard(games, rec) {
    const recKeys = new Set((rec?.gameReports || []).map(g => `${g.league}:${g.id}`));
    const liveKeys = new Set((live?.games || []).map(g => `${g.league}:${g.id}`));
    const day = d => games.filter(g => g.day === d);
    const chip = g => {
      const status = g.state === "in" ? `<span class="live-dot"></span>${esc(g.detail)} · ${esc(g.as)}–${esc(g.hs)}` : g.state === "post" ? `${esc(g.detail)} · ${esc(g.as)}–${esc(g.hs)}` : new Date(g.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + (g.broadcast ? ` · ${esc(g.broadcast)}` : "");
      const badge = liveKeys.has(g.key) ? `<span class="tag won">tracking live</span>` : recKeys.has(g.key) ? `<span class="tag">recorded</span>` : g.state === "pre" ? `<span class="tag">will track</span>` : "";
      const clickable = liveKeys.has(g.key) || recKeys.has(g.key);
      return `<button class="gchip${sel === g.key ? " sel" : ""}${clickable ? "" : " dim"}" data-key="${esc(g.key)}" ${clickable ? "" : "disabled"}><span class="tag">${LEAGUES[g.league].name}</span> <b>${esc(g.name)}</b><span class="pl-sub">${status}</span>${badge}</button>`;
    };
    return `<div class="card"><h2>Today and tomorrow <span class="pl-sub">NBA & NFL · every game is tracked live on Kalshi</span></h2>
      ${[0, 1].map(d => `<h3 class="day-h">${d ? "Tomorrow" : "Today"}</h3><div class="gchips">${day(d).map(chip).join("") || `<span class="pl-sub">${scheduleOk ? "No NBA or NFL games." : "Couldn't load the schedule from ESPN. It will retry in a minute."}</span>`}</div>`).join("")}
      <div class="pl-sub" style="margin-top:8px">${live?.updated ? `Live snapshot updated ${Math.max(0, Math.round((Date.now() - Date.parse(live.updated)) / 60e3))} min ago (refreshes every few minutes while games are on).` : "Live snapshots appear here once the recorder is running during games."} Click a tracked game to compare all of its Kalshi markets.</div></div>`;
  }

  function gameCard(r, source) {
    const groups = ["all", ...new Set(r.markets.map(m => m.group))];
    let rows = r.markets.filter(m => view.group === "all" || m.group === view.group);
    const sorts = {
      move: (a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0),
      traded: (a, b) => (b.traded ?? 0) - (a.traded ?? 0),
      fast: (a, b) => (a.reactT50 ?? 1e9) - (b.reactT50 ?? 1e9),
      moves: (a, b) => b.moves - a.moves,
    };
    rows = rows.slice().sort(sorts[view.sort]);
    const shown = view.all ? rows : rows.slice(0, 60);
    const score = r.score ? `${esc(r.away)} ${r.score.away} – ${r.score.home} ${esc(r.home)}` : "";
    return `<div class="card game-detail">
      <div class="gd-head"><div><h2>${esc(LEAGUES[r.league]?.name || "")} · ${esc(r.awayName || r.away)} at ${esc(r.homeName || r.home)}</h2>
        <div class="pl-sub">${score}${r.detail ? ` · ${esc(r.detail)}` : ""} · ${r.markets.length} Kalshi markets · ${source === "live" ? `live snapshot` : "from the recording"}</div></div></div>
      <div class="table-wrap">${winChart(r)}</div>
      <h3 class="sub-h">Market types compared</h3>
      <div class="table-wrap"><table class="lat-table"><thead><tr><th>Market type</th><th class="num">Markets</th><th class="num">Moved</th><th class="num">Median change</th><th class="num">Contracts traded</th><th class="num">Starts moving</th><th class="num">50% repriced</th><th class="num">Refreshed every</th></tr></thead><tbody>
      ${(r.groupSummary || []).map(g => `<tr><td><b>${esc(g.group)}</b></td><td class="num">${g.markets}</td><td class="num">${g.moved}</td><td class="num">${g.medianAbsChange != null ? Math.round(g.medianAbsChange * 100) + "¢" : "—"}</td><td class="num">${num(g.traded)}</td><td class="num">${sec(g.medianReactStart)}</td><td class="num">${sec(g.medianReactT50)}</td><td class="num">${sec(g.samplingSec)}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="pl-sub">"Starts moving" and "50% repriced" are medians after key plays (${r.league === "nfl" ? "scores and turnovers" : "scores"}), each measured until the next key play. Slower-refreshed market types can't show reactions faster than their refresh interval.</div>
      ${playersSection(r)}
      <h3 class="sub-h">Every market</h3>
      <div class="gd-ctrls">
        <label>Type <select id="gdGroup">${groups.map(g => `<option value="${esc(g)}"${g === view.group ? " selected" : ""}>${g === "all" ? "All types" : esc(g)}</option>`).join("")}</select></label>
        <label>Sort <select id="gdSort">${[["move", "Biggest price change"], ["traded", "Most traded"], ["fast", "Fastest to reprice"], ["moves", "Most price moves"]].map(([v, l]) => `<option value="${v}"${v === view.sort ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <div class="table-wrap"><table class="lat-table"><thead><tr><th>Market</th><th>Type</th><th>Path</th><th class="num">Pre-game → ${r.state === "post" ? "final" : "now"}</th><th class="num">Change</th><th class="num">Low–high</th><th class="num">Traded</th><th class="num">Moves</th><th class="num">Starts</th><th class="num">50%</th></tr></thead><tbody>
      ${shown.map(m => `<tr><td>${esc(m.label)}${m.closed ? ` <span class="tag">closed</span>` : ""}</td><td class="pl-sub">${esc(m.group)}</td><td>${spark(m.spark)}</td><td class="num">${cents(m.pre)} → ${cents(m.end)}</td><td class="num" style="color:${(m.change ?? 0) > 0 ? "var(--hit)" : (m.change ?? 0) < 0 ? "var(--miss)" : "var(--muted)"}">${chg(m.change)}</td><td class="num">${cents(m.low)}–${cents(m.high)}</td><td class="num">${num(m.traded)}</td><td class="num">${m.moves}</td><td class="num">${sec(m.reactStart)}</td><td class="num">${sec(m.reactT50)}</td></tr>`).join("")}
      </tbody></table></div>
      ${rows.length > 60 ? `<button class="chip" id="gdAll" style="margin-top:8px">${view.all ? "Show top 60" : `Show all ${rows.length}`}</button>` : ""}
    </div>`;
  }

  const STAT = { pts: "pts", reb: "reb", ast: "ast", fg3: "3PM", pass_yds: "pass yds", rush_yds: "rush yds", rec_yds: "rec yds", rec: "rec", td: "TD" };
  function playersSection(r) {
    const ps = r.players || []; if (!ps.length) return "";
    const shown = view.allPlayers ? ps : ps.slice(0, 12);
    const line = l => `<span class="ladder${l.settled ? " hit" : l.closed ? " closed" : ""}" title="${esc(l.label)}: ${cents(l.pre)} → ${cents(l.end)}${l.traded ? `, ${num(l.traded)} traded` : ""}">${esc(l.label.replace(/^(\d+\+)\s*/, "$1 "))} <b>${l.settled ? "✓" : cents(l.end)}</b>${!l.settled && l.change ? ` <i style="color:${l.change > 0 ? "var(--hit)" : "var(--miss)"}">${chg(l.change)}</i>` : ""}</span>`;
    return `<h3 class="sub-h">Players <span class="pl-sub">${ps.length} with Kalshi lines · ✓ = line already reached · price now, change since tip-off</span></h3>
      <div class="players">${shown.map(p => `<div class="player-row"><div class="pr-head"><b>${esc(p.player)}</b><span class="pl-sub">${p.stats ? Object.entries(p.stats).filter(([, v]) => v).map(([k, v]) => `${v} ${STAT[k] || k}`).join(" · ") || "no stats yet" : ""}${p.events ? ` · ${p.events} events` : ""} · ${num(p.traded)} traded</span></div>
        <div class="ladders">${p.lines.map(line).join("")}</div></div>`).join("")}</div>
      ${ps.length > 12 ? `<button class="chip" id="gdPlayers" style="margin-top:8px">${view.allPlayers ? "Show fewer players" : `Show all ${ps.length} players`}</button>` : ""}`;
  }

  async function render(el, rec) {
    const box = el.querySelector("#latGames");
    const [games] = await Promise.all([loadSchedule(), loadLive()]);
    const reports = new Map();
    for (const g of rec?.gameReports || []) reports.set(`${g.league}:${g.id}`, { r: g, source: "rec" });
    for (const g of live?.games || []) reports.set(`${g.league}:${g.id}`, { r: g, source: "live" }); // live wins
    if (!sel || !reports.has(sel)) sel = (live?.games?.[0] && `${live.games[0].league}:${live.games[0].id}`) || [...reports.keys()][0] || null;
    const cur = sel && reports.get(sel);
    box.innerHTML = scheduleCard(games, rec) + (cur ? gameCard(cur.r, cur.source) : "");
    box.querySelectorAll(".gchip:not([disabled])").forEach(b => b.onclick = () => { sel = b.dataset.key; view.all = false; render(el, rec); });
    const q = id => box.querySelector(id);
    if (q("#gdGroup")) q("#gdGroup").onchange = e => { view.group = e.target.value; render(el, rec); };
    if (q("#gdSort")) q("#gdSort").onchange = e => { view.sort = e.target.value; render(el, rec); };
    if (q("#gdAll")) q("#gdAll").onclick = () => { view.all = !view.all; render(el, rec); };
    if (q("#gdPlayers")) q("#gdPlayers").onclick = () => { view.allPlayers = !view.allPlayers; render(el, rec); };
    // keep scores and live snapshots fresh while this tab is open and something is live
    clearTimeout(timer);
    if (games.some(g => g.state === "in") || !scheduleOk) timer = setTimeout(() => { if (!el.hidden) render(el, rec); }, 60e3);
  }
  window.PropGames = { render, getLive: loadLive };
})();
