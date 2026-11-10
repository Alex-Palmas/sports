// Run: node --test
import test from "node:test";
import assert from "node:assert/strict";
import { parseOddsEvent, parseKalshiMarket, toAmerican, kalshiFee, normName } from "../scripts/fetch-data.mjs";

const nba = { markets: { player_points: "pts", player_rebounds: "reb" } };

test("parses The Odds API event odds into per-book quotes", () => {
  // Shape of GET /v4/sports/{sport}/events/{id}/odds?markets=player_points,...
  const ev = {
    id: "abc", sport_key: "basketball_nba", commence_time: "2026-11-11T00:30:00Z", home_team: "New York Knicks", away_team: "Milwaukee Bucks",
    bookmakers: [
      { key: "draftkings", title: "DraftKings", markets: [{ key: "player_points", outcomes: [
        { name: "Over", description: "Jalen Brunson", price: -115, point: 27.5 },
        { name: "Under", description: "Jalen Brunson", price: -105, point: 27.5 },
        { name: "Over", description: "Jalen Brunson", price: 150, point: 30.5 },
        { name: "Under", description: "Jalen Brunson", price: -190, point: 30.5 },
      ] }] },
      { key: "fanduel", title: "FanDuel", markets: [
        { key: "player_points", outcomes: [
          { name: "Over", description: "Jalen Brunson", price: -110, point: 28.5 },
          { name: "Under", description: "Jalen Brunson", price: -110, point: 28.5 },
        ] },
        { key: "player_unknown", outcomes: [{ name: "Over", description: "Jalen Brunson", price: 100, point: 1.5 }] },
      ] },
    ],
  };
  const q = {};
  parseOddsEvent("nba", nba, ev, q);
  const list = q["nba|jalenbrunson|pts"];
  assert.equal(list.length, 3);
  const dk = list.filter(x => x.k === "draftkings");
  assert.deepEqual(dk.find(x => !x.alt), { b: "DraftKings", k: "draftkings", l: 27.5, t: ev.commence_time, o: -115, u: -105 });
  assert.equal(dk.find(x => x.alt).l, 30.5);
  assert.deepEqual(list.find(x => x.k === "fanduel"), { b: "FanDuel", k: "fanduel", l: 28.5, t: ev.commence_time, o: -110, u: -110 });
  assert.equal(Object.keys(q).length, 1); // unknown market ignored
});

test("parses a Kalshi ladder market with fees", () => {
  const q = {};
  parseKalshiMarket("nba", "pts", { title: "Joel Embiid: 20+ points", floor_strike: 19.5, strike_type: "greater", yes_ask_dollars: "0.5200", no_ask_dollars: "0.5200", expected_expiration_time: "2026-11-11T03:00:00Z", volume_fp: "12.5" }, q);
  const [k] = q["nba|joelembiid|pts"];
  assert.equal(k.l, 19.5); assert.equal(k.b, "Kalshi");
  assert.equal(k.o, toAmerican(0.52 + kalshiFee(0.52)));
  assert.ok(k.o < -110 && k.o > -130, `got ${k.o}`);
  // one-sided / junk markets are skipped
  parseKalshiMarket("nba", "pts", { title: "X Y: 50+ points", floor_strike: 49.5, yes_ask_dollars: "0.0100", no_ask_dollars: "1.0000" }, q);
  parseKalshiMarket("nba", "pts", { title: "X Y: 20+ points", floor_strike: 19.5, yes_ask_dollars: "0.0600", no_ask_dollars: "0.9800" }, q);
  assert.equal(Object.keys(q).length, 1);
});

test("odds helpers", () => {
  assert.equal(toAmerican(0.5), -100);
  assert.equal(toAmerican(0.25), 300);
  assert.equal(toAmerican(0.75), -300);
  assert.equal(normName("Jaren Jackson Jr."), normName("Jaren Jackson"));
  assert.equal(normName("Nikola Jokić"), "nikolajokic");
});
