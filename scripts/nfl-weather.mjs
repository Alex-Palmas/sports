#!/usr/bin/env node
/**
 * Kickoff weather for every NFL game in .cache/nfl-dk.json: stadium from ESPN, hourly wind / gusts / temperature /
 * precipitation from Open-Meteo's archive (free, no key). Domes and closed roofs are marked indoor.
 *   node scripts/nfl-weather.mjs   → .cache/nfl-weather.json
 */
import { readFileSync, writeFileSync } from "node:fs";
const B = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
// stadium coordinates by city (approximate is fine for weather); roof: indoor = dome or usually-closed roof
const CITY = { "Arlington": [32.75, -97.09, 1], "New Orleans": [29.95, -90.08, 1], "Detroit": [42.34, -83.05, 1], "Indianapolis": [39.76, -86.16, 1], "Atlanta": [33.76, -84.4, 1],
  "Houston": [29.68, -95.41, 1], "Glendale": [33.53, -112.26, 1], "Inglewood": [33.95, -118.34, 1], "Minneapolis": [44.97, -93.26, 1], "Las Vegas": [36.09, -115.18, 1], "Paradise": [36.09, -115.18, 1],
  "Green Bay": [44.5, -88.06, 0], "Chicago": [41.86, -87.62, 0], "Orchard Park": [42.77, -78.79, 0], "Foxborough": [42.09, -71.26, 0], "East Rutherford": [40.81, -74.07, 0],
  "Philadelphia": [39.9, -75.17, 0], "Landover": [38.91, -76.86, 0], "Baltimore": [39.28, -76.62, 0], "Pittsburgh": [40.45, -80.02, 0], "Cleveland": [41.51, -81.7, 0],
  "Cincinnati": [39.1, -84.52, 0], "Nashville": [36.17, -86.77, 0], "Jacksonville": [30.32, -81.64, 0], "Miami Gardens": [25.96, -80.24, 0], "Tampa": [27.98, -82.5, 0],
  "Charlotte": [35.23, -80.85, 0], "Kansas City": [39.05, -94.48, 0], "Denver": [39.74, -105.02, 0], "Santa Clara": [37.4, -121.97, 0], "Seattle": [47.6, -122.33, 0] };
const get = async u => { for (let i = 0; i < 5; i++) { const r = await fetch(u).catch(() => null); if (r?.ok) return r.json(); await new Promise(s => setTimeout(s, 1000 * 2 ** i)); } return null; };
const dk = JSON.parse(readFileSync(".cache/nfl-dk.json", "utf8")); let db = {}; try { db = JSON.parse(readFileSync(".cache/nfl-weather.json", "utf8")); } catch {}
let miss = 0;
for (const [id, g] of Object.entries(dk)) {
  if (db[id]) continue;
  const s = await get(`${B}/summary?event=${id}`), v = s?.gameInfo?.venue, city = v?.address?.city, c = CITY[city];
  if (!c) { miss++; db[id] = { venue: v?.fullName, city, unknown: true }; continue; }
  const day = g.date.slice(0, 10), next = new Date(Date.parse(day) + 86400e3).toISOString().slice(0, 10);
  const w = await get(`https://archive-api.open-meteo.com/v1/archive?latitude=${c[0]}&longitude=${c[1]}&start_date=${day}&end_date=${next}&hourly=wind_speed_10m,wind_gusts_10m,temperature_2m,precipitation&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC`);
  const t = w?.hourly?.time?.findIndex(x => Date.parse(x + "Z") >= Date.parse(g.date) - 1800e3);
  const at = k => t >= 0 ? [0, 1, 2, 3].map(j => w.hourly[k][t + j]).filter(x => x != null) : [];
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  db[id] = { venue: v.fullName, city, indoor: !!c[2], wind: avg(at("wind_speed_10m")), gust: Math.max(...at("wind_gusts_10m"), 0), temp: avg(at("temperature_2m")), rain: at("precipitation").reduce((x, y) => x + y, 0) };
}
writeFileSync(".cache/nfl-weather.json", JSON.stringify(db, null, 0));
const g = Object.values(db), out = g.filter(x => !x.indoor && !x.unknown);
console.log(`${g.length} games; ${g.filter(x => x.indoor).length} indoor; ${out.length} outdoor with weather; unknown city ${miss}: ${[...new Set(g.filter(x => x.unknown).map(x => x.city))].join(", ")}; outdoor wind ≥ 15 mph: ${out.filter(x => x.wind >= 15).length}, temp ≤ 35°F: ${out.filter(x => x.temp <= 35).length}`);
