/* Crypto Bot tab: live BTC/ETH prices (Coinbase, straight from the browser) and the paper-trading
 * bot's snapshot (published by .github/workflows/crypto-bot.yml to the live-crypto branch, because
 * Kalshi refuses browser requests), plus past sessions from site/crypto/. */
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = x => x == null ? "—" : `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`;
  const px = x => x == null ? "—" : "$" + (+x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = x => x == null ? "—" : `${(x * 100).toFixed(1)}%`;
  const cents = x => x == null ? "—" : Math.round(x * 100) + "¢";
  const ago = iso => { if (!iso) return "—"; const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`; };
  const repo = (() => { const h = location.hostname; return h.endsWith(".github.io") ? { owner: h.split(".")[0], name: location.pathname.split("/")[1] || "sports" } : { owner: "Alex-Palmas", name: "sports" }; })();
  const KIND = { above: "Hourly above/below", range: "Hourly range", "15m": "15-minute up/down" };
  const STRAT = { latency: "Latency: Kalshi's own volatility + live price", model: "Model: our realized volatility" };

  let prices = {}, candles = {}, snap = null, snapAt = 0, sessions = null, timer = null, shown = false;
  async function getJSON(u, o) { try { const r = await fetch(u, o); return r.ok ? r.json() : null; } catch { return null; } }

  async function loadPrices() {
    await Promise.all(["BTC", "ETH"].map(async a => {
      const t = await getJSON(`https://api.exchange.coinbase.com/products/${a}-USD/ticker`);
      if (t?.price) prices[a] = { price: +t.price, t: Date.now() };
      if (!candles[a] || Date.now() - candles[a].t > 60e3) {
        const c = await getJSON(`https://api.exchange.coinbase.com/products/${a}-USD/candles?granularity=60`);
        if (Array.isArray(c)) candles[a] = { t: Date.now(), v: c.slice(0, 60).reverse().map(x => x[4]) };
      }
    }));
  }
  async function loadSnap() {
    if (snap !== null && Date.now() - snapAt < 60e3) return;
    snapAt = Date.now();
    const c = await getJSON(`https://api.github.com/repos/${repo.owner}/${repo.name}/commits/live-crypto`, { headers: { Accept: "application/vnd.github+json" } });
    snap = c?.sha ? await getJSON(`https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${c.sha}/crypto.json`) : null;
  }
  async function loadSessions() { if (sessions === null) sessions = (await getJSON("crypto/index.json", { cache: "no-cache" })) || []; }

  function spark(v, w = 160, h = 40) {
    if (!v || v.length < 2) return "";
    const lo = Math.min(...v), hi = Math.max(...v), span = Math.max(hi - lo, 1e-9);
    const up = v[v.length - 1] >= v[0];
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="cspark" aria-hidden="true"><polyline fill="none" stroke="${up ? "var(--hit)" : "var(--miss)"}" stroke-width="1.8" points="${v.map((x, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(h - 2 - (x - lo) / span * (h - 4)).toFixed(1)}`).join(" ")}"/></svg>`;
  }

  function priceCards() {
    return `<div class="cprices">${["BTC", "ETH"].map(a => {
      const p = prices[a], c = candles[a]?.v; const chg = c && p ? p.price / c[0] - 1 : null;
      const v = snap?.sigma?.[a];
      return `<div class="card cprice"><div class="cp-top"><b>${a}</b><span class="pl-sub">Coinbase · live</span></div>
        <div class="cp-row"><div><div class="cp-px">${px(p?.price)}</div><div class="pl-sub" style="color:${(chg ?? 0) >= 0 ? "var(--hit)" : "var(--miss)"}">${chg != null ? (chg >= 0 ? "+" : "") + (chg * 100).toFixed(2) + "% in 1h" : ""}</div></div>${spark(c)}</div>
        ${v ? `<div class="pl-sub">Volatility (annualized): realized ${pct(v.annualized)} · Kalshi implies ${pct(v.kalshiCalm ?? v.kalshiImplied)}</div>` : ""}</div>`;
    }).join("")}</div>`;
  }

  function stratCard(k, s) {
    return `<div class="card cstrat"><h3>${esc(STRAT[k])}</h3>
      <div class="kpis">
        <div class="kpi"><div class="k">Settled trades</div><div class="v">${s.trades}</div><div class="s">${s.open} open</div></div>
        <div class="kpi"><div class="k">Win rate</div><div class="v">${pct(s.trades ? s.wins / s.trades : null)}</div><div class="s">${s.wins} won</div></div>
        <div class="kpi"><div class="k">Profit &amp; loss</div><div class="v" style="color:${s.pnl >= 0 ? "var(--hit)" : "var(--miss)"}">${usd(s.pnl)}</div><div class="s">after Kalshi fees</div></div>
        <div class="kpi"><div class="k">Return</div><div class="v">${pct(s.roi)}</div><div class="s">${usd(s.staked)} staked</div></div>
      </div></div>`;
  }

  function marketsCard(d) {
    const evs = (d.markets || []).filter(e => e.markets.length);
    if (!evs.length) return "";
    return `<div class="card"><h2>Kalshi markets right now <span class="pl-sub">bid / ask vs. the two models · highlighted where a strategy sees ≥ ${cents(d.rules.edge)} of edge</span></h2>
      ${evs.map(e => `<h3 class="sub-h">${esc(e.asset)} · ${esc(KIND[e.kind] || e.label)} <span class="pl-sub">closes ${e.close ? new Date(e.close).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}</span></h3>
        <div class="table-wrap"><table class="lat-table ctable"><thead><tr><th>Market</th><th class="num">Bid</th><th class="num">Ask</th><th class="num">Latency</th><th class="num">Model</th><th class="num">Volume</th></tr></thead><tbody>
        ${e.markets.map(m => { const hot = f => f != null && m.ask != null && m.bid != null && (f - m.ask >= d.rules.edge || m.bid - f >= d.rules.edge);
          return `<tr><td>${esc(m.label)}</td><td class="num">${cents(m.bid)}</td><td class="num">${cents(m.ask)}</td><td class="num${hot(m.fairL) ? " edge" : ""}">${cents(m.fairL)}</td><td class="num${hot(m.fair) ? " edge" : ""}">${cents(m.fair)}</td><td class="num">${m.volume != null ? m.volume.toLocaleString() : "—"}</td></tr>`; }).join("")}
        </tbody></table></div>`).join("")}</div>`;
  }

  function positionsCard(d) {
    const ps = (d.positions || []).slice().reverse().slice(0, 40);
    if (!ps.length) return "";
    return `<div class="card"><h2>Paper positions <span class="pl-sub">latest ${ps.length} · held to Kalshi's result</span></h2>
      <div class="table-wrap"><table class="lat-table"><thead><tr><th>Entered</th><th>Strategy</th><th>Market</th><th>Side</th><th class="num">Price</th><th class="num">Fair</th><th class="num">Edge</th><th class="num">Qty</th><th class="num">P&amp;L</th><th>Status</th></tr></thead><tbody>
      ${ps.map(p => `<tr><td>${new Date(p.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}<div class="pl-sub">${Math.round(p.secsToClose / 60)} min left</div></td><td>${esc(p.strategy === "latency" ? "Latency" : "Model")}</td><td>${esc(p.label)}</td><td>${esc(p.side.toUpperCase())}</td><td class="num">${cents(p.entry)}</td><td class="num">${cents(p.side === "yes" ? p.fair : 1 - p.fair)}</td><td class="num">${cents(p.edge)}</td><td class="num">${p.qty}</td><td class="num" style="color:${(p.pnl ?? 0) >= 0 ? "var(--hit)" : "var(--miss)"}">${p.pnl != null ? usd(p.pnl) : "—"}</td><td>${p.status === "open" ? `<span class="tag mid">open</span>` : p.status === "won" ? `<span class="tag won">won</span>` : p.status === "lost" ? `<span class="tag lost">lost</span>` : esc(p.status)}</td></tr>`).join("")}
      </tbody></table></div></div>`;
  }

  function insightCard(d) {
    const c = d.calibration || {}, l = d.lag || {};
    return `<div class="kpis">
      <div class="kpi"><div class="k">Accuracy (Brier, lower is better)</div><div class="v">${c.model != null ? c.model.toFixed(3) : "—"} <span class="pl-sub">model</span></div><div class="s">Kalshi ${c.kalshi != null ? c.kalshi.toFixed(3) : "—"} · ${c.n || 0} settled markets, 5 min before close</div></div>
      <div class="kpi"><div class="k">Sharp moves seen</div><div class="v">${l.jumps ?? 0}</div><div class="s">≥ ${d.rules.jumpBps} bps in 10s</div></div>
      <div class="kpi"><div class="k">Kalshi catches up</div><div class="v">${l.medianT50 != null ? l.medianT50.toFixed(1) + "s" : "—"}</div><div class="s">median time to close half the gap</div></div>
      <div class="kpi"><div class="k">Gap after a move</div><div class="v">${l.medianGapAt0 != null ? cents(Math.abs(l.medianGapAt0)) : "—"}</div><div class="s">model vs. Kalshi, at-the-money</div></div>
    </div>`;
  }

  function historyCard() {
    if (!sessions?.length) return "";
    return `<div class="card"><h2>Past sessions</h2><div class="table-wrap"><table class="lat-table"><thead><tr><th>Started</th><th class="num">Settled trades</th><th class="num">Win rate</th><th class="num">P&amp;L</th><th class="num">Return</th><th class="num">Brier model / Kalshi</th></tr></thead><tbody>
      ${sessions.slice(0, 30).map(s => `<tr><td>${new Date(s.started).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td><td class="num">${s.trades}</td><td class="num">${pct(s.trades ? s.wins / s.trades : null)}</td><td class="num" style="color:${s.pnl >= 0 ? "var(--hit)" : "var(--miss)"}">${usd(s.pnl)}</td><td class="num">${pct(s.roi)}</td><td class="num">${s.calibration?.model != null ? s.calibration.model.toFixed(3) : "—"} / ${s.calibration?.kalshi != null ? s.calibration.kalshi.toFixed(3) : "—"}</td></tr>`).join("")}
      </tbody></table></div></div>`;
  }

  async function render(el) {
    shown = true;
    await Promise.all([loadPrices(), loadSnap(), loadSessions()]);
    const d = snap;
    const live = d && Date.now() - Date.parse(d.updated) < 10 * 60e3;
    el.querySelector("#cryptoBody").innerHTML = `
      ${priceCards()}
      <div class="card">
        <h2>Bot status ${d ? `<span class="pl-sub">${live ? `<span class="live-dot"></span>running · ` : "last run · "}updated ${ago(d.updated)}</span>` : ""}</h2>
        ${d ? `<p class="pl-sub">Paper trading only. Rules: buy YES or NO when a strategy's probability beats Kalshi's price by ${cents(d.rules.edge)}+ after fees, ${d.rules.qty} contracts (capped by the size offered), up to ${d.rules.maxPerEvent} positions per event, no new entries in the last ${Math.round(d.rules.noEntrySecs / 60)} minutes, held to Kalshi's actual result.</p>
          <div class="cstrats">${stratCard("latency", d.byStrategy?.latency || {})}${stratCard("model", d.byStrategy?.model || {})}</div>
          ${insightCard(d)}`
        : `<p class="pl-sub">The bot hasn't published a snapshot yet. It runs on GitHub about every 6 hours (crypto trades around the clock), or start it any time from the repo's Actions tab ("Kalshi crypto bot (paper)" → Run workflow). Live results appear here within a few minutes.</p>`}
      </div>
      ${d ? marketsCard(d) + positionsCard(d) : ""}
      ${historyCard()}`;
    clearTimeout(timer);
    timer = setTimeout(() => { if (!el.hidden) render(el); }, 5000); // prices every 5s; the bot snapshot refreshes every minute
  }
  window.PropCrypto = { render };
})();
