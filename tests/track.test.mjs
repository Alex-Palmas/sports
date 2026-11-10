import test from "node:test";
import assert from "node:assert/strict";
import { applyTrack } from "../scripts/fetch-data.mjs";

const logs = n => Array.from({ length: n }, (_, i) => ({ date: `2026-10-${String(30 - i).padStart(2, "0")}`, home: i % 2 === 0, stats: { pts: 20 + (i % 5) } }));

test("live ledger records before tip-off, grades from the game log, and fits a market weight", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  const p = { espnId: "1", gameDate: "2026-11-01T23:00Z", lines: { pts: 21.5 }, logs: logs(20),
    market: { pts: [{ b: "DK", l: 21.5, o: -110, u: -110 }] } };
  const out = { sports: { nba: { players: [p] } } }, track = {};
  applyTrack(out, track, now);
  const k = "nba|1|pts|2026-11-01";
  assert.ok(track.picks[k]); assert.equal(track.picks[k].y, undefined);
  assert.ok(Math.abs(track.picks[k].market - 0.5) < 1e-9);
  // next day: the game is in his log
  const p2 = { ...p, gameDate: "2026-11-03T23:00Z", logs: [{ date: "2026-11-01", stats: { pts: 25 } }, ...logs(20)] };
  const s = applyTrack({ sports: { nba: { players: [p2] } } }, track, now + 86400e3);
  assert.equal(track.picks[k].y, 1); assert.equal(track.picks[k].actual, 25);
  const bet = track.picks[k].bet; assert.ok(bet && [0, 1].includes(bet.won));
  assert.equal(bet.won, (bet.side === "over" ? 25 > bet.line : 25 < bet.line) ? 1 : 0);
  assert.ok(Array.isArray(track.picks[k].codes) && track.picks[k].grade);
  assert.equal(s.nba.n, 1); assert.ok(s.nba.blend.marketWeight >= 0 && s.nba.blend.marketWeight <= 1);
});
