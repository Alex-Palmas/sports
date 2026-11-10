import test from "node:test";
import assert from "node:assert/strict";
import { ncdf, probAbove, fairProb, realizedSigma, decide, takerFee, brier, lagSummary } from "../scripts/crypto-bot.mjs";

test("normal CDF", () => {
  assert.ok(Math.abs(ncdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(ncdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(ncdf(-1) - 0.158655) < 1e-5);
});

test("probability above a strike", () => {
  const sig = 0.0001; // per √s ≈ 59% annualised
  assert.ok(Math.abs(probAbove(70000, 70000, sig, 3600) - 0.5) < 0.01);   // at the money ≈ 50%
  assert.ok(probAbove(71000, 70000, sig, 3600) > 0.9);                     // 1.4% above with ~0.6% hourly σ
  assert.ok(probAbove(69000, 70000, sig, 3600) < 0.1);
  assert.equal(probAbove(71000, 70000, sig, 0), 1);                         // expired
  // more time → closer to 50%
  assert.ok(probAbove(70500, 70000, sig, 3600) < probAbove(70500, 70000, sig, 600));
});

test("fair value by Kalshi strike type", () => {
  const S = 73000, sig = 0.0001, tau = 1800;
  const above = fairProb({ strike_type: "greater", floor_strike: 73100 }, S, sig, tau);
  const below = fairProb({ strike_type: "less", cap_strike: 73100 }, S, sig, tau);
  assert.ok(Math.abs(above + below - 1) < 1e-9);
  const range = fairProb({ strike_type: "between", floor_strike: 72900, cap_strike: 73100 }, S, sig, tau);
  assert.ok(range > 0 && range < 1);
  assert.ok(Math.abs(range - (fairProb({ strike_type: "greater", floor_strike: 72900 }, S, sig, tau) - above)) < 1e-9);
  assert.equal(fairProb({ strike_type: "weird" }, S, sig, tau), null);
});

test("realized volatility is robust to a few jumps", () => {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const closes = [100]; for (let i = 1; i < 2000; i++) closes.push(closes[i - 1] * Math.exp(0.001 * gauss() + (i % 400 === 0 ? 0.02 : 0)));
  const s = realizedSigma(closes), truth = 0.001 / Math.sqrt(60);
  assert.ok(Math.abs(s - truth) / truth < 0.08, `got ${s}, want ~${truth}`);
  assert.equal(realizedSigma([1, 2]), null);
});

import { impliedSigma } from "../scripts/crypto-bot.mjs";
test("implied volatility recovers the σ used to price the strikes", () => {
  const S = 73000, tau = 1800, sig = 0.00008;
  const ms = [72800, 72950, 73050, 73200].map(K => { const p = probAbove(S, K, sig, tau); return { strike_type: "greater", floor_strike: K, yes_bid_dollars: String(p - 0.005), yes_ask_dollars: String(p + 0.005) }; });
  const iv = impliedSigma(ms, S, tau);
  assert.ok(Math.abs(iv - sig) / sig < 0.05, `got ${iv}`);
});

test("trade decision: needs edge after fees on the cheaper side", () => {
  assert.equal(decide(0.55, { yes_ask_dollars: "0.53", no_ask_dollars: "0.49" }, 0.04), null);          // 2¢ before fees: no
  const y = decide(0.70, { yes_ask_dollars: "0.60", no_ask_dollars: "0.42", yes_ask_size_fp: "30" }, 0.04);
  assert.equal(y.side, "yes"); assert.equal(y.price, 0.6); assert.equal(y.size, 30);
  assert.ok(Math.abs(y.edge - (0.10 - takerFee(0.6, 1))) < 1e-9);
  const n = decide(0.20, { yes_ask_dollars: "0.33", no_ask_dollars: "0.70" }, 0.04);
  assert.equal(n.side, "no");
});

test("brier and lag summary", () => {
  assert.equal(brier([{ p: 1, y: 1 }, { p: 0, y: 0 }]), 0);
  assert.equal(brier([{ p: 0.5, y: 1 }]), 0.25);
  const s = lagSummary([[0, 0.70, 0.50], [2, 0.70, 0.55], [5, 0.70, 0.61], [9, 0.70, 0.68]]);
  assert.equal(s.gap0, 0.2); assert.equal(s.t50, 5);
});

import { eventKey } from "../scripts/crypto-bot.mjs";
test("event ordering across hours, 15-minute events and month ends", () => {
  assert.ok(eventKey("KXBTCD-26NOV1012") < eventKey("KXBTCD-26NOV1017"));
  assert.ok(eventKey("KXBTC15M-26NOV101130") < eventKey("KXBTC15M-26NOV101145"));
  assert.ok(eventKey("KXBTCD-26NOV3023") < eventKey("KXBTCD-26DEC0100"));
  assert.equal(eventKey("KXBTCD-27"), null);
});
