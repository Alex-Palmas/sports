/* My Bets: bet tracker with closing-line value and auto-settlement, bankroll/Kelly sizing,
 * a watchlist, and "since your last visit" alerts. Everything is stored in this browser. */
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const odds = a => a == null ? "—" : (a > 0 ? "+" : "") + a;
  const usd = x => x == null ? "—" : `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`;
  const pct = x => x == null ? "—" : `${(x * 100).toFixed(1)}%`;
  const load = (k, d) => { try { const v = localStorage.getItem("proplab:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem("proplab:" + k, JSON.stringify(v)); } catch {} };
  const M = () => window.PropModel;
  const LEAGUE_PATH = { nba: "basketball/nba", nfl: "football/nfl", nhl: "hockey/nhl", mlb: "baseball/mlb" };

  // ESPN game-log columns → our stat keys (mirrors scripts/fetch-data.mjs)
  const num = v => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
  const ROW = {
    nba: g => { const p = num(g.points), r = num(g.totalRebounds), a = num(g.assists);
      return { pts: p, reb: r, ast: a, fg3: num(String(g["threePointFieldGoalsMade-threePointFieldGoalsAttempted"] || "").split("-")[0]), stl: num(g.steals), blk: num(g.blocks), pr: p + r, pa: p + a, ra: r + a, pra: p + r + a }; },
    nfl: g => ({ pass_yds: num(g.passingYards), pass_td: num(g.passingTouchdowns), rush_yds: num(g.rushingYards), rec_yds: num(g.receivingYards), rec: num(g.receptions), td: num(g.rushingTouchdowns) + num(g.receivingTouchdowns) }),
    nhl: g => ({ sog: num(g.shotsTotal), pts: num(g.points), g: num(g.goals), ast: num(g.assists) }),
    mlb: g => { const h = num(g.hits); return { hits: h, tb: h + num(g.doubles) + 2 * num(g.triples) + 3 * num(g.homeRuns), rbi: num(g.RBIs), runs: num(g.runs), hrr: h + num(g.runs) + num(g.RBIs), hr: num(g.homeRuns), so: num(g.strikeouts) }; },
  };
  async function espnLogs(sport, espnId) {
    try {
      const r = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/${LEAGUE_PATH[sport]}/athletes/${espnId}/gamelog`); if (!r.ok) return [];
      const g = await r.json(); const out = [];
      for (const st of g.seasonTypes || []) for (const c of st.categories || []) for (const ev of c.events || []) {
        const meta = g.events?.[ev.eventId]; if (!meta || !ev.stats) continue;
        out.push({ date: meta.gameDate.slice(0, 10), stats: ROW[sport](Object.fromEntries(g.names.map((n, i) => [n, ev.stats[i]]))) });
      }
      return out;
    } catch { return []; }
  }

  // ---------------------------------------------------------------- bets
  const bets = () => load("bets", []);
  const saveBets = b => store("bets", b);
  const bankroll = () => +load("bankroll", 1000);

  /** Quotes for the same side at the bet's line, best price first (closing price candidates). */
  function currentPrice(p, bet) {
    const qs = (p?.market?.[bet.stat] || []).filter(q => q.l === bet.line).map(q => bet.side === "over" ? q.o : q.u).filter(x => x != null);
    if (qs.length) return Math.max(...qs);
    if (p?.lines?.[bet.stat] === bet.line) { const o = p.odds?.[bet.stat]; return bet.side === "over" ? o?.over ?? null : o?.under ?? null; }
    return null;
  }
  /** Before kick-off, keep updating each bet's closing line/price from the latest data. */
  function updateClose(DATA) {
    const b = bets(); let changed = false;
    for (const bet of b) {
      if (bet.settled || Date.parse(bet.gameDate) < Date.now()) continue;
      const p = DATA.sports[bet.sport]?.players.find(x => x.id === bet.playerId); if (!p) continue;
      // close = your line's latest price; if your line is gone, the market's main line (line CLV only)
      const price = currentPrice(p, bet), main = p.lines?.[bet.stat];
      if (price != null) bet.close = { line: bet.line, price, at: new Date().toISOString() };
      else if (main != null) bet.close = { line: main, price: null, at: new Date().toISOString() };
      else continue;
      changed = true;
    }
    if (changed) saveBets(b);
  }
  /** Settle bets whose games are over, from the player's ESPN game log. */
  async function settleOpen() {
    const b = bets(); let changed = false;
    for (const bet of b) {
      if (bet.settled || !bet.espnId || Date.parse(bet.gameDate) > Date.now() - 3 * 3600e3) continue;
      const res = M().settle(bet, await espnLogs(bet.sport, bet.espnId));
      if (res) { bet.settled = res; changed = true; }
    }
    if (changed) saveBets(b);
    return changed;
  }

  // ---------------------------------------------------------------- track-bet dialog
  function openTrack(ctx) {
    const { p, sport, stat, label, side = "over", line, price, book, prob } = ctx;
    const dlg = document.getElementById("trackDlg");
    const br = bankroll();
    const sugg = (pr, pz) => pr != null && pz != null ? Math.round(br * M().kelly(pr, pz) * 0.25 * 100) / 100 : null;
    dlg.innerHTML = `<form method="dialog" class="track-form" id="trackForm">
      <h2>Track a bet</h2>
      <div class="pl-sub">${esc(p.name)} · ${esc(label)} · ${esc(p.team)} ${p.home ? "vs" : "@"} ${esc(p.opp)}</div>
      <div class="tf-grid">
        <label>Side <select id="tfSide"><option value="over"${side === "over" ? " selected" : ""}>Over</option><option value="under"${side === "under" ? " selected" : ""}>Under</option></select></label>
        <label>Line <input id="tfLine" type="number" step="0.5" value="${esc(line)}" required/></label>
        <label>Price (American) <input id="tfPrice" type="number" step="1" value="${esc(price ?? -110)}" required/></label>
        <label>Book <input id="tfBook" type="text" value="${esc(book || "")}" placeholder="DraftKings, Kalshi…"/></label>
        <label>Stake ($) <input id="tfStake" type="number" step="0.01" min="0.01" value="${esc(sugg(prob, price) || 10)}" required/></label>
        <label>Bankroll ($) <input id="tfBank" type="number" step="1" min="1" value="${esc(br)}"/></label>
      </div>
      <div class="pl-sub" id="tfKelly"></div>
      <div class="tf-actions"><button type="button" class="chip" id="tfCancel">Cancel</button><button type="submit" class="chip active" id="tfSave">Save bet</button></div>
    </form>`;
    const $ = s => dlg.querySelector(s);
    const kellyNote = () => {
      const pz = +$("#tfPrice").value, br2 = +$("#tfBank").value || br;
      if (prob == null || !pz) { $("#tfKelly").textContent = ""; return; }
      const sideProb = $("#tfSide").value === side ? prob : 1 - prob;
      const k = M().kelly(sideProb, pz);
      $("#tfKelly").innerHTML = k > 0 ? `We estimate ${pct(sideProb)} at this price. Quarter-Kelly stake: <b>${usd(br2 * k * 0.25)}</b> (${pct(k * 0.25)} of bankroll).` : `At this price we don't see an edge (estimated ${pct(sideProb)}). Kelly says don't bet.`;
    };
    ["#tfPrice", "#tfBank", "#tfSide"].forEach(s => $(s).addEventListener("input", kellyNote)); kellyNote();
    $("#tfCancel").onclick = () => dlg.close();
    $("#trackForm").onsubmit = e => {
      e.preventDefault();
      store("bankroll", +$("#tfBank").value || br);
      const b = bets();
      b.push({ id: Date.now().toString(36), sport, playerId: p.id, espnId: p.espnId || null, player: p.name, team: p.team, opp: p.opp, home: p.home,
        stat, statLabel: label, side: $("#tfSide").value, line: +$("#tfLine").value, price: +$("#tfPrice").value, book: $("#tfBook").value.trim(),
        stake: +$("#tfStake").value, gameDate: p.gameDate || null, placedAt: new Date().toISOString(), modelProb: prob ?? null });
      saveBets(b); dlg.close(); window.PropBets.onChange?.();
    };
    dlg.showModal();
  }

  /** Record a bet placed elsewhere (e.g. a real Kalshi order from the order ticket). */
  function addBet({ p, sport, stat, label, side, line, price, book, stake, prob, real }) {
    const b = bets();
    b.push({ id: Date.now().toString(36), sport, playerId: p.id, espnId: p.espnId || null, player: p.name, team: p.team, opp: p.opp, home: p.home,
      stat, statLabel: label, side, line, price, book, stake: +(+stake).toFixed(2), gameDate: p.gameDate || null, placedAt: new Date().toISOString(), modelProb: prob ?? null, real: real || null });
    saveBets(b); window.PropBets.onChange?.();
  }

  // ---------------------------------------------------------------- watchlist & alerts
  const watchKey = (sport, pid, stat) => `${sport}|${pid}|${stat}`;
  const watched = () => load("watch", []);
  const isWatched = k => watched().includes(k);
  const toggleWatch = k => { const w = watched(); const i = w.indexOf(k); i >= 0 ? w.splice(i, 1) : w.push(k); store("watch", w); return i < 0; };
  /** Changes on watched props since the last visit: line moves, better prices, new injuries, edge appearing. */
  function alerts(DATA) {
    const seen = load("seen", {}), next = {}, out = [];
    for (const k of watched()) {
      const [sport, pid, stat] = k.split("|"); const sp = DATA.sports[sport]; const p = sp?.players.find(x => x.id === pid); if (!p) continue;
      const r = M().bestBet(p, stat, sport);
      const now = { line: p.lines?.[stat], over: p.odds?.[stat]?.over ?? null, under: p.odds?.[stat]?.under ?? null, ev: r?.best?.ev ?? null, out: (p.withWithout || []).map(t => t.teammate).sort().join(",") };
      next[k] = now; const was = seen[k];
      const label = sp.stats.find(s => s.key === stat)?.label || stat;
      if (!was) continue;
      if (was.line !== now.line && now.line != null) out.push({ k, sport, pid, stat, text: `${p.name} ${label}: line ${was.line} → ${now.line}` });
      if (now.out && now.out !== was.out) out.push({ k, sport, pid, stat, text: `${p.name}: teammate now out (${now.out.split(",").join(", ")})` });
      if (now.ev != null && now.ev >= 0.03 && !(was.ev >= 0.03)) out.push({ k, sport, pid, stat, text: `${p.name} ${label}: edge appeared (EV ${(now.ev * 100).toFixed(1)}%)` });
    }
    store("seen", { ...seen, ...next });
    return out;
  }

  // ---------------------------------------------------------------- view
  async function render(el, DATA, api) {
    updateClose(DATA);
    const body = el.querySelector("#betsBody");
    const draw = () => {
      const b = bets().slice().sort((x, y) => (y.placedAt || "").localeCompare(x.placedAt || ""));
      const done = b.filter(x => x.settled), open = b.filter(x => !x.settled);
      const pnl = done.reduce((a, x) => a + x.settled.pnl, 0), staked = done.reduce((a, x) => a + x.stake, 0);
      const W = done.filter(x => x.settled.result === "won").length, L = done.filter(x => x.settled.result === "lost").length, P = done.length - W - L;
      const clvs = b.map(x => M().clv(x)?.prob).filter(x => x != null);
      const avgClv = clvs.length ? clvs.reduce((a, c) => a + c, 0) / clvs.length : null;
      const beatClose = clvs.length ? clvs.filter(c => c > 0).length / clvs.length : null;
      const wl = watched();
      const row = x => { const c = M().clv(x);
        return `<tr><td><b>${esc(x.player)}</b><div class="pl-sub">${esc(x.statLabel)} · ${esc(x.team)} ${x.home ? "vs" : "@"} ${esc(x.opp)} · ${x.gameDate ? new Date(x.gameDate).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</div></td>
          <td>${x.side === "over" ? "Over" : "Under"} ${x.line}</td><td class="num">${odds(x.price)}<div class="pl-sub">${esc(x.book || "")}${x.real ? ` <span class="tag won" title="Placed on Kalshi · order ${esc(x.real.orderId || "")} · ${esc(x.real.ticker || "")}">real · ${esc(x.real.contracts)}×</span>` : ""}${(x.real?.ticker || x.kalshi) && window.PropKalshi ? ` ${window.PropKalshi.link(x.real?.href || x.real?.ticker || x.kalshi, "Kalshi", "kalshi-link")}` : ""}</div></td><td class="num">${usd(x.stake)}</td>
          <td class="num">${x.close ? `${x.close.line !== x.line ? x.close.line + " · " : ""}${odds(x.close.price)}` : "—"}</td>
          <td class="num" style="color:${(c?.prob ?? 0) > 0 ? "var(--hit)" : (c?.prob ?? 0) < 0 ? "var(--miss)" : "var(--muted)"}">${c?.prob != null ? (c.prob > 0 ? "+" : "") + (c.prob * 100).toFixed(1) + " pts" : c?.line ? (c.line > 0 ? "+" : "") + c.line + " line" : "—"}</td>
          <td>${x.settled ? `<span class="tag ${x.settled.result === "won" ? "won" : x.settled.result === "lost" ? "lost" : ""}">${esc(x.settled.result)}</span> <span class="pl-sub">${x.settled.actual}</span>` : `<span class="tag mid">open</span>`}</td>
          <td class="num" style="color:${(x.settled?.pnl ?? 0) >= 0 ? "var(--hit)" : "var(--miss)"}">${x.settled ? usd(x.settled.pnl) : "—"}</td>
          <td><button class="chip sm" data-del="${esc(x.id)}" aria-label="Delete bet">✕</button></td></tr>`; };
      body.innerHTML = `
        <div class="kpis">
          <div class="kpi"><div class="k">Record</div><div class="v">${W}-${L}${P ? "-" + P : ""}</div><div class="s">${open.length} open</div></div>
          <div class="kpi"><div class="k">Profit &amp; loss</div><div class="v" style="color:${pnl >= 0 ? "var(--hit)" : "var(--miss)"}">${usd(pnl)}</div><div class="s">${usd(staked)} staked · ROI ${pct(staked ? pnl / staked : null)}</div></div>
          <div class="kpi"><div class="k">Closing-line value</div><div class="v" style="color:${(avgClv ?? 0) >= 0 ? "var(--hit)" : "var(--miss)"}">${avgClv != null ? (avgClv > 0 ? "+" : "") + (avgClv * 100).toFixed(1) + " pts" : "—"}</div><div class="s">${beatClose != null ? `beat the close ${pct(beatClose)} of the time` : "your price vs. the final price"}</div></div>
          <div class="kpi"><div class="k">Bankroll</div><div class="v"><input id="bankroll" type="number" min="1" step="1" value="${esc(bankroll())}" aria-label="Bankroll in dollars"/></div><div class="s">used for quarter-Kelly stakes</div></div>
        </div>
        <div class="card"><h2>Why closing-line value matters</h2><p class="pl-sub" style="margin:0">Results are noisy over a few dozen bets. Beating the final price consistently is the best early sign of a real edge: it means the market moved your way after you bet. We record the latest line and price for each of your bets every time you open the app before the game starts.</p></div>
        <div class="card"><h2>Bets <span class="pl-sub">${b.length} tracked · settle automatically from ESPN box scores</span></h2>
          ${b.length ? `<div class="table-wrap"><table class="lat-table bets-table"><thead><tr><th>Bet</th><th>Pick</th><th class="num">Price</th><th class="num">Stake</th><th class="num">Close</th><th class="num">CLV</th><th>Status</th><th class="num">P&amp;L</th><th></th></tr></thead><tbody>${b.map(row).join("")}</tbody></table></div>`
            : `<p class="pl-sub">No bets yet. Open any prop and tap <b>Track bet</b>, or pick one from the Edge Board.</p>`}</div>
        <div class="card"><h2>Watchlist <span class="pl-sub">${wl.length} prop${wl.length === 1 ? "" : "s"} · you'll see line moves, injuries and new edges here and on the Props tab</span></h2>
          ${wl.length ? `<div class="watch-list">${wl.map(k => { const [sport, pid, stat] = k.split("|"); const sp = DATA.sports[sport]; const p = sp?.players.find(x => x.id === pid);
            const label = sp?.stats.find(s => s.key === stat)?.label || stat;
            if (!p) return `<div class="watch-item dim"><span>${esc(pid)} · ${esc(label)}</span><span class="pl-sub">no game scheduled</span><button class="chip sm" data-unwatch="${esc(k)}">Remove</button></div>`;
            const r = M().bestBet(p, stat, sport);
            return `<div class="watch-item"><button class="linklike" data-open="${esc(k)}">${api.avatar(p, 32, "", sp)}<span><b>${esc(p.name)}</b> <span class="pl-sub">${esc(label)} ${p.lines[stat]} · proj ${r?.proj.mean ?? "—"}</span></span></button>${r?.best ? `<span class="pl-sub">best ${r.best.side} ${r.best.line} ${odds(r.best.price)} · EV <b style="color:${r.best.ev >= 0 ? "var(--hit)" : "var(--miss)"}">${(r.best.ev * 100).toFixed(1)}%</b></span>` : `<span class="pl-sub">no price yet</span>`}<button class="chip sm" data-unwatch="${esc(k)}">Remove</button></div>`; }).join("")}</div>`
            : `<p class="pl-sub">Tap ☆ on any prop to watch it.</p>`}</div>`;
      body.querySelector("#bankroll").onchange = e => { store("bankroll", Math.max(1, +e.target.value || 1000)); draw(); };
      body.querySelectorAll("[data-del]").forEach(x => x.onclick = () => { if (x.dataset.confirm) { saveBets(bets().filter(y => y.id !== x.dataset.del)); draw(); } else { x.dataset.confirm = 1; x.textContent = "Delete?"; } });
      body.querySelectorAll("[data-unwatch]").forEach(x => x.onclick = () => { toggleWatch(x.dataset.unwatch); draw(); });
      body.querySelectorAll("[data-open]").forEach(x => x.onclick = () => { const [s, pid, st] = x.dataset.open.split("|"); api.openProp(s, pid, st); });
    };
    draw();
    if (await settleOpen()) draw();
  }

  window.PropBets = { render, openTrack, addBet, toggleWatch, isWatched, watchKey, alerts, updateClose, settleOpen, bets };
})();
