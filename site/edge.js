/* Edge Board: every prop tonight ranked by expected value, with the reasons behind each projection. */
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const odds = a => a == null ? "—" : (a > 0 ? "+" : "") + a;
  const pct = x => x == null ? "—" : Math.round(x * 100) + "%";
  const evTxt = e => (e >= 0 ? "+" : "") + (e * 100).toFixed(1) + "%";
  let opts = { league: "all", minEv: 0.02, minConf: "any", marketOnly: true, q: "", show: 60 };
  const RANK = { Low: 0, Medium: 1, High: 2 }, MIN = { any: 0, medium: 1, high: 2 };
  /** Confidence badge: grade + score, with the reasons in the tooltip. */
  const confBadge = c => c ? `<span class="conf conf-${c.grade.toLowerCase()}" title="${esc(c.why.length ? c.why.map(w => `−${w.pts} ${w.txt}`).join("\n") : "Nothing lowers confidence")}"><i></i>${c.grade} ${c.score}</span>` : "";
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
        if (RANK[r.confidence?.grade] < MIN[opts.minConf]) continue;
        if (r.best) { if (r.best.ev < opts.minEv) continue; }
        else if (opts.marketOnly) continue;
        // no market: rank by how far the projection is from the line, in standard deviations
        const z = r.proj.sd ? Math.abs(r.proj.mean - r.line) / Math.max(r.proj.sd, 1) : 0;
        out.push({ lg, sp, p, stat, label, r, score: r.best ? r.best.ev : z * 0.05 - 1 });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  // walk-forward backtest (scripts/backtest-model.mjs) + live ledger (scripts/fetch-data.mjs)
  let report = null, reportReq = null;
  const loadReport = () => reportReq ||= fetch("model-report.json", { cache: "no-cache" }).then(r => r.ok ? r.json() : null).catch(() => null).then(r => (report = r));
  const roi = x => x == null ? "—" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
  const n2 = x => x == null ? "—" : (+x).toFixed(3);
  function accuracy(DATA) {
    const lgs = Object.entries(report?.leagues || {}), live = Object.entries(DATA.modelTrack || {});
    if (!lgs.length && !live.length) return "";
    const name = k => DATA.sports[k]?.name || k.toUpperCase();
    return `<details class="card model-acc"><summary><b>Model accuracy</b> <span class="pl-sub">tested on past games it never saw</span></summary>
      ${lgs.length ? `<p class="pl-sub">${esc(report.method)} Log loss: lower is better; a coin flip scores 0.693. "Hit rate only" is the last-20 over % on its own.</p>
      <div class="table-scroll"><table class="acc-table"><thead><tr><th>League</th><th>Props tested</th><th>Log loss</th><th>Hit rate only</th><th>Main line</th><th>Brier</th><th>Avg miss</th></tr></thead><tbody>
      ${lgs.map(([k, r]) => `<tr><td>${esc(name(k))}</td><td>${r.tuned.props.toLocaleString()}</td><td><b>${n2(r.tuned.logLoss)}</b></td><td>${n2(r.tuned.logLossHitRate)}</td><td>${n2(r.tuned.mainLine.logLoss)}</td><td>${n2(r.tuned.brier)}</td><td>${(+r.tuned.mae).toFixed(2)}</td></tr>`).join("")}
      </tbody></table></div>
      ${lgs.map(([k, r]) => `<div class="acc-cal"><span class="pl-sub">${esc(name(k))} calibration (predicted → actual over rate)</span><div class="acc-bars">${r.tuned.calibration.filter(b => b.n >= 30).map(b => `<span title="${b.n} props"><i style="height:${Math.round(b.actual * 100)}%"></i><em style="bottom:${Math.round(b.predicted * 100)}%"></em><small>${Math.round(b.predicted * 100)}</small></span>`).join("")}</div></div>`).join("")}` : ""}
      ${live.some(([, t]) => t.byGrade) ? `<p class="pl-sub"><b>Live record by confidence</b>: ${live.map(([k, t]) => `${esc(name(k))}: ${Object.entries(t.byGrade || {}).map(([g, x]) => `${g} ${x.n} props, ours ${n2(x.model)} vs market ${n2(x.market)}`).join(", ")}`).join(" · ")}</p>` : ""}
      ${live.length ? `<p class="pl-sub"><b>Live record</b> (real lines, graded after each game): ${live.map(([k, t]) => `${esc(name(k))}: ${t.n} props, ours ${n2(t.model.logLoss)} vs market ${n2(t.market.logLoss)}, best market weight ${Math.round(t.blend.marketWeight * 100)}%`).join(" · ")}. Retuned daily from these results (see docs/model-changelog.md).</p>${live.some(([, t]) => t.bets?.all?.n) ? `<p class="pl-sub"><b>Edge Board picks</b> (positive EV, 1 unit each): ${live.filter(([, t]) => t.bets?.all?.n).map(([k, t]) => `${esc(name(k))}: ${t.bets.all.n} bets, ROI ${roi(t.bets.all.roi)} (expected ${roi(t.bets.all.expected)})${Object.entries(t.bets.byGrade).map(([g, x]) => ` · ${g} ${x.n} @ ${roi(x.roi)}`).join("")}`).join(" | ")}</p>` : ""}` : `<p class="pl-sub">Live record: starts filling in as tonight's props are graded.</p>`}
    </details>`;
  }

  function render(el, DATA, api) {
    if (!report && !reportReq) loadReport().then(() => { if (!el.hidden) render(el, DATA, api); });
    const all = rows(DATA), shown = all.slice(0, opts.show);
    const leagues = Object.entries(DATA.sports).filter(([, s]) => s.players?.length);
    el.querySelector("#edgeBody").innerHTML = `
      <div class="edge-ctrls card">
        <label>League <select id="edgeLeague"><option value="all">All</option>${leagues.map(([k, s]) => `<option value="${k}"${opts.league === k ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
        <label>Minimum EV <select id="edgeMin">${[[-1, "Any"], [0, "0%+"], [0.02, "2%+"], [0.05, "5%+"], [0.1, "10%+"]].map(([v, l]) => `<option value="${v}"${+opts.minEv === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Confidence <select id="edgeConf">${[["any", "Any"], ["medium", "Medium+"], ["high", "High only"]].map(([v, l]) => `<option value="${v}"${opts.minConf === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="edge-search">Search <input id="edgeQ" type="search" placeholder="Player, team or stat" value="${esc(opts.q)}" autocomplete="off"/></label>
        <label class="check"><input type="checkbox" id="edgeMarket"${opts.marketOnly ? " checked" : ""}/> Only props with a price to bet</label>
      </div>
      ${accuracy(DATA)}
      <div class="pl-sub edge-note">${all.length} prop${all.length === 1 ? "" : "s"} · EV uses our projection blended with the market's vig-free price at that line (market weight ${Math.round(((window.PropModel.cfg(opts.league === "all" ? "nba" : opts.league).marketWeight) || 0.5) * 100)}%), after Kalshi fees where they apply. Confidence (High / Medium / Low) drops for injury news, untested teammate boosts, role changes, thin or long-shot markets and big disagreement with the market; hover a badge for why. Above +25% usually means the model is missing something: check before betting. Not betting advice.</div>
      <div class="edge-list">${shown.map((x, i) => {
        const { p, r, stat, label, lg, sp } = x, b = r.best, warn = b && b.ev > 0.25;
        return `<div class="card edge-row" role="button" tabindex="0" data-pid="${esc(p.id)}" data-k="${esc(stat)}" data-sport="${esc(lg)}">
          <span class="er-rank">${i + 1}</span>
          ${api.avatar(p, 44, "", sp)}
          <span class="er-main"><b>${esc(p.name)}</b> <span class="pl-sub">${esc(sp.name)} · ${esc(p.team)} ${p.home ? "vs" : "@"} ${esc(p.opp)}</span>
            <span class="er-prop">${b ? `${b.side === "over" ? "Over" : "Under"} ${b.line}` : `Line ${r.line}`} ${esc(label)} <span class="pl-sub">· projection <b>${r.proj.mean}</b></span></span>
            <span class="er-chips">${chips(p, r.proj, stat).map(([c, t]) => `<span class="echip ${c}">${esc(t)}</span>`).join("")}${warn ? `<span class="echip warn">Big disagreement: check news</span>` : ""}</span></span>
          <span class="er-num">${b ? `<span class="er-ev" style="color:${b.ev >= 0 ? "var(--hit)" : "var(--miss)"}">${evTxt(b.ev)}</span><span class="pl-sub">${odds(b.price)} ${esc(b.book)}</span><span class="pl-sub">we say ${pct(b.prob)}</span>${confBadge(r.confidence)}${b.book === "Kalshi" && (b.href || b.tk) && window.PropKalshi ? window.PropKalshi.link(b, "Open in Kalshi", "kalshi-link er-link") : ""}`
            : `<span class="er-ev">${pct(r.probs.over > 0.5 ? r.probs.over : r.probs.under)}</span><span class="pl-sub">${r.probs.over > 0.5 ? "over" : "under"} · fair ${odds(r.probs.over > 0.5 ? r.fairOver : r.fairUnder)}</span><span class="pl-sub">no price yet</span>${confBadge(r.confidence)}`}</span>
        </div>`; }).join("") || `<div class="card empty">Nothing matches. Lower the minimum EV, or untick "Only props with a price".</div>`}</div>
      ${all.length > shown.length ? `<button class="chip" id="edgeMore">Show more (${all.length - shown.length} left)</button>` : ""}`;
    const q = s => el.querySelector(s);
    q("#edgeLeague").onchange = e => { opts.league = e.target.value; save(); render(el, DATA, api); };
    q("#edgeMin").onchange = e => { opts.minEv = +e.target.value; save(); render(el, DATA, api); };
    q("#edgeConf").onchange = e => { opts.minConf = e.target.value; save(); render(el, DATA, api); };
    q("#edgeMarket").onchange = e => { opts.marketOnly = e.target.checked; save(); render(el, DATA, api); };
    q("#edgeQ").oninput = e => { opts.q = e.target.value; clearTimeout(q("#edgeQ")._t); q("#edgeQ")._t = setTimeout(() => { save(); render(el, DATA, api); setTimeout(() => { const n = el.querySelector("#edgeQ"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 250); };
    if (q("#edgeMore")) q("#edgeMore").onclick = () => { opts.show += 60; render(el, DATA, api); };
    el.querySelectorAll(".edge-row").forEach(b => {
      const open = () => api.openProp(b.dataset.sport, b.dataset.pid, b.dataset.k);
      b.onclick = e => { if (!e.target.closest("[data-kalshi-link]")) open(); };
      b.onkeydown = e => { if ((e.key === "Enter" || e.key === " ") && e.target === b) { e.preventDefault(); open(); } };
    });
  }
  window.PropEdge = { render, chips, confBadge };
})();
