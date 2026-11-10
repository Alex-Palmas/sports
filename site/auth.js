/* Sign-in for PropLab.
 *
 * The site is static (GitHub Pages), so this is a gate in the browser, not server security: it checks a
 * username/password against salted PBKDF2 hashes in users.json (passwords are never stored), keeps a
 * session on this device, and gives every user their own storage (bets, watchlist, bankroll, settings,
 * Kalshi key). Anyone determined can still read the public data files directly.
 *
 * Load this before every other app script: it sets window.PROPLAB_NS (the storage prefix) synchronously.
 * Users are added with `node scripts/add-user.mjs <username>`.
 */
(function (root) {
  const ITER = 310000, enc = new TextEncoder();
  const subtle = () => (root.crypto || globalThis.crypto).subtle;
  const b64 = buf => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  /** PBKDF2-SHA256 → base64 (same parameters as scripts/add-user.mjs). */
  async function hashPassword(password, saltB64, iter = ITER) {
    const key = await subtle().importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    return b64(await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(saltB64), iterations: iter }, key, 256));
  }
  /** Constant-time-ish comparison of two base64 strings. */
  const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
  async function verify(users, username, password) {
    const u = (users || []).find(x => x.u.toLowerCase() === String(username || "").trim().toLowerCase());
    // hash even for unknown users so timing doesn't reveal which names exist
    const h = await hashPassword(String(password || ""), u?.salt || "AAAAAAAAAAAAAAAAAAAAAA==", u?.iter || ITER);
    return u && same(h, u.hash) ? { u: u.u, name: u.name || u.u } : null;
  }

  const api = { hashPassword, verify, ITER };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }

  // ---------------------------------------------------------------- browser
  const SESSION = "proplab:session";
  const readSession = () => {
    for (const st of [localStorage, sessionStorage]) {
      try { const s = JSON.parse(st.getItem(SESSION) || "null"); if (s && s.u && (!s.exp || s.exp > Date.now())) return s; } catch {}
    }
    return null;
  };
  const session = readSession();
  const nsOf = u => `proplab:u:${encodeURIComponent(u.toLowerCase())}:`;
  root.PROPLAB_NS = session ? nsOf(session.u) : "proplab:guest:";
  root.PROPLAB_USER = session;

  /** The first account to sign in on a device inherits that device's pre-login data (bets, settings…). */
  function adoptLegacy(u) {
    try {
      if (localStorage.getItem("proplab:legacyClaimed")) return;
      const ns = nsOf(u), keys = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^proplab:(?!u:|guest:|session|legacyClaimed)/.test(k)) keys.push(k); }
      for (const k of keys) if (localStorage.getItem(ns + k.slice(8)) == null) localStorage.setItem(ns + k.slice(8), localStorage.getItem(k));
      localStorage.setItem("proplab:legacyClaimed", u);
    } catch {}
  }

  function signOut() {
    try { localStorage.removeItem(SESSION); sessionStorage.removeItem(SESSION); } catch {}
    location.reload();
  }

  function showLogin() {
    document.documentElement.classList.add("auth-locked");
    const box = document.createElement("div");
    box.className = "login-screen"; box.id = "loginScreen";
    box.innerHTML = `<form class="login-card" id="loginForm" autocomplete="on">
      <div class="login-brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 17l6-6 4 4 8-8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span>Prop<b>Lab</b></span></div>
      <h1>Sign in</h1>
      <p class="pl-sub">Player props, edges and game lines.</p>
      <label>Username <input id="loginUser" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required/></label>
      <label>Password <input id="loginPass" name="password" type="password" autocomplete="current-password" required/></label>
      <label class="check"><input type="checkbox" id="loginKeep" checked/> Keep me signed in on this device</label>
      <div class="login-msg" id="loginMsg" role="alert"></div>
      <button class="login-btn" id="loginBtn" type="submit">Sign in</button>
      <p class="pl-sub login-foot">Ask the site owner for an account.</p>
    </form>`;
    const mount = () => { document.body.prepend(box); setTimeout(() => box.querySelector("#loginUser").focus(), 50); };
    document.body ? mount() : document.addEventListener("DOMContentLoaded", mount);
    let fails = 0, users = null;
    const loadUsers = () => users || (users = fetch("users.json", { cache: "no-cache" }).then(r => r.ok ? r.json() : []).catch(() => []));
    loadUsers();
    box.addEventListener("submit", async e => {
      e.preventDefault();
      const msg = box.querySelector("#loginMsg"), btn = box.querySelector("#loginBtn");
      btn.disabled = true; btn.textContent = "Signing in…"; msg.textContent = "";
      const list = await loadUsers();
      const ok = await verify(list, box.querySelector("#loginUser").value, box.querySelector("#loginPass").value);
      if (!ok) {
        fails++;
        await new Promise(r => setTimeout(r, Math.min(8000, 400 * 2 ** fails)));   // slow down repeated guesses
        msg.textContent = list.length ? "Wrong username or password." : "Sign-in isn't set up yet (no users).";
        btn.disabled = false; btn.textContent = "Sign in"; box.querySelector("#loginPass").select(); return;
      }
      const keep = box.querySelector("#loginKeep").checked;
      const s = { u: ok.u, name: ok.name, at: Date.now(), exp: keep ? Date.now() + 30 * 86400e3 : null };
      try { (keep ? localStorage : sessionStorage).setItem(SESSION, JSON.stringify(s)); } catch {}
      adoptLegacy(ok.u);
      location.reload();
    });
  }

  if (!session) showLogin();
  root.PropAuth = { ...api, user: () => session, signOut };
})(typeof window !== "undefined" ? window : globalThis);
