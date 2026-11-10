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
  // ---- images (ESPN CDN). Small sizes come from ESPN's resizer; on error fall back to the
  // full image, then to initials (headshots) or nothing (logos).
  const ESPN_IMG = "https://a.espncdn.com";
  const sized = (full, w, h) => { try { const u = new URL(full); return u.host.endsWith("espncdn.com") ? `${ESPN_IMG}/combiner/i?img=${u.pathname}&w=${w}&h=${h}&scale=crop&cquality=60` : full; } catch { return full; } };
  const imgTag = (full, w, h, cls, alt = "") => full ? `<img class="${cls}" src="${esc(sized(full, w * 2, h * 2))}" data-full="${esc(full)}" width="${w}" height="${h}" alt="${esc(alt)}" loading="lazy" decoding="async" onerror="window.__imgFallback(this)">` : "";
  window.__imgFallback = img => { if (img.dataset.full && img.src !== img.dataset.full) img.src = img.dataset.full; else img.remove(); };
  const logoOf = abbr => team(abbr)?.logo || null;
  const teamLogo = (abbr, size = 18) => imgTag(logoOf(abbr), size, size, "tlogo", "");
  // round player photo on the team colour, initials underneath as a fallback
  const avatar = (p, size, extra = "", sp = null) => { const t = (sp || sport()).teams.find(x => x.abbr === p.team);
    return `<span class="av ${extra}" style="--av:${size}px;background:${t ? t.color : "#64748b"}"><span class="av-i">${esc(initials(p.name))}</span>${p.headshot ? imgTag(p.headshot, size, size, "av-img", p.name) : ""}${t?.logo ? `<span class="av-team">${imgTag(t.logo, Math.round(size * 0.42), Math.round(size * 0.42), "tlogo", "")}</span>` : ""}</span>`; };
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
    // green for overs that hit, red for misses; stronger as the rate moves away from 50%
    const c = r >= 0.5 ? `rgba(52,199,123,${0.12 + a * 0.78})` : `rgba(242,95,92,${0.12 + a * 0.78})`;
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
      li.innerHTML = `<div class="pl-cell">${avatar(r.p, 38)}<div style="min-width:0"><div class="pl-name">${esc(r.p.name)}</div>
        <div class="pl-sub">${r.p.team} ${r.p.home ? "vs" : "@"} ${r.p.opp} · ${state.side === "over" ? "O" : "U"} ${r.line} ${esc(statLabel(r.k))}${isProj(r.p, r.k) ? ` <span class="tag">proj</span>` : ""}</div>
        ${r.val ? `<div class="pl-sub best-row">Best: ${state.side === "over" ? "O" : "U"} ${r.val.q.l} <b>${odds(r.val.price)}</b> ${esc(shortBook(r.val.q.b))} · <span style="color:${evColor(r.val.ev)};font-weight:700">EV ${evTxt(r.val.ev)}</span></div>` : ""}</div></div>
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
    const rankColor = rank <= n / 3 ? "var(--miss)" : rank > n * 2 / 3 ? "var(--hit)" : "var(--amber)";

    const splits = [["L5", p.logs.slice(0, 5)], ["L10", p.logs.slice(0, 10)], ["L20", p.logs.slice(0, 20)], ["Season", curSeason(p)], ["Last 40", p.logs], ["H2H", p.logs.filter(l => l.opp === p.opp)], ["Home", p.logs.filter(l => l.home)], ["Away", p.logs.filter(l => !l.home)]];

    d.innerHTML = `
      <button class="mobile-back" id="backBtn">← All props</button>
      <div class="card player-head">
        ${avatar(p, 84, "av-lg")}
        <div class="ph-main"><h1>${esc(p.name)}${p.injury ? ` <span class="tag inj">${esc(p.injury)}</span>` : ""}</h1><div class="pl-sub team-line">${teamLogo(p.team, 20)}${esc(p.pos)} · ${esc(t ? t.name : p.team)}</div></div>
        <div class="game-tag"><span class="pl-sub">Next game</span><b class="matchup">${teamLogo(p.team, 26)}${p.team} <span class="vs">${p.home ? "vs" : "@"}</span> ${teamLogo(p.opp, 26)}${p.opp}</b><span class="pl-sub">${esc(gameWhen(p))}${p.game?.details ? ` · ${esc(p.game.details)}${p.game.total ? ` · O/U ${p.game.total}` : ""}` : ""}</span></div>
        <div class="ph-actions">
          <button class="chip" id="watchBtn" aria-pressed="${window.PropBets.isWatched(window.PropBets.watchKey(state.sport, p.id, k))}">${window.PropBets.isWatched(window.PropBets.watchKey(state.sport, p.id, k)) ? "★ Watching" : "☆ Watch"}</button>
          <button class="chip active" id="trackBtn">+ Track bet</button>
        </div>
      </div>
      <div class="card">
        <div class="stat-tabs" id="statTabs">${Object.keys(p.lines).map(sk => `<button class="chip ${sk === k ? "active" : ""}" data-k="${sk}">${esc(statLabel(sk))} ${p.lines[sk]}</button>`).join("")}</div>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="k">Hit rate (${state.range})</div><div class="v" style="color:${hr >= 0.5 ? "var(--hit)" : "var(--miss)"}">${pct(hr)}</div><div class="s">${logs.filter(l => isHit(l.stats[k], line, side)).length}/${logs.length} ${side}</div></div>
        <div class="kpi"><div class="k">Average</div><div class="v">${fmt(avg(logs, k))}</div><div class="s">${(avg(logs, k) - line >= 0 ? "+" : "") + fmt(avg(logs, k) - line)} vs line</div></div>
        <div class="kpi"><div class="k">Median</div><div class="v">${fmt(median(logs, k))}</div><div class="s">${state.range} sample</div></div>
        <div class="kpi"><div class="k">Streak</div><div class="v">${streak(p.logs, k, line, side)}</div><div class="s">straight ${side}s</div></div>
        ${(() => { const bb = window.PropModel.bestBet(p, k, state.sport), b = bb?.best; return b
          ? `<div class="kpi"><div class="k">Best bet</div><div class="v" style="color:${evColor(b.ev)}">EV ${evTxt(b.ev)}</div><div class="s">${b.side === "over" ? "O" : "U"} ${b.line} ${odds(b.price)} · ${esc(b.book)}</div></div>`
          : `<div class="kpi"><div class="k">Projection</div><div class="v">${bb ? bb.proj.mean : "—"}</div><div class="s">${price != null ? `${side} ${odds(price)} · ${pct(implied(price))} implied` : "no market price yet"}</div></div>`; })()}
        <div class="kpi"><div class="k">Opp vs ${esc(statLabel(k))}</div><div class="v" style="color:${rankColor}">${rank}<span style="font-size:13px">/${n}</span></div><div class="s">${rankTxt} matchup</div></div>
      </div>
      <div class="card">
        <div class="chart-top">
          <div class="stat-tabs" id="rangeTabs">${["L5", "L10", "L20", "Season", "H2H", "Home", "Away"].map(r => `<button class="chip ${r === state.range ? "active" : ""}" data-r="${r}">${r}</button>`).join("")}</div>
          <div class="line-ctrl"><button id="lineDown" aria-label="Lower line">−</button><div class="line-val">${side === "over" ? "O" : "U"} ${line}<small>${state.lineAdj ? "alt line" : isProj(p, k) ? "projected" : "book line"}</small></div><button id="lineUp" aria-label="Raise line">+</button></div>
        </div>
        ${logs.length ? chartSVG(logs, k, line, side) : `<div class="empty">No games in this split.</div>`}
      </div>
      ${edgeCards(p, k, line, side)}
      ${shopCard(p, k, side, line)}
      <div class="card"><h2>Splits at ${side === "over" ? "O" : "U"} ${line}</h2><div class="splits">
        ${splits.map(([lab, lg]) => { const r = rate(lg, k, line, side); return `<div class="split"><div class="pl-sub">${lab} · ${lg.length} gp</div><b style="font-size:17px">${lg.length ? pct(r) : "—"}</b> <span class="pl-sub">avg ${fmt(avg(lg, k))}</span><div class="bar"><i style="width:${r * 100}%;background:${r >= 0.5 ? "var(--hit)" : "var(--miss)"}"></i></div></div>`; }).join("")}
      </div></div>
      <div class="tables">
        <div class="card"><h2>Game log</h2><table><thead><tr><th>Date</th><th>Opp</th>${p.logs[0].min != null ? `<th class="num">Min</th>` : ""}<th class="num">${esc(statLabel(k))}</th><th class="num">Result</th></tr></thead><tbody>
          ${p.logs.slice(0, 15).map(l => { const h = isHit(l.stats[k], line, side); return `<tr><td>${l.date.slice(5).replace("-", "/")}</td><td class="opp-cell">${l.home ? "vs" : "@"} ${teamLogo(l.opp, 16)}${l.opp}</td>${l.min != null ? `<td class="num">${l.min}</td>` : ""}<td class="num">${l.stats[k]}</td><td class="num ${h ? "h-over" : "h-under"}">${l.stats[k] === line ? "PUSH" : h ? "HIT" : "MISS"}</td></tr>`; }).join("")}
        </tbody></table></div>
        <div class="card"><h2>Alt lines (L10)</h2><table><thead><tr><th>Line</th><th class="num">Over</th><th class="num">Under</th></tr></thead><tbody>
          ${altLines(base).map(L => { const lg = p.logs.slice(0, 10); const ov = rate(lg, k, L, "over"), un = rate(lg, k, L, "under"); return `<tr${L === line ? ` style="background:var(--panel2)"` : ""}><td><b>${L}</b>${L === base ? ` <span class="pl-sub">main</span>` : ""}</td><td class="num"><span class="pill" style="display:inline-block;width:52px;${heat(ov)}">${pct(ov)}</span></td><td class="num"><span class="pill" style="display:inline-block;width:52px;${heat(un)}">${pct(un)}</span></td></tr>`; }).join("")}
        </tbody></table>
        <h2 style="margin-top:16px">${esc(ot ? ot.name : p.opp)} matchup</h2>
        <div class="pl-sub">${rank ? `Ranked ${rank} of ${n} in ${esc(statLabel(k))} allowed (1 = toughest).` : ""} ${(() => { const h = p.logs.filter(l => l.opp === p.opp); return h.length ? `${esc(p.name.split(" ")[0])} averages ${fmt(avg(h, k))} in ${h.length} game${h.length > 1 ? "s" : ""} vs ${p.opp} this season.` : `No meetings with ${p.opp} yet this season.`; })()}</div>
        </div>
      </div>`;

    $("#backBtn").onclick = () => document.querySelector(".layout").classList.remove("show-detail");
    $("#watchBtn").onclick = () => { const on = window.PropBets.toggleWatch(window.PropBets.watchKey(state.sport, p.id, k)); $("#watchBtn").textContent = on ? "★ Watching" : "☆ Watch"; $("#watchBtn").setAttribute("aria-pressed", on);
      if (on) window.PropBets.alerts(DATA); }; // record today's line/price as the baseline for alerts
    $("#trackBtn").onclick = () => { const r = window.PropModel.bestBet(p, k, state.sport); const b = r?.best;
      const sd = b ? b.side : side, ln = b ? b.line : line, pr = b ? b.price : (side === "over" ? p.odds?.[k]?.over : p.odds?.[k]?.under) ?? -110;
      const prob = b ? b.prob : r ? (sd === "over" ? r.probs.over : r.probs.under) : null;
      window.PropBets.openTrack({ p, sport: state.sport, stat: k, label: statLabel(k), side: sd, line: ln, price: pr, book: b?.book || "", prob }); };
    d.querySelectorAll("[data-corr]").forEach(b => b.onclick = () => select(b.dataset.corr, b.dataset.k));
    d.querySelectorAll("#statTabs .chip").forEach(b => b.onclick = () => select(p.id, b.dataset.k));
    d.querySelectorAll("#rangeTabs .chip").forEach(b => b.onclick = () => { state.range = b.dataset.r; renderDetail(); });
    $("#lineDown").onclick = () => { if (base + state.lineAdj - 1 >= 0.5) { state.lineAdj -= 1; renderDetail(); } };
    $("#lineUp").onclick = () => { state.lineAdj += 1; renderDetail(); };
    const lb = $("#ladderBtn"); if (lb) lb.onclick = () => { state.fullLadder = !state.fullLadder; renderDetail(); };
  }

  /** Projection, injuries, matchup by position, minutes & rest, line movement/history, correlated props. */
  function edgeCards(p, k, line, side) {
    const M = window.PropModel, sp = sport(), lg = state.sport;
    const r = M.bestBet(p, k, lg); if (!r) return "";
    const pr = M.probabilities(p, k, line, r.proj);
    const pctS = x => x == null ? "—" : Math.round(x * 100) + "%";
    const multTxt = m => `${m >= 1 ? "+" : "−"}${Math.abs((m - 1) * 100).toFixed(1)}%`;
    const statL = statLabel(k);
    // projection
    const proj = `<div class="card"><h2>Projection <span class="pl-sub">${esc(statL)}</span></h2>
      <div class="proj-top"><div class="proj-num">${r.proj.mean}</div><div class="pl-sub">vs line ${line} · we estimate <b>${pctS(pr.over)}</b> over / <b>${pctS(pr.under)}</b> under · fair odds ${odds(M.toAmerican(pr.over))} / ${odds(M.toAmerican(pr.under))}${r.best ? ` · best bet: <b>${r.best.side} ${r.best.line} ${odds(r.best.price)}</b> at ${esc(r.best.book)} (EV <b style="color:${r.best.ev >= 0 ? "var(--hit)" : "var(--miss)"}">${(r.best.ev * 100).toFixed(1)}%</b>)` : ""}</div></div>
      <div class="factors">${r.proj.parts.map(x => `<div class="factor"><span>${esc(x.label)}</span><b class="${x.mult == null ? "" : x.mult >= 1 ? "up" : "down"}">${x.mult == null ? x.value : multTxt(x.mult)}</b></div>`).join("")}</div>
      <div class="pl-sub">Probability = 75% this projection (${r.proj.dist === "poisson" ? "Poisson" : "normal"} distribution) + 25% the last-20 hit rate. Betting EV also blends in the market's vig-free price.</div></div>`;
    // injuries
    const ww = (p.withWithout || []);
    const inj = ww.length || p.teammatesQuestionable?.length ? `<div class="card"><h2>Teammates out <span class="pl-sub">tonight's injury report</span></h2>
      ${ww.length ? `<div class="table-wrap"><table class="lat-table"><thead><tr><th>Teammate</th><th>Status</th><th class="num">Games with / without</th><th class="num">${esc(statL)} with</th><th class="num">without</th><th class="num">Over ${line} without</th></tr></thead><tbody>
        ${ww.map(t => { const wo = (p.logs || []).filter(l => (t.datesWithout || []).includes(l.date)); const hr2 = wo.length ? wo.filter(l => (l.stats[k] ?? 0) > line).length / wo.length : null;
          const a = t.avgWith?.[k], b = t.avgWithout?.[k];
          return `<tr><td><b>${esc(t.teammate)}</b> <span class="pl-sub">${esc(t.pos || "")}</span></td><td><span class="tag inj">${esc(t.status || "Out")}</span></td><td class="num">${t.gamesWith} / ${t.gamesWithout}</td><td class="num">${a ?? "—"}</td><td class="num" style="color:${b != null && a != null ? (b > a ? "var(--hit)" : b < a ? "var(--miss)" : "") : ""}">${b ?? "—"}</td><td class="num">${hr2 == null ? "—" : `${pctS(hr2)} <span class="pl-sub">(${wo.length})</span>`}</td></tr>`; }).join("")}
      </tbody></table></div>` : ""}
      ${p.teammatesQuestionable?.length ? `<div class="pl-sub" style="margin-top:6px">Questionable: ${p.teammatesQuestionable.map(q => `${esc(q.name)} (${esc(q.status)})`).join(", ")}</div>` : ""}</div>` : "";
    // matchup by position + minutes + rest
    const dv = p.dvp || {}, rk = dv.rank?.[k], f = dv.factor?.[k];
    const mins = (p.logs || []).map(l => l.min).filter(m => m != null);
    const mAvg = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : "—";
    const rs = M.restSplits(p.logs || [], k, line);
    const sprd = p.game?.teamSpread;
    const ctx = `<div class="card"><h2>Matchup, minutes &amp; rest</h2><div class="ctx-grid">
      <div class="ctx"><div class="k">${esc(p.opp)} vs ${esc(dv.group || "position")}</div><div class="v" style="color:${rk ? (rk > (dv.of || 30) * 2 / 3 ? "var(--hit)" : rk <= (dv.of || 30) / 3 ? "var(--miss)" : "var(--amber)") : ""}">${rk ? `${rk}<span class="of">/${dv.of}</span>` : "—"}</div><div class="s">${f ? `${f >= 1 ? "allows" : "holds"} ${dv.group}s to ${Math.round(Math.abs(f - 1) * 100)}% ${f >= 1 ? "above" : "below"} their usual ${esc(statL.toLowerCase())}` : "not enough games yet"} · 1 = toughest</div></div>
      ${mins.length ? `<div class="ctx"><div class="k">Minutes</div><div class="v">${mAvg(mins.slice(0, 5))}</div><div class="s">last 5 · ${mAvg(mins.slice(0, 20))} last 20 · ${mAvg(mins)} last ${mins.length}</div>${miniBars(mins.slice(0, 15).reverse())}</div>` : ""}
      <div class="ctx"><div class="k">Rest</div><div class="v">${p.restDays == null ? "—" : p.restDays === 0 ? "Back-to-back" : p.restDays + " day" + (p.restDays === 1 ? "" : "s")}</div><div class="s">${rs.b2b.n ? `On back-to-backs: avg ${rs.b2b.avg.toFixed(1)}, over ${line} ${pctS(rs.b2b.over)} (${rs.b2b.n})` : "No back-to-backs in the sample"} · rested 2+ days: ${rs.rested.n ? `avg ${rs.rested.avg.toFixed(1)}, over ${pctS(rs.rested.over)} (${rs.rested.n})` : "—"}</div></div>
      <div class="ctx"><div class="k">Game script</div><div class="v">${sprd == null ? (p.game?.details ? esc(p.game.details) : "—") : `${sprd > 0 ? "+" : ""}${sprd}`}</div><div class="s">${sprd == null ? "no spread posted yet" : Math.abs(sprd) >= 10 ? "Blowout risk: starters may sit late" : sprd < 0 ? `${esc(p.team)} favored` : `${esc(p.team)} underdog`}${p.game?.total ? ` · total ${p.game.total}` : ""}</div></div>
    </div></div>`;
    // line movement & history
    const mv = p.lineMove?.[k] || {}, hist = p.lineHistory?.[k] || [];
    const qs = (p.market?.[k] || []).filter(q => q.ol != null && !q.alt);
    const moved = qs.filter(q => q.ol !== q.l || q.oo !== q.o);
    const hAbove = hist.filter(h => h.line >= line), hHit = hAbove.filter(h => h.actual > h.line).length;
    const lines = `<div class="card"><h2>Line movement &amp; history</h2>
      <div class="pl-sub">Opened ${mv.openLine ?? "—"}${mv.openOver != null ? ` (${odds(mv.openOver)} / ${odds(mv.openUnder)})` : ""}${mv.openedAt ? ` · first seen ${new Date(mv.openedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""} → now ${line}${p.odds?.[k]?.over != null ? ` (${odds(p.odds[k].over)} / ${odds(p.odds[k].under)})` : ""}${mv.openLine != null && mv.openLine !== p.lines[k] ? ` · <b style="color:var(--accent)">moved ${p.lines[k] > mv.openLine ? "up" : "down"} ${Math.abs(p.lines[k] - mv.openLine)}</b>` : ""}</div>
      ${moved.length ? `<div class="table-wrap"><table class="lat-table"><thead><tr><th>Book</th><th class="num">Opened</th><th class="num">Now</th></tr></thead><tbody>${moved.map(q => `<tr><td>${esc(q.b)}</td><td class="num">${q.ol} · ${odds(q.oo)} / ${odds(q.ou)}</td><td class="num">${q.l} · ${odds(q.o)} / ${odds(q.u)}</td></tr>`).join("")}</tbody></table></div>` : ""}
      ${hist.length ? `<div class="pl-sub" style="margin-top:8px">When his line was ${line} or higher, he went over <b>${hHit} of ${hAbove.length}</b>. Last ${hist.length} lines:</div>
        <div class="hist-strip">${hist.map(h => `<span class="hchip ${h.actual > h.line ? "hit" : "miss"}" title="${esc(h.date)}: line ${h.line}, actual ${h.actual}">${h.line}<b>${h.actual}</b></span>`).join("")}</div>`
        : `<div class="pl-sub" style="margin-top:8px">Line history builds up from today: each night's line is saved and checked against the box score.</div>`}</div>`;
    // correlated props in the same game (teammates and opponents)
    const mates = sp.players.filter(x => x.id !== p.id && (x.team === p.team || x.team === p.opp) && x.gameDate === p.gameDate);
    const corr = [];
    for (const x of mates) for (const s2 of Object.keys(x.lines || {})) {
      const c = M.correlation(p.logs, k, line, x.logs, s2, x.lines[s2]);
      if (c && c.n >= 8 && Math.abs(c.phi) >= 0.15) corr.push({ x, s2, c });
    }
    // same player, different stat (skip combos built from each other, e.g. PRA and points)
    const COMBO = { pra: ["pts", "reb", "ast"], hrr: ["hits", "runs", "rbi"], pts: ["g", "ast"] };
    const related = (a, b) => (COMBO[a] || []).includes(b) || (COMBO[b] || []).includes(a);
    for (const s2 of Object.keys(p.lines)) if (s2 !== k && !related(k, s2)) { const c = M.correlation(p.logs, k, line, p.logs, s2, p.lines[s2]); if (c && c.n >= 8 && Math.abs(c.phi) >= 0.2) corr.push({ x: p, s2, c }); }
    corr.sort((a, b) => Math.abs(b.c.phi) - Math.abs(a.c.phi));
    const corrCard = corr.length ? `<div class="card"><h2>Correlated props <span class="pl-sub">same game · how often both overs hit together</span></h2>
      <div class="table-wrap"><table class="lat-table"><thead><tr><th>With</th><th class="num">Both over</th><th class="num">If independent</th><th class="num">Correlation</th><th class="num">Games</th></tr></thead><tbody>
      ${corr.slice(0, 8).map(({ x, s2, c }) => `<tr><td><button class="linklike" data-corr="${esc(x.id)}" data-k="${esc(s2)}">${x === p ? "Same player" : esc(x.name)} <span class="pl-sub">${esc(statLabel(s2))} over ${x.lines[s2]}${x.team !== p.team ? " · opponent" : ""}</span></button></td><td class="num">${pctS(c.both)}</td><td class="num">${pctS(c.independent)}</td><td class="num" style="color:${c.phi > 0 ? "var(--hit)" : "var(--miss)"}">${c.phi > 0 ? "+" : ""}${c.phi.toFixed(2)}</td><td class="num">${c.n}</td></tr>`).join("")}
      </tbody></table></div><div class="pl-sub">Same-game parlays price legs as if they were independent. A strong positive correlation means the parlay hits more often than its price assumes; a negative one, less often.</div></div>` : "";
    return proj + inj + ctx + lines + corrCard;
  }
  function miniBars(v) {
    if (v.length < 3) return ""; const hi = Math.max(...v, 1);
    return `<svg class="minibars" viewBox="0 0 ${v.length * 8} 28" preserveAspectRatio="none" aria-hidden="true">${v.map((x, i) => `<rect x="${i * 8 + 1}" y="${28 - x / hi * 26}" width="6" height="${x / hi * 26}" rx="1.5"/>`).join("")}</svg>`;
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
  $("#themeBtn").onclick = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const t = cur === "light" ? "dark" : "light"; document.documentElement.dataset.theme = t; store.set("theme", t); };

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
          <div class="arb-who">${(() => { const pl = DATA.sports[a.sport]?.players.find(x => x.id === a.playerId); return pl ? avatar(pl, 40, "", DATA.sports[a.sport]) : ""; })()}<div><b>${esc(a.player)}</b> · ${esc(a.statLabel)} <span class="pl-sub">${esc(a.sportName)} · ${esc(a.team)} ${a.home ? "vs" : "@"} ${esc(a.opp)} · ${esc(when)}</span></div></div>
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
    $("#latView").hidden = v !== "lat";
    $("#cryptoView").hidden = v !== "crypto";
    $("#edgeView").hidden = v !== "edge";
    $("#betsView").hidden = v !== "bets";
    document.querySelector(".layout").hidden = v !== "props";
    // Arbitrage, the latency study and the crypto bot live under one "Testing" tab
    const testing = ["arb", "lat", "crypto"].includes(v);
    if (testing) { state.lastTest = v; store.set("lastTest", v); }
    $("#testNav").hidden = !testing;
    document.querySelectorAll("#testNav [data-test]").forEach(b => { const on = b.dataset.test === v; b.classList.toggle("active", on); b.setAttribute("aria-selected", on); });
    const navKey = testing ? "testing" : v;
    document.querySelectorAll("#viewNav .view-btn").forEach(b => { const on = b.dataset.view === navKey; b.classList.toggle("active", on); b.setAttribute("aria-current", on ? "page" : "false"); });
    document.body.dataset.view = v;
    if (v !== "props") document.querySelectorAll("#sportTabs button").forEach(b => b.classList.remove("active"));
    if (v === "arb") renderArbs();
    else if (v === "lat") window.PropLatency.render($("#latView"));
    else if (v === "crypto") window.PropCrypto.render($("#cryptoView"));
    else if (v === "edge") window.PropEdge.render($("#edgeView"), DATA, api);
    else if (v === "bets") window.PropBets.render($("#betsView"), DATA, api);
    else renderTabs();
    window.scrollTo(0, 0);
    try { if (location.hash.slice(1) !== (v === "props" ? "" : v)) history.replaceState(null, "", v === "props" ? location.pathname : "#" + v); } catch {}
  }
  document.querySelectorAll("#viewNav .view-btn").forEach(b => b.onclick = () => setView(b.dataset.view === "testing" ? (state.lastTest || store.get("lastTest", "arb")) : b.dataset.view));
  document.querySelectorAll("#testNav [data-test]").forEach(b => b.onclick = () => setView(b.dataset.test));
  // shared helpers for the Edge Board and My Bets views
  const api = {
    avatar,
    openProp(sp, pid, k) { setView("props"); state.sport = sp; state.stat = "all"; store.set("sport", sp); renderTabs(); select(pid, k); },
  };
  window.PropBets.onChange = () => { if (state.view === "bets") window.PropBets.render($("#betsView"), DATA, api); };
  // "since your last visit" alerts for watched props
  try {
    window.PropBets.updateClose(DATA);
    const al = window.PropBets.alerts(DATA);
    if (al.length) {
      const bar = $("#alertBar"); bar.hidden = false;
      bar.innerHTML = `<div class="alert-head"><b>Since your last visit</b><button class="chip sm" id="alertClose" aria-label="Dismiss">✕</button></div>${al.slice(0, 6).map(a => `<button class="alert-item" data-sport="${esc(a.sport)}" data-pid="${esc(a.pid)}" data-k="${esc(a.stat)}">${esc(a.text)}</button>`).join("")}`;
      bar.querySelectorAll(".alert-item").forEach(b => b.onclick = () => api.openProp(b.dataset.sport, b.dataset.pid, b.dataset.k));
      $("#alertClose").onclick = () => { bar.hidden = true; };
    }
  } catch {}
  document.body.dataset.view = "props";
  window.PropLatency.wire($("#latView"));
  ["#arbStake", "#arbMin", "#arbSport"].forEach(id => $(id).addEventListener("input", renderArbs));
  $("#sportTabs").addEventListener("click", () => { if (state.view && state.view !== "props") setView("props"); }, true);
  // open a section from the link (#arb, #lat, #crypto)
  const startView = location.hash.slice(1);
  if (["arb", "lat", "crypto", "edge", "bets", "testing"].includes(startView)) setTimeout(() => setView(startView === "testing" ? store.get("lastTest", "arb") : startView), 0);
  // follow links to a section while the page is open (#edge, #bets, #arb, #lat, #crypto)
  window.addEventListener("hashchange", () => {
    const h = location.hash.slice(1);
    if (["arb", "lat", "crypto", "edge", "bets"].includes(h) && h !== state.view) setView(h);
    else if (h === "testing") setView(state.lastTest || store.get("lastTest", "arb"));
    else if (!h && state.view !== "props") setView("props");
  });

  const foot = document.querySelector(".foot");
  if (LIVE) {
    const upd = new Date(DATA.generated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const src = DATA.sources || {};
    const t = x => x ? new Date(x).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
    foot.innerHTML = `Game logs: ESPN (${esc(upd)})${src.sportsbooks ? ` · Sportsbooks via The Odds API (${esc(t(src.sportsbooks))})` : ""}${src.kalshi ? ` · Kalshi (${esc(t(src.kalshi))})` : ""}. <span class="tag">proj</span> = no market yet, projected from recent games. EV uses each player's last-20 hit rate — a rough guide, not betting advice.`;
  }

  renderAll();
})();
