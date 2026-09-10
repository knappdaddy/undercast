#!/usr/bin/env node
/* =========================================================================
   UnderCast SITUATIONAL backtest — do the "crowd-money" & situational
   factors actually predict unders? (primetime, division, favorite, travel,
   short week, rest). All free from nflverse — no odds API.

   For each factor we "bet UNDER" on flagged games and report the win rate
   vs the -110 break-even (52.38%) and vs the sample's baseline under rate.

   Run:  node tools/backtest-situational.mjs 2010-2024
         node tools/backtest-situational.mjs 2015-2024 all
   ========================================================================= */

const CSV_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const ARG = String(process.argv[2] || '2010-2024');
const [LO, HI] = ARG.includes('-') ? ARG.split('-').map(Number) : [ +ARG, +ARG ];
const SCOPE = (process.argv[3] || 'reg').toLowerCase();
const BREAKEVEN = 52.38;

const DIV = {BUF:'AFCE',MIA:'AFCE',NE:'AFCE',NYJ:'AFCE',BAL:'AFCN',CIN:'AFCN',CLE:'AFCN',PIT:'AFCN',
  HOU:'AFCS',IND:'AFCS',JAX:'AFCS',TEN:'AFCS',DEN:'AFCW',KC:'AFCW',LV:'AFCW',LAC:'AFCW',OAK:'AFCW',SD:'AFCW',
  DAL:'NFCE',NYG:'NFCE',PHI:'NFCE',WAS:'NFCE',CHI:'NFCN',DET:'NFCN',GB:'NFCN',MIN:'NFCN',
  ATL:'NFCS',CAR:'NFCS',NO:'NFCS',TB:'NFCS',ARI:'NFCW',LAR:'NFCW',LA:'NFCW',STL:'NFCW',SF:'NFCW',SEA:'NFCW'};
const ZONE = {SEA:3,SF:3,LAR:3,LA:3,LAC:3,SD:3,OAK:3,LV:3,ARI:2,DEN:2,
  CHI:1,GB:1,MIN:1,DAL:1,HOU:1,NO:1,KC:1,TEN:1,STL:1,
  BUF:0,MIA:0,NE:0,NYJ:0,BAL:0,CIN:0,CLE:0,PIT:0,IND:0,JAX:0,NYG:0,PHI:0,WAS:0,ATL:0,CAR:0,TB:0,DET:0};

function parseCSV(text){ const rows=[]; let row=[],f='',q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if(c==='"') q=true; else if(c===','){ row.push(f); f=''; }
    else if(c==='\n'){ row.push(f); rows.push(row); row=[]; f=''; } else if(c!=='\r') f+=c; }
  if(f.length||row.length){ row.push(f); rows.push(row); }
  const h=rows.shift(); return rows.filter(r=>r.length>1).map(r=>{ const o={}; h.forEach((k,i)=>o[k]=r[i]); return o; }); }
const num = v => (v==null||v===''||v==='NA')?null:(isNaN(+v)?null:+v);

function tally(games){ let u=0,o=0,p=0,ds=0;
  for(const g of games){ if(g.total<g.line)u++; else if(g.total>g.line)o++; else p++; ds+=g.total-g.line; }
  const dec=u+o; return {n:games.length,u,o,p,pct:dec?u/dec*100:0,avg:games.length?ds/games.length:0}; }
function line(label,t,base){ const flag=t.pct>=BREAKEVEN?'  ✅':(t.pct<=100-BREAKEVEN?'  ⤴over':'');
  const vsBase = base!=null ? `${(t.pct-base>=0?'+':'')+(t.pct-base).toFixed(1)} vs base` : '';
  return '  '+label.padEnd(26)+`${String(t.n).padStart(5)}  ${String(t.u).padStart(4)}-${String(t.o).padStart(4)}-${t.p}  `
    +`${t.pct.toFixed(1).padStart(5)}%  ${(t.avg>=0?'+':'')+t.avg.toFixed(1)}  ${vsBase.padStart(12)}${flag}`; }

(async()=>{
  const all = parseCSV(await (await fetch(CSV_URL)).text());
  const types = SCOPE==='all' ? ['REG','WC','DIV','CON','SB'] : ['REG'];
  const games = all.filter(r=>+r.season>=LO && +r.season<=HI && types.includes(r.game_type))
    .map(r=>{ const hour=+((r.gametime||'13:00').split(':')[0]);
      return { wd:(r.weekday||'').trim(), hour, home:r.home_team, away:r.away_team,
        total:num(r.total), line:num(r.total_line), spread:num(r.spread_line),
        homeRest:num(r.home_rest), awayRest:num(r.away_rest) }; })
    .filter(g=>g.total!=null && g.line!=null);

  const base = tally(games).pct;
  const span = LO===HI?`${LO}`:`${LO}–${HI}`;
  console.log(`\n  UNDERCAST SITUATIONAL BACKTEST — ${span} ${SCOPE==='all'?'(incl. playoffs)':'reg'}`);
  console.log(`  bet UNDER on flagged games · break-even ${BREAKEVEN}% · baseline under rate ${base.toFixed(1)}%\n`);
  console.log('  factor                        n    U -  O -P   under%  avgΔ        vs base');
  console.log('  '+'─'.repeat(78));

  const prime = g => g.wd==='Thursday'||g.wd==='Monday'||g.wd==='Saturday'||(g.wd==='Sunday'&&g.hour>=19);
  const early = g => g.wd==='Sunday'&&g.hour<=13;
  const division = g => DIV[g.home]&&DIV[g.home]===DIV[g.away];
  const travel = g => ((ZONE[g.away]??0)-(ZONE[g.home]??0))>=2 && early(g);
  const bigFav = g => g.spread!=null && Math.abs(g.spread)>=7;
  const hugeFav = g => g.spread!=null && Math.abs(g.spread)>=10;

  console.log(line('ALL games (baseline)', tally(games), null));
  console.log('  —— crowd / scheduling ——');
  console.log(line('Primetime (all standalone)', tally(games.filter(prime)), base));
  console.log(line('  Thu night (TNF)', tally(games.filter(g=>g.wd==='Thursday')), base));
  console.log(line('  Sun night (SNF)', tally(games.filter(g=>g.wd==='Sunday'&&g.hour>=19)), base));
  console.log(line('  Mon night (MNF)', tally(games.filter(g=>g.wd==='Monday')), base));
  console.log(line('Sunday early (1pm ET)', tally(games.filter(early)), base));
  console.log('  —— matchup / spread ——');
  console.log(line('Division game', tally(games.filter(division)), base));
  console.log(line('Non-division game', tally(games.filter(g=>!division(g))), base));
  console.log(line('Favorite ≥ 7', tally(games.filter(bigFav)), base));
  console.log(line('Favorite ≥ 10', tally(games.filter(hugeFav)), base));
  console.log(line('Close game (spread < 3)', tally(games.filter(g=>g.spread!=null&&Math.abs(g.spread)<3)), base));
  console.log('  —— rest / travel ——');
  console.log(line('West→East, early kick', tally(games.filter(travel)), base));
  console.log(line('A team off bye (rest≥13)', tally(games.filter(g=>g.homeRest>=13||g.awayRest>=13)), base));
  console.log(line('Short week (any Thu)', tally(games.filter(g=>g.wd==='Thursday')), base));
  console.log('  '+'─'.repeat(78));
  console.log(`  ✅ = under rate clears ${BREAKEVEN}% (profitable UNDER). ⤴over = flag actually favors OVERS.`);
  console.log(`  avgΔ = mean (actual total − closing line); negative = games ran under.\n`);
})();
