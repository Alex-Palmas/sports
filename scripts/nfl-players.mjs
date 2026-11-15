#!/usr/bin/env node
/**
 * NFL player game logs for every QB/RB/WR/TE on a roster (ESPN, free), this season and last, with the raw
 * box-score columns kept, for the player-stats test against Kalshi's NFL props (scripts/nfl-props-model.mjs).
 *
 *   node scripts/nfl-players.mjs [--out .cache/nfl-players.json]
 */
import { writeFileSync, readFileSync } from "node:fs";
const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl", WEB = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl";
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : ".cache/nfl-players.json";
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(u) { for (let i = 0; i < 5; i++) { const r = await fetch(u).catch(() => null); if (r?.ok) return r.json(); if (r && r.status === 404) return null; await sleep(800 * 2 ** i); } return null; }
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

async function gameLog(id, season) {
  const g = await get(`${WEB}/athletes/${id}/gamelog${season ? `?season=${season}` : ""}`);
  if (!g?.names) return [];
  const out = [];
  for (const st of g.seasonTypes || []) {
    if (/preseason|pro bowl/i.test(st.displayName)) continue;
    for (const cat of st.categories || []) {
      if (cat.type === "total") continue;
      for (const ev of cat.events || []) {
        const meta = g.events?.[ev.eventId]; if (!meta || !ev.stats) continue;
        const raw = Object.fromEntries(g.names.map((n, i) => [n, ev.stats[i]]));
        out.push({ date: meta.gameDate.slice(0, 10), t: meta.gameDate, opp: meta.opponent?.abbreviation, home: meta.atVs !== "@", season: st.displayName, raw });
      }
    }
  }
  return out;
}

const teams = (await get(`${SITE}/teams`))?.sports?.[0]?.leagues?.[0]?.teams?.map(t => t.team) || [];
const roster = (await pool(teams, 6, async t => {
  const r = await get(`${SITE}/teams/${t.id}/roster`);
  return (r?.athletes || []).flatMap(g => g.items || [g]).filter(a => ["QB", "RB", "WR", "TE", "FB"].includes(a.position?.abbreviation)).map(a => ({ id: a.id, name: a.displayName, pos: a.position.abbreviation, team: t.abbreviation }));
})).flat();
console.log(`${teams.length} teams, ${roster.length} skill players`);
let done = 0;
const players = await pool(roster, 8, async a => {
  const logs = [...await gameLog(a.id, 2026), ...await gameLog(a.id, 2025)];
  const seen = new Set(), uniq = logs.filter(l => !seen.has(l.t) && seen.add(l.t)).sort((x, y) => y.t.localeCompare(x.t));
  if (++done % 100 === 0) console.log(done, "players");
  return { ...a, logs: uniq };
});
writeFileSync(OUT, JSON.stringify({ fetched: new Date().toISOString(), players }));
console.log(`wrote ${OUT}: ${players.length} players, ${players.reduce((s, p) => s + p.logs.length, 0)} games; columns: ${Object.keys(players.find(p => p.logs.length)?.logs[0].raw || {}).join(", ")}`);
