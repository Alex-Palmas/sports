#!/usr/bin/env node
/**
 * Kalshi crypto bot simulation (paper trading only; it never places orders).
 *
 * Kalshi lists BTC and ETH markets that settle on the CF Benchmarks Real-Time Index:
 *   KXBTCD / KXETHD     hourly "price above $X at the top of the hour"
 *   KXBTC  / KXETH      hourly price ranges ("$73,000 to 73,249.99")
 *   KXBTC15M / KXETH15M "price up in the next 15 minutes?"
 * The index is built from major exchanges, so the bot tracks the median of Coinbase, Kraken
 * and Bitstamp as a stand-in, estimates volatility from the last two hours of 1-minute
 * Coinbase candles, and prices every market with a lognormal model:
 *   P(S_T > K) = N( (ln(S/K) − σ²τ/2) / (σ√τ) )
 * (settlement averages the index over the final 60 seconds, which shrinks the variance a little).
 *
 * Two paper strategies, tracked separately:
 *   latency – prices every market with the volatility Kalshi's own prices imply (measured while
 *             the spot price is calm) and the live spot price, so it only finds an edge when the
 *             spot has just moved and Kalshi hasn't caught up: "react before Kalshi adjusts".
 *   model   – uses our own realized-volatility estimate instead: "is Kalshi mispricing volatility?"
 * Each: buy YES when probability − ask − fee ≥ EDGE, or NO when (1 − model) − NO ask − fee ≥ EDGE,
 * QTY contracts capped by the size offered, one entry per market, at most MAX_PER_EVENT per
 * event, no new entries in the final 2 minutes. Positions are held to Kalshi's actual result.
 *
 * Also measured:
 *   lag          – after a sharp move in the spot price (≥ JUMP_BPS within 10s), how fast the
 *                  Kalshi price of the at-the-money market catches up with the model
 *   calibration  – for settled markets, the model's and Kalshi's probability 5 minutes before
 *                  the close against the result (Brier score: lower is better)
 *
 * Output: site/crypto/live.json every LIVE_EVERY seconds while running (the workflow publishes
 * it to the live-crypto branch) and site/crypto/<date>-<HHMM>.json + index.json at the end.
 * Env: ASSETS (BTC,ETH), EDGE (0.04), QTY (10), MAX_PER_EVENT (5), JUMP_BPS (15),
 *      REQS_PER_SEC (4), MAX_MINUTES (345), LIVE_EVERY (60), OUT_DIR (site/crypto).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";

const ASSETS = (process.env.ASSETS || "BTC,ETH").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
const EDGE = +(process.env.EDGE || 0.04);
const QTY = +(process.env.QTY || 10);
const MAX_PER_EVENT = +(process.env.MAX_PER_EVENT || 5);
const JUMP_BPS = +(process.env.JUMP_BPS || 15);
const REQS_PER_SEC = +(process.env.REQS_PER_SEC || 4);
const MAX_MINUTES = +(process.env.MAX_MINUTES || 345);
const LIVE_EVERY = +(process.env.LIVE_EVERY || 60);
const OUT_DIR = process.env.OUT_DIR || "site/crypto";
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const NO_ENTRY_SECS = 120;

export const SERIES = {
  BTC: [{ s: "KXBTCD", kind: "above", label: "Hourly above/below" }, { s: "KXBTC", kind: "range", label: "Hourly range" }, { s: "KXBTC15M", kind: "15m", label: "15-minute up/down" }],
  ETH: [{ s: "KXETHD", kind: "above", label: "Hourly above/below" }, { s: "KXETH", kind: "range", label: "Hourly range" }, { s: "KXETH15M", kind: "15m", label: "15-minute up/down" }],
};
const PAIRS = { BTC: { cb: "BTC-USD", kr: "XBTUSD", bs: "btcusd" }, ETH: { cb: "ETH-USD", kr: "ETHUSD", bs: "ethusd" } };

// ---------------------------------------------------------------- math (pure; tested)
/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function ncdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
/**
 * P(settlement price > K). sigma is volatility per √second; tau in seconds.
 * Settlement is the average of the last 60s, whose variance is ~1/3 of a 60s terminal move.
 */
