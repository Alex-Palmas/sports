/* Edge Board: every prop tonight ranked by expected value, with the reasons behind each projection. */
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const odds = a => a == null ? "—" : (a > 0 ? "+" : "") + a;
  const pct = x => x == null ? "—" : Math.round(x * 100) + "%";
  const evTxt = e => (e >= 0 ? "+" : "") + (e * 100).toFixed(1) + "%";
  let opts = { league: "all", minEv: 0.02, marketOnly: true, q: "", show: 60 };
  try { Object.assign(opts, JSON.parse(localStorage.getItem("proplab:edge") || "{}")); } catch {}
  const save = () => { try { localStorage.setItem("proplab:edge", JSON.stringify({ ...opts, show: 60 })); } catch {} };

  /** Chips explaining what drives a projection. */
  function chips(p, proj, stat) {
    const out = [];
    for (const x of proj.parts) {
      if (x.key === "teammate") out.push([x.mult > 1 ? "good" : "bad", "Teammate out"]);
      if (x.key === "matchup") out.push([x.mult > 1 ? "good" : "bad", x.mult > 1 ? "Soft matchup" : "Tough matchup"]);
      if (x.key === "minutes") out.push([x.mult > 1 ? "good" : "bad", x.mult > 1 ? "Minutes ↑" : "Minutes ↓"]);
      if (x.key === "rest") out.push(["bad", "Back-to-back"]);
      if (x.key === "blowout") out.push(["bad", "Blowout risk"]);
    }
    const mv = p.lineMove?.[stat]; const line = p.lines?.[stat];
    if (mv && mv.openLine != null && line !== mv.openLine) out.push(["info", `Line ${mv.openLine} → ${line}`]);
    // dedupe
    const seen = new Set(); return out.filter(([, t]) => !seen.has(t) && seen.add(t));
  }

  function rows(DATA) {
    const M = window.PropModel; const out = [];
    for (const [lg, sp] of Object.entries(DATA.sports)) {
      if (opts.league !== "all" && opts.league !== lg) continue;
      for (const p of sp.players || []) for (const stat of Object.keys(p.lines || {})) {
        const r = M.bestBet(p, stat, lg); if (!r) continue;
        const label = sp.stats.find(s => s.key === stat)?.label || stat;
        if (opts.q && !`${p.name} ${p.team} ${label}`.toLowerCase().includes(opts.q.toLowerCase())) continue;
        if (r.best) { if (r.best.ev < opts.minEv) continue; }
        else if (opts.marketOnly) continue;
        // no market: rank by how far the projection is from the line, in standard deviations
        const z = r.proj.sd ? Math.abs(r.proj.mean - r.line) / Math.max(r.proj.sd, 1) : 0;
        out.push({ lg, sp, p, stat, label, r, score: r.best ? r.best.ev : z * 0.05 - 1 });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function render(el, DATA, api) {
    const all = rows(DATA), shown = all.slice(0, opts.show);
    const leagues = Object.entries(DATA.sports).filter(([, s]) => s.players?.length);
    el.querySelector("#edgeBody").innerHTML = `
      <div class="edge-ctrls card">
        <label>League <select id="edgeLeague"><option value="all">All</option>${leagues.map(([k, s]) => `<option value="${k}"${opts.league === k ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
        <label>Minimum EV <select id="edgeMin">${[[-1, "Any"], [0, "0%+"], [0.02, "2%+"], [0.05, "5%+"], [0.1, "10%+"]].map(([v, l]) => `<option value="${v}"${+opts.minEv === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="edge-search">Search <input id="edgeQ" type="search" placeholder="Player, team or stat" value="${esc(opts.q)}" autocomplete="off"/></label>
        <label class="check"><input type="checkbox" id="edgeMarket"${opts.marketOnly ? " checked" : ""}/> Only props with a price to bet</label>
      </div>
      <div class="pl-sub edge-note">${all.length} prop${all.length === 1 ? "" : "s"} · EV uses our projection blended 50/50 with the market's vig-free price at that line, after Kalshi fees where they apply. Above +25% usually means the model is missing something (news, minutes limits): check before betting. Not betting advice.</div>
      <div class="edge-list">${shown.map((x, i) => {
        const { p, r, stat, label, lg, sp } = x, b = r.best, warn = b && b.ev > 0.25;
        return `<button class="card edge-row" data-pid="${esc(p.id)}" data-k="${esc(stat)}" data-sport="${esc(lg)}">
          <span class="er-rank">${i + 1}</span>
          ${api.avatar(p, 44, "", sp)}
          <span class="er-main"><b>${esc(p.name)}</b> <span class="pl-sub">${esc(sp.name)} · ${esc(p.team)} ${p.home ? "vs" : "@"} ${esc(p.opp)}</span>
            <span class="er-prop">${b ? `${b.side === "over" ? "Over" : "Under"} ${b.line}` : `Line ${r.line}`} ${esc(label)} <span class="pl-sub">· projection <b>${r.proj.mean}</b></span></span>
            <span class="er-chips">${chips(p, r.proj, stat).map(([c, t]) => `<span class="echip ${c}">${esc(t)}</span>`).join("")}${warn ? `<span class="echip warn">Big disagreement: check news</span>` : ""}</span></span>
          <span class="er-num">${b ? `<span class="er-ev" style="color:${b.ev >= 0 ? "var(--hit)" : "var(--miss)"}">${evTxt(b.ev)}</span><span class="pl-sub">${odds(b.price)} ${esc(b.book)}</span><span class="pl-sub">we say ${pct(b.prob)}</span>`
            : `<span class="er-ev">${pct(r.probs.over > 0.5 ? r.probs.over : r.probs.under)}</span><span class="pl-sub">${r.probs.over > 0.5 ? "over" : "under"} · fair ${odds(r.probs.over > 0.5 ? r.fairOver : r.fairUnder)}</span><span class="pl-sub">no price yet</span>`}</span>
        </button>`; }).join("") || `<div class="card empty">Nothing matches. Lower the minimum EV, or untick "Only props with a price".</div>`}</div>
      ${all.length > shown.length ? `<button class="chip" id="edgeMore">Show more (${all.length - shown.length} left)</button>` : ""}`;
    const q = s => el.querySelector(s);
    q("#edgeLeague").onchange = e => { opts.league = e.target.value; save(); render(el, DATA, api); };
    q("#edgeMin").onchange = e => { opts.minEv = +e.target.value; save(); render(el, DATA, api); };
    q("#edgeMarket").onchange = e => { opts.marketOnly = e.target.checked; save(); render(el, DATA, api); };
    q("#edgeQ").oninput = e => { opts.q = e.target.value; clearTimeout(q("#edgeQ")._t); q("#edgeQ")._t = setTimeout(() => { save(); render(el, DATA, api); setTimeout(() => { const n = el.querySelector("#edgeQ"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 250); };
    if (q("#edgeMore")) q("#edgeMore").onclick = () => { opts.show += 60; render(el, DATA, api); };
    el.querySelectorAll(".edge-row").forEach(b => b.onclick = () => api.openProp(b.dataset.sport, b.dataset.pid, b.dataset.k));
  }
  window.PropEdge = { render, chips };
})();
