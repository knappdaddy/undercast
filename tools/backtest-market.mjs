#!/usr/bin/env node
/* =========================================================================
   UnderCast MARKET backtest — does Book-vs-Sharp actually predict unders?

   Validates the inflation module's core betting-market signal: when your
   retail book's CLOSING total sits above the sharp book (Pinnacle), does the
   UNDER hit more than the -110 break-even? And symmetrically for overs.

   Data:
     • Results + schedule + closing consensus — nflverse games.csv (free)
     • Per-book CLOSING totals — The Odds API historical snapshots, taken a
       few minutes before each kickoff wave (Pinnacle, FanDuel, DraftKings).
       REQUIRES a paid key in env ODDS_API_KEY.

   Cost control:
     • Snapshots are grouped by kickoff time and CACHED under tools/.mktcache/
       so re-runs are free. Remaining API credits are printed each run.
     • Pass a week limit to keep the first run cheap:
         node tools/backtest-market.mjs 2024 reg 2     # weeks 1-2 only
         node tools/backtest-market.mjs 2024 reg        # full season
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = process.env.ODDS_API_KEY;
if(!KEY){ console.error('Missing ODDS_API_KEY (set it as an env var / GitHub Actions secret).'); process.exit(1); }
const CSV_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const HIST = 'https://api.the-odds-api.com/v4/historical/sports/americanfootball_nfl/odds';
const SEASON = +(process.argv[2] || 2024);
const SCOPE  = (process.argv[3] || 'reg').toLowerCase();
const WEEK_LIMIT = process.argv[4] ? +process.argv[4] : 99;
const RETAIL = 'fanduel', SHARP = 'pinnacle';
// pinnacle/lowvig/betonlineag are the sharp, low-hold references (fallbacks if Pinnacle absent)
const BOOKS = 'pinnacle,fanduel,draftkings,lowvig,betonlineag';
const BREAKEVEN = 52.38;
const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.mktcache');

/* ---- nflverse teams (abbr -> full name used by The Odds API) ---- */
const FULL = {ARI:'Arizona Cardinals',ATL:'Atlanta Falcons',BAL:'Baltimore Ravens',BUF:'Buffalo Bills',
  CAR:'Carolina Panthers',CHI:'Chicago Bears',CIN:'Cincinnati Bengals',CLE:'Cleveland Browns',
  DAL:'Dallas Cowboys',DEN:'Denver Broncos',DET:'Detroit Lions',GB:'Green Bay Packers',
  HOU:'Houston Texans',IND:'Indianapolis Colts',JAX:'Jacksonville Jaguars',KC:'Kansas City Chiefs',
  LV:'Las Vegas Raiders',LAC:'Los Angeles Chargers',LAR:'Los Angeles Rams',MIA:'Miami Dolphins',
  MIN:'Minnesota Vikings',NE:'New England Patriots',NO:'New Orleans Saints',NYG:'New York Giants',
  NYJ:'New York Jets',PHI:'Philadelphia Eagles',PIT:'Pittsburgh Steelers',SF:'San Francisco 49ers',
  SEA:'Seattle Seahawks',TB:'Tampa Bay Buccaneers',TEN:'Tennessee Titans',WAS:'Washington Commanders'};
const norm = s => (s||'').toLowerCase().replace(/[^a-z]/g,'');

/* ---- utils ---- */
function parseCSV(text){ const rows=[]; let row=[],f='',q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if(c==='"') q=true; else if(c===','){ row.push(f); f=''; }
    else if(c==='\n'){ row.push(f); rows.push(row); row=[]; f=''; } else if(c!=='\r') f+=c; }
  if(f.length||row.length){ row.push(f); rows.push(row); }
  const h=rows.shift(); return rows.filter(r=>r.length>1).map(r=>{ const o={}; h.forEach((k,i)=>o[k]=r[i]); return o; }); }
