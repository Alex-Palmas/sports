/* Trading simulator panel for the Kalshi Latency Study tab (engine in simulator.js). */
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = x => x == null ? "—" : `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`;
  const pct = x => x == null ? "—" : `${(x * 100).toFixed(1)}%`;
  const cents = x => x == null ? "—" : Math.round(x * 100) + "¢";
  const STRATS = { settled: "Settled props: buy the line a play just settled, hold to $1", rung: "Player events: after any stat change, buy the player's next line up, sell after the hold", gameline: "Game line: after a score, buy the scoring team, sell after the hold" };
  const NAMES = { settled: "Settled props", rung: "Player events", gameline: "Game line" };
  let opts = { strategies: ["settled", "rung", "gameline"], league: "all", feed: "", orderDelay: 0.5, maxPrice: 90, contracts: 10, hold: 30, clutchOnly: false, scope: "session" };
  try { Object.assign(opts, JSON.parse(localStorage.getItem("proplab:sim") || "{}")); } catch {}
  const all = { loaded: false, recs: [] }; let showTrades = 25;

  async function getJSON(u) { try { const r = await fetch(u, { cache: "no-cache" }); return r.ok ? r.json() : null; } catch { return null; } }

  function curve(trades) {
    if (trades.length < 2) return "";
    const W = 760, H = 200, P = { l: 56, r: 14, t: 12, b: 24 };
    const ys = [0, ...trades.map(t => t.cum)], lo = Math.min(...ys), hi = Math.max(...ys), span = Math.max(hi - lo, 1);
    const X = i => P.l + i / trades.length * (W - P.l - P.r), Y = v => P.t + (hi - v) / span * (H - P.t - P.b);
    let s = `<svg class="lat-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative profit and loss by trade">`;
    for (const v of [lo, (lo + hi) / 2, hi]) s += `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${P.l - 6}" y="${Y(v) + 4}" text-anchor="end">${usd(v)}</text>`;
    if (lo < 0 && hi > 0) s += `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(0)}" y2="${Y(0)}" class="zero"/>`;
    s += `<text x="${(P.l + W - P.r) / 2}" y="${H - 6}" text-anchor="middle">trades in time order (${trades.length})</text>`;
    const end = trades[trades.length - 1].cum;
    s += `<polyline fill="none" stroke="${end >= 0 ? "var(--hit)" : "var(--miss)"}" stroke-width="2.2" points="${ys.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}"/>`;
    return s + "</svg>";
  }

  function table(rows, label) {
    return `<div class="table-wrap"><table class="lat-table"><thead><tr><th>${label}</th><th class="num">Trades</th><th class="num">Win rate</th><th class="num">Staked</th><th class="num">P&amp;L</th><th class="num">Return</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${esc(NAMES[r.key] || r.key)}</td><td class="num">${r.trades}</td><td class="num">${pct(r.wins / r.trades)}</td><td class="num">${usd(r.staked)}</td><td class="num" style="color:${r.pnl >= 0 ? "var(--hit)" : "var(--miss)"}">${usd(r.pnl)}</td><td class="num">${pct(r.staked ? r.pnl / r.staked : null)}</td></tr>`).join("")}
      </tbody></table></div>`;
  }

  async function render(box, current, sessions) {
    if (!box) return;
    if (opts.scope === "all" && !all.loaded) {
      box.innerHTML = `<div class="card pl-sub">Loading all recorded sessions…</div>`;
      all.recs = await Promise.all((sessions || []).slice(0, 40).map(s => getJSON("latency/" + s.file))); all.loaded = true;
    }
    const recs = opts.scope === "all" ? all.recs : [current];
    const has = recs.some(r => r && ((r.crossings || []).length || (r.playerEvents || []).length || (r.scoreReactions || []).length));
    const res = has ? window.PropSim.simulate(recs, { strategies: opts.strategies, league: opts.league, feedDelay: opts.feed === "" ? null : +opts.feed,
      orderDelay: +opts.orderDelay, maxPrice: +opts.maxPrice / 100, contracts: +opts.contracts, hold: +opts.hold, clutchOnly: opts.clutchOnly }) : null;
    const s = res?.summary;
    box.innerHTML = `<div class="card sim">
      <h2>Trading simulator <span class="pl-sub">paper trades replayed on the recorded Kalshi order book</span></h2>
      <p class="pl-sub sim-lede">You act when your feed delivers the play, plus your order delay, and fill at the recorded best price and size at that moment, after Kalshi fees. Queue position, your own effect on the price and stat corrections aren't modelled, so read the results as a best case.</p>
      <div class="sim-ctrls">
        <fieldset><legend>Strategies</legend>${Object.entries(STRATS).map(([k, l]) => `<label class="check"><input type="checkbox" data-strat="${k}" id="simS_${k}"${opts.strategies.includes(k) ? " checked" : ""}/> ${esc(l)}</label>`).join("")}</fieldset>
        <div class="sim-grid">
          <label>Data <select id="simScope"><option value="session"${opts.scope === "session" ? " selected" : ""}>Selected session</option><option value="all"${opts.scope === "all" ? " selected" : ""}>All sessions</option></select></label>
          <label>League <select id="simLeague">${[["all", "NBA + NFL"], ["nba", "NBA"], ["nfl", "NFL"]].map(([v, l]) => `<option value="${v}"${opts.league === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
          <label>Your feed <select id="simFeed"><option value=""${opts.feed === "" ? " selected" : ""}>Recorded ESPN delay</option>${[0, 1, 2, 3, 5, 8].map(v => `<option value="${v}"${String(opts.feed) === String(v) ? " selected" : ""}>${v}s after the play</option>`).join("")}</select></label>
          <label>Order delay (s) <input id="simOrder" type="number" min="0" max="10" step="0.1" value="${esc(opts.orderDelay)}"/></label>
          <label>Max price (¢) <input id="simMax" type="number" min="1" max="99" step="1" value="${esc(opts.maxPrice)}"/></label>
          <label>Contracts per trade <input id="simQty" type="number" min="1" max="10000" step="1" value="${esc(opts.contracts)}"/></label>
          <label>Hold (s) <select id="simHold">${[5, 10, 20, 30, 60, 90, 120].map(v => `<option value="${v}"${+opts.hold === v ? " selected" : ""}>${v}s</option>`).join("")}</select></label>
          <label class="check sim-clutch"><input type="checkbox" id="simClutch"${opts.clutchOnly ? " checked" : ""}/> Game line: clutch only</label>
        </div>
      </div>
      ${!res ? `<div class="pl-sub sim-empty">No recorded plays to simulate yet. Tonight's NBA games will fill this in.</div>` : `
      <div class="kpis">
        <div class="kpi"><div class="k">Trades</div><div class="v">${s.trades}</div><div class="s">${Object.values(res.skipped).reduce((a, b) => a + b, 0)} skipped (no price, or above max price)</div></div>
        <div class="kpi"><div class="k">Win rate</div><div class="v">${pct(s.trades ? s.wins / s.trades : null)}</div><div class="s">${s.wins} winners</div></div>
        <div class="kpi"><div class="k">Profit &amp; loss</div><div class="v" style="color:${s.pnl >= 0 ? "var(--hit)" : "var(--miss)"}">${usd(s.pnl)}</div><div class="s">after Kalshi fees</div></div>
        <div class="kpi"><div class="k">Return on stake</div><div class="v">${pct(s.roi)}</div><div class="s">${usd(s.staked)} staked</div></div>
        <div class="kpi"><div class="k">Per trade</div><div class="v">${usd(s.avg)}</div><div class="s">best ${usd(s.best)} · worst ${usd(s.worst)}</div></div>
      </div>
      <div class="table-wrap">${curve(res.trades)}</div>
      <div class="sim-two">${table(res.byStrategy, "Strategy")}${table(res.byGame.slice(0, 12), "Game")}</div>
      <h3 class="sub-h">Trades <span class="pl-sub">${res.trades.length > showTrades ? `latest ${showTrades} of ${res.trades.length}` : res.trades.length}</span></h3>
      <div class="table-wrap"><table class="lat-table"><thead><tr><th>Play</th><th>Strategy</th><th>Market</th><th class="num">Entered</th><th class="num">Buy</th><th class="num">Sell / settle</th><th class="num">Qty</th><th class="num">P&amp;L</th><th class="num">Running</th></tr></thead><tbody>
      ${res.trades.slice(-showTrades).reverse().map(t => `<tr><td>${new Date(t.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}<div class="pl-sub">${esc(t.game)}</div></td><td>${esc(NAMES[t.strategy])}</td><td>${esc(t.label)}</td><td class="num">+${t.entryT.toFixed(1)}s</td><td class="num">${cents(t.entry)}</td><td class="num">${cents(t.exit)}</td><td class="num">${t.qty}</td><td class="num" style="color:${t.pnl >= 0 ? "var(--hit)" : "var(--miss)"}">${usd(t.pnl)}</td><td class="num">${usd(t.cum)}</td></tr>`).join("")}
      </tbody></table></div>
      ${res.trades.length > showTrades ? `<button class="chip" id="simMore" style="margin-top:8px">Show ${Math.min(100, res.trades.length - showTrades)} more</button>` : ""}`}
    </div>`;
    const save = () => { try { localStorage.setItem("proplab:sim", JSON.stringify(opts)); } catch {} render(box, current, sessions); };
    box.querySelectorAll("[data-strat]").forEach(c => c.onchange = () => { opts.strategies = [...box.querySelectorAll("[data-strat]:checked")].map(x => x.dataset.strat); save(); });
    const bind = (id, key, f = v => v) => { const n = box.querySelector(id); if (n) n.onchange = () => { opts[key] = f(n.type === "checkbox" ? n.checked : n.value); save(); }; };
    bind("#simScope", "scope"); bind("#simLeague", "league"); bind("#simFeed", "feed"); bind("#simOrder", "orderDelay"); bind("#simMax", "maxPrice");
    const more = box.querySelector("#simMore"); if (more) more.onclick = () => { showTrades += 100; render(box, current, sessions); };
    bind("#simQty", "contracts"); bind("#simHold", "hold"); bind("#simClutch", "clutchOnly");
  }
  window.PropSimUI = { render };
})();
