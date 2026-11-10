/* Game lines: moneyline, spread and total for every game — DraftKings (via ESPN) and Kalshi prices,
 * where each line opened, our projected score, EV on every price, and each side's recent scoring. */
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const odds = a => a == null ? "—" : (a > 0 ? "+" : "") + a;
  const pct = x => x == null ? "—" : Math.round(x * 100) + "%";
  const evTxt = e => (e >= 0 ? "+" : "") + (e * 100).toFixed(1) + "%";
  const sgn = x => x == null ? "—" : (x > 0 ? "+" : "") + x;
  const r1 = x => (Math.round(x * 10) / 10).toFixed(1);
  const gk = g => `${g.away}@${g.home}|${g.date}`;
  const dayKey = iso => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const dayLabel = k => { const t = dayKey(new Date().toISOString()), tm = dayKey(new Date(Date.now() + 86400e3).toISOString());
    return k === t ? "Today" : k === tm ? "Tomorrow" : new Date(k + "T12:00:00").toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }); };
  const unit = lg => lg === "nhl" || lg === "mlb" ? "goals" : "points";
  const lgAvgOf = games => { const v = games.flatMap(g => Object.values(g.form || {}).flat().flatMap(x => [x.pf, x.pa])); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

  /** Recent-form summary for one side against tonight's numbers. */
  function trends(g, team, lg) {
    const f = window.PropModel.seasonForm(g.form?.[team]).slice(0, 10); if (!f.length) return null;
    const pf = f.reduce((a, x) => a + x.pf, 0) / f.length, pa = f.reduce((a, x) => a + x.pa, 0) / f.length;
    const w = f.filter(x => x.pf > x.pa).length, l = f.filter(x => x.pf < x.pa).length;
    const sp = g.dk?.spread?.home != null ? (team === g.home ? g.dk.spread.home : -g.dk.spread.home) : null;   // this team's line tonight
    const cover = sp == null ? null : f.filter(x => x.pf - x.pa + sp > 0).length;
    const tot = g.dk?.total?.line, over = tot == null ? null : f.filter(x => x.pf + x.pa > tot).length;
    const h2h = (g.form?.[team] || []).filter(x => x.opp === (team === g.home ? g.away : g.home)).slice(0, 5);
    const md = d => new Date(d + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric" });
    return { n: f.length, pf, pa, w, l, sp, cover, tot, over, h2h, span: `${md(f[f.length - 1].date)} – ${md(f[0].date)}`, prev: f.some(x => x.season === "prev") };
  }

  /** One game card. compact = the summary shown above the props list when a game is picked. */
  function card(g, lg, api, opts = {}) {
    const M = window.PropModel, { model: m, bets } = M.gameBets(g, lg, opts.lgAvg);
    const tA = trends(g, g.away, lg), tH = trends(g, g.home, lg);
    const dk = g.dk || {}, K = g.kalshi || {}, logo = api.teamLogo;
    const t = new Date(g.date), live = t.getTime() <= Date.now() && Date.now() - t.getTime() < 4 * 3600e3;
    const when = live ? `<span class="gs-live">LIVE</span>` : esc(`${opts.showDay ? dayLabel(dayKey(g.date)) + " · " : ""}${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
    const evOf = (label, book) => bets.find(b => b.label === label && b.book === book);
    const cell = (price, label, book, sub) => { if (price == null) return `<td class="gl-cell"><span class="pl-sub">—</span></td>`;
      const b = evOf(label, book), good = b && b.ev > 0.01;
      return `<td class="gl-cell${good ? " good" : ""}"><b>${esc(sub ? sub + " " : "")}${odds(price)}</b>${b ? `<small>${pct(b.model)} · <span style="color:${b.ev >= 0 ? "var(--hit)" : "var(--miss)"}">${evTxt(b.ev)}</span></small>` : ""}</td>`; };
    const sp = dk.spread, tt = dk.total;
    // Kalshi at tonight's numbers
    const kml = tm => K.ml?.[tm];
    const ksp = tm => sp?.home == null ? null : (tm === g.home ? sp.home < 0 : sp.home > 0)
      ? K.spread?.find(q => q.team === tm && q.l === Math.abs(sp.home)) : K.spread?.find(q => q.team !== tm && q.l === Math.abs(sp.home));
    const ktt = tt?.line != null ? K.total?.find(q => q.l === tt.line) : null;
    const kRow = tm => { const ml = kml(tm), s = ksp(tm), favSide = s && s.team === tm;
      const spLab = s ? (favSide ? `${tm} -${s.l}` : `${tm} +${s.l}`) : null, spPrice = s ? (favSide ? s.o : s.u) : null;
      return { ml, spLab, spPrice, spLine: s ? (favSide ? -s.l : s.l) : null, spHref: s?.href }; };
    const row = (tm, side) => { const kr = kRow(tm), isHome = tm === g.home;
      const myLine = sp?.home == null ? null : isHome ? sp.home : -sp.home;
      return `<tr><th class="gl-team"><span>${logo(tm, 22)}<b>${esc(tm)}</b></span></th>
        ${cell(isHome ? dk.ml?.home : dk.ml?.away, `${tm} ML`, dk.book || "DraftKings")}
        ${cell(isHome ? sp?.homeOdds : sp?.awayOdds, `${tm} ${sgn(myLine)}`, dk.book || "DraftKings", sgn(myLine))}
        ${cell(side === "o" ? tt?.over : tt?.under, `${side === "o" ? "Over" : "Under"} ${tt?.line}`, dk.book || "DraftKings", tt?.line != null ? `${side === "o" ? "O" : "U"} ${tt.line}` : "")}
        ${opts.compact ? "" : `<td class="gl-k">${kr.ml ? `<a href="${esc(kr.ml.href)}" target="_blank" rel="noopener" data-kalshi-link>${odds(kr.ml.o)}</a>` : "—"}</td>
        <td class="gl-k">${kr.spPrice != null ? `<a href="${esc(kr.spHref || "#")}" target="_blank" rel="noopener" data-kalshi-link>${esc(sgn(kr.spLine))} ${odds(kr.spPrice)}</a>` : "—"}</td>
        <td class="gl-k">${ktt ? `<a href="${esc(ktt.href)}" target="_blank" rel="noopener" data-kalshi-link>${side === "o" ? "O" : "U"} ${odds(side === "o" ? ktt.o : ktt.u)}</a>` : "—"}</td>`}</tr>`; };
    const move = (now, open, fmt) => open != null && now != null && open !== now ? `<span class="gl-move">opened ${fmt(open)}</span>` : "";
    const top = bets.filter(b => b.ev > 0.005).slice(0, opts.compact ? 2 : 4);

    const trendLine = (tm, tr) => tr ? `<div class="gl-trend"><b>${esc(tm)}</b> last ${tr.n} <span class="pl-sub">(${esc(tr.span)}${tr.prev ? ", incl. last season" : ""})</span>: ${tr.w}-${tr.l} · ${r1(tr.pf)} scored / ${r1(tr.pa)} allowed${tr.cover != null ? ` · covered ${sgn(tr.sp)} in ${tr.cover}/${tr.n}` : ""}${tr.over != null ? ` · over ${tr.tot} in ${tr.over}/${tr.n}` : ""}${tr.h2h.length ? ` · vs ${esc(tm === g.home ? g.away : g.home)}: ${tr.h2h.map(x => `${x.pf}-${x.pa}`).join(", ")}` : ""}</div>` : "";
    return `<div class="card game-card${opts.compact ? " compact" : ""}" id="game-${esc(g.id)}" data-gkey="${esc(gk(g))}">
      <div class="gc-head"><div class="gc-matchup">${logo(g.away, 26)}<b>${esc(g.away)}</b><span class="pl-sub">@</span>${logo(g.home, 26)}<b>${esc(g.home)}</b></div><span class="pl-sub">${when}</span></div>
      <div class="table-wrap"><table class="gl-table"><thead><tr><th></th><th>Moneyline</th><th>Spread</th><th>Total</th>${opts.compact ? "" : `<th class="gl-k">Kalshi ML</th><th class="gl-k">Kalshi spread</th><th class="gl-k">Kalshi total</th>`}</tr></thead>
        <tbody>${row(g.away, "o")}${row(g.home, "u")}</tbody></table></div>
      ${!dk.ml && !dk.spread && !dk.total ? `<div class="gl-nolines">DraftKings hasn't posted lines for this game yet (usually the day before or the morning of). ${Object.keys(K.ml || {}).length ? "Kalshi's prices are live." : ""}</div>` : ""}
      <div class="pl-sub gl-src">${esc(dk.book || "DraftKings")} via ESPN${move(dk.ml?.home, dk.ml?.openHome, v => `${g.home} ${odds(v)}`)}${move(sp?.home, sp?.openHome, v => `${g.home} ${sgn(v)}`)}${move(tt?.line, tt?.openLine, v => `total ${v}`)} · small text: our chance · EV</div>
      ${m ? `<div class="gl-model"><span>Projection</span><b>${esc(g.away)} ${r1(m.away)} – ${esc(g.home)} ${r1(m.home)}</b><span class="pl-sub">fair spread ${esc(m.margin >= 0 ? g.home : g.away)} −${r1(Math.abs(m.margin))} · fair total ${r1(m.total)} · ${esc(g.home)} wins ${pct(m.pWin(g.home))}</span><span class="pl-sub gl-basis">from this season: ${esc(g.away)} ${tA?.n ?? "—"} games, ${esc(g.home)} ${tH?.n ?? "—"} games${tA?.prev || tH?.prev ? " (early season: includes last season)" : ""}</span></div>` : `<div class="pl-sub">Not enough recent games for a projection.</div>`}
      ${top.length ? `<div class="gl-best"><span class="pl-sub">Best value</span>${top.map(b => `<span class="gl-bet">${esc(b.label)} <b>${odds(b.price)}</b> ${esc(b.book)} · <b style="color:var(--hit)">EV ${evTxt(b.ev)}</b>${b.href ? ` <a href="${esc(b.href)}" target="_blank" rel="noopener" data-kalshi-link class="kalshi-link">Open ↗</a>` : ""}</span>`).join("")}</div>` : ""}
      ${opts.compact ? `<button class="chip sm gl-more" data-full="${esc(g.id)}">All lines &amp; trends →</button>` : `<details class="gl-trends"${opts.open ? " open" : ""}><summary>Recent scoring &amp; trends</summary>${trendLine(g.away, tA)}${trendLine(g.home, tH)}
        ${K.spread?.length || K.total?.length ? `<div class="gl-ladders">${K.spread?.length ? `<div><span class="pl-sub">Kalshi spread ladder</span>${K.spread.map(q => `<span class="gl-lad">${esc(q.team)} by ${q.l}+ <b>${odds(q.o)}</b></span>`).join("")}</div>` : ""}${K.total?.length ? `<div><span class="pl-sub">Kalshi total ladder</span>${K.total.map(q => `<span class="gl-lad">O ${q.l} <b>${odds(q.o)}</b></span>`).join("")}</div>` : ""}</div>` : ""}</details>`}
    </div>`;
  }

  function render(el, DATA, api) {
    const lg = api.sport(), sp = DATA.sports[lg], games = (sp?.games || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const body = el.querySelector("#gamesBody"), lgAvg = lgAvgOf(games);
    if (!games.length) { body.innerHTML = `<div class="card empty">${sp ? "No game lines yet — they appear with the next data refresh." : "No games."}</div>`; return; }
    let html = "", last = null;
    for (const g of games) {
      const d = dayKey(g.date);
      if (d !== last) { last = d; html += `<h3 class="day-head"><span>${esc(dayLabel(d))}</span><span class="pl-sub">${games.filter(x => dayKey(x.date) === d).length} games</span></h3>`; }
      html += card(g, lg, api, { lgAvg });
    }
    body.innerHTML = `<div class="games-list">${html}</div><p class="pl-sub">Projections come from each side's recent ${unit(lg)} for and against (recent games weighted more, small samples pulled to the league average, home edge included). Game lines are sharp, so our probability leans 85% on the market's no-vig price; treat big EVs with suspicion. Not betting advice.</p>`;
    if (api.focusGame) { const c = body.querySelector(`#game-${CSS.escape(api.focusGame)}`); api.focusGame = null; if (c) { c.querySelector("details")?.setAttribute("open", ""); c.scrollIntoView({ block: "start" }); c.classList.add("flash"); } }
  }

  window.PropGames = { render, card, lgAvgOf, gk };
})();
