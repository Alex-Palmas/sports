/* Kalshi Latency Study tab: reads latency/index.json and the per-night recordings
 * written by scripts/kalshi-latency.mjs and explains whether a free feed beats Kalshi. */
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const sec = x => x == null ? "—" : `${x < 0 ? "−" : ""}${Math.abs(x).toFixed(1)}s`;
  const pct = x => x == null ? "—" : Math.round(x * 100) + "%";
  const cents = x => x == null ? "—" : Math.round(x * 100) + "¢";
  const statName = { pts: "pts", reb: "reb", ast: "ast", fg3: "3PM" };
  const feedName = f => f === "nba" ? "NBA official feed" : "ESPN feed";
  let index = null, current = null, loadedFile = null;

  async function getJSON(url) { try { const r = await fetch(url, { cache: "no-cache" }); return r.ok ? r.json() : null; } catch { return null; } }

  function verdict(s, feed) {
    if (!s.measured) return `No settled prop markets were measured in this session yet.`;
    const f = s.medianFeedDelay, k = s.medianKalshiDelay;
    if (k == null || f == null) return "Not enough data for a verdict.";
    if (k <= f) return `Kalshi adjusted <b>${sec(f - k)} faster</b> than the ${esc(feedName(feed))} delivered the play (median). With this feed you'd be reacting to news Kalshi has already priced in. The ${pct(s.feedFirstShare)} of cases where the feed was first are the ones worth studying.`;
    return `The ${esc(feedName(feed))} delivered plays <b>${sec(k - f)} before</b> Kalshi adjusted (median), and Kalshi still offered a stale price ${s.staleChances} time${s.staleChances === 1 ? "" : "s"} (median ${cents(s.medianStaleEdge)} profit per contract after fees). Check the order sizes before trusting this: a few contracts at a stale price is not a strategy.`;
  }

  function chart(rows) {
    const r = rows.filter(c => !c.alreadyPriced && c.feedDelay != null).slice(0, 60);
    if (!r.length) return "";
    const max = Math.max(10, ...r.map(c => Math.max(c.feedDelay, c.kalshiDelay ?? 0)));
    const W = 760, rowH = 16, P = { l: 150, r: 20, t: 26, b: 28 }, H = P.t + P.b + r.length * rowH;
    const x = v => P.l + (Math.max(-5, Math.min(max, v)) + 5) / (max + 5) * (W - P.l - P.r);
    let s = `<svg class="lat-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Seconds after each play until the feed delivered it and until Kalshi adjusted">`;
    const step = max > 60 ? 15 : max > 30 ? 10 : 5;
    for (let v = 0; v <= max; v += step) s += `<line x1="${x(v)}" x2="${x(v)}" y1="${P.t - 6}" y2="${H - P.b}" class="grid"/><text x="${x(v)}" y="${H - P.b + 16}" text-anchor="middle">${v}s</text>`;
    s += `<line x1="${x(0)}" x2="${x(0)}" y1="${P.t - 6}" y2="${H - P.b}" class="zero"/><text x="${x(0)}" y="${P.t - 10}" text-anchor="middle" class="axis-lab">play happens</text>`;
    r.forEach((c, i) => {
      const y = P.t + i * rowH + rowH / 2;
      s += `<text x="${P.l - 8}" y="${y + 4}" text-anchor="end" class="row-lab">${esc(c.player.split(" ").slice(-1)[0])} ${esc(Math.ceil(c.line))}+ ${esc(statName[c.stat] || c.stat)}</text>`;
      if (c.kalshiDelay != null) s += `<line x1="${x(c.feedDelay)}" x2="${x(c.kalshiDelay)}" y1="${y}" y2="${y}" class="link ${c.feedFirst ? "won" : "lost"}"/>`;
      s += `<circle cx="${x(c.feedDelay)}" cy="${y}" r="4.5" class="dot-feed"><title>Feed: ${sec(c.feedDelay)}</title></circle>`;
      if (c.kalshiDelay != null) s += `<rect x="${x(c.kalshiDelay) - 4}" y="${y - 4}" width="8" height="8" class="dot-kalshi"><title>Kalshi: ${sec(c.kalshiDelay)}</title></rect>`;
    });
    return s + `</svg>`;
  }

  function renderSession(el, data) {
    const s = data.summary;
    const rows = data.crossings.slice().sort((a, b) => a.play.localeCompare(b.play));
    const measured = rows.filter(c => !c.alreadyPriced);
    el.querySelector("#latBody").innerHTML = `
      <div class="card lat-verdict">${verdict(s, data.feed)}</div>
      <div class="kpis">
        <div class="kpi"><div class="k">Feed delay</div><div class="v">${sec(s.medianFeedDelay)}</div><div class="s">median, ${s.plays} plays · ${esc(feedName(data.feed))}</div></div>
        <div class="kpi"><div class="k">Kalshi adjusts</div><div class="v">${sec(s.medianKalshiDelay)}</div><div class="s">median after a play settles a prop</div></div>
        <div class="kpi"><div class="k">Feed beat Kalshi</div><div class="v" style="color:${(s.feedFirstShare ?? 0) >= 0.5 ? "var(--hit)" : "var(--miss)"}">${pct(s.feedFirstShare)}</div><div class="s">of ${s.measured} settled props</div></div>
        <div class="kpi"><div class="k">Stale prices</div><div class="v">${s.staleChances}</div><div class="s">median ${cents(s.medianStaleEdge)}/contract after fees</div></div>
        <div class="kpi"><div class="k">Game line moves</div><div class="v">${sec(s.medianGameLineDelay)}</div><div class="s">median after ${s.scoringPlays} scoring plays</div></div>
      </div>
      ${measured.length ? `<div class="card"><h2>Seconds after each play</h2>
        <div class="lat-legend pl-sub"><span><i class="lg-feed"></i> feed delivered the play</span><span><i class="lg-kalshi"></i> Kalshi bid reached 90¢ or closed the market</span><span><i class="lg-won"></i> feed was first</span><span><i class="lg-lost"></i> Kalshi was first</span></div>
        <div class="table-wrap">${chart(measured)}</div>${measured.length > 60 ? `<div class="pl-sub">First 60 of ${measured.length} shown.</div>` : ""}</div>` : ""}
      <div class="card"><h2>Every settled prop</h2>
        ${rows.length ? `<div class="table-wrap"><table class="lat-table"><thead><tr><th>Play (local time)</th><th>Game</th><th>Market</th><th class="num">Feed</th><th class="num">Kalshi</th><th class="num">YES ask when feed showed it</th><th class="num">Profit/contract</th><th>First</th></tr></thead><tbody>
        ${rows.map(c => `<tr${c.alreadyPriced ? ` class="muted"` : ""}><td>${new Date(c.play).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</td><td>${esc(c.game)}</td><td><b>${esc(c.player)}</b> ${esc(Math.ceil(c.line))}+ ${esc(statName[c.stat] || c.stat)}</td>
          ${c.alreadyPriced ? `<td colspan="5" class="pl-sub">Already priced at 90¢+ before the play</td>` : `<td class="num">${sec(c.feedDelay)}</td><td class="num">${sec(c.kalshiDelay)}</td><td class="num">${cents(c.askAtSeen)}${c.askSizeAtSeen ? ` <span class="pl-sub">× ${Math.round(c.askSizeAtSeen)}</span>` : ""}</td><td class="num" style="color:${(c.staleEdge ?? 0) > 0 && c.feedFirst ? "var(--hit)" : "var(--muted)"}">${c.feedFirst && c.staleEdge != null ? cents(c.staleEdge) : "—"}</td><td>${c.feedFirst ? `<span class="tag won">feed</span>` : `<span class="tag lost">Kalshi</span>`}</td>`}</tr>`).join("")}
        </tbody></table></div>` : `<div class="pl-sub">No player crossed a Kalshi prop line during this session.</div>`}
      </div>`;
  }

  async function render(el) {
    if (!index) index = await getJSON("latency/index.json");
    const sessions = Array.isArray(index) ? index : [];
    el.querySelector("#latSession").innerHTML = sessions.map(s => `<option value="${esc(s.file)}">${esc(new Date(s.started || s.date).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))} · ${s.games} game${s.games === 1 ? "" : "s"} · ${esc(feedName(s.feed))}</option>`).join("");
    el.querySelector("#latPick").hidden = !sessions.length;
    if (!sessions.length) {
      el.querySelector("#latBody").innerHTML = `<div class="card lat-empty">
        <h2>No recordings yet</h2>
        <p>The recorder runs on GitHub every evening at about 6:50pm ET (and late morning on weekends) while NBA games are live. Each night's results appear here after the last game ends.</p>
        <p class="pl-sub">To run it yourself, or with the faster NBA feed from a home connection: <code>FEED=nba node scripts/kalshi-latency.mjs</code></p></div>`;
      return;
    }
    const file = el.querySelector("#latSession").value = loadedFile && sessions.some(s => s.file === loadedFile) ? loadedFile : sessions[0].file;
    if (loadedFile !== file || !current) { current = await getJSON("latency/" + file); loadedFile = file; }
    if (current) renderSession(el, current);
    else el.querySelector("#latBody").innerHTML = `<div class="card empty">Couldn't load this recording.</div>`;
  }

  function wire(el) {
    el.querySelector("#latSession").addEventListener("change", e => { loadedFile = e.target.value; current = null; render(el); });
  }
  window.PropLatency = { render, wire };
})();
