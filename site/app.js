(async () => {
  let DATA = window.PROPLAB_DATA, LIVE = false;
  try {
    const r = await fetch("data.json", { cache: "no-cache" });
    if (r.ok) { const d = await r.json(); if (d && d.sports) { DATA = d; LIVE = true; } }
  } catch {}
  const $ = s => document.querySelector(s);
  const el = (tag, attrs = {}, html = "") => { const e = document.createElement(tag); Object.assign(e, attrs); if (html) e.innerHTML = html; return e; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = { get(k, d) { try { const v = localStorage.getItem("proplab:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem("proplab:" + k, JSON.stringify(v)); } catch {} } };

  const state = {
    sport: store.get("sport", "nba"),
    stat: "all", side: "over", sort: "hit", q: "",
    sel: null, range: "L10", lineAdj: 0,
  };
  if (!DATA.sports[state.sport] || !DATA.sports[state.sport].players.length) state.sport = Object.keys(DATA.sports).find(k => DATA.sports[k].players.length) || "nba";

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
  const initials = n => n.split(" ").map(p => p[0]).join("").slice(0, 3);
  const gameWhen = p => {
    if (!p.gameDate) return p.gameTime || "";
    const d = new Date(p.gameDate);
    const day = d.toDateString() === new Date().toDateString() ? "Today" : d.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" });
    return `${day} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  };
  const curSeason = p => p.logs.filter(l => l.season === p.logs[0]?.season);
  const isProj = (p, k) => p.lineSource && p.lineSource[k] === "proj";
  // ---- line shopping
  const impl = a => a < 0 ? -a / (100 - a) : 100 / (a + 100);          // implied probability of American odds
  const dec = a => a < 0 ? 1 + 100 / -a : 1 + a / 100;                  // decimal odds
  const quotes = (p, k) => (p.market && p.market[k]) || [];
  const priceOf = (q, side) => side === "over" ? q.o : q.u;
  // market's fair (no-vig) probability for a side
  const fairP = (q, side) => { const io = q.o != null ? impl(q.o) : null, iu = q.u != null ? impl(q.u) : null;
    if (io != null && iu != null) return side === "over" ? io / (io + iu) : iu / (io + iu);
    return side === "over" ? io : iu; };
  // our probability: last-20 hit rate, shrunk toward the market's fair price (worth PRIOR games),
  // so a 12-game sample can't turn a 9% longshot into a 21% "lock"
  const PRIOR = 10;
  const modelP = (p, k, line, side, q) => { const lg = p.logs.slice(0, 20); const h = lg.filter(l => isHit(l.stats[k], line, side)).length;
    const prior = q ? fairP(q, side) : 0.5; return (h + PRIOR * prior) / (lg.length + PRIOR); };
  const evOf = (prob, price) => prob * (dec(price) - 1) - (1 - prob);
  // comparable "main" quotes: each book's main line + the Kalshi strike closest to 50/50
  const mainQuotes = (p, k) => {
    const qs = quotes(p, k), out = qs.filter(q => q.k !== "kalshi" && !q.alt);
    const ks = qs.filter(q => q.k === "kalshi").sort((a, b) => Math.abs(fairP(a, "over") - 0.5) - Math.abs(fairP(b, "over") - 0.5));
    if (ks[0]) out.push(ks[0]);
    return out;
  };
  // best line: over → lowest line (then best price); under → highest line (then best price)
  const bestLine = (p, k, side) => mainQuotes(p, k).filter(q => priceOf(q, side) != null)
    .sort((a, b) => (side === "over" ? a.l - b.l : b.l - a.l) || priceOf(b, side) - priceOf(a, side))[0] || null;
  // best value: highest EV among realistic prices (fair 20–80%)
  const bestValue = (p, k, side) => {
    let best = null;
    for (const q of quotes(p, k)) { const pr = priceOf(q, side); if (pr == null) continue; const f = fairP(q, side); if (f < 0.2 || f > 0.8) continue;
      const ev = evOf(modelP(p, k, q.l, side, q), pr); if (!best || ev > best.ev) best = { q, ev, price: pr }; }
    return best;
  };
  const evTxt = ev => (ev >= 0 ? "+" : "") + Math.round(ev * 100) + "%";
  const evColor = ev => ev >= 0.03 ? "var(--hit)" : ev <= -0.03 ? "var(--miss)" : "var(--muted)";
  const shortBook = b => ({ DraftKings: "DK", FanDuel: "FD", BetMGM: "MGM", Caesars: "CZR", "ESPN BET": "ESPN", BetRivers: "BR", Fanatics: "FAN", Kalshi: "Kalshi", Bovada: "BOV", "Hard Rock Bet": "HR" }[b] || b);

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
        streak: streak(p.logs, k, line, state.side),
        val: bestValue(p, k, state.side) });
    }
    const q = state.q.trim().toLowerCase();
    if (state.marketOnly) out.splice(0, out.length, ...out.filter(x => x.val));
    const f = q ? out.filter(x => x.p.name.toLowerCase().includes(q) || x.p.team.toLowerCase().includes(q) || team(x.p.team).name.toLowerCase().includes(q) || statLabel(x.k).toLowerCase().includes(q)) : out;
    const by = { hit: (a, b) => b.l10 - a.l10 || b.l20 - a.l20, edge: (a, b) => b.edge - a.edge, value: (a, b) => (b.val ? b.val.ev : -9) - (a.val ? a.val.ev : -9) || b.l10 - a.l10, streak: (a, b) => b.streak - a.streak || b.l10 - a.l10, name: (a, b) => a.p.name.localeCompare(b.p.name) }[state.sort];
    return f.sort(by);
  }

  // ---------- rendering ----------
  function renderTabs() {
    const nav = $("#sportTabs"); nav.innerHTML = "";
    for (const [k, s] of Object.entries(DATA.sports)) {
      const b = el("button", { className: k === state.sport ? "active" : "", textContent: s.name });
      if (!s.players.length) b.classList.add("off");
      if (!s.players.length) b.title = s.note || "No upcoming games";
      b.setAttribute("role", "tab");
      b.onclick = () => { state.sport = k; state.stat = "all"; state.sel = null; store.set("sport", k); renderAll(); };
      nav.append(b);
    }
    const sf = $("#statFilter"); sf.innerHTML = `<option value="all">All props</option>` + sport().stats.map(s => `<option value="${s.key}">${esc(s.label)}</option>`).join("");
    sf.value = state.stat;
  }

  function renderList() {
    const list = $("#propList"); const rows = props(); list.innerHTML = "";
    if (!rows.length) { list.innerHTML = `<li class="empty" style="display:block">${esc(sport().players.length ? "No props match." : (sport().note || "No upcoming games."))}</li>`; return rows; }
    const frag = document.createDocumentFragment();
    for (const r of rows.slice(0, 400)) {
      const li = el("li");
      if (state.sel && state.sel.id === r.p.id && state.sel.k === r.k) li.className = "sel";
      li.innerHTML = `<div style="min-width:0"><div class="pl-name">${esc(r.p.name)}</div>
        <div class="pl-sub">${r.p.team} ${r.p.home ? "vs" : "@"} ${r.p.opp} · ${state.side === "over" ? "O" : "U"} ${r.line} ${esc(statLabel(r.k))}${isProj(r.p, r.k) ? ` <span class="tag">proj</span>` : ""}</div>
        ${r.val ? `<div class="pl-sub best-row">Best: ${state.side === "over" ? "O" : "U"} ${r.val.q.l} <b>${odds(r.val.price)}</b> ${esc(shortBook(r.val.q.b))} · <span style="color:${evColor(r.val.ev)};font-weight:700">EV ${evTxt(r.val.ev)}</span></div>` : ""}</div>
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
    if (r === "Season") return curSeason(p);
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
      if (top) { state.sel = { id: top.p.id, k: top.k }; renderList(); } else { d.innerHTML = `<div class="card empty">${esc(s.players.length ? "Select a prop" : (s.note || "No upcoming games for this league."))}</div>`; return; }
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
    const price = o ? (side === "over" ? o.over : o.under) : null;
    const rank = p.oppRank[k];
    const n = s.teamCount;
    const rankTxt = rank <= n / 3 ? "Tough" : rank > n * 2 / 3 ? "Soft" : "Neutral";
    const rankColor = rank <= n / 3 ? "var(--red)" : rank > n * 2 / 3 ? "var(--accent)" : "var(--amber)";

    const splits = [["L5", p.logs.slice(0, 5)], ["L10", p.logs.slice(0, 10)], ["L20", p.logs.slice(0, 20)], ["Season", curSeason(p)], ["Last 40", p.logs], ["H2H", p.logs.filter(l => l.opp === p.opp)], ["Home", p.logs.filter(l => l.home)], ["Away", p.logs.filter(l => !l.home)]];

    d.innerHTML = `
      <button class="mobile-back" id="backBtn">← All props</button>
      <div class="card player-head">
        <div class="avatar" style="background:${t ? t.color : "#64748b"}">${p.headshot ? `<img src="${esc(p.headshot)}" alt="" onerror="this.remove()">` : ""}<span>${esc(initials(p.name))}</span></div>
        <div class="ph-main"><h1>${esc(p.name)}${p.injury ? ` <span class="tag inj">${esc(p.injury)}</span>` : ""}</h1><div class="pl-sub">${esc(p.pos)} · ${esc(t ? t.name : p.team)}</div></div>
        <div class="game-tag"><span class="pl-sub">Next game</span><b>${p.team} ${p.home ? "vs" : "@"} ${p.opp} · ${esc(gameWhen(p))}</b></div>
      </div>
      <div class="card">
        <div class="stat-tabs" id="statTabs">${Object.keys(p.lines).map(sk => `<button class="chip ${sk === k ? "active" : ""}" data-k="${sk}">${esc(statLabel(sk))} ${p.lines[sk]}</button>`).join("")}</div>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="k">Hit rate (${state.range})</div><div class="v" style="color:${hr >= 0.5 ? "var(--hit)" : "var(--miss)"}">${pct(hr)}</div><div class="s">${logs.filter(l => isHit(l.stats[k], line, side)).length}/${logs.length} ${side}</div></div>
        <div class="kpi"><div class="k">Average</div><div class="v">${fmt(avg(logs, k))}</div><div class="s">${(avg(logs, k) - line >= 0 ? "+" : "") + fmt(avg(logs, k) - line)} vs line</div></div>
        <div class="kpi"><div class="k">Median</div><div class="v">${fmt(median(logs, k))}</div><div class="s">${state.range} sample</div></div>
        <div class="kpi"><div class="k">Streak</div><div class="v">${streak(p.logs, k, line, side)}</div><div class="s">straight ${side}s</div></div>
        ${(() => { const bv = bestValue(p, k, side); return bv
          ? `<div class="kpi"><div class="k">Best value</div><div class="v" style="color:${evColor(bv.ev)}">EV ${evTxt(bv.ev)}</div><div class="s">${side === "over" ? "O" : "U"} ${bv.q.l} ${odds(bv.price)} · ${esc(bv.q.b)}</div></div>`
          : `<div class="kpi"><div class="k">${side} odds</div><div class="v">${price != null ? odds(price) : "—"}</div><div class="s">${price != null ? `${pct(implied(price))} implied` : "projected line, no market"}</div></div>`; })()}
        <div class="kpi"><div class="k">Opp vs ${esc(statLabel(k))}</div><div class="v" style="color:${rankColor}">${rank}<span style="font-size:13px">/${n}</span></div><div class="s">${rankTxt} matchup</div></div>
      </div>
      <div class="card">
        <div class="chart-top">
          <div class="stat-tabs" id="rangeTabs">${["L5", "L10", "L20", "Season", "H2H", "Home", "Away"].map(r => `<button class="chip ${r === state.range ? "active" : ""}" data-r="${r}">${r}</button>`).join("")}</div>
          <div class="line-ctrl"><button id="lineDown" aria-label="Lower line">−</button><div class="line-val">${side === "over" ? "O" : "U"} ${line}<small>${state.lineAdj ? "alt line" : isProj(p, k) ? "projected" : "book line"}</small></div><button id="lineUp" aria-label="Raise line">+</button></div>
        </div>
        ${logs.length ? chartSVG(logs, k, line, side) : `<div class="empty">No games in this split.</div>`}
      </div>
      ${shopCard(p, k, side, line)}
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
        <h2 style="margin-top:16px">${esc(ot ? ot.name : p.opp)} matchup</h2>
        <div class="pl-sub">${rank ? `Ranked ${rank} of ${n} in ${esc(statLabel(k))} allowed (1 = toughest).` : ""} ${(() => { const h = p.logs.filter(l => l.opp === p.opp); return h.length ? `${esc(p.name.split(" ")[0])} averages ${fmt(avg(h, k))} in ${h.length} game${h.length > 1 ? "s" : ""} vs ${p.opp} this season.` : `No meetings with ${p.opp} yet this season.`; })()}</div>
        </div>
      </div>`;

    $("#backBtn").onclick = () => document.querySelector(".layout").classList.remove("show-detail");
    d.querySelectorAll("#statTabs .chip").forEach(b => b.onclick = () => select(p.id, b.dataset.k));
    d.querySelectorAll("#rangeTabs .chip").forEach(b => b.onclick = () => { state.range = b.dataset.r; renderDetail(); });
    $("#lineDown").onclick = () => { if (base + state.lineAdj - 1 >= 0.5) { state.lineAdj -= 1; renderDetail(); } };
    $("#lineUp").onclick = () => { state.lineAdj += 1; renderDetail(); };
    const lb = $("#ladderBtn"); if (lb) lb.onclick = () => { state.fullLadder = !state.fullLadder; renderDetail(); };
  }

  function shopCard(p, k, side, line) {
    const qs = quotes(p, k);
    if (!qs.length) return `<div class="card"><h2>Line shopping</h2><div class="pl-sub">No sportsbook or Kalshi market for this prop yet${p.lineSource ? " — the line shown is a projection from recent games" : ""}. Books usually post props the day of the game.</div></div>`;
    const bo = bestLine(p, k, "over"), bu = bestLine(p, k, "under");
    const bv = bestValue(p, k, side);
    // books first; Kalshi ladder trimmed to the 3 strikes nearest 50/50 unless expanded
    const kal = qs.filter(q => q.k === "kalshi").sort((a, b) => Math.abs(fairP(a, "over") - 0.5) - Math.abs(fairP(b, "over") - 0.5));
    const kalShown = state.fullLadder ? kal : kal.slice(0, 3);
    const rows = qs.filter(q => q.k !== "kalshi").concat(kalShown).sort((a, b) => (a.k === "kalshi") - (b.k === "kalshi") || a.l - b.l || a.b.localeCompare(b.b));
    // best price at each line, per side
    const bestAt = {}; for (const q of qs) for (const sd of ["o", "u"]) if (q[sd] != null) { const id = q.l + sd; if (bestAt[id] == null || q[sd] > bestAt[id]) bestAt[id] = q[sd]; }
    const nBooks = new Set(qs.map(q => q.b)).size;
    const cell = (q, sd, isBest) => { const pr = priceOf(q, sd); if (pr == null) return `<td class="num">—</td>`;
      const ev = evOf(modelP(p, k, q.l, sd === "over" ? "over" : "under", q), pr);
      const topAtLine = nBooks > 1 && bestAt[q.l + (sd === "over" ? "o" : "u")] === pr;
      return `<td class="num${isBest ? " best" : topAtLine ? " top" : ""}">${odds(pr)}<small style="color:${evColor(ev)}">${evTxt(ev)}</small></td>`; };
    return `<div class="card"><h2>Line shopping <span class="pl-sub" style="font-weight:400">· ${nBooks} book${nBooks > 1 ? "s" : ""} · boxed = best over / best under line · bold = best price at that line · small % = est. EV</span></h2>
      <div class="table-wrap"><table class="shop"><thead><tr><th>Book</th><th class="num">Line</th><th class="num">Over</th><th class="num">Under</th><th class="num">L20 over%</th></tr></thead><tbody>
      ${rows.map(q => `<tr${bv && bv.q === q ? ` class="valrow"` : ""}><td><b>${esc(q.b)}</b>${q.alt ? ` <span class="tag">alt</span>` : ""}${q.vol ? ` <span class="pl-sub">vol ${q.vol.toLocaleString()}</span>` : ""}</td><td class="num"><b>${q.l}</b></td>${cell(q, "over", q === bo)}${cell(q, "under", q === bu)}<td class="num">${pct(rate(p.logs.slice(0, 20), k, q.l, "over"))}</td></tr>`).join("")}
      </tbody></table></div>
      ${kal.length > 3 ? `<button class="chip" id="ladderBtn" style="margin-top:8px">${state.fullLadder ? "Show fewer Kalshi strikes" : `Show full Kalshi ladder (${kal.length})`}</button>` : ""}
      ${bv ? `<div class="pl-sub" style="margin-top:8px">Best value for the <b>${side}</b>: <b>${esc(bv.q.b)} ${side === "over" ? "O" : "U"} ${bv.q.l} at ${odds(bv.price)}</b> (EV ${evTxt(bv.ev)}: we estimate ${pct(modelP(p, k, bv.q.l, side, bv.q))} vs. ${pct(impl(bv.price))} implied by the price). Kalshi prices include its trading fee.</div>` : ""}
    </div>`;
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
  $("#marketOnly").onchange = e => { state.marketOnly = e.target.checked; state.sel = null; renderList(); renderDetail(); };
  document.querySelectorAll("#sideToggle button").forEach(b => b.onclick = () => {
    state.side = b.dataset.side;
    document.querySelectorAll("#sideToggle button").forEach(x => x.classList.toggle("active", x === b));
    renderList(); renderDetail();
  });
  const theme = store.get("theme", null);
  if (theme) document.documentElement.dataset.theme = theme;
  $("#themeBtn").onclick = () => { const t = document.documentElement.dataset.theme === "light" ? "dark" : "light"; document.documentElement.dataset.theme = t; store.set("theme", t); };

  // ---------- arbitrage view ----------
  const money = x => "$" + x.toFixed(2);
  const sportSel = $("#arbSport");
  sportSel.innerHTML += Object.entries(DATA.sports).filter(([, s]) => s.players.length).map(([k, s]) => `<option value="${k}">${esc(s.name)}</option>`).join("");
  function renderArbs() {
    const stake = Math.max(1, +$("#arbStake").value || 100);
    const minM = +$("#arbMin").value, sp = sportSel.value;
    const all = window.PropArb.findArbs(DATA, { minMargin: minM }).filter(a => sp === "all" || a.sport === sp);
    const sure = all.filter(a => a.margin > 0).length;
    const nQuoted = Object.values(DATA.sports).reduce((n, s) => n + s.players.reduce((m, p) => m + Object.keys(p.market || {}).length, 0), 0);
    const books = new Set(); Object.values(DATA.sports).forEach(s => s.players.forEach(p => Object.values(p.market || {}).forEach(qs => qs.forEach(q => books.add(q.b)))));
    $("#arbNote").innerHTML = `Scanned <b>${nQuoted}</b> props with prices from <b>${books.size}</b> book${books.size === 1 ? "" : "s"} (${esc([...books].join(", ") || "none")}) → <b>${sure}</b> sure-profit arb${sure === 1 ? "" : "s"}${minM < 0 ? ` and ${all.length - sure} near-arbs` : ""}.
      ${books.size < 2 ? ` Arbs need prices from several books — add an <code>ODDS_API_KEY</code> to bring in DraftKings, FanDuel, BetMGM, Caesars and more.` : ""}
      Prices move fast and books limit or void obvious arbs: re-check both prices before betting. Kalshi prices include its fee.`;
    if (!all.length) { $("#arbList").innerHTML = `<div class="card empty">No ${minM < 0 ? "arbs or near-arbs" : "arbitrage opportunities"} right now. ${minM === 0 ? "Try showing near-arbs, or check back after books post the day's props." : ""}</div>`; return; }
    $("#arbList").innerHTML = all.slice(0, 200).map(a => {
      const sO = stake * a.wO, sU = stake * a.wU, pay = sO * window.PropArb.dec(a.over.o); // equal on either leg
      const profit = pay - stake;
      const when = a.gameDate ? new Date(a.gameDate).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : (a.gameTime || "");
      return `<div class="card arb ${a.margin > 0 ? "sure" : ""}" data-pid="${esc(a.playerId)}" data-k="${esc(a.stat)}" data-sport="${esc(a.sport)}">
        <div class="arb-top">
          <div><b>${esc(a.player)}</b> · ${esc(a.statLabel)} <span class="pl-sub">${esc(a.sportName)} · ${esc(a.team)} ${a.home ? "vs" : "@"} ${esc(a.opp)} · ${esc(when)}</span></div>
          <div class="arb-margin" style="color:${a.margin > 0 ? "var(--hit)" : "var(--amber)"}">${a.margin > 0 ? "+" : ""}${(a.margin * 100).toFixed(2)}%${a.middle ? ` <span class="tag mid">middle ${a.over.l}–${a.under.l}</span>` : ""}</div>
        </div>
        <div class="legs">
          <div class="leg"><span class="pl-sub">Bet</span> <b>${money(sO)}</b> on <b>Over ${a.over.l}</b> <b class="px">${odds(a.over.o)}</b> at <b>${esc(a.over.b)}</b></div>
          <div class="leg"><span class="pl-sub">Bet</span> <b>${money(sU)}</b> on <b>Under ${a.under.l}</b> <b class="px">${odds(a.under.u)}</b> at <b>${esc(a.under.b)}</b></div>
        </div>
        <div class="pl-sub">Either leg pays <b>${money(pay)}</b> → ${profit >= 0 ? "guaranteed profit" : "worst case"} <b style="color:${profit >= 0 ? "var(--hit)" : "var(--miss)"}">${profit >= 0 ? "+" : "−"}${money(Math.abs(profit))}</b>${a.middle ? `; if the result lands between ${a.over.l} and ${a.under.l} both win (<b>${money(sO * window.PropArb.dec(a.over.o) + sU * window.PropArb.dec(a.under.u) - stake)}</b> profit; happened in ${pct(a.hitMiddle)} of last 20 games)` : ""}.</div>
      </div>`;
    }).join("");
    document.querySelectorAll("#arbList .arb").forEach(c => c.onclick = () => {
      setView("props"); state.sport = c.dataset.sport; state.stat = "all"; store.set("sport", state.sport);
      renderTabs(); select(c.dataset.pid, c.dataset.k);
    });
  }
  function setView(v) {
    state.view = v;
    $("#arbView").hidden = v !== "arb";
    document.querySelector(".layout").hidden = v === "arb";
    $("#arbBtn").classList.toggle("active", v === "arb");
    if (v === "arb") { document.querySelectorAll("#sportTabs button").forEach(b => b.classList.remove("active")); renderArbs(); }
    else renderTabs();
  }
  $("#arbBtn").onclick = () => setView(state.view === "arb" ? "props" : "arb");
  ["#arbStake", "#arbMin", "#arbSport"].forEach(id => $(id).addEventListener("input", renderArbs));
  $("#sportTabs").addEventListener("click", () => { if (state.view === "arb") setView("props"); }, true);

  const foot = document.querySelector(".foot");
  if (LIVE) {
    const upd = new Date(DATA.generated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const src = DATA.sources || {};
    const t = x => x ? new Date(x).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
    foot.innerHTML = `Game logs: ESPN (${esc(upd)})${src.sportsbooks ? ` · Sportsbooks via The Odds API (${esc(t(src.sportsbooks))})` : ""}${src.kalshi ? ` · Kalshi (${esc(t(src.kalshi))})` : ""}. <span class="tag">proj</span> = no market yet, projected from recent games. EV uses each player's last-20 hit rate — a rough guide, not betting advice.`;
  }

  renderAll();
})();