export function probAbove(S, K, sigma, tau) {
  if (!(S > 0 && K > 0)) return null;
  const effTau = tau > 60 ? tau - 60 + 20 : Math.max(tau, 0) / 3;
  if (effTau <= 0 || sigma <= 0) return S > K ? 1 : 0;
  const v = sigma * Math.sqrt(effTau);
  return ncdf((Math.log(S / K) - v * v / 2) / v);
}
/** Model probability for a Kalshi crypto market. */
export function fairProb(m, S, sigma, tau) {
  const lo = m.floor_strike != null ? +m.floor_strike : null, hi = m.cap_strike != null ? +m.cap_strike : null;
  switch (m.strike_type) {
    case "greater": case "greater_or_equal": return probAbove(S, lo, sigma, tau);
    case "less": case "less_or_equal": return 1 - probAbove(S, hi, sigma, tau);
    case "between": { const a = probAbove(S, lo, sigma, tau), b = probAbove(S, hi, sigma, tau); return a == null || b == null ? null : Math.max(0, a - b); }
    default: return null;
  }
}
/**
 * Volatility per √second from candle closes (oldest first). Robust: median absolute deviation
 * of 1-minute log returns × 1.4826, so a few jumpy candles don't blow up the estimate.
 */
export function realizedSigma(closes, secondsPerBar = 60) {
  const r = []; for (let i = 1; i < closes.length; i++) if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  if (r.length < 10) return null;
  const med = median(r), mad = median(r.map(x => Math.abs(x - med)));
  return mad * 1.4826 / Math.sqrt(secondsPerBar);
}
/** Volatility the Kalshi prices imply: solve P(above K) = mid for σ on near-the-money strikes, take the median. */
export function impliedSigma(markets, S, tau) {
  const out = [];
  for (const m of markets) {
    if (!/greater/.test(m.strike_type || "")) continue;
    const mid = m.yes_bid_dollars != null && m.yes_ask_dollars != null ? (+m.yes_bid_dollars + +m.yes_ask_dollars) / 2 : null;
    if (mid == null || mid < 0.25 || mid > 0.75) continue;
    let lo = 1e-6, hi = 0.01, K = +m.floor_strike;
    // P(above) moves toward 0.5 as σ grows: bisect on the side of the strike
    const f = sg => probAbove(S, K, sg, tau) - mid, above = S > K;
    if (Math.sign(f(lo)) === Math.sign(f(hi))) continue;
    for (let i = 0; i < 60; i++) { const md = (lo + hi) / 2; (f(md) > 0) === above ? (lo = md) : (hi = md); }
    out.push((lo + hi) / 2);
  }
  return median(out);
}
export const takerFee = (p, qty) => Math.ceil(0.07 * qty * p * (1 - p) * 100 - 1e-9) / 100;
/** Trade decision for one market given model probability and the book. */
export function decide(fair, m, edge = EDGE) {
  const ya = m.yes_ask_dollars != null ? +m.yes_ask_dollars : null, na = m.no_ask_dollars != null ? +m.no_ask_dollars : null;
  if (fair == null) return null;
  const yesEdge = ya > 0 && ya < 1 ? fair - ya - takerFee(ya, 1) : -1;
  const noEdge = na > 0 && na < 1 ? (1 - fair) - na - takerFee(na, 1) : -1;
  if (yesEdge >= edge && yesEdge >= noEdge) return { side: "yes", price: ya, size: m.yes_ask_size_fp != null ? +m.yes_ask_size_fp : null, edge: yesEdge };
  if (noEdge >= edge) return { side: "no", price: na, size: m.no_ask_size_fp != null ? +m.no_ask_size_fp : null, edge: noEdge };
  return null;
}
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
/** Sortable time key from an event ticker suffix: 26NOV1012 (yyMONddHH) or 26NOV101130 (yyMONddHHMM). */
export function eventKey(ticker) {
  const m = /-(\d\d)([A-Z]{3})(\d\d)(\d\d)(\d\d)?$/.exec(ticker); if (!m || MON[m[2]] == null) return null;
  return ((((+m[1] * 12 + MON[m[2]]) * 31 + +m[3]) * 24 + +m[4]) * 60) + (m[5] ? +m[5] : 0);
}
export const brier = rows => rows.length ? rows.reduce((a, r) => a + (r.p - r.y) ** 2, 0) / rows.length : null;
const median = a => { const s = a.filter(x => x != null && Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const midOf = m => { const b = m.yes_bid_dollars != null ? +m.yes_bid_dollars : null, a = m.yes_ask_dollars != null ? +m.yes_ask_dollars : null; return b != null && a != null && a > 0 ? (b + a) / 2 : null; };

// ---------------------------------------------------------------- http
const sleep = ms => new Promise(r => setTimeout(r, ms));
let kalshiNext = 0, backoffUntil = 0;
async function getJSON(url) {
  const kalshi = url.startsWith(KALSHI);
  if (kalshi) { const now = Date.now(), at = Math.max(now, kalshiNext, backoffUntil); kalshiNext = at + 1000 / REQS_PER_SEC; if (at > now) await sleep(at - now); }
  try {
    const r = await fetch(url, { headers: { "User-Agent": "proplab-crypto-sim/1.0" } });
    if (r.status === 429 && kalshi) { backoffUntil = Date.now() + 2000; return null; }
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- bot
export class CryptoBot {
  constructor() {
    this.started = Date.now();
    this.spot = {};        // asset → { price, sources, t }
    this.hist = {};        // asset → [[t, price]] (last 15 min)
    this.sigma = {};       // asset → per √s
    this.events = {};      // series → { event, close, markets: Map }
    this.positions = [];   // paper trades
    this.entered = new Set();
    this.lags = [];        // spot jumps and Kalshi catch-up
    this.calib = [];       // { p model, k kalshi, y result }
    this.snapAt5 = new Map(); // ticker → { p, k }
    this.ptr = 0;
    this.closedEvents = new Set();
  }

  async pollSpot(asset) {
    const p = PAIRS[asset];
    const [cb, kr, bs] = await Promise.all([
      getJSON(`https://api.exchange.coinbase.com/products/${p.cb}/ticker`),
      getJSON(`https://api.kraken.com/0/public/Ticker?pair=${p.kr}`),
      getJSON(`https://www.bitstamp.net/api/v2/ticker/${p.bs}/`),
    ]);
    const krRes = kr?.result ? Object.values(kr.result)[0] : null;
    const px = { coinbase: cb?.price ? +cb.price : null, kraken: krRes?.c?.[0] ? +krRes.c[0] : null, bitstamp: bs?.last ? +bs.last : null };
    const vals = Object.values(px).filter(v => v > 0);
    if (!vals.length) return;
    const price = median(vals), t = Date.now();
    this.spot[asset] = { price, sources: px, t };
    const h = (this.hist[asset] ||= []); h.push([t, price]); while (h.length && h[0][0] < t - 15 * 60e3) h.shift();
    this.detectJump(asset, t, price);
  }

  async refreshVol(asset) {
    const c = await getJSON(`https://api.exchange.coinbase.com/products/${PAIRS[asset].cb}/candles?granularity=60`);
    if (!Array.isArray(c)) return;
    const closes = c.slice(0, 120).reverse().map(x => x[4]);
    const s = realizedSigma(closes);
    if (s) this.sigma[asset] = Math.max(s, 0.00002); // floor: markets are rarely calmer than this
  }

  /** Find the nearest still-open event for each series (one listing request per series). */
  async refreshEvents() {
    for (const asset of ASSETS) for (const { s, kind, label } of SERIES[asset]) {
      const r = await getJSON(`${KALSHI}/events?series_ticker=${s}&status=open&limit=50`);
      const evs = (r?.events || []).map(e => e.event_ticker).filter(t => !this.closedEvents.has(t) && eventKey(t) != null);
      if (!evs.length) continue;
      const cur = this.events[s];
      this.implied ||= {};
      const pick = evs.sort((a, b) => eventKey(a) - eventKey(b))[0];   // nearest close
      if (!cur || cur.event !== pick) this.events[s] = { series: s, asset, kind, label, event: pick, close: null, markets: new Map() };
    }
  }

  async pollEvent(e) {
    const r = await getJSON(`${KALSHI}/markets?event_ticker=${e.event}&limit=200`);
    const ms = r?.markets || []; if (!ms.length) return;
    const now = Date.now();
    e.close = Date.parse(ms[0].close_time);
    const S = this.spot[e.asset]?.price, sig = this.sigma[e.asset];
    const tau = (e.close - now) / 1000;
    // Close to the top of the hour, small differences between our exchange median and the
    // settlement index swing the implied volatility wildly: only learn it with 15+ minutes left
    // and within a sane band around realized volatility.
    if (e.kind === "above" && S && tau > 900) {
      let iv = impliedSigma(ms, S, tau);
      if (iv && sig && (iv > 3 * sig || iv < sig / 3)) iv = null;
      if (iv) {
        (this.implied ||= {})[e.asset] = iv;
        // learn Kalshi's volatility only while the spot is calm, so a fresh move isn't absorbed into it
        const lastJump = this.lags.filter(l => l.asset === e.asset).at(-1);
        const calm = !lastJump || now - Date.parse(lastJump.at) > 60e3;
        this.ivSmooth ||= {};
        if (calm) this.ivSmooth[e.asset] = this.ivSmooth[e.asset] ? 0.8 * this.ivSmooth[e.asset] + 0.2 * iv : iv;
      }
    }
    for (const m of ms) {
      const fair = S && sig ? fairProb(m, S, sig, tau) : null;
      const ivs = this.ivSmooth?.[e.asset];
      const fairL = S && ivs ? fairProb(m, S, ivs, tau) : null;
      e.markets.set(m.ticker, { m, fair, fairL, t: now });
      // calibration snapshot ~5 minutes before close
      if (tau <= 300 && tau > 240 && !this.snapAt5.has(m.ticker) && fair != null) {
        const k = midOf(m); if (k != null) this.snapAt5.set(m.ticker, { p: fair, k, asset: e.asset, kind: e.kind, close: e.close });
      }
      if (m.status && !/active|open/i.test(m.status)) continue;
      if (tau < NO_ENTRY_SECS) continue;
      for (const [strategy, p] of [["latency", fairL], ["model", fair]]) {
        if (p == null || this.entered.has(strategy + "|" + m.ticker)) continue;
        if (this.positions.filter(x => x.event === e.event && x.strategy === strategy).length >= MAX_PER_EVENT) continue;
        const d = decide(p, m);
        if (!d) continue;
        const qty = Math.max(1, Math.min(QTY, d.size || QTY));
        this.entered.add(strategy + "|" + m.ticker);
        const lastJump = this.lags.filter(l => l.asset === e.asset).at(-1);
        this.positions.push({ strategy, ticker: m.ticker, event: e.event, asset: e.asset, kind: e.kind, label: `${e.asset} ${m.yes_sub_title || m.subtitle || m.ticker}`, side: d.side,
          entry: d.price, qty, fee: takerFee(d.price, qty), fair: +p.toFixed(4), edge: +d.edge.toFixed(4), spot: S, secsToClose: Math.round(tau),
          secsSinceJump: lastJump ? Math.round((now - Date.parse(lastJump.at)) / 1000) : null,
          at: new Date(now).toISOString(), close: new Date(e.close).toISOString(), status: "open" });
      }
    }
    if (tau < -5) { this.closedEvents.add(e.event); this.events[e.series] = null; } // closed: look for the next one
  }

  /** Settle open positions on Kalshi's actual result. */
  async settle() {
    const due = this.positions.filter(p => p.status === "open" && Date.parse(p.close) < Date.now() - 30e3);
    for (const p of due.slice(0, 3)) {
      const r = await getJSON(`${KALSHI}/markets/${p.ticker}`); const m = r?.market; if (!m) continue;
      if (m.result === "yes" || m.result === "no") {
        const won = m.result === p.side;
        p.result = m.result; p.status = won ? "won" : "lost";
        p.pnl = +((won ? 1 - p.entry : -p.entry) * p.qty - p.fee).toFixed(2);
      } else if (Date.now() - Date.parse(p.close) > 30 * 60e3) p.status = "unsettled";
    }
    // calibration rows for markets whose results are now known
    for (const [ticker, s] of this.snapAt5) {
      if (s.done || s.close > Date.now() - 60e3 || s.tries > 3) continue;
      s.tries = (s.tries || 0) + 1;
      const r = await getJSON(`${KALSHI}/markets/${ticker}`); const res = r?.market?.result;
      if (res === "yes" || res === "no") { this.calib.push({ asset: s.asset, kind: s.kind, p: s.p, k: s.k, y: res === "yes" ? 1 : 0 }); s.done = true; }
      break; // one lookup per pass
    }
  }

  /** A sharp spot move: record model vs Kalshi for the at-the-money above/below market as it catches up. */
  detectJump(asset, t, price) {
    const h = this.hist[asset]; const ref = h.find(([tt]) => tt >= t - 10e3);
    if (!ref) return;
    const bps = (price / ref[1] - 1) * 1e4;
    const last = this.lags.filter(l => l.asset === asset).at(-1);
    if (Math.abs(bps) < JUMP_BPS || (last && t - Date.parse(last.at) < 60e3)) return;
    const e = Object.values(this.events).find(x => x && x.asset === asset && x.kind === "above");
    if (!e) return;
    // market whose probability is closest to 50%: where a move matters most
    const atm = [...e.markets.values()].filter(x => x.fair != null).sort((a, b) => Math.abs(a.fair - 0.5) - Math.abs(b.fair - 0.5))[0];
    if (!atm) return;
    this.lags.push({ asset, at: new Date(t).toISOString(), bps: +bps.toFixed(1), ticker: atm.m.ticker, path: [], start: t });
  }
  trackLags() {
    const now = Date.now();
    for (const l of this.lags) {
      if (l.done) continue;
      const e = Object.values(this.events).find(x => x && x.markets.has(l.ticker)); const x = e?.markets.get(l.ticker);
      if (!x) { l.done = true; continue; }
      const dt = (now - l.start) / 1000;
      const k = midOf(x.m);
      l.path.push([+dt.toFixed(1), x.fair != null ? +x.fair.toFixed(4) : null, k != null ? +k.toFixed(4) : null]);
      if (dt > 60) { l.done = true; l.summary = lagSummary(l.path); }
    }
  }

  report() {
    const closed = this.positions.filter(p => p.pnl != null);
    const pnl = closed.reduce((a, p) => a + p.pnl, 0), staked = closed.reduce((a, p) => a + p.entry * p.qty, 0);
    const by = {}; for (const p of closed) { const k = `${p.strategy}|${p.kind}`; const x = (by[k] ||= { strategy: p.strategy, kind: p.kind, trades: 0, wins: 0, pnl: 0, staked: 0 }); x.trades++; x.wins += p.pnl > 0; x.pnl += p.pnl; x.staked += p.entry * p.qty; }
    const strat = s => { const c = closed.filter(p => p.strategy === s); const pl = c.reduce((a, p) => a + p.pnl, 0), st = c.reduce((a, p) => a + p.entry * p.qty, 0);
      return { trades: c.length, open: this.positions.filter(p => p.strategy === s && p.status === "open").length, wins: c.filter(p => p.pnl > 0).length, pnl: +pl.toFixed(2), staked: +st.toFixed(2), roi: st ? pl / st : null }; };
    const lagsDone = this.lags.filter(l => l.summary);
    const markets = Object.values(this.events).filter(Boolean).map(e => ({
      series: e.series, asset: e.asset, kind: e.kind, label: e.label, event: e.event, close: e.close ? new Date(e.close).toISOString() : null,
      markets: [...e.markets.values()].map(({ m, fair, fairL }) => ({ fairL: fairL != null ? +fairL.toFixed(3) : null, ticker: m.ticker, label: m.yes_sub_title || m.subtitle, strike: m.floor_strike ?? m.cap_strike, type: m.strike_type,
        bid: m.yes_bid_dollars != null ? +m.yes_bid_dollars : null, ask: m.yes_ask_dollars != null ? +m.yes_ask_dollars : null, fair: fair != null ? +fair.toFixed(3) : null,
        volume: m.volume_fp != null ? Math.round(+m.volume_fp) : null }))
        .filter(x => x.fair != null && (x.fair > 0.01 && x.fair < 0.99 || (x.ask ?? 1) < 0.99 && (x.bid ?? 0) > 0.01)).sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0)).slice(0, 40),
    }));
    return {
      updated: new Date().toISOString(), started: new Date(this.started).toISOString(),
      rules: { edge: EDGE, qty: QTY, maxPerEvent: MAX_PER_EVENT, noEntrySecs: NO_ENTRY_SECS, jumpBps: JUMP_BPS },
      spot: this.spot, sigma: Object.fromEntries(Object.entries(this.sigma).map(([a, s]) => [a, { perSqrtSec: s, annualized: s * Math.sqrt(365 * 86400),
        kalshiImplied: this.implied?.[a] ? this.implied[a] * Math.sqrt(365 * 86400) : null,
        kalshiCalm: this.ivSmooth?.[a] ? this.ivSmooth[a] * Math.sqrt(365 * 86400) : null }])),
      summary: { trades: closed.length, open: this.positions.filter(p => p.status === "open").length, wins: closed.filter(p => p.pnl > 0).length,
        pnl: +pnl.toFixed(2), staked: +staked.toFixed(2), roi: staked ? pnl / staked : null, medianEdge: median(this.positions.map(p => p.edge)) },
      byStrategy: { latency: strat("latency"), model: strat("model") },
      byKind: Object.values(by).map(x => ({ ...x, pnl: +x.pnl.toFixed(2), staked: +x.staked.toFixed(2) })),
      calibration: { n: this.calib.length, model: brier(this.calib.map(c => ({ p: c.p, y: c.y }))), kalshi: brier(this.calib.map(c => ({ p: c.k, y: c.y }))) },
      lag: { jumps: lagsDone.length, medianT50: median(lagsDone.map(l => l.summary.t50)), medianGapAt0: median(lagsDone.map(l => l.summary.gap0)), recent: lagsDone.slice(-20) },
      markets, positions: this.positions.slice(-300),
    };
  }
}
/** From a lag path [[dt, model, kalshi]]: initial gap and when Kalshi had closed half of it. */
export function lagSummary(path) {
  const first = path.find(p => p[1] != null && p[2] != null); if (!first) return { gap0: null, t50: null };
  const gap0 = first[1] - first[2]; if (Math.abs(gap0) < 0.02) return { gap0: +gap0.toFixed(3), t50: 0 };
  const hit = path.find(p => p[1] != null && p[2] != null && Math.abs(p[1] - p[2]) <= Math.abs(gap0) / 2);
  return { gap0: +gap0.toFixed(3), t50: hit ? hit[0] : null };
}

async function writeLive(bot) { await mkdir(OUT_DIR, { recursive: true }); await writeFile(`${OUT_DIR}/live.json`, JSON.stringify(bot.report())); }
async function saveFinal(bot) {
  const rep = bot.report(); const date = rep.started.slice(0, 10), hhmm = rep.started.slice(11, 16).replace(":", "");
  const file = `${date}-${hhmm}.json`;
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(`${OUT_DIR}/${file}`, JSON.stringify(rep));
  let index = []; try { index = JSON.parse(await readFile(`${OUT_DIR}/index.json`, "utf8")); } catch {}
  index = index.filter(x => x.file !== file).concat({ file, started: rep.started, ended: rep.updated, ...rep.summary, calibration: rep.calibration, lagJumps: rep.lag.jumps })
    .sort((a, b) => b.started.localeCompare(a.started));
  await writeFile(`${OUT_DIR}/index.json`, JSON.stringify(index, null, 1));
  return rep;
}

async function main() {
  const bot = new CryptoBot(); const deadline = Date.now() + MAX_MINUTES * 60e3;
  let running = true, lastVol = 0, lastEvents = 0, lastLive = 0, lastLog = 0;
  const stop = async () => { running = false; const r = await saveFinal(bot); console.log("saved", JSON.stringify(r.summary), JSON.stringify(r.calibration)); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  console.log(`Kalshi crypto bot (paper): ${ASSETS.join(",")} · edge ≥ ${EDGE * 100}¢ · ${QTY} contracts · ${MAX_MINUTES} min`);
  // Kalshi loop: cycle through the nearest event of each series
  (async () => {
    while (running) {
      const evs = Object.values(bot.events).filter(Boolean);
      if (!evs.length) { await sleep(1000); continue; }
      await bot.pollEvent(evs[(bot.ptr++) % evs.length]);
    }
  })();
  while (Date.now() < deadline) {
    const t0 = Date.now();
    if (t0 - lastVol > 5 * 60e3) { await Promise.all(ASSETS.map(a => bot.refreshVol(a))); lastVol = t0; }
    if (t0 - lastEvents > 60e3 || Object.values(bot.events).some(e => e === null)) { await bot.refreshEvents(); lastEvents = t0; }
    await Promise.all(ASSETS.map(a => bot.pollSpot(a)));
    bot.trackLags();
    await bot.settle();
    if (t0 - lastLive > LIVE_EVERY * 1e3) { await writeLive(bot); lastLive = t0; }
    if (t0 - lastLog > 5 * 60e3) { lastLog = t0; const r = bot.report(); console.log(new Date().toISOString(), Object.entries(bot.spot).map(([a, s]) => `${a} ${s.price}`).join(" "), "| trades", r.summary.trades, "open", r.summary.open, "pnl", r.summary.pnl, "| jumps", r.lag.jumps, "| calib n", r.calibration.n); }
    await sleep(Math.max(0, 1500 - (Date.now() - t0)));
  }
  await stop();
}

if (import.meta.url === `file://${process.argv[1]}`) main();
