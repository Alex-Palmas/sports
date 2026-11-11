/* Kalshi trading from PropLab: your API key, kept in this browser, and one-tap orders on Kalshi props.
 *
 * How it stays safe:
 *  - The private key is imported into the browser's crypto engine as NON-EXTRACTABLE and kept in
 *    IndexedDB as a CryptoKey: the page can sign with it but nothing (including this code) can read
 *    the key back out. The PEM text is never stored.
 *  - Kalshi refuses requests from web pages (CORS), so calls go through a relay you run
 *    (relay/worker.js on Cloudflare, or `node scripts/kalshi-relay.mjs` locally). Requests are signed
 *    here; the relay only ever sees signed requests, never the key.
 *  - Off by default. Every order needs an explicit confirmation, re-prices against the live market,
 *    is capped by your max-per-order setting, and is immediate-or-cancel (never left resting).
 */
(function (root) {
  const enc = new TextEncoder();
  const subtle = () => (root.crypto || globalThis.crypto).subtle;
  const b64 = buf => { let s = ""; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  // ---------------------------------------------------------------- keys
  // DER helpers to wrap a PKCS#1 "RSA PRIVATE KEY" (what Kalshi hands out) into PKCS#8 for WebCrypto
  const derLen = n => n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255];
  const der = (tag, bytes) => Uint8Array.from([tag, ...derLen(bytes.length), ...bytes]);
  const RSA_ALG_ID = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  function pkcs1ToPkcs8(pkcs1) { return der(0x30, [0x02, 0x01, 0x00, ...RSA_ALG_ID, ...der(0x04, pkcs1)]); }

  /** Parse a PEM private key into a non-extractable signing key. Returns { key, alg }. */
  async function importPem(pem) {
    const m = String(pem).match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/);
    if (!m) throw new Error("That doesn't look like a PEM private key (it should start with -----BEGIN … PRIVATE KEY-----).");
    let body = unb64(m[2].replace(/[^A-Za-z0-9+/=]/g, ""));
    if (m[1] === "RSA PRIVATE KEY") body = pkcs1ToPkcs8(body);
    else if (m[1] !== "PRIVATE KEY") throw new Error(`Unsupported key type "${m[1]}". Use the private key file Kalshi gave you.`);
    try { return { key: await subtle().importKey("pkcs8", body, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]), alg: "RSA-PSS" }; }
    catch (e) {
      try { return { key: await subtle().importKey("pkcs8", body, { name: "Ed25519" }, false, ["sign"]), alg: "Ed25519" }; }
      catch { throw new Error("Couldn't read that private key. Paste the whole key file, including the BEGIN/END lines."); }
    }
  }

  /** Kalshi auth headers: signature over timestamp + METHOD + path (no query string). */
  async function authHeaders(cred, method, path, now = Date.now()) {
    const ts = String(now), msg = enc.encode(ts + method.toUpperCase() + path.split("?")[0]);
    const sig = cred.alg === "Ed25519" ? await subtle().sign({ name: "Ed25519" }, cred.key, msg)
      : await subtle().sign({ name: "RSA-PSS", saltLength: 32 }, cred.key, msg);
    return { "KALSHI-ACCESS-KEY": cred.keyId, "KALSHI-ACCESS-SIGNATURE": b64(sig), "KALSHI-ACCESS-TIMESTAMP": ts };
  }

  // ---------------------------------------------------------------- orders (pure)
  /** Kalshi's taker fee in dollars for C contracts at price P: ceil(0.07·C·P·(1−P)) to the cent. */
  const takerFee = (C, P) => Math.ceil(0.07 * C * P * (1 - P) * 100 - 1e-9) / 100;
  const fmtPrice = x => String(+x.toFixed(4));
  /**
   * V2 order body. The V2 endpoint quotes everything from the YES leg: buying YES is a `bid` at the
   * YES price; buying NO at q is the same as selling YES (`ask`) at 1 − q.
   */
  function orderBody({ ticker, buy, contracts, price, clientId }) {
    if (!ticker || !(contracts >= 1) || !(price > 0 && price < 1)) throw new Error("Bad order");
    return { ticker, client_order_id: clientId, side: buy === "yes" ? "bid" : "ask", count: String(Math.floor(contracts)),
      price: fmtPrice(buy === "yes" ? price : 1 - price), time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross" };
  }
  /** Size an order: contracts from a dollar stake, capped by the max-per-order setting (fees included). */
  function size(stake, price, maxOrder) {
    const cap = Math.min(stake, maxOrder);
    let c = Math.floor(cap / price);
    while (c > 0 && c * price + takerFee(c, price) > cap + 1e-9) c--;
    return { contracts: c, cost: +(c * price + takerFee(c, price)).toFixed(2), fee: takerFee(c, price) };
  }

  // ---------------------------------------------------------------- links to kalshi.com (open the app on phones)
  // series slugs as Kalshi uses them in page URLs (data.json carries a ready-made href; this is the fallback)
  const SLUGS = { kxnbapts: "nba-player-points", kxnbareb: "nba-player-rebounds", kxnbaast: "nba-player-assists", kxnba3pt: "nba-player-threes",
    kxnbapra: "nba-player-points-rebounds-assists", kxnbapr: "pro-basketball-player-points-rebounds", kxnbapa: "pro-basketball-player-points-assists", kxnbara: "pro-basketball-player-rebounds-assists", kxnbastl: "nba-player-steals", kxnbablk: "nba-player-blocks",
    kxnflpassyds: "pro-football-passing-yards", kxnflrshyds: "pro-football-rushing-yards", kxnflrecyds: "pro-football-receiving-yards",
    kxnflrec: "pro-football-player-receptions", kxnflanytd: "pro-football-anytime-touchdown", kxnhlpts: "pro-hockey-points",
    kxnhlast: "pro-hockey-assists", kxnhlanygoal: "pro-hockey-goalscorer", kxnhlgoal: "nhl-goalscorer" };
  /** kalshi.com page for a quote (or a bare market ticker). */
  function href(q) {
    if (q?.href) return q.href;
    const tk = typeof q === "string" ? q : q?.tk || q?.ticker; if (!tk) return null;
    const ev = String(tk).split("-").slice(0, 2).join("-").toLowerCase(), series = ev.split("-")[0];
    return SLUGS[series] ? `https://kalshi.com/markets/${series}/${SLUGS[series]}/${ev}` : `https://kalshi.com/markets/${series}`;
  }
  const ICON = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`;
  /** An "Open in Kalshi" link. On a phone with the Kalshi app, the OS opens the app at this market. */
  function link(q, text = "Open in Kalshi", cls = "chip kalshi-link") {
    const u = href(q); if (!u) return "";
    return `<a class="${cls}" href="${u.replace(/"/g, "&quot;")}" target="_blank" rel="noopener" data-kalshi-link>${text} ${ICON}</a>`;
  }

  // ---------------------------------------------------------------- settings & storage (browser)
  const LS = (typeof window !== "undefined" && window.PROPLAB_NS || "proplab:") + "kalshi";
  const settings = () => { try { return { relay: "http://localhost:8787", maxOrder: 25, enabled: false, ...JSON.parse(localStorage.getItem(LS) || "{}") }; } catch { return { relay: "http://localhost:8787", maxOrder: 25, enabled: false }; } };
  const saveSettings = s => { try { localStorage.setItem(LS, JSON.stringify(s)); } catch {} };
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open("proplab-kalshi", 1); r.onupgradeneeded = () => r.result.createObjectStore("keys"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function idbDo(mode, fn) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction("keys", mode), st = tx.objectStore("keys"), r = fn(st); tx.oncomplete = () => res(r?.result); tx.onerror = () => rej(tx.error); }); }
  const KEY_SLOT = () => "main";
  let credCache;
  async function getCred() {
    if (credCache !== undefined) return credCache;
    try {
      credCache = (await idbDo("readonly", s => s.get(KEY_SLOT()))) || null;
    } catch { credCache = null; }
    return credCache;
  }
  async function saveCred(keyId, pem) { const { key, alg } = await importPem(pem); const c = { keyId: keyId.trim(), key, alg, savedAt: new Date().toISOString() }; await idbDo("readwrite", s => s.put(c, KEY_SLOT())); credCache = c; return c; }
  async function forget() { await idbDo("readwrite", s => s.delete(KEY_SLOT())); credCache = null; }

  async function call(method, path, body, signed = true) {
    const s = settings(), cred = signed ? await getCred() : null;
    if (signed && !cred) throw new Error("Add your Kalshi API key in Settings first.");
    const full = `/trade-api/v2${path}`;
    const headers = { "content-type": "application/json", ...(signed ? await authHeaders(cred, method, full) : {}) };
    let r;
    try { r = await fetch(s.relay.replace(/\/+$/, "") + full, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
    catch { throw new Error(`Couldn't reach your relay at ${s.relay}. Is it running? (see Settings → How to set up)`); }
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
    if (!r.ok) throw new Error(`Kalshi ${r.status}: ${j?.error?.message || j?.message || j?.error || txt.slice(0, 200) || r.statusText}`);
    return j;
  }
  const balance = async () => { const j = await call("GET", "/portfolio/balance"); return j.balance_dollars != null ? +j.balance_dollars : (j.balance ?? 0) / 100; };
  const market = async ticker => (await call("GET", `/markets/${encodeURIComponent(ticker)}`, null, false)).market;
  const placeOrder = o => call("POST", "/portfolio/events/orders", orderBody(o));

  // ---------------------------------------------------------------- UI
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = x => `$${(+x).toFixed(2)}`;
  const pct = x => `${(x * 100).toFixed(1)}%`;

  async function openSettings() {
    const dlg = document.getElementById("settingsDlg"), s = settings(), cred = await getCred();
    dlg.innerHTML = `<form method="dialog" class="track-form" id="setForm">
      <h2>Settings</h2>
      ${root.PropAuth?.unlocked?.() ? `<div class="set-acct"><span>Unlocked for this browser session</span><button type="button" class="chip sm" id="setSignOut">Lock</button></div>` : ""}
      <h3 class="set-h">Kalshi account</h3>
      <p class="pl-sub">Lets you place a bet on Kalshi from a prop you like. Your private key stays in this browser, locked so it can be used to sign orders but never read back out. Real money: orders are only sent after you confirm each one.</p>
      ${cred ? `<div class="set-key"><span class="tag won">key saved</span> <span class="pl-sub">API key ID ${esc(cred.keyId.slice(0, 8))}… · ${esc(cred.alg)} · added ${new Date(cred.savedAt).toLocaleDateString()}</span> <button type="button" class="chip sm" id="setForget">Remove key</button></div>` : ""}
      <label>API key ID <input id="setKeyId" type="text" autocomplete="off" spellcheck="false" placeholder="${cred ? "leave blank to keep the saved key" : "e.g. a952bcbe-ec3b-4b5b-…"}"/></label>
      <label>Private key <textarea id="setPem" rows="4" spellcheck="false" autocomplete="off" placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;…&#10;-----END RSA PRIVATE KEY-----"></textarea></label>
      <label class="file-pick">or load the key file <input id="setFile" type="file" accept=".pem,.key,.txt"/></label>
      <label>Relay URL <input id="setRelay" type="url" value="${esc(s.relay)}"/></label>
      <div class="tf-grid">
        <label>Max per order ($) <input id="setMax" type="number" min="1" max="1000" step="1" value="${esc(s.maxOrder)}"/></label>
        <label class="check"><input id="setOn" type="checkbox"${s.enabled ? " checked" : ""}/> Enable placing orders</label>
      </div>
      <div class="pl-sub" id="setMsg" role="status"></div>
      <details class="set-help"><summary>How to set up</summary><ol class="pl-sub">
        <li>On kalshi.com go to Account &amp; security → API keys → Create key. Save the key ID and download the private key file.</li>
        <li>Kalshi blocks requests from websites, so orders go through a small relay that you run. Quick start on a computer: <code>node scripts/kalshi-relay.mjs</code> in this repo, then keep the relay URL as <code>http://localhost:8787</code>. To use it from your phone, paste <code>relay/kalshi-relay-worker.mjs</code> into a free Cloudflare Worker (instructions at the top of that file) and put its URL here. The relay never sees your key.</li>
        <li>Paste the key ID and private key here, press Test, then tick "Enable placing orders".</li>
      </ol><p class="pl-sub">Anyone with access to this browser profile could place orders with the saved key. Use a separate browser profile if this device is shared, and remove the key when you're done. Kalshi API keys can trade but can't withdraw funds.</p></details>
      <div class="tf-actions"><button type="button" class="chip" id="setTest">Test connection</button><button type="button" class="chip" id="setClose">Close</button><button type="submit" class="chip active">Save</button></div>
    </form>`;
    const $ = q => dlg.querySelector(q), msg = (t, bad) => { $("#setMsg").innerHTML = t; $("#setMsg").style.color = bad ? "var(--miss)" : ""; };
    $("#setFile").onchange = async e => { const f = e.target.files[0]; if (f) $("#setPem").value = await f.text(); };
    $("#setClose").onclick = () => dlg.close();
    if ($("#setSignOut")) $("#setSignOut").onclick = () => root.PropAuth?.lock();
    if ($("#setForget")) $("#setForget").onclick = async () => { await forget(); saveSettings({ ...settings(), enabled: false }); openSettings(); };
    const persist = async () => {
      const relay = $("#setRelay").value.trim() || "http://localhost:8787";
      if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(relay)) throw new Error("The relay URL must be https://… (or http://localhost for a relay on this computer).");
      const pem = $("#setPem").value.trim(), keyId = $("#setKeyId").value.trim();
      if (pem || keyId) { if (!pem || !keyId) throw new Error("Enter both the API key ID and the private key."); await saveCred(keyId, pem); $("#setPem").value = ""; $("#setKeyId").value = ""; }
      saveSettings({ relay, maxOrder: Math.min(1000, Math.max(1, +$("#setMax").value || 25)), enabled: $("#setOn").checked && !!(await getCred()) });
    };
    $("#setTest").onclick = async () => { try { await persist(); msg("Testing…"); const b = await balance(); msg(`Connected. Kalshi balance: <b>${usd(b)}</b>`); } catch (e) { msg(esc(e.message), true); } };
    $("#setForm").onsubmit = async e => { e.preventDefault(); try { await persist(); dlg.close(); root.PropKalshi.onChange?.(); } catch (er) { msg(esc(er.message), true); } };
    dlg.showModal();
  }

  /**
   * Order ticket for a Kalshi prop: pick the strike/side, re-price against the live market, confirm.
   * opts: { p, sport, stat, label, quotes: Kalshi quotes for this prop, pick: {line, side}, probAt(line, side, q) }
   */
  async function openOrder(opts) {
    const dlg = document.getElementById("kalshiDlg"), s = settings(), M = root.PropModel;
    const qs = (opts.quotes || []).filter(q => q.tk);
    const choices = qs.flatMap(q => [["over", q], ["under", q]]);
    let sel = Math.max(0, choices.findIndex(([sd, q]) => q.l === opts.pick?.line && sd === opts.pick?.side));
    const bank = (() => { try { return +JSON.parse(localStorage.getItem((window.PROPLAB_NS || "proplab:") + "bankroll") || "1000"); } catch { return 1000; } })();
    let live = null, userStake = null;
    const render = (state = "") => {
      const [side, q] = choices[sel] || [];
      const buy = side === "over" ? "yes" : "no";
      const ask = live ? +(buy === "yes" ? live.yes_ask_dollars : live.no_ask_dollars) : (buy === "yes" ? q?.ya : q?.na);
      const prob = q ? opts.probAt(q.l, side, live ? { ...q, o: M.toAmerican(+live.yes_ask_dollars), u: M.toAmerican(+live.no_ask_dollars) } : q) : null;
      const perCost = ask ? ask + takerFee(1, ask) : null;
      const kel = prob != null && perCost ? M.kelly(prob, M.toAmerican(Math.min(0.99, perCost))) : 0;
      const kStake = Math.round(Math.min(s.maxOrder, bank * kel * 0.25));
      const stake = userStake ?? (kStake >= 1 ? kStake : Math.min(5, s.maxOrder));
      const z = ask ? size(stake, ask, s.maxOrder) : { contracts: 0, cost: 0, fee: 0 };
      const ev = prob != null && z.contracts ? (prob * z.contracts - z.cost) / z.cost : null;
      const moved = live && q && ask != null && (buy === "yes" ? q.ya : q.na) != null ? ask - (buy === "yes" ? q.ya : q.na) : 0;
      const closed = live && live.status && !/active|open/i.test(live.status);
      dlg.innerHTML = `<form method="dialog" class="track-form" id="koForm">
        <h2>Bet on Kalshi <span class="pl-sub">${esc(opts.p.name)} · ${esc(opts.label)}</span></h2>
        ${!s.enabled ? `<p class="pl-sub" style="color:var(--miss)">Order placement is off. Turn it on in Settings (and add your API key).</p>` : ""}
        <label>Pick <select id="koPick">${choices.map(([sd, qq], i) => `<option value="${i}"${i === sel ? " selected" : ""}>${sd === "over" ? "Over" : "Under"} ${qq.l} → buy ${sd === "over" ? "YES" : "NO"} on “${esc(qq.title || `${Math.floor(qq.l) + 1}+ ${opts.label}`)}”</option>`).join("")}</select></label>
        <div class="ko-open">${q ? link(q, "Open this market in Kalshi", "kalshi-link") : ""}</div>
        <div class="ko-live">${live ? `Live ask <b>${ask != null ? Math.round(ask * 100) + "¢" : "—"}</b>${moved ? ` <span style="color:${moved > 0 ? "var(--miss)" : "var(--hit)"}">(${moved > 0 ? "+" : ""}${Math.round(moved * 100)}¢ since the data refresh)</span>` : ""} · ${esc(live.status || "")}` : state === "loading" ? "Getting the live price…" : `Ask ${ask != null ? Math.round(ask * 100) + "¢" : "—"} at the last data refresh`}</div>
        <div class="tf-grid">
          <label>Stake up to ($) <input id="koStake" type="number" min="1" step="1" max="${esc(s.maxOrder)}" value="${esc(stake)}"/></label>
          <div class="ko-sum"><div><b>${z.contracts}</b> contract${z.contracts === 1 ? "" : "s"}</div><div class="pl-sub">cost ${usd(z.cost)} incl. ${usd(z.fee)} fee · pays ${usd(z.contracts)} if it hits</div></div>
        </div>
        <div class="pl-sub">We estimate <b>${prob != null ? pct(prob) : "—"}</b> to hit · EV at this price <b style="color:${(ev ?? 0) >= 0 ? "var(--hit)" : "var(--miss)"}">${ev != null ? (ev >= 0 ? "+" : "") + pct(ev) : "—"}</b> · quarter-Kelly ${usd(bank * kel * 0.25)} of your ${usd(bank)} bankroll · max per order ${usd(s.maxOrder)}</div>
        ${ev != null && ev < 0 ? `<p class="pl-sub" style="color:var(--miss)">No edge at the live price.</p>` : ""}
        ${closed ? `<p class="pl-sub" style="color:var(--miss)">This market isn't open for trading.</p>` : ""}
        <label class="check"><input type="checkbox" id="koOk"/> I understand this sends a real-money order to Kalshi (fills now at ${ask != null ? Math.round(ask * 100) + "¢" : "the ask"} or better, otherwise cancels).</label>
        <div class="pl-sub" id="koMsg" role="status"></div>
        <div class="tf-actions"><button type="button" class="chip" id="koCancel">Cancel</button><button type="submit" class="chip active" id="koGo" disabled>Place order</button></div>
      </form>`;
      const $ = x => dlg.querySelector(x);
      $("#koPick").onchange = e => { sel = +e.target.value; live = null; userStake = null; render("loading"); refresh(); };
      $("#koStake").oninput = () => { clearTimeout($("#koStake")._t); $("#koStake")._t = setTimeout(() => { userStake = Math.max(0, +$("#koStake").value || 0); render(); const n = dlg.querySelector("#koStake"); n.focus(); }, 400); };
      $("#koCancel").onclick = () => dlg.close();
      const canGo = () => s.enabled && $("#koOk").checked && z.contracts > 0 && !closed && ask != null && live;
      $("#koOk").onchange = () => { $("#koGo").disabled = !canGo(); };
      $("#koForm").onsubmit = async e => {
        e.preventDefault(); if (!canGo()) return;
        $("#koGo").disabled = true; $("#koMsg").textContent = "Sending order…";
        try {
          const clientId = (root.crypto.randomUUID && root.crypto.randomUUID()) || String(Date.now());
          const r = await placeOrder({ ticker: q.tk, buy, contracts: z.contracts, price: ask, clientId });
          const filled = Math.floor(parseFloat(r.fill_count ?? r.order?.fill_count_fp ?? 0));
          if (!filled) { $("#koMsg").innerHTML = `No fill: the price moved before the order arrived. Nothing was bought. <span class="pl-sub">(order ${esc(r.order_id || "")})</span>`; $("#koGo").disabled = false; return; }
          const avgYes = r.average_fill_price != null ? +r.average_fill_price : null;
          const each = avgYes != null ? (buy === "yes" ? avgYes : 1 - avgYes) : ask;
          const fee = r.average_fee_paid != null ? +r.average_fee_paid * filled : takerFee(filled, each);
          const cost = +(filled * each + fee).toFixed(2);
          root.PropBets?.addBet?.({ p: opts.p, sport: opts.sport, stat: opts.stat, label: opts.label, side, line: q.l, price: M.toAmerican(Math.min(0.99, cost / filled)),
            book: "Kalshi", stake: cost, prob, real: { orderId: r.order_id, ticker: q.tk, href: href(q), contracts: filled, buy } });
          $("#koMsg").innerHTML = `<b style="color:var(--hit)">Filled ${filled} contract${filled === 1 ? "" : "s"}</b> at ${Math.round(each * 100)}¢ (${usd(cost)} incl. fees). Added to My Bets. ${link(q, "See it in Kalshi", "kalshi-link")}`;
          $("#koCancel").textContent = "Done";
        } catch (er) { $("#koMsg").innerHTML = `<span style="color:var(--miss)">${esc(er.message)}</span>`; $("#koGo").disabled = false; }
      };
    };
    const refresh = async () => { const [, q] = choices[sel] || []; if (!q) return; try { live = await market(q.tk); render(); } catch (e) { render(); const m = dlg.querySelector("#koMsg"); if (m) m.innerHTML = `<span style="color:var(--miss)">${esc(e.message)}</span>`; } };
    if (!choices.length) { dlg.innerHTML = `<div class="track-form"><h2>Bet on Kalshi</h2><p class="pl-sub">No Kalshi market for this prop.</p><div class="tf-actions"><button class="chip" onclick="this.closest('dialog').close()">Close</button></div></div>`; dlg.showModal(); return; }
    render("loading"); dlg.showModal(); refresh();
  }

  const api = { href, link, importPem, pkcs1ToPkcs8, authHeaders, orderBody, size, takerFee, settings, saveSettings, getCred, saveCred, forget, balance, market, placeOrder, openSettings, openOrder,
    ready: async () => settings().enabled && !!(await getCred()) };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PropKalshi = api;
})(typeof window !== "undefined" ? window : globalThis);
