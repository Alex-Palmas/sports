/* Password gate for PropLab.
 *
 * The site is static (GitHub Pages), so this is a gate in the browser, not server security: it checks the
 * entered password against a salted PBKDF2 hash in access.json (the password itself is never stored) and
 * remembers this device once unlocked. Anyone determined can still read the public data files directly.
 *
 * Change the password with `node scripts/set-password.mjs [new password]`.
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
  /** True when the password matches the stored hash ({ salt, iter, hash }). */
  async function verify(access, password) {
    if (!access?.hash || !access?.salt) return false;
    return same(await hashPassword(String(password || ""), access.salt, access.iter || ITER), access.hash);
  }

  const api = { hashPassword, verify, ITER };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }

  // ---------------------------------------------------------------- browser
  // An unlock lasts only for this browser session (tab), and is re-checked against a fresh access.json on
  // every page load: changing the password, or bumping "epoch" (set-password.mjs --lock-all), locks every
  // device on its next load. Until the check passes the app stays hidden.
  const SESSION = "proplab:unlocked";
  root.PROPLAB_NS = "proplab:";
  document.documentElement.classList.add("auth-locked");
  try { localStorage.removeItem(SESSION); } catch {}   // older builds could remember a device for 30 days
  // data saved under the short-lived per-account sign-in moves back to this device's storage
  try {
    const old = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^proplab:u:[^:]+:/.test(k)) old.push(k); }
    for (const k of old) { const base = "proplab:" + k.replace(/^proplab:u:[^:]+:/, ""); if (localStorage.getItem(base) == null) localStorage.setItem(base, localStorage.getItem(k)); localStorage.removeItem(k); }
    if (old.length) { localStorage.removeItem("proplab:session"); localStorage.removeItem("proplab:legacyClaimed"); }
  } catch {}

  const fetchAccess = () => fetch(`access.json?t=${Date.now()}`, { cache: "no-store" }).then(r => r.ok ? r.json() : null);
  const stamp = a => `${a.hash}|${a.epoch || 0}`;
  const saved = () => { try { return JSON.parse(sessionStorage.getItem(SESSION) || "null"); } catch { return null; } };
  let unlocked = false;

  function lock() {
    try { sessionStorage.removeItem(SESSION); localStorage.removeItem(SESSION); } catch {}
    location.reload();
  }
  const reveal = () => { unlocked = true; document.documentElement.classList.remove("auth-locked"); document.getElementById("loginScreen")?.remove(); };

  function showGate(access, note) {
    const box = document.createElement("div");
    box.className = "login-screen"; box.id = "loginScreen";
    box.innerHTML = `<form class="login-card" id="loginForm">
      <div class="login-brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 17l6-6 4 4 8-8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span>Prop<b>Lab</b></span></div>
      <h1>Enter password</h1>
      <p class="pl-sub">Player props, edges and game lines.</p>
      <label>Password <input id="loginPass" name="password" type="password" autocomplete="current-password" required/></label>
      <div class="login-msg" id="loginMsg" role="alert">${note || ""}</div>
      <button class="login-btn" id="loginBtn" type="submit">Enter</button>
    </form>`;
    const mount = () => { document.getElementById("loginScreen")?.remove(); document.body.prepend(box); setTimeout(() => box.querySelector("#loginPass").focus(), 50); };
    document.body ? mount() : document.addEventListener("DOMContentLoaded", mount);
    let fails = 0;
    box.addEventListener("submit", async e => {
      e.preventDefault();
      const msg = box.querySelector("#loginMsg"), btn = box.querySelector("#loginBtn");
      btn.disabled = true; btn.textContent = "Checking…"; msg.textContent = "";
      const a = access || (access = await fetchAccess().catch(() => null));
      if (!(await verify(a, box.querySelector("#loginPass").value))) {
        fails++;
        await new Promise(r => setTimeout(r, Math.min(8000, 400 * 2 ** fails)));   // slow down repeated guesses
        msg.textContent = a ? "Wrong password." : "Couldn't check the password. Check your connection and try again.";
        btn.disabled = false; btn.textContent = "Enter"; box.querySelector("#loginPass").select(); return;
      }
      try { sessionStorage.setItem(SESSION, JSON.stringify({ at: Date.now(), stamp: stamp(a) })); } catch {}
      reveal();
    });
  }

  // every load: check the session against the current password file before showing anything
  fetchAccess().then(a => {
    const s = saved();
    if (a && s && s.stamp === stamp(a)) reveal();
    else { if (s) try { sessionStorage.removeItem(SESSION); } catch {} showGate(a, s && a ? "The site was locked. Enter the password again." : ""); }
  }).catch(() => showGate(null, ""));

  root.PropAuth = { ...api, unlocked: () => unlocked, lock };
})(typeof window !== "undefined" ? window : globalThis);
