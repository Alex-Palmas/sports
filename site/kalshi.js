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

  // PKCS#8 wrapper for a bare 32-byte Ed25519 private key (seed)
  const ED25519_PKCS8_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
  const edSeedToPkcs8 = seed => Uint8Array.from([...ED25519_PKCS8_PREFIX, ...seed]);
  async function importEd25519(body) {
    try { return { key: await subtle().importKey("pkcs8", body, { name: "Ed25519" }, false, ["sign"]), alg: "Ed25519" }; }
    catch (e) {
      // browsers without Ed25519 in WebCrypto throw NotSupportedError
      if (/NotSupported|Unrecognized|not supported/i.test(`${e.name} ${e.message}`)) throw new Error("This browser can't sign with Ed25519 keys. Update Chrome/Safari/Firefox, or use an RSA key from Kalshi.");
      throw new Error("Couldn't read that Ed25519 key. Paste the whole key, including any BEGIN/END lines.");
    }
  }

  /**
   * Parse a Kalshi private key into a non-extractable signing key. Returns { key, alg }.
   * Accepts RSA (PKCS#1 "RSA PRIVATE KEY" or PKCS#8 "PRIVATE KEY") and Ed25519 (PKCS#8 "PRIVATE KEY",
   * or the bare key as base64/hex: 32-byte seed, or 64 bytes seed+public key).
   */
  async function importPem(pem) {
    const text = String(pem || "").trim();
    const m = text.match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/);
    if (!m) {
      // no PEM armor: maybe a bare Ed25519 key
      const compact = text.replace(/\s+/g, "");
      let raw = null;
      if (/^[0-9a-fA-F]{64}$|^[0-9a-fA-F]{128}$/.test(compact)) raw = Uint8Array.from(compact.match(/../g), h => parseInt(h, 16));
      else if (/^[A-Za-z0-9+/=_-]{40,100}$/.test(compact)) { try { raw = unb64(compact.replace(/-/g, "+").replace(/_/g, "/")); } catch {} }
      if (raw && (raw.length === 32 || raw.length === 64)) return importEd25519(edSeedToPkcs8(raw.slice(0, 32)));
      throw new Error("That doesn't look like a private key. Paste the key file Kalshi gave you (it usually starts with -----BEGIN … PRIVATE KEY-----).");
    }
    let body = unb64(m[2].replace(/[^A-Za-z0-9+/=]/g, ""));
    if (m[1] === "OPENSSH PRIVATE KEY") throw new Error("That's an OpenSSH-format key. Use the private key file Kalshi gave you (PEM).");
    if (m[1] === "RSA PRIVATE KEY") body = pkcs1ToPkcs8(body);
    else if (m[1] !== "PRIVATE KEY") throw new Error(`Unsupported key type "${m[1]}". Use the private key file Kalshi gave you.`);
    // PKCS#8 Ed25519 keys carry the OID 1.3.101.112 (06 03 2b 65 70) near the start
    const isEd = body.length < 100 && body.slice(0, 16).some((b, i) => b === 0x2b && body[i + 1] === 0x65 && body[i + 2] === 0x70);
    if (isEd) return importEd25519(body);
    try { return { key: await subtle().importKey("pkcs8", body, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]), alg: "RSA-PSS" }; }
    catch (e) {
      try { return await importEd25519(body); }
      catch (e2) { if (/can't sign with Ed25519/.test(e2.message)) throw e2; throw new Error("Couldn't read that private key. Paste the whole key file, including the BEGIN/END lines."); }
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
  // Kalshi wants 2–4 decimals ("0.50", not "0.5"): cents as "0.xx", sub-cent prices keep 4 places
  const fmtPrice = x => { const c = Math.round(x * 10000) / 10000; return Math.abs(c * 100 - Math.round(c * 100)) < 1e-6 ? c.toFixed(2) : c.toFixed(4); };
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
  // the PropLab Mac app runs its own relay and tells the page where it is
  const desktopRelay = () => (typeof window !== "undefined" && window.PROPLAB_DESKTOP?.relay) || null;
  const settings = () => {
    let s; try { s = { relay: "http://localhost:8787", maxOrder: 25, enabled: false, quickAmount: 5, botPct: 50, botBetPct: 1, botLeadHours: 2, ...JSON.parse(localStorage.getItem(LS) || "{}") }; }
    catch { s = { relay: "http://localhost:8787", maxOrder: 25, enabled: false, quickAmount: 5 }; }
    if (desktopRelay()) s.relay = desktopRelay();
    return s;
  };
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

  // Kalshi rate-limits per account/IP: every request goes through one queue spaced ~150 ms apart
  // (≈6 per second), and a 429 "too many requests" waits (Retry-After, else 1s, 2s, 4s, 8s) and retries.
  const GAP_MS = 150;
  let queue = Promise.resolve(), lastAt = 0;
  const pace = () => { const p = queue.then(async () => { const w = lastAt + GAP_MS - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w)); lastAt = Date.now(); }); queue = p.catch(() => {}); return p; };
  async function call(method, path, body, signed = true) {
    const s = settings(), cred = signed ? await getCred() : null;
    if (signed && !cred) throw new Error("Add your Kalshi API key in Settings first.");
    const full = `/trade-api/v2${path}`;
    let r;
    for (let attempt = 0; ; attempt++) {
      await pace();
      // signed fresh each try: the signature includes the timestamp
      const headers = { "content-type": "application/json", ...(signed ? await authHeaders(cred, method, full) : {}) };
      try { r = await fetch(s.relay.replace(/\/+$/, "") + full, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
      catch { if (desktopRelay()) throw new Error("Couldn't reach Kalshi through the app's built-in relay. Check your internet connection and try again."); throw new Error(`Couldn't reach your relay at ${s.relay}. Is it running? (see Settings → How to set up)`); }
      if (r.status !== 429 || attempt >= 4) break;
      const ra = +r.headers.get("retry-after");
      const wait = ra > 0 ? Math.min(ra * 1000, 15000) : 1000 * 2 ** attempt;
      lastAt = Date.now() + wait;   // hold the whole queue, not just this request
      await new Promise(res => setTimeout(res, wait));
    }
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
    if (r.status === 429) throw new Error("Kalshi 429: too many requests (still limited after retrying). Wait a minute and try again.");
    if (!r.ok) throw new Error(`Kalshi ${r.status}: ${j?.error?.message || j?.message || j?.error || txt.slice(0, 200) || r.statusText}`);
    return j;
  }
  const balance = async () => { const j = await call("GET", "/portfolio/balance"); return j.balance_dollars != null ? +j.balance_dollars : (j.balance ?? 0) / 100; };
  /**
   * Where the money is. Kalshi keeps balances per exchange shard (balance_breakdown) and routes each
   * order to its market's shard; a key restricted to a subaccount sees only that subaccount (no breakdown).
   */
  async function balanceInfo() {
    const j = await call("GET", "/portfolio/balance");
    const total = j.balance_dollars != null ? +j.balance_dollars : (j.balance ?? 0) / 100;
    const shards = (j.balance_breakdown || []).map(b => ({ index: +b.exchange_index, balance: +(b.balance_dollars ?? b.balance ?? 0) || 0 })).sort((a, b) => a.index - b.index);
    let key = null;
    try { const cred = await getCred(); const k = (await call("GET", "/api_keys")).api_keys?.find(x => x.api_key_id === cred?.keyId); if (k) key = { scopes: k.scopes || [], subaccount: k.subaccount ?? null }; } catch {}
    return { total, shards, subaccountKey: !j.balance_breakdown || key?.subaccount != null, key };
  }
  /** Money in open (unsettled) positions, summed from Kalshi's positions (all shards). */
  async function openExposure() {
    let cursor = "", total = 0, n = 0;
    for (let page = 0; page < 20; page++) {
      const j = await call("GET", `/portfolio/positions?count_filter=position&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const m of j.market_positions || []) { const x = Math.abs(+(m.market_exposure_dollars ?? 0)) || 0; total += x; if (x) n++; }
      cursor = j.cursor; if (!cursor) break;
    }
    return { total: +total.toFixed(2), positions: n };
  }
  const usdS = x => `$${(+x).toFixed(2)}`;
  const describeBalances = info => info.shards.length > 1 ? info.shards.map(x => `${usdS(x.balance)} on shard ${x.index}`).join(", ") : usdS(info.total);
  /** Move money between event-contract shards (needs the key's write::transfer scope). */
  async function transfer(fromShard, toShard, dollars) {
    const id = (root.crypto.randomUUID && root.crypto.randomUUID()) || String(Date.now());
    return call("POST", "/portfolio/intra_exchange_instance_transfer", { client_transfer_id: id, source: "event_contract", destination: "event_contract",
      source_exchange_shard: fromShard, destination_exchange_shard: toShard, amount: Math.ceil(dollars * 10000) });   // centicents
  }
  /**
   * After Kalshi says "insufficient balance": find out why. Returns { message, fix? } where fix is a
   * transfer that would cover the order (another shard holds enough).
   */
  async function diagnoseInsufficient(ticker, needed) {
    let info, m;
    try { [info, m] = await Promise.all([balanceInfo(), market(ticker)]); } catch { return { message: "Kalshi says your balance is too low for this order." }; }
    const shard = m?.exchange_index != null ? +m.exchange_index : null;
    if (info.subaccountKey) return { message: `Kalshi says insufficient balance. This API key is tied to a subaccount and only sees ${usdS(info.total)}. Create an API key for your main account on kalshi.com (or move money into that subaccount).` };
    if (shard == null || !info.shards.length) return { message: `Kalshi says insufficient balance (your key sees ${usdS(info.total)}; this order needs about ${usdS(needed)}).` };
    const here = info.shards.find(x => x.index === shard)?.balance ?? 0;
    if (here >= needed) return { message: `Kalshi says insufficient balance, but shard ${shard} shows ${usdS(here)}. Funds may still be settling; try again in a minute.` };
    const src = info.shards.filter(x => x.index !== shard && x.balance >= needed - here).sort((a, b) => b.balance - a.balance)[0];
    const amount = +(Math.max(needed - here, 1) + 0.5).toFixed(2);   // a little headroom for fees and price ticks
    const base = `This market trades on Kalshi shard ${shard}, where you have ${usdS(here)}. Your money: ${describeBalances(info)}.`;
    if (!src) return { message: `${base} Not enough on any shard for this order (needs about ${usdS(needed)}).` };
    return { message: base, fix: { from: src.index, to: shard, amount: Math.min(amount, src.balance) } };
  }
  /** Run an order; on "insufficient balance", explain and (with the user's OK) move funds and retry once. */
  async function withFundsFix(ticker, needed, run, confirmFn = q => root.confirm(q)) {
    try { return await run(); }
    catch (e) {
      if (!/insufficient/i.test(e.message)) throw e;
      const d = await diagnoseInsufficient(ticker, needed);
      if (!d.fix) throw new Error(d.message);
      if (!confirmFn(`${d.message}\n\nMove ${usdS(d.fix.amount)} from shard ${d.fix.from} to shard ${d.fix.to} and place the bet?`)) throw new Error(d.message);
      try { await transfer(d.fix.from, d.fix.to, d.fix.amount); }
      catch (te) { throw new Error(`${d.message} Moving funds failed (${te.message}). Your API key may need the "transfer" permission, or move it on kalshi.com.`); }
      await new Promise(r => setTimeout(r, 1500));
      return run();
    }
  }
  /** Live quotes for many markets (public data through the relay, 100 tickers per request). */
  async function markets(tickers) {
    const out = [];
    for (let i = 0; i < tickers.length; i += 100) {
      const j = await call("GET", `/markets?limit=1000&tickers=${encodeURIComponent(tickers.slice(i, i + 100).join(","))}`, null, false);
      out.push(...(j.markets || []));
    }
    return out;
  }
  /** Where live prices come from: the app's built-in relay, or a relay the user set up. */
  const liveSource = () => desktopRelay() ? "app" : "relay";
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
      ${cred ? `<div class="set-key"><span class="tag won">key saved</span> <span class="pl-sub">API key ID ${esc(cred.keyId.slice(0, 8))}… · ${esc(cred.alg === "Ed25519" ? "Ed25519 key" : "RSA key")} · added ${new Date(cred.savedAt).toLocaleDateString()}</span> <button type="button" class="chip sm" id="setForget">Remove key</button></div>` : ""}
      <label>API key ID <input id="setKeyId" type="text" autocomplete="off" spellcheck="false" placeholder="${cred ? "leave blank to keep the saved key" : "e.g. a952bcbe-ec3b-4b5b-…"}"/></label>
      <label>Private key (RSA or Ed25519) <textarea id="setPem" rows="4" spellcheck="false" autocomplete="off" placeholder="-----BEGIN … PRIVATE KEY-----&#10;(RSA or Ed25519)&#10;-----END … PRIVATE KEY-----"></textarea></label>
      <label class="file-pick">or load the key file <input id="setFile" type="file" accept=".pem,.key,.txt"/></label>
      ${desktopRelay() ? `<div class="set-acct"><span>Relay: <b>built into the PropLab app</b></span><span class="tag won">connected</span></div><input id="setRelay" type="hidden" value="${esc(s.relay)}"/>`
        : `<label>Relay URL <input id="setRelay" type="url" value="${esc(s.relay)}"/></label>`}
      <div class="tf-grid">
        <label>Max per order ($) <input id="setMax" type="number" min="1" max="1000" step="1" value="${esc(s.maxOrder)}"/></label>
        <label>"Bet" button amount ($) <input id="setQuick" type="number" min="1" max="1000" step="1" value="${esc(s.quickAmount ?? 5)}"/></label>
        <label class="check"><input id="setOn" type="checkbox"${s.enabled ? " checked" : ""}/> Enable placing orders</label>
      </div>
      ${root.PropOdds ? (() => { const o = root.PropOdds.settings(), c = root.PropOdds.cache(); return `
      <h3 class="set-h">Sportsbook odds (The Odds API)</h3>
      <p class="pl-sub">Adds DraftKings, FanDuel, BetMGM, Caesars and more next to Kalshi. Use your own free key from <a href="https://the-odds-api.com" target="_blank" rel="noopener">the-odds-api.com</a> (500 credits a month free). The key stays in this browser and only your credits are used. Each game's odds cost about ${"2–3"} credits per region.</p>
      ${o.key ? `<div class="set-key"><span class="tag won">key saved</span> <span class="pl-sub">…${esc(o.key.slice(-4))}${c?.at ? ` · last loaded ${new Date(c.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}: ${c.games} game${c.games === 1 ? "" : "s"}, ${c.spent} credits${c.remaining != null ? ` · ${c.remaining} credits left this month` : ""}` : ""}</span> <button type="button" class="chip sm" id="setOddsForget">Remove key</button></div>` : ""}
      <label>Odds API key <input id="setOddsKey" type="password" autocomplete="off" spellcheck="false" placeholder="${o.key ? "leave blank to keep the saved key" : "paste your key from the-odds-api.com"}"/></label>
      <div class="tf-grid">
        <label>Books <select id="setOddsRegions"><option value="us"${o.regions === "us" ? " selected" : ""}>US books (DraftKings, FanDuel, BetMGM, Caesars, …)</option><option value="us,us2"${o.regions === "us,us2" ? " selected" : ""}>US + Hard Rock, Fliff, … (2× credits)</option></select></label>
        <label>Credits per load <input id="setOddsMax" type="number" min="1" max="2000" step="1" value="${esc(o.maxCredits)}"/></label>
        <label>Load automatically every (hours, 0 = only when I tap Load) <input id="setOddsAuto" type="number" min="0" max="168" step="1" value="${esc(o.autoHours)}"/></label>
      </div>
      <div class="tf-actions" style="justify-content:flex-start"><button type="button" class="chip" id="setOddsTest">Test key</button><button type="button" class="chip" id="setOddsLoad">Load sportsbook odds now</button></div>
      <div class="pl-sub" id="setOddsMsg" role="status"></div>`; })() : ""}
      ${root.PropModel?.EDGE_FITS ? (() => { const mode = root.PropModel.edgeMode(); return `
      <h3 class="set-h">Edge model (NBA Kalshi props)</h3>
      <label>Model <select id="setEdgeMode">
        <option value="market"${mode === "market" ? " selected" : ""}>Conservative: follows Kalshi's price (recommended; few or no bets)</option>
        <option value="players"${mode === "players" ? " selected" : ""}>Site players: Kalshi's price refit on the site's players (also close to the price)</option>
      </select></label>
      <p class="pl-sub">Takes effect right away on the Edge Board and for Auto bet. On real Kalshi results neither model found a reliable edge on NBA props (an earlier "NO on overs" edge came from a backtest bug, fixed 2026-11-13), so expect few or no picks.</p>`; })() : ""}
      <h3 class="set-h">Auto bet bot</h3>
      <p class="pl-sub">When "Auto bet" is ticked on the Edge Board, the bot bets on every Kalshi pick the board is showing (with its current filters), and on new ones as they appear. It checks your Kalshi cash and open bets every few minutes: your account = cash + money in open bets. Each bet is a share of the account (capped by "Max per order", at least one contract), and the bot keeps the money in open bets under its limit, so when bets settle the freed cash goes into new picks. One bet per pick, placed only in the last hours before the game (default 2 h). It only runs while PropLab is open.</p>
      <div class="tf-grid">
        <label>Each bet (% of account) <input id="setBotBetPct" type="number" min="0.1" max="100" step="0.1" value="${esc(s.botBetPct ?? 1)}"/></label>
        <label>Max in open bets (% of account) <input id="setBotPct" type="number" min="1" max="100" step="1" value="${esc(s.botPct ?? 50)}"/></label>
        <label>Bet only within (hours before the game) <input id="setBotLead" type="number" min="0.25" max="48" step="0.25" value="${esc(s.botLeadHours ?? 2)}"/></label>
        <div class="pl-sub" id="setBotNow">${root.PropEdge?.botSummary?.() || ""}</div>
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
      persistOdds();
      const relay = desktopRelay() || $("#setRelay").value.trim() || "http://localhost:8787";
      if (!desktopRelay() && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(relay)) throw new Error("The relay URL must be https://… (or http://localhost for a relay on this computer).");
      const pem = $("#setPem").value.trim(), keyId = $("#setKeyId").value.trim();
      if (pem || keyId) { if (!pem || !keyId) throw new Error("Enter both the API key ID and the private key."); await saveCred(keyId, pem); $("#setPem").value = ""; $("#setKeyId").value = ""; }
      const maxOrder = Math.min(1000, Math.max(1, +$("#setMax").value || 25));
      saveSettings({ ...settings(), relay, maxOrder, quickAmount: Math.min(maxOrder, Math.max(1, +$("#setQuick").value || 5)), enabled: $("#setOn").checked && !!(await getCred()),
        botPct: Math.min(100, Math.max(1, Math.round(+$("#setBotPct").value || 50))),
        botBetPct: Math.min(100, Math.max(0.1, Math.round((+$("#setBotBetPct").value || 1) * 10) / 10)),
        botLeadHours: Math.min(48, Math.max(0.25, +$("#setBotLead").value || 2)) });
    };
    // sportsbook odds (The Odds API): saved with the rest; Test and Load use the key in the box or the saved one
    const oMsg = (t, bad) => { const m = $("#setOddsMsg"); if (m) { m.innerHTML = t; m.style.color = bad ? "var(--miss)" : ""; } };
    const persistOdds = () => {
      const O = root.PropOdds; if (!O || !$("#setOddsKey")) return;
      const k = $("#setOddsKey").value.trim();
      O.saveSettings({ ...(k ? { key: k } : {}), regions: $("#setOddsRegions").value, maxCredits: Math.min(2000, Math.max(1, Math.round(+$("#setOddsMax").value || 15))), autoHours: Math.min(168, Math.max(0, Math.round(+$("#setOddsAuto").value || 0))) });
      if (k) $("#setOddsKey").value = "";
    };
    if ($("#setOddsForget")) $("#setOddsForget").onclick = () => { root.PropOdds.forget(); root.PropOdds.onChange?.(); openSettings(); };
    if ($("#setOddsTest")) $("#setOddsTest").onclick = async () => {
      try { persistOdds(); const k = root.PropOdds.settings().key; if (!k) throw new Error("Paste your Odds API key first.");
        oMsg("Testing…"); const r = await root.PropOdds.test(k); oMsg(`Key works.${r.remaining != null ? ` <b>${r.remaining}</b> credits left this month (${r.used} used).` : ""}`); }
      catch (e) { oMsg(esc(e.message), true); }
    };
    if ($("#setOddsLoad")) $("#setOddsLoad").onclick = async () => {
      try { persistOdds(); oMsg("Loading sportsbook odds…");
        const r = await root.PropOdds.refresh(root.PropData?.get?.()); const n = root.PropOdds.onChange?.() ?? 0;
        oMsg(`Loaded ${r.games} of ${r.of} upcoming game${r.of === 1 ? "" : "s"} (${r.spent} credits): book lines for ${Object.keys(r.quotes).length} player prop${Object.keys(r.quotes).length === 1 ? "" : "s"}.${r.remaining != null ? ` ${r.remaining} credits left this month.` : ""}${r.games < r.of ? " Raise “Credits per load” to cover more games." : ""}`); }
      catch (e) { oMsg(esc(e.message), true); }
    };
    if ($("#setEdgeMode")) $("#setEdgeMode").onchange = e => { try { localStorage.setItem((root.PROPLAB_NS || "proplab:") + "edgeMode2", JSON.stringify(e.target.value)); } catch {} root.PropView?.redraw?.(); };
    $("#setTest").onclick = async () => { try { await persist(); msg("Testing…"); const info = await balanceInfo();
      msg(`Connected. Kalshi balance: <b>${usd(info.total)}</b>${info.shards.length > 1 ? ` <span class="pl-sub">(${esc(describeBalances(info))})</span>` : ""}${info.subaccountKey ? `<br><span style="color:var(--amber)">This API key is tied to a subaccount, so it only sees that subaccount's money.</span>` : ""}${info.key && !info.key.scopes.some(x => /write/.test(x)) ? `<br><span style="color:var(--amber)">This API key is read-only, so it can't place orders.</span>` : ""}`); } catch (e) { msg(esc(e.message), true); } };
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
          const r = await withFundsFix(q.tk, z.cost, () => placeOrder({ ticker: q.tk, buy, contracts: z.contracts, price: ask, clientId: (root.crypto.randomUUID && root.crypto.randomUUID()) || clientId + Math.random() }));
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

  /**
   * One-tap bet from the Edge Board: the Settings amount on the recommended leg. Re-prices against the
   * live market first and refuses if the ask moved up more than 2c or the edge is gone; IOC order.
   * opts: { p, sport, stat, label, best } (best from PropModel.bestBet). Returns { filled, each, cost, buy }.
   */
  /** Default "price moved" prompt (the Edge Board passes its own inline one). */
  const confirmMoveDefault = ({ was, now, buy, prob, ev }) => Promise.resolve(root.confirm(
    `Price moved: ${buy.toUpperCase()} was ${Math.round(was * 100)}¢, now ${Math.round(now * 100)}¢.\n` +
    (prob != null ? `We make it ${Math.round(prob * 100)}% · EV ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}¢ per contract${ev < 0 ? " (no edge at this price)" : ""}.\n` : "") +
    `Accept ${Math.round(now * 100)}¢ and place the bet?`));
  async function quickBet({ p, sport, stat, label, best, confirmMove = confirmMoveDefault, amount: amountOverride, auto = false }) {
    const s = settings();
    if (!s.enabled || !(await getCred())) throw new Error("Turn on order placement and add your Kalshi key in Settings.");
    if (!best?.tk) throw new Error("No Kalshi market for this pick.");
    const amount = Math.min(amountOverride ?? s.quickAmount ?? 5, s.maxOrder);
    const m = await market(best.tk);
    if (m?.status && !/active|open/i.test(m.status)) throw new Error("This market isn't open for trading.");
    const buy = best.side === "over" ? "yes" : "no";
    const ask = +(buy === "yes" ? m.yes_ask_dollars : m.no_ask_dollars), was = buy === "yes" ? best.ya : best.na;
    if (!(ask > 0 && ask < 1)) throw new Error("No live price right now.");
    // re-price our estimate at the live quote (it is anchored on the market price, which may have moved)
    let prob = best.prob;
    const PM = root.PropModel;
    if (PM?.edgeOver) {
      const proj = PM.project(p, stat, sport), pr = proj && PM.probabilities(p, stat, best.line, proj, sport);
      const o = PM.edgeOver({ b: "Kalshi", l: best.line, ya: +m.yes_ask_dollars, na: +m.no_ask_dollars }, { p, stat, proj, league: sport, modelOver: pr?.over });
      if (o != null) prob = best.side === "over" ? o : 1 - o;
    }
    const evLive = prob != null ? prob - ask - takerFee(1, ask) : null;
    // the price you saw on the board vs the live ask: any move needs your OK at the new price
    if (was != null && Math.round(ask * 100) !== Math.round(was * 100)) {
      if (!(await confirmMove({ was, now: ask, buy, prob, ev: evLive }))) throw new Error(`Not placed: price is ${Math.round(ask * 100)}¢ now (was ${Math.round(was * 100)}¢).`);
    } else if (evLive != null && evLive <= 0) throw new Error(`No edge at the live price (${Math.round(ask * 100)}¢): we make it ${Math.round(prob * 100)}%. Not placed.`);
    const z = size(amount, ask, s.maxOrder);
    if (!z.contracts) throw new Error(`$${amount} doesn't buy a contract at ${Math.round(ask * 100)}¢.`);
    const clientId = (root.crypto.randomUUID && root.crypto.randomUUID()) || String(Date.now());
    const r = await withFundsFix(best.tk, z.cost, () => placeOrder({ ticker: best.tk, buy, contracts: z.contracts, price: ask, clientId: (root.crypto.randomUUID && root.crypto.randomUUID()) || clientId + Math.random() }),
      auto ? () => true : undefined);   // the bot may move its own money between Kalshi shards
    const filled = Math.floor(parseFloat(r.fill_count ?? r.order?.fill_count_fp ?? 0));
    if (!filled) throw new Error(`No fill at ${Math.round(ask * 100)}¢: the price moved again before the order arrived. Nothing was bought.`);
    const avgYes = r.average_fill_price != null ? +r.average_fill_price : null;
    const each = avgYes != null ? (buy === "yes" ? avgYes : 1 - avgYes) : ask;
    const fee = r.average_fee_paid != null ? +r.average_fee_paid * filled : takerFee(filled, each);
    const cost = +(filled * each + fee).toFixed(2);
    root.PropBets?.addBet?.({ p, sport, stat, label, side: best.side, line: best.line, price: root.PropModel.toAmerican(Math.min(0.99, cost / filled)),
      book: "Kalshi", stake: cost, prob: best.prob, real: { orderId: r.order_id, ticker: best.tk, href: best.href || href(best), contracts: filled, buy, bot: auto || undefined } });
    return { filled, each, cost, buy };
  }

  const api = { openExposure, markets, liveSource, balanceInfo, transfer, diagnoseInsufficient, withFundsFix, quickBet, href, link, importPem, pkcs1ToPkcs8, authHeaders, orderBody, size, takerFee, settings, saveSettings, getCred, saveCred, forget, balance, market, placeOrder, openSettings, openOrder,
    ready: async () => settings().enabled && !!(await getCred()) };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PropKalshi = api;
})(typeof window !== "undefined" ? window : globalThis);
