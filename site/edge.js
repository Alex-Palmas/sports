/* Edge Board: every prop tonight ranked by expected value, with the reasons behind each projection. */
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const odds = a => a == null ? "—" : (a > 0 ? "+" : "") + a;
  const pct = x => x == null ? "—" : Math.round(x * 100) + "%";
  /** "Tonight 9:00 PM" / "Tomorrow 9:00 PM" / "Thu 9:00 PM" in the viewer's time zone. */
  function when(iso) {
    const d = new Date(iso), t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const day = x => new Date(x).toDateString(), now = Date.now();
    if (day(d) === day(now)) return `Today ${t}`;
    if (day(d) === day(now + 86400e3)) return `Tomorrow ${t}`;
    return `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
  }
  const evTxt = e => (e >= 0 ? "+" : "") + (e * 100).toFixed(1) + "%";
  const fitN = () => (window.PropModel?.EDGE_FIT?.nba?.n || 28431).toLocaleString();
  let opts = { league: "all", minEv: 0.02, grades: ["High", "Medium", "Low"], sort: "ev", marketOnly: true, q: "", show: 60, day: "all", stat: "all" };
  // local calendar day of a game, and a friendly label for it
  const dayKey = iso => { if (!iso) return ""; const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const dayLabel = k => { const t = dayKey(new Date().toISOString()), tm = dayKey(new Date(Date.now() + 86400e3).toISOString());
    return k === t ? "Today" : k === tm ? "Tomorrow" : k ? new Date(k + "T12:00:00").toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }) : "Date TBD"; };
  const GRADES = ["High", "Medium", "Low"];
  const SORTS = { ev: "Best EV", conf: "Highest confidence", adj: "EV × confidence" };
  let gradeCounts = {}, statCounts = {};
  /** Confidence badge: grade + score, with the reasons in the tooltip. */
  const confBadge = c => c ? `<span class="conf conf-${c.grade.toLowerCase()}" title="${esc(c.why.length ? c.why.map(w => `−${w.pts} ${w.txt}`).join("\n") : "Nothing lowers confidence")}"><i></i>${c.grade} ${c.score}</span>` : "";
  try { Object.assign(opts, JSON.parse(localStorage.getItem((window.PROPLAB_NS || "proplab:") + "edge") || "{}")); } catch {}
  // older saved setting (a minimum grade) → the grade chips
  if (opts.minConf) { opts.grades = { high: ["High"], medium: ["High", "Medium"] }[opts.minConf] || opts.grades; delete opts.minConf; }
  if (!Array.isArray(opts.grades) || !opts.grades.length) opts.grades = ["High", "Medium", "Low"];
  const save = () => { try { localStorage.setItem((window.PROPLAB_NS || "proplab:") + "edge", JSON.stringify({ ...opts, show: 60 })); } catch {} };

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

  /** "▲3¢" when the leg's ask changed in the last live refresh (within 10 minutes). */
  function movedTag(p, stat, b) {
    const q = (p.market?.[stat] || []).find(x => x.b === "Kalshi" && x.l === b.line && x.tk === b.tk);
    if (!q?.movedAt || Date.now() - q.movedAt > 10 * 60e3) return "";
    const yes = b.side === "over", now = yes ? q.ya : q.na, was = yes ? q.pya : q.pna;
    if (now == null || was == null) return "";
    const d = Math.round(now * 100) - Math.round(was * 100); if (!d) return "";
    return ` <span class="kmove ${d > 0 ? "up" : "down"}" title="Was ${Math.round(was * 100)}¢">${d > 0 ? "▲" : "▼"}${Math.abs(d)}¢</span>`;
  }
  function rows(DATA) {
    const M = window.PropModel; const out = []; gradeCounts = {}; statCounts = {};
    for (const [lg, sp] of Object.entries(DATA.sports)) {
      if (opts.league !== "all" && opts.league !== lg) continue;
      for (const p of sp.players || []) for (const stat of Object.keys(p.lines || {})) {
        const r = M.bestBet(p, stat, lg); if (!r) continue;
        const label = sp.stats.find(s => s.key === stat)?.label || stat;
        if (opts.q && !`${p.name} ${p.team} ${label}`.toLowerCase().includes(opts.q.toLowerCase())) continue;
        const statOk = opts.stat === "all" || opts.stat === stat;
        if (r.best) { if (r.best.ev < opts.minEv) continue; }
        else if (opts.marketOnly) continue;
        const g = r.confidence?.grade || "Low";
        if (opts.grades.includes(g)) statCounts[stat] = (statCounts[stat] || 0) + 1;   // per-stat counts under the grade filter
        if (!statOk) continue;
        gradeCounts[g] = (gradeCounts[g] || 0) + 1;   // counted before the grade filter, for the chips
        if (!opts.grades.includes(g)) continue;
        // no market: rank by how far the projection is from the line, in standard deviations
        const z = r.proj.sd ? Math.abs(r.proj.mean - r.line) / Math.max(r.proj.sd, 1) : 0;
        const ev = r.best ? r.best.ev : z * 0.05 - 1, conf = r.confidence?.score ?? 0;
        const score = opts.sort === "conf" ? conf * 10 + Math.max(-1, Math.min(1, ev))   // confidence first, EV breaks ties
          : opts.sort === "adj" && r.best ? ev * conf / 100 : ev;
        out.push({ lg, sp, p, stat, label, r, score });
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

  /** Stat chips (Points · Rebounds · Assists · 3PTM · P+R · P+A · R+A · PRA …) under the confidence bar. */
  function statBar(DATA) {
    const SHORT = window.PropShort || {}, seen = new Map();
    for (const [lg, sp] of Object.entries(DATA.sports)) {
      if (opts.league !== "all" && opts.league !== lg) continue;
      for (const st of sp.stats || []) if (!seen.has(st.key) && (sp.players || []).some(p => p.lines?.[st.key] != null)) seen.set(st.key, SHORT[st.key] || st.label);
    }
    if (opts.stat !== "all" && !seen.has(opts.stat)) opts.stat = "all";
    return `<div class="stat-strip edge-stats" role="toolbar" aria-label="Prop type">${[["all", "All"], ...seen].map(([k, l]) => `<button class="ss-chip${opts.stat === k ? " active" : ""}" data-estat="${k}" aria-pressed="${opts.stat === k}">${esc(l)}${k !== "all" && statCounts[k] ? ` <b>${statCounts[k]}</b>` : ""}</button>`).join("")}</div>`;
  }

  // ---------------------------------------------------------------- live Kalshi prices
  // While the Edge Board is open, Kalshi quotes for games that haven't started are refreshed every
  // minute (through the Mac app's built-in relay, or your own relay on the web) and the board re-ranks.
  const LIVE_MS = 60e3;
  const live = { at: null, err: null, busy: false, timer: null, n: 0 };
  const feeOf = x => Math.ceil(0.07 * x * (1 - x) * 100 - 1e-9) / 100;
  function kalshiQuotes(DATA) {
    const now = Date.now(), out = [];
    for (const sp of Object.values(DATA.sports)) for (const p of sp.players || []) {
      if (p.gameDate && Date.parse(p.gameDate) < now - 5 * 60e3) continue;   // started: in-game prices aren't pre-game edges
      for (const qs of Object.values(p.market || {})) for (const q of qs || []) if (q.b === "Kalshi" && q.tk) out.push(q);
    }
    return out;
  }
  async function refreshLive(DATA) {
    const K = window.PropKalshi, M = window.PropModel;
    if (live.busy || !K?.markets) return false;
    const qs = kalshiQuotes(DATA); if (!qs.length) return false;
    live.busy = true;
    try {
      const byTk = new Map(); for (const q of qs) (byTk.get(q.tk) || byTk.set(q.tk, []).get(q.tk)).push(q);
      const ms = await K.markets([...byTk.keys()]);
      let moved = 0;
      for (const m of ms) for (const q of byTk.get(m.ticker) || []) {
        const ya = parseFloat(m.yes_ask_dollars), na = parseFloat(m.no_ask_dollars);
        const open = !m.status || /active|open/i.test(m.status);
        if (!open || !(ya > 0.02 && ya < 0.98 && na > 0.02 && na < 0.98) || ya + na > 1.12) { q.o = q.u = null; continue; }   // not tradable now: drop from the board
        if (q.ya != null && (Math.round(q.ya * 100) !== Math.round(ya * 100) || Math.round(q.na * 100) !== Math.round(na * 100))) { q.pya = q.ya; q.pna = q.na; q.movedAt = Date.now(); moved++; }
        q.ya = +ya.toFixed(4); q.na = +na.toFixed(4);
        q.o = M.toAmerican(Math.min(0.99, ya + feeOf(ya))); q.u = M.toAmerican(Math.min(0.99, na + feeOf(na)));
        if (m.volume_fp != null) q.vol = Math.round(parseFloat(m.volume_fp));
      }
      live.at = Date.now(); live.err = null; live.n = ms.length; live.moved = moved;
      return true;
    } catch (e) { live.err = e.message; return false; }
    finally { live.busy = false; }
  }
  /** Start (or keep) the refresh loop for this view; it stops itself when the Edge tab is hidden. */
  function startLive(el, DATA, api) {
    if (live.timer) return;
    const tick = async () => {
      if (el.hidden) { clearInterval(live.timer); live.timer = null; return; }
      if (document.hidden) return;
      const ok = await refreshLive(DATA);
      // don't redraw under a bet that's being confirmed or placed
      if (!el.hidden && !el.querySelector("[data-qbet][data-armed],[data-qbet][data-busy],.qmove")) render(el, DATA, api, true);
      else if (ok) live.pending = true;
    };
    live.timer = setInterval(tick, LIVE_MS);
    if (!live.at || Date.now() - live.at > LIVE_MS) tick();
  }
  const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`; };
  function liveStatus(DATA) {
    const src = window.PropKalshi?.liveSource?.() === "app" ? "the PropLab app" : "your relay";
    if (live.at) return `<span class="live-dot on"></span>Kalshi prices live · updated ${ago(live.at)}${live.moved ? ` · ${live.moved} moved` : ""} · every minute`;
    if (live.err) return `<span class="live-dot"></span>Kalshi prices from the ${DATA.generated ? new Date(DATA.generated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "last"} data refresh. Live updates need ${src} (${esc(live.err.replace(/ \(see Settings.*$/, ""))}).`;
    return `<span class="live-dot"></span>Getting live Kalshi prices…`;
  }
  /** Inline "price moved" question in the row; resolves true when you accept the new price. */
  function askMove(btn, { was, now, buy, prob, ev }) {
    return new Promise(resolve => {
      const box = document.createElement("span"); box.className = "qmove"; box.setAttribute("role", "alertdialog");
      const up = now > was;
      box.innerHTML = `<span><b>Price moved</b> ${buy.toUpperCase()} ${Math.round(was * 100)}¢ → <b style="color:${up ? "var(--miss)" : "var(--hit)"}">${Math.round(now * 100)}¢</b>${prob != null ? ` · we make it ${pct(prob)} · EV <b style="color:${ev >= 0 ? "var(--hit)" : "var(--miss)"}">${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}¢</b>${ev < 0 ? " (no edge now)" : ""}` : ""}</span>
        <button type="button" class="qm-yes">Accept ${Math.round(now * 100)}¢</button><button type="button" class="qm-no">Cancel</button>`;
      btn.after(box);
      const done = v => { clearTimeout(t); box.remove(); resolve(v); };
      const t = setTimeout(() => done(false), 20000);
      box.onclick = e => e.stopPropagation();
      box.querySelector(".qm-yes").onclick = () => done(true);
      box.querySelector(".qm-no").onclick = () => done(false);
      box.querySelector(ev != null && ev < 0 ? ".qm-no" : ".qm-yes").focus();
    });
  }

  function render(el, DATA, api, fromLive) {
    startLive(el, DATA, api);
    live.pending = false;
    const scrollY = fromLive ? window.scrollY : null;
    if (!report && !reportReq) loadReport().then(() => { if (!el.hidden) render(el, DATA, api); });
    const ranked = rows(DATA), days = [...new Set(ranked.map(x => dayKey(x.p.gameDate)))].sort();
    if (opts.day !== "all" && !days.includes(opts.day)) opts.day = "all";
    // separated by day (earliest first), best EV first within each day
    const all = ranked.filter(x => opts.day === "all" || dayKey(x.p.gameDate) === opts.day)
      .map((x, i) => ({ ...x, day: dayKey(x.p.gameDate), i })).sort((a, b) => a.day.localeCompare(b.day) || a.i - b.i);
    const perDay = {}; for (const x of all) perDay[x.day] = (perDay[x.day] || 0) + 1;
    const ks = window.PropKalshi?.settings?.() || {}, quick = ks.enabled ? Math.min(ks.quickAmount ?? 5, ks.maxOrder ?? 25) : 0, qi = [];
    const taken = {}, shown = all.filter(x => (taken[x.day] = (taken[x.day] || 0) + 1) <= opts.show);   // each day gets its own top N
    let lastDay = null, rank = 0;
    const leagues = Object.entries(DATA.sports).filter(([, s]) => s.players?.length);
    el.querySelector("#edgeBody").innerHTML = `
      <div class="conf-bar card"><div class="cb-row" role="group" aria-label="Filter by confidence"><span class="cf-label">Confidence</span>${GRADES.map(g => `<button type="button" class="conf conf-${g.toLowerCase()} cf-chip${opts.grades.includes(g) ? " on" : ""}" data-grade="${g}" aria-pressed="${opts.grades.includes(g)}"><i></i>${g} <b>${gradeCounts[g] || 0}</b></button>`).join("")}</div>
        ${statBar(DATA)}</div>
      <div class="edge-ctrls card">
        <label>League <select id="edgeLeague"><option value="all">All</option>${leagues.map(([k, s]) => `<option value="${k}"${opts.league === k ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
        <label>Minimum EV <select id="edgeMin">${[[-1, "Any"], [0, "0%+"], [0.02, "2%+"], [0.05, "5%+"], [0.1, "10%+"]].map(([v, l]) => `<option value="${v}"${+opts.minEv === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Day <select id="edgeDay"><option value="all">All days</option>${days.map(d => `<option value="${d}"${opts.day === d ? " selected" : ""}>${esc(dayLabel(d))}</option>`).join("")}</select></label>
        <label>Sort <select id="edgeSort">${Object.entries(SORTS).map(([v, l]) => `<option value="${v}"${opts.sort === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="edge-search">Search <input id="edgeQ" type="search" placeholder="Player, team or stat" value="${esc(opts.q)}" autocomplete="off"/></label>
        <label class="check"><input type="checkbox" id="edgeMarket"${opts.marketOnly ? " checked" : ""}/> Only props with a price to bet</label>
      </div>
      ${accuracy(DATA)}
      <div class="pl-sub edge-live"><span role="status">${liveStatus(DATA)}</span><button type="button" class="chip sm" id="edgeRefresh"${live.busy ? " disabled" : ""}>${live.busy ? "Refreshing…" : "↻ Refresh prices"}</button></div>
      <div class="pl-sub edge-note">${all.length} prop${all.length === 1 ? "" : "s"} · NBA Kalshi props: our chance is Kalshi's own price, recalibrated on ${fitN()} settled markets (the price beat our projection there); elsewhere the projection gets ${Math.round((1 - (window.PropModel.cfg(opts.league === "all" ? "nhl" : opts.league).marketWeight || 0.9)) * 100)}% weight against the market. EV is after Kalshi fees. Confidence (High / Medium / Low) drops for injury news, untested teammate boosts, role changes, thin or long-shot markets and big disagreement with the market; hover a badge for why. Above +25% usually means the model is missing something: check before betting. Not betting advice.</div>
      <div class="edge-list">${shown.map(x => {
        const { p, r, stat, label, lg, sp } = x, b = r.best, warn = b && b.ev > 0.25;
        let head = "";
        if (x.day !== lastDay) { lastDay = x.day; rank = 0; head = `<h3 class="day-head"><span>${esc(dayLabel(x.day))}</span><span class="pl-sub">${perDay[x.day] > opts.show ? `top ${opts.show} of ${perDay[x.day]}` : `${perDay[x.day]} prop${perDay[x.day] === 1 ? "" : "s"}`}</span></h3>`; }
        const i = rank++;
        return `${head}<div class="card edge-row" role="button" tabindex="0" data-pid="${esc(p.id)}" data-k="${esc(stat)}" data-sport="${esc(lg)}">
          <span class="er-rank">${i + 1}</span>
          ${api.avatar(p, 44, "", sp)}
          <span class="er-main"><b>${esc(p.name)}</b>${p.jersey != null && p.jersey !== "" ? ` <span class="jersey">#${esc(p.jersey)}</span>` : ""} <span class="pl-sub">${esc(sp.name)} · ${esc(p.team)} ${p.home ? "vs" : "@"} ${esc(p.opp)}${p.gameDate ? ` · ${esc(when(p.gameDate))}` : ""}</span>
            <span class="er-prop">${b ? `${b.side === "over" ? "Over" : "Under"} ${b.line}` : `Line ${r.line}`} ${esc(label)} <span class="pl-sub">· projection <b>${r.proj.mean}</b></span></span>
            ${b && b.book === "Kalshi" ? `${(() => { const L = window.PropModel.kalshiLeg(b.side, b.line, label, b); return `<span class="kleg"><span class="kleg-k">Kalshi</span> Buy <b class="kleg-${L.action.toLowerCase()}">${L.action}</b> on “${esc(p.name)} ${esc(L.contract)}”${L.cents != null ? ` · ${L.cents}¢` : ""}${movedTag(p, stat, b)}${b.tk && quick ? `<button type="button" class="qbet" data-qbet="${qi.push(x) - 1}" data-action="${L.action}" data-cents="${L.cents ?? ""}">Bet $${quick}</button>` : ""}</span>`; })()}` : ""}
            <span class="er-chips">${chips(p, r.proj, stat).map(([c, t]) => `<span class="echip ${c}">${esc(t)}</span>`).join("")}${warn ? `<span class="echip warn">Big disagreement: check news</span>` : ""}</span></span>
          <span class="er-num">${b ? `<span class="er-ev" style="color:${b.ev >= 0 ? "var(--hit)" : "var(--miss)"}">${evTxt(b.ev)}</span><span class="pl-sub">${odds(b.price)} ${esc(b.book)}</span><span class="pl-sub">we say ${pct(b.prob)}</span>${confBadge(r.confidence)}${b.book === "Kalshi" && (b.href || b.tk) && window.PropKalshi ? window.PropKalshi.link(b, "Open in Kalshi", "kalshi-link er-link") : ""}`
            : `<span class="er-ev">${pct(r.probs.over > 0.5 ? r.probs.over : r.probs.under)}</span><span class="pl-sub">${r.probs.over > 0.5 ? "over" : "under"} · fair ${odds(r.probs.over > 0.5 ? r.fairOver : r.fairUnder)}</span><span class="pl-sub">no price yet</span>${confBadge(r.confidence)}`}</span>
        </div>`; }).join("") || `<div class="card empty">Nothing clears the bar right now. Tested on ${fitN()} settled Kalshi NBA prop markets, Kalshi's own price was already accurate, and almost nothing beats it after the bid/ask spread and Kalshi's fee. An empty board is the honest answer most days. Lower the minimum EV to see the closest calls.</div>`}</div>
      ${all.length > shown.length ? `<button class="chip" id="edgeMore">Show more (${all.length - shown.length} left)</button>` : ""}`;
    const q = s => el.querySelector(s);
    q("#edgeLeague").onchange = e => { opts.league = e.target.value; save(); render(el, DATA, api); };
    q("#edgeMin").onchange = e => { opts.minEv = +e.target.value; save(); render(el, DATA, api); };
    q("#edgeDay").onchange = e => { opts.day = e.target.value; save(); render(el, DATA, api); };
    el.querySelectorAll("[data-estat]").forEach(b => b.onclick = () => { opts.stat = b.dataset.estat; save(); render(el, DATA, api); });
    q("#edgeSort").onchange = e => { opts.sort = e.target.value; save(); render(el, DATA, api); };
    el.querySelectorAll(".cf-chip").forEach(b => b.onclick = () => {
      const g = b.dataset.grade, on = opts.grades.includes(g);
      opts.grades = on ? opts.grades.filter(x => x !== g) : GRADES.filter(x => x === g || opts.grades.includes(x));
      if (!opts.grades.length) opts.grades = [g];   // never filter everything out
      save(); render(el, DATA, api);
    });
    q("#edgeMarket").onchange = e => { opts.marketOnly = e.target.checked; save(); render(el, DATA, api); };
    q("#edgeQ").oninput = e => { opts.q = e.target.value; clearTimeout(q("#edgeQ")._t); q("#edgeQ")._t = setTimeout(() => { save(); render(el, DATA, api); setTimeout(() => { const n = el.querySelector("#edgeQ"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 250); };
    q("#edgeRefresh").onclick = async e => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = "Refreshing…";
      await refreshLive(DATA); render(el, DATA, api, true);
    };
    if (q("#edgeMore")) q("#edgeMore").onclick = () => { opts.show += 60; render(el, DATA, api); };
    // one-tap Kalshi bet: first tap asks to confirm (what, price, amount), second tap places it
    el.querySelectorAll("[data-qbet]").forEach(btn => btn.onclick = async e => {
      e.stopPropagation();
      const x = qi[+btn.dataset.qbet]; if (!x || btn.dataset.busy) return;
      if (!btn.dataset.armed) {
        btn.dataset.armed = "1"; btn.classList.add("armed");
        btn.textContent = `Confirm ${btn.dataset.action}${btn.dataset.cents ? " @ " + btn.dataset.cents + "¢" : ""} · $${quick}`;
        clearTimeout(btn._t); btn._t = setTimeout(() => { delete btn.dataset.armed; btn.classList.remove("armed"); btn.textContent = `Bet $${quick}`; }, 4000);
        return;
      }
      clearTimeout(btn._t); btn.dataset.busy = "1"; btn.classList.remove("armed"); btn.textContent = "Placing…";
      try {
        const r = await window.PropKalshi.quickBet({ p: x.p, sport: x.lg, stat: x.stat, label: x.label, best: x.r.best,
          confirmMove: info => { btn.textContent = "Price moved…"; return askMove(btn, info).then(ok => { if (ok) btn.textContent = "Placing…"; return ok; }); } });
        btn.classList.add("done"); btn.textContent = `Bought ${r.filled} ${r.buy.toUpperCase()} @ ${Math.round(r.each * 100)}¢ · $${r.cost.toFixed(2)}`;
      } catch (er) {
        btn.classList.add("fail"); btn.textContent = er.message; btn.title = er.message;
        setTimeout(() => { delete btn.dataset.busy; delete btn.dataset.armed; btn.classList.remove("fail"); btn.textContent = `Bet $${quick}`; btn.title = ""; }, 6000);
      }
    });
    el.querySelectorAll(".edge-row").forEach(b => {
      const open = () => api.openProp(b.dataset.sport, b.dataset.pid, b.dataset.k);
      b.onclick = e => { if (!e.target.closest("[data-kalshi-link],[data-qbet]")) open(); };
      b.onkeydown = e => { if ((e.key === "Enter" || e.key === " ") && e.target === b) { e.preventDefault(); open(); } };
    });
    if (scrollY != null) window.scrollTo(0, scrollY);
  }
  window.PropEdge = { render, chips, confBadge, refreshLive, live };
})();
