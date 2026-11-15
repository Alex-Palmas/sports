// NFL weather vs Kalshi props and totals (needs .cache/nfl-deep*.json, kalshi-history-nfl.json, nfl-dk.json, nfl-weather.json). Run: node scripts/nfl-weather-study.cjs
const fs=require("fs");const ev={};for(const f of fs.readdirSync(".cache").filter(f=>/^nfl-deep(-\d)?\.json$/.test(f)))Object.assign(ev,JSON.parse(fs.readFileSync(".cache/"+f)).events);
for(const [k,e] of Object.entries(JSON.parse(fs.readFileSync(".cache/kalshi-history-nfl.json")).events)) ev[k]={series:e.series,date:e.date,markets:e.markets};
const dk=JSON.parse(fs.readFileSync(".cache/nfl-dk.json")), wx=JSON.parse(fs.readFileSync(".cache/nfl-weather.json"));
const fee=p=>Math.ceil(0.07*p*(1-p)*100-1e-9)/100, etDate=d=>new Date(Date.parse(d)-5*3600e3).toISOString().slice(0,10);
const ALIAS={WSH:["WAS","WSH"],LAR:["LA","LAR"],JAX:["JAC","JAX"]};const codes=a=>ALIAS[a]||[a];
const W=k=>{const suf=k.split("-")[1].slice(7);const id=Object.keys(dk).find(i=>{const g=dk[i];return etDate(g.date)===k.split("-")[1].slice(0,0)+0||false});return null};
const gameOf=(k,date)=>{const suf=k.split("-")[1].slice(7);for(const [id,g] of Object.entries(dk)) if(etDate(g.date)===date&&codes(g.home).some(c=>suf.includes(c))&&codes(g.away).some(c=>suf.includes(c))) return wx[id];return null};
const groups={"bad weather (gusts ≥ 25 mph or rain ≥ 2 mm)":w=>w&&!w.indoor&&!w.unknown&&(w.gust>=25||w.rain>=2),"calm outdoor":w=>w&&!w.indoor&&!w.unknown&&w.gust<15&&w.rain<0.5,"indoor":w=>w&&w.indoor};
const SER={"game total":"KXNFLTOTAL","QB passing yards":"KXNFLPASSYDS","pass attempts":"KXNFLPASSATT","receiving yards":"KXNFLRECYDS","longest reception":"KXNFLLONGREC"};
const cache={};
for(const [gname,f] of Object.entries(groups)){ for(const [sname,s] of Object.entries(SER)){ let c=0,w=0,n=0,evs=new Set();
  for(const [k,e] of Object.entries(ev)){ if(e.series!==s) continue; const x=cache[k]??=gameOf(k,e.date)||0; if(!f(x)) continue;
    for(const m of e.markets){ if(m.bid==null||m.ask==null||m.ask-m.bid>.1) continue; const mid=(m.bid+m.ask)/2; if(mid<.3||mid>.7) continue; const p=1-m.bid; c+=p+fee(p); w+=1-m.y; n++; evs.add(k);} }
  console.log(`${gname.padEnd(46)} ${sname.padEnd(18)} UNDER (NO) near 50¢: ${String(n).padStart(4)} bets in ${String(evs.size).padStart(3)} events, ROI ${n?(((w-c)/c)*100).toFixed(1):"—"}%`); } }
// game-level: all passing-game unders (pass yds, pass att, rec yds, longest reception) near 50¢, one ROI per game
const PASS=new Set(["KXNFLPASSYDS","KXNFLPASSATT","KXNFLRECYDS","KXNFLLONGREC","KXNFLPASSCOMP"]);
const wk=d=>Math.floor((Date.parse(d)-Date.parse("2026-09-08"))/6048e5);
const perGame=f=>{const G={};for(const [k,e] of Object.entries(ev)){ if(!PASS.has(e.series)) continue; const x=cache[k]??=gameOf(k,e.date)||0; if(!f(x)) continue; const gk=k.split("-")[1];
  for(const m of e.markets){ if(m.bid==null||m.ask==null||m.ask-m.bid>.1) continue; const mid=(m.bid+m.ask)/2; if(mid<.3||mid>.7) continue; const p=1-m.bid; const g=G[gk]??={c:0,w:0,wk:wk(e.date)}; g.c+=p+fee(p); g.w+=1-m.y; } } return Object.values(G);};
const summ=(name,f)=>{const G=perGame(f); const roi=a=>{const c=a.reduce((s,g)=>s+g.c,0);return c?(a.reduce((s,g)=>s+g.w,0)-c)/c:NaN};
  let seed=11;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;const bs=[];for(let i=0;i<4000;i++){const s=[];for(let j=0;j<G.length;j++)s.push(G[Math.floor(rnd()*G.length)]);bs.push(roi(s))}bs.sort((a,b)=>a-b);
  const win=G.filter(g=>g.w>g.c).length;
  console.log(`${name.padEnd(44)} ${String(G.length).padStart(3)} games · ROI ${(roi(G)*100).toFixed(1).padStart(6)}% · 90% range ${(bs[200]*100).toFixed(0)}% … ${(bs[3800]*100).toFixed(0)}% · games won ${win}/${G.length} · weeks 0–4 ${(roi(G.filter(g=>g.wk<5))*100).toFixed(1)}% (${G.filter(g=>g.wk<5).length}) | 5+ ${(roi(G.filter(g=>g.wk>=5))*100).toFixed(1)}% (${G.filter(g=>g.wk>=5).length})`);};
console.log("\npassing-game UNDERS, per game:");
for(const [n,f] of [["gusts ≥ 20 mph",w=>w&&!w.indoor&&!w.unknown&&w.gust>=20],["gusts ≥ 25 mph",w=>w&&!w.indoor&&!w.unknown&&w.gust>=25],["gusts ≥ 30 mph",w=>w&&!w.indoor&&!w.unknown&&w.gust>=30],
  ["wind ≥ 10 mph",w=>w&&!w.indoor&&!w.unknown&&w.wind>=10],["rain ≥ 1 mm",w=>w&&!w.indoor&&!w.unknown&&w.rain>=1],["rain ≥ 2 mm",w=>w&&!w.indoor&&!w.unknown&&w.rain>=2],
  ["gusts ≥ 25 or rain ≥ 2 (pre-set rule)",w=>w&&!w.indoor&&!w.unknown&&(w.gust>=25||w.rain>=2)],["calm outdoor",w=>w&&!w.indoor&&!w.unknown&&w.gust<15&&w.rain<0.5],["indoor",w=>w&&w.indoor],["all games",w=>!!w&&!w.unknown]]) summ(n,f);
