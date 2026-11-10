(() => {
  const DATA = window.PROPLAB_DATA;
  const $ = s => document.querySelector(s);
  const el = (tag, attrs = {}, html = "") => { const e = document.createElement(tag); Object.assign(e, attrs); if (html) e.innerHTML = html; return e; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = { get(k, d) { try { const v = localStorage.getItem("proplab:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem("proplab:" + k, JSON.stringify(v)); } catch {} } };

  const state = {
    sport: store.get("sport", "nba"),
    stat: "all", side: "over", sort: "hit", q: "",
    sel: null, range: "L10", lineAdj: 0,
  };
  if (!DATA.sports[state.sport]) state.sport = "nba";

  // ---------- helpers ----------
  const sport = () => DATA.sports[state.sport];
  const team = abbr => sport().teams.find(t => t.abbr === abbr);
  const statLabel = k => sport().stats.find(s => s.key === k)?.label || k;
  const isHit = (v, line, side) => side === "over" ? v > line : v < line;
  const rate = (logs, k, line, side) => logs.length ? logs.filter(l => isHit(l.stats[k], line, side)).length / logs.length : 0;
  const avg = (logs, k) => logs.length ? logs.reduce((a, l) => a + l.stats[k], 0) / logs.length : 0;
  const median = (logs, k) => { if (!logs.length) return 0; const a = logs.map(l => l.stats[k]).sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const streak = (logs, k, line, side) => { let n = 0; for (const l of logs) { if (isHit(l.stats[k], line, side)) n++; else break; } return n; };
  const pct = x => Math.round(x * 100) + "%";
  const fmt = x => (Math.round(x * 10) / 10).toString();
  const odds = o => (o > 0 ? "+" : "") + o;
  const heat = r => {
    // red -> neutral -> green
    const a = Math.min(1, Math.abs(r - 0.5) * 2.2);
    const c = r >= 0.5 ? `rgba(34,197,94,${0.15 + a * 0.75})` : `rgba(239,68,68,${0.15 + a * 0.75})`;
    return `background:${c};color:${a > 0.55 ? "#fff" : "var(--text)"}`;
  };
  const initials = n => n.split(" ").map(p => p[0]).join("");

  function props() {
    const s = sport(); const out = [];
    for (const p of s.players) for (const k of Object.keys(p.lines)) {
      if (state.stat !== "all" && state.stat !== k) continue;
      const line = p.lines[k];
      out.push({ p, k, line,
        l5: rate(p.logs.slice(0, 5), k, line, state.side),
        l10: rate(p.logs.slice(0, 10), k, line, state.side),
        l20: rate(p.logs.slice(0, 20), k, line, state.side),
        edge: (avg(p.logs.slice(0, 10), k) - line) / Math.max(line, 0.5) * (state.side === "over" ? 1 : -1),
        streak: streak(p.logs, k, line, state.side) });
    }
    const q = state.q.trim().toLowerCase();
    const f = q ? out.filter(x => x.p.name.toLowerCase().includes(q) || x.p.team.toLowerCase().includes(q) || team(x.p.team).name.toLowerCase().includes(q) || statLabel(x.k).toLowerCase().includes(q)) : out;
    const by = { hit: (a, b) => b.l10 - a.l10 || b.l20 - a.l20, edge: (a, b) => b.edge - a.edge, streak: (a, b) => b.streak - a.streak || b.l10 - a.l10, name: (a, b) => a.p.name.localeCompare(b.p.name) }[state.sort];
    return f.sort(by);
  }

  // ---------- rendering ----------
  function renderTabs() {
    const nav = $("#sportTabs"); nav.innerHTML = "";
    for (const [k, s] of Object.entries(DATA.sports)) {
      const b = el("button", { className: k === state.sport ? "active" : "", textContent: s.name });
      b.setAttribute("role", "tab");
      b.onclick = () => { state.sport = k; state.stat = "all"; state.sel = null; store.set("sport", k); renderAll(); };
      nav.append(b);
    }
    const sf = $("#statFilter"); sf.innerHTML = `<option value="all">All props</option>` + sport().stats.map(s => `<option value="${s.key}">${esc(s.label)}</option>`).join("");
    sf.value = state.stat;
  }

  function renderList() {
    const list = $("#propList"); const rows = props(); list.innerHTML = "";
    if (!rows.length) { list.innerHTML = `<li class="empty" style="display:block">No props match.</li>`; return rows; }
    const frag = document.createDocumentFragment();
    for (const r of rows.slice(0, 400)) {
      const li = el("li");
      if (state.sel && state.sel.id === r.p.id && state.sel.k === r.k) li.className = "sel";
      li.innerHTML = `<div style="min-width:0"><div class="pl-name">${esc(r.p.name)}</div>
        <div class="pl-sub">${r.p.team} ${r.p.home ? "vs" : "@"} ${r.p.opp} · ${state.side === "over" ? "O" : "U"} ${r.line} ${esc(statLabel(r.k))}</div></div>
        <div class="pill" style="${heat(r.l5)}">${pct(r.l5)}</div>
        <div class="pill" style="${heat(r.l10)}">${pct(r.l10)}</div>
        <div class="pill" style="${heat(r.l20)}">${pct(r.l20)}</div>`;
      li.onclick = () => select(r.p.id, r.k);
      frag.append(li);
    }
    list.append(frag);
    return rows;
  }

  function select(id, k) {
    state.sel = { id, k }; state.lineAdj = 0;
    document.querySelector(".layout").classList.add("show-detail");
    renderList(); renderDetail();
    if (window.innerWidth <= 900) window.scrollTo(0, 0);
  }

  function rangeLogs(p) {
    const r = state.range;
    if (r === "H2H") return p.logs.filter(l => l.opp === p.opp);
    if (r === "Home") return p.logs.filter(l => l.home);
    if (r === "Away") return p.logs.filter(l => !l.home);
    if (r === "Season") return p.logs;
    return p.logs.slice(0, +r.slice(1));
  }

  function chartSVG(logs, k, line, side) {
    const games = logs.slice().reverse(); // oldest -> newest left to right
    const W = 800, H = 280, P = { l: 36, r: 12, t: 18, b: 40 };
    const max = Math.max(line * 1.4, ...games.map(g => g.stats[k]), 1);
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const bw = Math.min(46, iw / Math.max(games.length, 1) * 0.72);
    const gap = iw / Math.max(games.length, 1);
    const y = v => P.t + ih - (v / max) * ih;
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Game log chart">`;
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) { const v = max * i / ticks; s += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`; }
    games.forEach((g, i) => {
      const v = g.stats[k], x = P.l + gap * i + (gap - bw) / 2;
      const hit = isHit(v, line, side), push = v === line;
      const c = push ? "var(--push)" : hit ? "var(--hit)" : "var(--miss)";
      const h = Math.max(2, (v / max) * ih);
      s += `<rect x="${x}" y="${P.t + ih - h}" width="${bw}" height="${h}" rx="4" fill="${c}"><title>${g.date} ${g.home ? "vs" : "@"} ${g.opp}: ${v}</title></rect>`;
      s += `<text class="bar-label" x="${x + bw / 2}" y="${P.t + ih - h - 5}" text-anchor="middle">${v}</text>`;
      if (games.length <= 20 || i % 2 === 0) s += `<text x="${x + bw / 2}" y="${H - P.b + 15}" text-anchor="middle">${g.opp}</text><text x="${x + bw / 2}" y="${H - P.b + 29}" text-anchor="middle" style="font-size:10px">${g.date.slice(5).replace("-", "/")}</text>`;
    });
    s += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(line)}" y2="${y(line)}" stroke="var(--amber)" stroke-width="2" stroke-dasharray="6 4"/>`;
    s += `<text x="${W - P.r}" y="${y(line) - 6}" text-anchor="end" style="fill:var(--amber);font-weight:700">${line}</text></svg>`;
    return s;
  }

  function renderDetail() {
    const d = $("#detail");
    const s = sport();
    if (!state.sel) {
      const top = props().slice(0, 1)[0];
      if (top) { state.sel = { id: top.p.id, k: top.k }; renderList(); } else { d.innerHTML = `<div class="card empty">Select a prop</div>`; return; }
    }
    const p = s.players.find(x => x.id === state.sel.id); const k = state.sel.k;
    if (!p) { state.sel = null; return renderDetail(); }
    const t = team(p.team), ot = team(p.opp);
    const base = p.lines[k];
    const line = Math.max(0.5, base + state.lineAdj);
    const side = state.side;
    const logs = rangeLogs(p);
    const hr = rate(logs, k, line, side);
    const o = p.odds[k];
    const implied = x => x < 0 ? -x / (-x + 100) : 100 / (x + 100);
    const price = side === "over" ? o.over : o.under;
    const rank = p.oppRank[k];
    const n = s.teamCount;
    const rankTxt = rank <= n / 3 ? "Tough" : rank > n * 2 / 3 ? "Soft" : "Neutral";
    const rankColor = rank <= n / 3 ? "var(--red)" : rank > n * 2 / 3 ? "var(--accent)" : "var(--amber)";

    const splits = [["L5", p.logs.slice(0, 5)], ["L10", p.logs.slice(0, 10)], ["L20", p.logs.slice(0, 20)], ["Season", p.logs], ["H2H", p.logs.filter(l => l.opp === p.opp)], ["Home", p.logs.filter(l => l.home)], ["Away", p.logs.filter(l => !l.home)]];

    d.innerHTML = `
      <button class="mobile-back" id="backBtn">← All props</button>
      <div class="card player-head">
        <div class="avatar" style="background:${t.color}">${initials(p.name)}</div>
        <div class="ph-main"><h1>${esc(p.name)}</h1><div class="pl-sub">${p.pos} · ${esc(t.name)}</div></div>
        <div class="game-tag"><span class="pl-sub">Next game</span><b>${p.team} ${p.home ? "vs" : "@"} ${p.opp} · ${p.gameTime}</b></div>
      </div>
      <div class="card">
        <div class="stat-tabs" id="statTabs">${Object.keys(p.lines).map(sk => `<button class="chip ${sk === k ? "active" : ""}" data-k="${sk}">${esc(statLabel(sk))} ${p.lines[sk]}</button>`).join("")}</div>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="k">Hit rate (${state.range})</div><div class="v" style="color:${hr >= 0.5 ? "var(--hit)" : "var(--miss)"}">${pct(hr)}</div><div class="s">${logs.filter(l => isHit(l.stats[k], line, side)).length}/${logs.length} ${side}</div></div>
        <div class="kpi"><div class="k">Average</div><div class="v">${fmt(avg(logs, k))}</div><div class="s">${(avg(logs, k) - line >= 0 ? "+" : "") + fmt(avg(logs, k) - line)} vs line</div></div>
        <div class="kpi"><div class="k">Median</div><div class="v">${fmt(median(logs, k))}</div><div class="s">${state.range} sample</div></div>
        <div class="kpi"><div class="k">Streak</div><div class="v">${streak(p.logs, k, line, side)}</div><div class="s">straight ${side}s</div></div>
        <div class="kpi"><div class="k">${side} odds</div><div class="v">${odds(price)}</div><div class="s">${pct(implied(price))} implied</div></div>
        <div class="kpi"><div class="k">Opp vs ${esc(statLabel(k))}</div><div class="v" style="color:${rankColor}">${rank}<span style="font-size:13px">/${n}</span></div><div class="s">${rankTxt} matchup</div></div>
      </div>
      <div class="card">
        <div class="chart-top">
          <div class="stat-tabs" id="rangeTabs">${["L5", "L10", "L20", "Season", "H2H", "Home", "Away"].map(r => `<button class="chip ${r === state.range ? "active" : ""}" data-r="${r}">${r}</button>`).join("")}</div>
          <div class="line-ctrl"><button id="lineDown" aria-label="Lower line">−</button><div class="line-val">${side === "over" ? "O" : "U"} ${line}<small>${state.lineAdj ? "alt line" : "main line"}</small></div><button id="lineUp" aria-label="Raise line">+</button></div>
        </div>
        ${logs.length ? chartSVG(logs, k, line, side) : `<div class="empty">No games in this split.</div>`}
      </div>
      <div class="card"><h2>Splits at ${side === "over" ? "O" : "U"} ${line}</h2><div class="splits">
        ${splits.map(([lab, lg]) => { const r = rate(lg, k, line, side); return `<div class="split"><div class="pl-sub">${lab} · ${lg.length} gp</div><b style="font-size:17px">${lg.length ? pct(r) : "—"}</b> <span class="pl-sub">avg ${fmt(avg(lg, k))}</span><div class="bar"><i style="width:${r * 100}%;background:${r >= 0.5 ? "var(--hit)" : "var(--miss)"}"></i></div></div>`; }).join("")}
      </div></div>
      <div class="tables">
        <div class="card"><h2>Game log</h2><table><thead><tr><th>Date</th><th>Opp</th>${p.logs[0].min != null ? `<th class="num">Min</th>` : ""}<th class="num">${esc(statLabel(k))}</th><th class="num">Result</th></tr></thead><tbody>
          ${p.logs.slice(0, 15).map(l => { const h = isHit(l.stats[k], line, side); return `<tr><td>${l.date.slice(5).replace("-", "/")}</td><td>${l.home ? "vs" : "@"} ${l.opp}</td>${l.min != null ? `<td class="num">${l.min}</td>` : ""}<td class="num">${l.stats[k]}</td><td class="num ${h ? "h-over" : "h-under"}">${l.stats[k] === line ? "PUSH" : h ? "HIT" : "MISS"}</td></tr>`; }).join("")}
        </tbody></table></div>
        <div class="card"><h2>Alt lines (L10)</h2><table><thead><tr><th>Line</th><th class="num">Over</th><th class="num">Under</th></tr></thead><tbody>
          ${altLines(base).map(L => { const lg = p.logs.slice(0, 10); const ov = rate(lg, k, L, "over"), un = rate(lg, k, L, "under"); return `<tr${L === line ? ` style="background:var(--panel2)"` : ""}><td><b>${L}</b>${L === base ? ` <span class="pl-sub">main</span>` : ""}</td><td class="num"><span class="pill" style="display:inline-block;width:52px;${heat(ov)}">${pct(ov)}</span></td><td class="num"><span class="pill" style="display:inline-block;width:52px;${heat(un)}">${pct(un)}</span></td></tr>`; }).join("")}
        </tbody></table>
        <h2 style="margin-top:16px">${esc(ot.name)} matchup</h2>
        <div class="pl-sub">Ranked ${rank} of ${n} in ${esc(statLabel(k))} allowed (1 = toughest). ${(() => { const h = p.logs.filter(l => l.opp === p.opp); return h.length ? `${esc(p.name.split(" ")[0])} averages ${fmt(avg(h, k))} in ${h.length} game${h.length > 1 ? "s" : ""} vs ${p.opp} this season.` : `No meetings with ${p.opp} yet this season.`; })()}</div>
        </div>
      </div>`;

    $("#backBtn").onclick = () => document.querySelector(".layout").classList.remove("show-detail");
    d.querySelectorAll("#statTabs .chip").forEach(b => b.onclick = () => select(p.id, b.dataset.k));
    d.querySelectorAll("#rangeTabs .chip").forEach(b => b.onclick = () => { state.range = b.dataset.r; renderDetail(); });
    $("#lineDown").onclick = () => { if (base + state.lineAdj - 1 >= 0.5) { state.lineAdj -= 1; renderDetail(); } };
    $("#lineUp").onclick = () => { state.lineAdj += 1; renderDetail(); };
  }

  function altLines(base) {
    const step = base >= 60 ? 10 : base >= 15 ? 2 : 1;
    const out = [];
    for (let i = -3; i <= 3; i++) { const L = base + i * step; if (L >= 0.5) out.push(L); }
    return out;
  }

  function renderAll() { renderTabs(); renderList(); renderDetail(); }

  // ---------- events ----------
  $("#search").oninput = e => { state.q = e.target.value; renderList(); };
  $("#statFilter").onchange = e => { state.stat = e.target.value; state.sel = null; renderList(); renderDetail(); };
  $("#sortBy").onchange = e => { state.sort = e.target.value; renderList(); };
  document.querySelectorAll("#sideToggle button").forEach(b => b.onclick = () => {
    state.side = b.dataset.side;
    document.querySelectorAll("#sideToggle button").forEach(x => x.classList.toggle("active", x === b));
    renderList(); renderDetail();
  });
  const theme = store.get("theme", null);
  if (theme) document.documentElement.dataset.theme = theme;
  $("#themeBtn").onclick = () => { const t = document.documentElement.dataset.theme === "light" ? "dark" : "light"; document.documentElement.dataset.theme = t; store.set("theme", t); };

  renderAll();
})();