const num = v => (v==null||v===''||v==='NA')?null:(isNaN(+v)?null:+v);
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// ET wall time -> UTC instant (handles EDT/EST without a tz lib)
function etToUTC(gameday, gametime){
  const g = new Date(`${gameday}T${(gametime||'13:00')}:00Z`);          // wall time as if UTC
  const utc = new Date(g.toLocaleString('en-US',{timeZone:'UTC'}));
  const et  = new Date(g.toLocaleString('en-US',{timeZone:'America/New_York'}));
  const offMin = Math.round((utc - et)/60000);                          // 240 or 300
  return new Date(g.getTime() + offMin*60000);
}
function tsOf(d){ return d.toISOString().slice(0,19)+'Z'; }

let creditsRemaining = null;
async function snapshot(dateISO){
  fs.mkdirSync(CACHE,{recursive:true});
  const f = path.join(CACHE, dateISO.replace(/[:]/g,'-')+'.json');
  if(fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8'));
  const url = `${HIST}/?apiKey=${encodeURIComponent(KEY)}&regions=us,eu&markets=totals&oddsFormat=american`
    + `&bookmakers=${BOOKS}&date=${encodeURIComponent(dateISO)}`;
  const r = await fetch(url);
  const rem = r.headers.get('x-requests-remaining'); if(rem!=null) creditsRemaining = rem;
  if(!r.ok){ throw new Error(`historical ${dateISO}: HTTP ${r.status} ${await r.text().catch(()=> '')}`.slice(0,180)); }
  const j = await r.json();
  const games = (j && j.data) ? j.data : [];
  const byTeam = {};
  games.forEach(o=>{ const tot={};
    (o.bookmakers||[]).forEach(b=>{ const m=(b.markets||[]).find(x=>x.key==='totals');
      const ov=m&&(m.outcomes||[]).find(x=>x.name==='Over'); if(ov&&ov.point!=null) tot[b.key]=+ov.point; });
    byTeam[norm(o.home_team)] = tot; });
  fs.writeFileSync(f, JSON.stringify(byTeam));
  await sleep(300);
  return byTeam;
}

/* ---- tally ---- */
function tally(rows, side){ // side: 'under' | 'over' — which way we bet
  let win=0,lose=0,push=0;
  for(const g of rows){
    if(g.total===g.betLine){ push++; continue; }
    const wentUnder = g.total < g.betLine;
    const won = side==='under' ? wentUnder : !wentUnder;
    if(won) win++; else lose++;
  }
  const dec=win+lose;
  return {n:rows.length, win, lose, push, pct: dec? win/dec*100 : 0};
}
function line(label, t, side){ const flag=t.pct>=BREAKEVEN?'  ✅':'';
  return '  '+label.padEnd(30)+`${String(t.n).padStart(4)}  ${String(t.win).padStart(4)}-${String(t.lose).padStart(3)}-${t.push}  `
    +`${t.pct.toFixed(1).padStart(5)}% ${side}${flag}`; }

(async()=>{
  process.stdout.write('Fetching nflverse games… ');
  const all = parseCSV(await (await fetch(CSV_URL)).text());
  console.log('ok');
  const types = SCOPE==='all' ? ['REG','WC','DIV','CON','SB'] : ['REG'];
  const games = all.filter(r=>+r.season===SEASON && types.includes(r.game_type) && +r.week<=WEEK_LIMIT)
    .map(r=>({ week:+r.week, home:r.home_team, away:r.away_team, gameday:r.gameday, gametime:r.gametime,
      total:num(r.total), closeConsensus:num(r.total_line) }))
    .filter(g=>g.total!=null && FULL[g.home]);
  if(!games.length){ console.log('No games matched.'); return; }

  // group games by the snapshot timestamp = kickoff − 5 min
  const groups = {};
  for(const g of games){
    const k = etToUTC(g.gameday, g.gametime); if(isNaN(k)) continue;
    g.snapTs = tsOf(new Date(k.getTime() - 5*60000));
    (groups[g.snapTs] ||= []).push(g);
  }
  const stamps = Object.keys(groups).sort();
  console.log(`${games.length} games · ${stamps.length} snapshot calls (weeks ≤ ${WEEK_LIMIT})`);

  let calls=0;
  for(const ts of stamps){
    let byTeam;
    try{ byTeam = await snapshot(ts); }
    catch(e){ console.error('  '+e.message); continue; }
    calls++;
    for(const g of groups[ts]){
      const tot = byTeam[norm(FULL[g.home])];
      g.hadSnap = !!tot;
      if(!tot) continue;
      g.retailClose = tot[RETAIL] ?? tot.draftkings ?? null;
      g.sharpClose  = tot.pinnacle ?? tot.lowvig ?? tot.betonlineag ?? null;
      g.sharpSrc = tot.pinnacle!=null?'pinnacle':tot.lowvig!=null?'lowvig':tot.betonlineag!=null?'betonline':'—';
      g.pinHad = tot.pinnacle!=null;
    }
    if(calls%10===0) process.stdout.write(`  …${calls}/${stamps.length} snapshots (credits left: ${creditsRemaining})\n`);
  }

  // diagnostics — why do games drop out?
  const noSnap  = games.filter(g=>!g.hadSnap);
  const noRetail= games.filter(g=>g.hadSnap && g.retailClose==null);
  const noSharp = games.filter(g=>g.hadSnap && g.sharpClose==null);
  console.log(`\n  diagnostics: no snapshot ${noSnap.length} · missing retail ${noRetail.length} · missing sharp ${noSharp.length}`);
  const pinAmong = games.filter(g=>g.sharpClose!=null);
  console.log(`  sharp source: Pinnacle on ${pinAmong.filter(g=>g.pinHad).length}/${pinAmong.length} matched (rest used lowvig/betonline)`);
  noSnap.slice(0,5).forEach(g=>console.log(`    no snapshot: ${g.away}@${g.home} ${g.gameday} ${g.gametime} → ${g.snapTs}`));

  // keep games where we have both retail + sharp closing totals
  const rows = games.filter(g=>g.retailClose!=null && g.sharpClose!=null);
  rows.forEach(g=>{ g.gap = +(g.retailClose - g.sharpClose).toFixed(2); });
  const matched = rows.length;

  console.log(`\n  UNDERCAST MARKET BACKTEST — ${SEASON} ${SCOPE==='all'?'(incl. playoffs)':'reg'}${WEEK_LIMIT<99?` · wks 1-${WEEK_LIMIT}`:''}`);
  console.log(`  retail=${RETAIL} vs sharp=${SHARP} · closing lines · break-even ${BREAKEVEN}%`);
  console.log(`  matched ${matched}/${games.length} games with both books · credits remaining: ${creditsRemaining}\n`);
  console.log('  bucket                          n   W-L-P    win%   side');
  console.log('  '+'─'.repeat(66));

  // Bet the retail line, UNDER, when retail is inflated vs sharp
  const infl = th => { const s=rows.filter(g=>g.gap>=th); s.forEach(g=>g.betLine=g.retailClose); return tally(s,'under'); };
  const defl = th => { const s=rows.filter(g=>g.gap<=-th); s.forEach(g=>g.betLine=g.retailClose); return tally(s,'over'); };
  const agree = () => { const s=rows.filter(g=>Math.abs(g.gap)<0.5); s.forEach(g=>g.betLine=g.retailClose); return tally(s,'under'); };

  console.log(line(`retail ≥ sharp +1.5  → UNDER`, infl(1.5), 'U'));
  console.log(line(`retail ≥ sharp +1.0  → UNDER`, infl(1.0), 'U'));
  console.log(line(`retail ≥ sharp +0.5  → UNDER`, infl(0.5), 'U'));
  console.log(line(`retail ≤ sharp −0.5  → OVER`,  defl(0.5), 'O'));
  console.log(line(`retail ≤ sharp −1.0  → OVER`,  defl(1.0), 'O'));
  console.log(line(`|gap| < 0.5 (agree)  → UNDER`, agree(), 'U'));
  console.log('  '+'─'.repeat(66));
  console.log(`  ✅ = win rate clears the ${BREAKEVEN}% needed to profit at -110.`);
  console.log(`  Credits remaining on your key: ${creditsRemaining}\n`);
})();
