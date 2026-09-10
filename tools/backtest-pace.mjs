#!/usr/bin/env node
/* =========================================================================
   UnderCast PACE backtest — does combined team pace predict unders?

   Thesis: fewer plays/possessions → fewer scoring chances → under. The market
   prices efficiency well but is thought to be slower on PACE. We use each
   team's PRIOR-SEASON offensive plays/game (no lookahead) as its pace, sum
   the two teams for each game, and test whether the slowest games go under.

   Data (all free):
     • Results + closing totals — nflverse games.csv
     • Plays — nflverse play-by-play releases (one season at a time, in memory)

   Run:  node tools/backtest-pace.mjs 2016-2024
   ========================================================================= */

import zlib from 'node:zlib';

const CSV_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const PBP = s => `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${s}.csv.gz`;
const ARG = String(process.argv[2] || '2016-2024');
const [LO, HI] = ARG.includes('-') ? ARG.split('-').map(Number) : [ +ARG, +ARG ];
const BREAKEVEN = 52.38;
const CANON = s => ({OAK:'LV',SD:'LAC',STL:'LAR',LA:'LAR'}[s]||s);   // merge relocated franchises

function parseCSV(text){ const rows=[]; let row=[],f='',q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if(c==='"') q=true; else if(c===','){ row.push(f); f=''; }
    else if(c==='\n'){ row.push(f); rows.push(row); row=[]; f=''; } else if(c!=='\r') f+=c; }
  if(f.length||row.length){ row.push(f); rows.push(row); }
  const h=rows.shift(); return rows.filter(r=>r.length>1).map(r=>{ const o={}; h.forEach((k,i)=>o[k]=r[i]); return o; }); }
const num = v => (v==null||v===''||v==='NA')?null:(isNaN(+v)?null:+v);

// stream a pbp CSV, counting offensive plays per team without building 380-col objects
function aggregatePace(text){
  const nl = text.indexOf('\n');
  const header = text.slice(0,nl).split(',');
  const IG = header.indexOf('game_id'), IP = header.indexOf('posteam'), IT = header.indexOf('play_type');
  const acc = {};                                   // team -> {plays, passes, games:Set}
  let field='', col=0, q=false, gid='', team='', pt='';
  const endField = () => { if(col===IG)gid=field; else if(col===IP)team=field; else if(col===IT)pt=field; field=''; col++; };
  const endRow = () => { endField();
    if(team && (pt==='pass'||pt==='run')){ const k=CANON(team); const a=acc[k]||(acc[k]={plays:0,passes:0,games:new Set()});
      a.plays++; if(pt==='pass')a.passes++; a.games.add(gid); }
    field='';col=0;gid='';team='';pt=''; };
  for(let i=nl+1;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){field+='"';i++;} else q=false; } else field+=c; }
    else if(c==='"') q=true; else if(c===',') endField();
    else if(c==='\n') endRow(); else if(c!=='\r') field+=c; }
  if(col>0||field.length) endRow();
  const out={};
  for(const [t,a] of Object.entries(acc)){ const g=a.games.size||1; out[t]={ppg:a.plays/g, passRate:a.passes/a.plays}; }
  return out;
}
async function seasonPace(s){
  const r = await fetch(PBP(s)); if(!r.ok) throw new Error(`pbp ${s}: HTTP ${r.status}`);
  const csv = zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8');
  return aggregatePace(csv);
}

function tally(games){ let u=0,o=0,p=0,ds=0;
  for(const g of games){ if(g.total<g.line)u++; else if(g.total>g.line)o++; else p++; ds+=g.total-g.line; }
  const dec=u+o; return {n:games.length,u,o,p,pct:dec?u/dec*100:0,avg:games.length?ds/games.length:0}; }
function line(label,t,base){ const flag=t.pct>=BREAKEVEN?'  ✅':(t.pct<=100-BREAKEVEN?'  ⤴over':'');
  const vs = base!=null?`${(t.pct-base>=0?'+':'')+(t.pct-base).toFixed(1)} vs base`:'';
  return '  '+label.padEnd(28)+`${String(t.n).padStart(5)}  ${String(t.u).padStart(4)}-${String(t.o).padStart(4)}-${t.p}  `
    +`${t.pct.toFixed(1).padStart(5)}%  ${(t.avg>=0?'+':'')+t.avg.toFixed(1)}  ${vs.padStart(12)}${flag}`; }
const quantile=(arr,q)=>{ const s=[...arr].sort((a,b)=>a-b); return s[Math.floor((s.length-1)*q)]; };

(async()=>{
  process.stdout.write('Fetching results… ');
  const all = parseCSV(await (await fetch(CSV_URL)).text());
  console.log('ok');
  const pace = {};
  for(let s=LO-1; s<=HI-1; s++){ process.stdout.write(`  pace ${s}… `); pace[s]=await seasonPace(s); console.log(Object.keys(pace[s]).length+' teams'); }

  const games = all.filter(r=>+r.season>=LO && +r.season<=HI && r.game_type==='REG')
    .map(r=>({ season:+r.season, home:CANON(r.home_team), away:CANON(r.away_team), total:num(r.total), line:num(r.total_line) }))
    .filter(g=>g.total!=null && g.line!=null);
  for(const g of games){ const hp=(pace[g.season-1]||{})[g.home], ap=(pace[g.season-1]||{})[g.away];
    if(hp&&ap){ g.ppg=hp.ppg+ap.ppg; g.pass=(hp.passRate+ap.passRate)/2; } }
  const rows = games.filter(g=>g.ppg!=null);
  const base = tally(rows).pct;
  const ppgs = rows.map(g=>g.ppg);
  const t33=quantile(ppgs,1/3), t67=quantile(ppgs,2/3), d10=quantile(ppgs,0.1), d90=quantile(ppgs,0.9);
  const passes = rows.map(g=>g.pass);
  const p33=quantile(passes,1/3), p67=quantile(passes,2/3);

  console.log(`\n  UNDERCAST PACE BACKTEST — ${LO}–${HI} reg · prior-season pace`);
  console.log(`  ${rows.length} games with pace · break-even ${BREAKEVEN}% · baseline under ${base.toFixed(1)}%\n`);
  console.log('  bucket                          n    U -  O -P   under%  avgΔ        vs base');
  console.log('  '+'─'.repeat(80));
  console.log(line('ALL (baseline)', tally(rows), null));
  console.log('  —— combined plays/game (both teams, prior yr) ——');
  console.log(line('Slowest third', tally(rows.filter(g=>g.ppg<=t33)), base));
  console.log(line('Middle third', tally(rows.filter(g=>g.ppg>t33&&g.ppg<t67)), base));
  console.log(line('Fastest third', tally(rows.filter(g=>g.ppg>=t67)), base));
  console.log(line('Slowest 10%', tally(rows.filter(g=>g.ppg<=d10)), base));
  console.log(line('Fastest 10%', tally(rows.filter(g=>g.ppg>=d90)), base));
  console.log('  —— combined pass rate (run-heavy = low) ——');
  console.log(line('Most run-heavy third', tally(rows.filter(g=>g.pass<=p33)), base));
  console.log(line('Most pass-heavy third', tally(rows.filter(g=>g.pass>=p67)), base));
  console.log('  '+'─'.repeat(80));
  console.log(`  ✅ = under rate clears ${BREAKEVEN}%. avgΔ = mean (actual − line); negative = ran under.\n`);
})();
