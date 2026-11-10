/* Kalshi Latency Study tab: reads latency/index.json and the per-night recordings
 * written by scripts/kalshi-latency.mjs. Shows when Kalshi starts repricing after a play,
 * how far the probability moves, and how long the move takes to play out. */
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const sec = x => x == null ? "—" : `${x < 0 ? "−" : ""}${Math.abs(x) < 10 ? Math.abs(x).toFixed(1) : Math.round(Math.abs(x))}s`;
  const pct = x => x == null ? "—" : Math.round(x * 100) + "%";
  const cents = x => x == null ? "—" : Math.round(x * 100) + "¢";
  const pts = x => x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 1000) / 10)} pts`; // probability points
  const num = x => x == null ? "—" : Math.round(x).toLocaleString();
  const statName = { pts: "pts", reb: "reb", ast: "ast", fg3: "3PM" };
  const feedName = f => f === "nba" ? "NBA official feed" : "ESPN feed";
  const clock = s => s == null ? "" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  let index = null, current = null, loadedFile = null;

  async function getJSON(url) { try { const r = await fetch(url, { cache: "no-cache" }); return r.ok ? r.json() : null; } catch { return null; } }

  function verdict(s, feed) {
    if (!s.measured && !s.gameMoved) return `Nothing measurable was recorded in this session yet.`;
    const parts = [];
    const f = s.medianFeedDelay, k = s.medianKalshiDelay;
    if (s.measured && f != null && k != null) {
      parts.push(k <= f
        ? `On settled props, Kalshi's bid reached 90¢ <b>${sec(f - k)} before</b> the ${esc(feedName(feed))} delivered the play (median).`
        : `On settled props, the ${esc(feedName(feed))} delivered the play <b>${sec(k - f)} before</b> Kalshi's bid reached 90¢ (median).`);
    }
    if (s.propLeftAtSeen != null) parts.push(`When the feed showed the play, <b>${pct(s.propLeftAtSeen)}</b> of the prop's price move was still to come.`);
    if (s.gameLeftAtSeen != null) parts.push(`On the game line, <b>${pct(s.gameLeftAtSeen)}</b> of the move was still to come, and it took a median <b>${sec(s.gameT90)}</b> to get 90% of the way.`);
    parts.push(`A large share still to come means the price drifts after the first jump, which is where a fast feed could matter. Check the order sizes before trusting it.`);
    return parts.join(" ");
  }

  // ---- charts
  const xs = o => Math.sqrt(o + 10);      // sqrt time scale: detail in the first seconds, still shows 2 minutes
  function curveChart(data, feedDelay) {
    const off = data.offsets || [], c = data.curves || {};
    const series = [["props", "Player props a play settled", "var(--accent)"], ["game", "Game line after a score", "var(--blue)"]].filter(([k]) => (c[k] || []).some(v => v != null));
    if (!series.length) return "";
    const W = 760, H = 300, P = { l: 48, r: 24, t: 18, b: 38 };
    const X = o => P.l + (xs(o) - xs(off[0])) / (xs(off[off.length - 1]) - xs(off[0])) * (W - P.l - P.r);
    const Y = v => P.t + (1 - Math.max(0, Math.min(1.1, v)) / 1.1) * (H - P.t - P.b);
    let s = `<svg class="lat-chart curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of Kalshi's price move completed, by seconds after the play">`;
    for (const v of [0, 0.25, 0.5, 0.75, 1]) s += `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${P.l - 8}" y="${Y(v) + 4}" text-anchor="end">${v * 100}%</text>`;
    for (const o of [-10, 0, 5, 10, 20, 30, 60, 90, 120]) s += `<line x1="${X(o)}" x2="${X(o)}" y1="${P.t}" y2="${H - P.b}" class="${o === 0 ? "zero" : "grid"}"/><text x="${X(o)}" y="${H - P.b + 16}" text-anchor="middle">${o === 0 ? "play" : o + "s"}</text>`;
    s += `<text x="${(P.l + W - P.r) / 2}" y="${H - 4}" text-anchor="middle" class="axis-lab">seconds after the play (square-root scale)</text>`;
    if (feedDelay != null && feedDelay >= 0 && feedDelay <= 120) s += `<line x1="${X(feedDelay)}" x2="${X(feedDelay)}" y1="${P.t}" y2="${H - P.b}" class="feedline"/><text x="${X(feedDelay) + 5}" y="${P.t + 12}" class="feedlab">feed delivers (${sec(feedDelay)})</text>`;
    let lastLabY = null;
    for (const [k, , color] of series) {
      const pts2 = off.map((o, i) => [o, c[k][i]]).filter(([, v]) => v != null);
      s += `<polyline fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" points="${pts2.map(([o, v]) => `${X(o).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}"/>`;
      for (const [o, v] of pts2) s += `<circle cx="${X(o)}" cy="${Y(v)}" r="3" fill="${color}"><title>${o}s: ${pct(v)} done</title></circle>`;
      const [lo, lv] = pts2[pts2.length - 1]; let ly = Y(lv) - 8;
      if (lastLabY != null && Math.abs(ly - lastLabY) < 14) ly = lastLabY + 16;  // keep end labels apart
      lastLabY = ly;
      s += `<text x="${X(lo) - 4}" y="${ly}" text-anchor="end" style="fill:${color};font-weight:700">${pct(lv)}</text>`;
    }
    s += `</svg><div class="lat-legend pl-sub">${series.map(([, label, color]) => `<span><i style="background:${color}"></i> ${label}</span>`).join("")}<span><i class="lg-feedline"></i> median feed delay</span></div>`;
    return s;
  }
  // tiny price path: probability at each offset, marked at the play and when the feed delivered it
  function spark(traj, offsets, feedDelay) {
    if (!traj?.path) return "";
    const W = 110, H = 26, pts2 = offsets.map((o, i) => [o, traj.path[i]]).filter(([, v]) => v != null);
    if (pts2.length < 2) return "";
    const lo = Math.min(...pts2.map(p => p[1])), hi = Math.max(...pts2.map(p => p[1])), span = Math.max(hi - lo, 0.02);
    const X = o => 2 + (xs(o) - xs(offsets[0])) / (xs(offsets[offsets.length - 1]) - xs(offsets[0])) * (W - 4);
    const Y = v => H - 3 - (v - lo) / span * (H - 6);
    const up = traj.move >= 0;
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-label="Price path ${cents(traj.pre)} to ${cents(traj.end)}">
      <line x1="${X(0)}" x2="${X(0)}" y1="0" y2="${H}" class="zero"/>${feedDelay != null && feedDelay <= 120 ? `<line x1="${X(feedDelay)}" x2="${X(feedDelay)}" y1="0" y2="${H}" class="feedline"/>` : ""}
      <polyline fill="none" stroke="${up ? "var(--hit)" : "var(--miss)"}" stroke-width="1.8" points="${pts2.map(([o, v]) => `${X(o).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}"/></svg>`;
  }

  const tile = (k, v, s, color) => `<div class="kpi"><div class="k">${k}</div><div class="v"${color ? ` style="color:${color}"` : ""}>${v}</div><div class="s">${s}</div></div>`;

  function renderSession(el, data) {
    const s = data.summary, off = data.offsets || [];
    const rows = data.crossings.slice().sort((a, b) => a.play.localeCompare(b.play));
    const measured = rows.filter(c => !c.alreadyPriced);
    const games = (data.scoreReactions || []).filter(r => r.traj && !r.traj.flat).sort((a, b) => Math.abs(b.traj.move) - Math.abs(a.traj.move));
    if (!s.measured && !s.gameMoved) {
      el.querySelector("#latBody").innerHTML = `<div class="card pl-sub">No player prop was settled by a play while it was being recorded in this session${data.leagues?.length ? ` (${esc(data.leagues.map(l => l.toUpperCase()).join(" + "))})` : ""}, so there's no prop-latency data. The game breakdowns above still have every market's movement.</div>`;
      return;
    }
    el.querySelector("#latBody").innerHTML = `
      <div class="card lat-verdict">${verdict(s, data.feed)}</div>

      <div class="card"><h2>How fast Kalshi prices in a play</h2>
        <p class="pl-sub lat-lede">Share of the total price move completed at each moment after the play (median across plays). A prop a play settled has to end at 100¢. The game line's end point is its price just before the next score, or 2 minutes later.</p>
        <div class="table-wrap">${curveChart(data, s.medianFeedDelay)}</div>
      </div>

      <div class="lat-groups">
        <section><h3>Player props a play settled <span class="pl-sub">${s.measured} plays</span></h3>
          <div class="kpis">
            ${tile("Moved", pts(s.propMove), "median, up to 100¢")}
            ${tile("Starts", sec(s.propStart), "first price change")}
            ${tile("50% done", sec(s.propT50), "median")}
            ${tile("90% done", sec(s.propT90), "median")}
            ${tile("Price steps", s.propSteps ?? "—", "separate changes in 2 min")}
            ${tile("Contracts traded", num(s.propTraded), "in the 2 min after")}
            ${tile("Left when feed showed it", pct(s.propLeftAtSeen), `feed delay ${sec(s.medianFeedDelay)}`, (s.propLeftAtSeen ?? 0) >= 0.3 ? "var(--hit)" : "var(--miss)")}
          </div></section>
        <section><h3>Game line after a score <span class="pl-sub">${s.gameMoved ?? 0} of ${s.scoringPlays} scores moved it ≥1 pt</span></h3>
          <div class="kpis">
            ${tile("Moved", pts(s.gameMove), "median size")}
            ${tile("Starts", sec(s.gameStart), "first price change")}
            ${tile("50% done", sec(s.gameT50), "median")}
            ${tile("90% done", sec(s.gameT90), "median")}
            ${tile("Price steps", s.gameSteps ?? "—", "until the next score")}
            ${tile("Contracts traded", num(s.gameTraded), "until the next score")}
            ${tile("Left when feed showed it", pct(s.gameLeftAtSeen), `feed delay ${sec(s.medianFeedDelay)}`, (s.gameLeftAtSeen ?? 0) >= 0.3 ? "var(--hit)" : "var(--miss)")}
          </div></section>
      </div>

      ${(data.gameBySituation || []).length ? `<div class="card"><h2>Game line: move size and speed by situation</h2>
        <div class="table-wrap"><table class="lat-table"><thead><tr><th>Situation</th><th>Score</th><th class="num">Plays</th><th class="num">Moved ≥1 pt</th><th class="num">Median move</th><th class="num">50% done</th><th class="num">90% done</th></tr></thead><tbody>
        ${data.gameBySituation.map(g => `<tr><td>${esc(g.situation)}</td><td>${g.points}-pointer${g.points === 1 ? " (free throw)" : ""}</td><td class="num">${g.plays}</td><td class="num">${g.moved}</td><td class="num">${pts(g.medianMove)}</td><td class="num">${sec(g.medianT50)}</td><td class="num">${sec(g.medianT90)}</td></tr>`).join("")}
        </tbody></table></div></div>` : ""}

      <div class="card"><h2>Every settled prop</h2>
        ${rows.length ? `<div class="table-wrap"><table class="lat-table"><thead><tr><th>Play</th><th>Market</th><th>Price path <span class="pl-sub">−10s → 2 min</span></th><th class="num">Before → after</th><th class="num">Feed</th><th class="num">Starts</th><th class="num">50%</th><th class="num">90%</th><th class="num">Left at feed</th><th class="num">Ask then</th><th class="num">Profit/contract</th><th>First</th></tr></thead><tbody>
        ${rows.map(c => { const t = c.traj || {}; return `<tr${c.alreadyPriced ? ` class="muted"` : ""}><td>${new Date(c.play).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</td><td><b>${esc(c.player)}</b> ${esc(Math.ceil(c.line))}+ ${esc(statName[c.stat] || c.stat)}<div class="pl-sub">${esc(c.game)}</div></td>
          ${c.alreadyPriced ? `<td colspan="10" class="pl-sub">Already priced at 90¢+ before the play</td>` : `<td>${spark(c.traj, off, c.feedDelay)}</td><td class="num">${cents(t.pre)} → ${cents(t.end)}</td><td class="num">${sec(c.feedDelay)}</td><td class="num">${sec(t.tStart)}</td><td class="num">${sec(t.t50)}</td><td class="num">${sec(t.t90)}</td><td class="num">${pct(t.leftAtSeen)}</td><td class="num">${cents(c.askAtSeen)}${c.askSizeAtSeen ? ` <span class="pl-sub">× ${Math.round(c.askSizeAtSeen)}</span>` : ""}</td><td class="num" style="color:${(c.staleEdge ?? 0) > 0 && c.feedFirst ? "var(--hit)" : "var(--muted)"}">${c.feedFirst && c.staleEdge != null ? cents(c.staleEdge) : "—"}</td><td>${c.feedFirst ? `<span class="tag won">feed</span>` : `<span class="tag lost">Kalshi</span>`}</td>`}</tr>`; }).join("")}
        </tbody></table></div>` : `<div class="pl-sub">No player crossed a Kalshi prop line during this session.</div>`}
      </div>

      ${games.length ? `<div class="card"><h2>Biggest game-line moves</h2>
        <div class="table-wrap"><table class="lat-table"><thead><tr><th>Play</th><th>Score</th><th>Price path <span class="pl-sub">until next score</span></th><th class="num">Before → after</th><th class="num">Feed</th><th class="num">Starts</th><th class="num">50%</th><th class="num">90%</th><th class="num">Steps</th><th class="num">Traded</th><th class="num">Left at feed</th></tr></thead><tbody>
        ${games.slice(0, 25).map(r => { const t = r.traj; return `<tr><td>${new Date(r.play).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}<div class="pl-sub">${esc(r.game)}</div></td><td><b>${esc(r.team)}</b> +${r.points} <div class="pl-sub">Q${r.period} ${clock(r.secsLeft)}${r.margin != null ? ` · margin ${r.margin}` : ""}${r.clutch ? ` · <span class="tag mid">clutch</span>` : ""}</div></td>
          <td>${spark(t, off, r.feedDelay)}</td><td class="num">${cents(t.pre)} → ${cents(t.end)}</td><td class="num">${sec(r.feedDelay)}</td><td class="num">${sec(t.tStart)}</td><td class="num">${sec(t.t50)}</td><td class="num">${sec(t.t90)}</td><td class="num">${t.steps ?? "—"}</td><td class="num">${num(t.traded)}</td><td class="num">${pct(t.leftAtSeen)}</td></tr>`; }).join("")}
        </tbody></table></div>${games.length > 25 ? `<div class="pl-sub">Top 25 of ${games.length} moves shown.</div>` : ""}</div>` : ""}`;
  }

  async function render(el) {
    if (!index) index = await getJSON("latency/index.json");
    const sessions = Array.isArray(index) ? index : [];
    el.querySelector("#latSession").innerHTML = sessions.map(s => `<option value="${esc(s.file)}">${esc(new Date(s.started || s.date).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))} · ${s.games} game${s.games === 1 ? "" : "s"}${s.leagues ? " · " + esc(s.leagues.map(l => l.toUpperCase()).join(" + ")) : ""} · ${esc(feedName(s.feed))}</option>`).join("");
    el.querySelector("#latPick").hidden = !sessions.length;
    if (!sessions.length) {
      window.PropGames.render(el, null);
      window.PropSimUI.render(el.querySelector("#latSim"), null, []);
      el.querySelector("#latBody").innerHTML = `<div class="card lat-empty">
        <h2>No recordings yet</h2>
        <p>The recorder runs on GitHub three times a day (about 11:45am, 5:15pm and 11pm ET) and follows every NBA and NFL game that's live or starting soon. Live games appear above within a few minutes; the full prop-latency analysis appears here after the games end.</p>
        <p class="pl-sub">To run it yourself, or with the faster NBA feed from a home connection: <code>FEED=nba node scripts/kalshi-latency.mjs</code></p></div>`;
      return;
    }
    const file = el.querySelector("#latSession").value = loadedFile && sessions.some(s => s.file === loadedFile) ? loadedFile : sessions[0].file;
    if (loadedFile !== file || !current) { current = await getJSON("latency/" + file); loadedFile = file; }
    window.PropGames.render(el, current);
    window.PropSimUI.render(el.querySelector("#latSim"), current, sessions);
    if (current) renderSession(el, current);
    else el.querySelector("#latBody").innerHTML = `<div class="card empty">Couldn't load this recording.</div>`;
  }

  function wire(el) {
    el.querySelector("#latSession").addEventListener("change", e => { loadedFile = e.target.value; current = null; render(el); });
  }
  window.PropLatency = { render, wire };
})();
