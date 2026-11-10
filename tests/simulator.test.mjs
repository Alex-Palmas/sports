import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { simulate, fee, at } = createRequire(import.meta.url)("../site/simulator.js");

const rec = {
  started: "2026-11-11T00:00:00Z",
  crossings: [
    // feed showed it at 6s; Kalshi still asked 45¢ until 9s
    { play: "2026-11-11T00:40:00Z", game: "BOS @ PHI", player: "Jalen Brunson", stat: "pts", line: 19.5, feedDelay: 6, book: [[-10, 0.40, 0.45, 50], [9, 0.93, 0.98, 20]] },
    { play: "2026-11-11T00:41:00Z", game: "BOS @ PHI", player: "Joel Embiid", stat: "reb", line: 7.5, feedDelay: 12, book: [[-10, 0.40, 0.45, 50], [9, 0.93, 0.98, 20]] },
    { alreadyPriced: true, play: "x", game: "g" },
  ],
  playerEvents: [
    { play: "2026-11-11T00:42:00Z", game: "BOS @ PHI", player: "Jalen Brunson", stat: "pts", before: 15, after: 17, feedDelay: 5,
      rungs: [{ line: 19.5, book: [[-10, 0.30, 0.33, 100], [8, 0.42, 0.45, 100], [40, 0.50, 0.53, 100]] }] },
  ],
  scoreReactions: [
    { league: "nba", play: "2026-11-11T00:43:00Z", game: "BOS @ PHI", team: "PHI", points: 3, clutch: true, feedDelay: 4, book: [[-10, 0.50, 0.52, 200], [3, 0.55, 0.57, 200], [20, 0.58, 0.60, 200]] },
  ],
};

test("Kalshi fee and book lookup", () => {
  assert.equal(fee(0.5, 10), 0.18);  // 0.07*10*0.25 = 0.175 → 18¢
  assert.equal(fee(0.45, 1), 0.02);
  assert.deepEqual(at([[-10, 1], [5, 2]], 4), [-10, 1]);
});

test("settled props: buys the stale ask when the feed is first, skips when Kalshi already moved", () => {
  const r = simulate([rec], { strategies: ["settled"], orderDelay: 0.5, contracts: 10 });
  assert.equal(r.trades.length, 1);                       // Embiid: entry at 12.5s → ask 98¢ > max price → skipped
  const t = r.trades[0];
  assert.equal(t.entry, 0.45); assert.equal(t.qty, 10);
  assert.equal(t.pnl, +(10 - 4.5 - fee(0.45, 10)).toFixed(2));
  assert.equal(r.skipped.tooExpensive, 1);
});

test("a faster hypothetical feed catches both", () => {
  const r = simulate([rec], { strategies: ["settled"], feedDelay: 2, orderDelay: 0.5 });
  assert.equal(r.trades.length, 2);
});

test("player-event rung and game line: buy at ask, sell at bid after the hold", () => {
  const rung = simulate([rec], { strategies: ["rung"], orderDelay: 0.5, hold: 30, contracts: 10 }).trades[0];
  // enter at 5.5s → ask 33¢; exit at 35.5s → bid 42¢
  assert.equal(rung.entry, 0.33); assert.equal(rung.exit, 0.42);
  assert.equal(rung.pnl, +(10 * (0.42 - 0.33) - fee(0.33, 10) - fee(0.42, 10)).toFixed(2));
  const gl = simulate([rec], { strategies: ["gameline"], orderDelay: 0.5, hold: 30, contracts: 10 });
  assert.equal(gl.trades[0].entry, 0.57); assert.equal(gl.trades[0].exit, 0.58);
  assert.equal(simulate([rec], { strategies: ["gameline"], minPoints: 4 }).trades.length, 0);
});

test("summary adds up", () => {
  const r = simulate([rec], { contracts: 10 });
  assert.equal(r.summary.trades, r.trades.length);
  assert.equal(r.summary.pnl, +r.trades.reduce((a, t) => a + t.pnl, 0).toFixed(2));
  assert.equal(r.trades.at(-1).cum, r.summary.pnl);
});
