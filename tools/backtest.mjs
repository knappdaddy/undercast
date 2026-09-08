#!/usr/bin/env node
/* =========================================================================
   UnderCast backtest — does the weather model's UNDER lean actually beat
   the break-even rate on real results?

   Data: nflverse games.csv (free, no key) — carries each game's closing
   total, final score, roof, temperature and wind.

   Run:  node tools/backtest.mjs             # 2024 regular season
         node tools/backtest.mjs 2023        # any season
         node tools/backtest.mjs 2010-2024   # a range (bigger sample)
         node tools/backtest.mjs 2024 all    # include playoffs

   NOTE: nflverse does not include precipitation, so the model is run with
   wind + cold(wind-chill) + heat only. That makes the penalty a LOWER BOUND
   — real edges in rain/snow games are undercounted here.
   ========================================================================= */

const CSV_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const ARG = String(process.argv[2] || '2024');
const [LO, HI] = ARG.includes('-') ? ARG.split('-').map(Number) : [ +ARG, +ARG ];
const SCOPE   = (process.argv[3] || 'reg').toLowerCase();   // 'reg' | 'all'
const BREAKEVEN = 52.38;                                    // -110 juice

/* ---- weather model (identical to the app) ---- */
function windPenalty(w){ if(w<10) return 0; let p=(Math.min(w,20)-10)*0.18; if(w>20) p+=(w-20)*0.32; return Math.min(p,5.5); }
function coldPenalty(f){ if(f>=32) return 0; if(f>=20) return 0.6; if(f>=10) return 1.1; return 1.7; }
function heatPenalty(f){ if(f<=85) return 0; if(f<=92) return 0.5; return 1.0; }
function windChill(t,w){ if(t==null||t>50||w==null||w<3) return t; const v=Math.pow(w,0.16); return 35.74+0.6215*t-35.75*v+0.4275*t*v; }
function modelPenalty(g){
  if(g.roof==='dome' || g.roof==='closed') return 0;          // weather-neutral
  if(g.temp==null || g.wind==null) return 0;                  // no forecast data
  const feels = Math.round(windChill(g.temp, g.wind));
  return +(windPenalty(g.wind) + coldPenalty(feels) + heatPenalty(g.temp)).toFixed(2);
}

/* ---- tiny CSV parser (handles quoted fields) ---- */
function parseCSV(text){
  const rows=[]; let row=[], field='', q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){ field+='"'; i++; } else q=false; } else field+=c; }
    else if(c==='"') q=true;
    else if(c===','){ row.push(field); field=''; }
    else if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=''; }
    else if(c!=='\r') field+=c;
  }
  if(field.length||row.length){ row.push(field); rows.push(row); }
  const hdr=rows.shift();
  return rows.filter(r=>r.length>1).map(r=>{ const o={}; hdr.forEach((h,i)=>o[h]=r[i]); return o; });
}

const num = v => (v==null||v===''||v==='NA') ? null : (isNaN(+v)?null:+v);

/* ---- tally helper ---- */
function tally(games){
  let under=0, over=0, push=0, diffSum=0;
  for(const g of games){
    if(g.total < g.line) under++; else if(g.total > g.line) over++; else push++;
    diffSum += (g.total - g.line);
  }
  const decided = under+over;
  return { n:games.length, under, over, push,
    underPct: decided? under/decided*100 : 0,
    avgDiff: games.length? diffSum/games.length : 0 };
}
function line(label, t){
  const flag = t.underPct>=BREAKEVEN ? '  ✅' : '';
  return label.padEnd(26) + `${String(t.n).padStart(4)}  `
    + `${String(t.under).padStart(4)}-${String(t.over).padStart(3)}-${t.push}  `
    + `${t.underPct.toFixed(1).padStart(5)}%  `
    + `${(t.avgDiff>=0?'+':'')+t.avgDiff.toFixed(1)} pts${flag}`;
}

(async()=>{
  const res = await fetch(CSV_URL);
  if(!res.ok){ console.error('Failed to fetch nflverse games.csv:', res.status); process.exit(1); }
  const all = parseCSV(await res.text());

  const types = SCOPE==='all' ? ['REG','WC','DIV','CON','SB'] : ['REG'];
  const games = all
    .filter(r => +r.season>=LO && +r.season<=HI && types.includes(r.game_type))
    .map(r => ({ wk:+r.week, type:r.game_type, roof:(r.roof||'').trim(),
      away:r.away_team, home:r.home_team,
      total:num(r.total), line:num(r.total_line), temp:num(r.temp), wind:num(r.wind) }))
    .filter(g => g.total!=null && g.line!=null);

  games.forEach(g => g.pen = modelPenalty(g));

  const outdoor = games.filter(g => g.roof==='outdoors' || g.roof==='open');
  const wx = outdoor.filter(g => g.wind!=null);

  const span = LO===HI ? `${LO}` : `${LO}–${HI}`;
  console.log(`\n  UNDERCAST BACKTEST — ${span} ${SCOPE==='all'?'(incl. playoffs)':'regular season'}`);
  console.log(`  Source: nflverse games.csv · break-even at -110 = ${BREAKEVEN}%  (✅ = beats it)\n`);
  console.log('  bucket                       n   U-O-P    under%   avg(actual−line)');
  console.log('  ' + '─'.repeat(70));
  console.log('  ' + line('ALL games', tally(games)));
  console.log('  ' + line('Indoor / roof closed', tally(games.filter(g=>g.roof==='dome'||g.roof==='closed'))));
  console.log('  ' + line('Outdoor (any)', tally(outdoor)));
  console.log();
  console.log('  WIND (outdoor)');
  console.log('  ' + line('  0–9 mph', tally(wx.filter(g=>g.wind<10))));
  console.log('  ' + line('  10–14 mph', tally(wx.filter(g=>g.wind>=10&&g.wind<15))));
  console.log('  ' + line('  15–19 mph', tally(wx.filter(g=>g.wind>=15&&g.wind<20))));
  console.log('  ' + line('  20+ mph', tally(wx.filter(g=>g.wind>=20))));
  console.log();
  console.log('  TEMPERATURE (outdoor)');
  console.log('  ' + line('  < 32°F (freezing)', tally(outdoor.filter(g=>g.temp!=null&&g.temp<32))));
  console.log('  ' + line('  32–49°F', tally(outdoor.filter(g=>g.temp!=null&&g.temp>=32&&g.temp<50))));
  console.log('  ' + line('  50–69°F', tally(outdoor.filter(g=>g.temp!=null&&g.temp>=50&&g.temp<70))));
  console.log('  ' + line('  70+°F', tally(outdoor.filter(g=>g.temp!=null&&g.temp>=70))));
  console.log();
  console.log('  UNDERCAST MODEL LEAN  (wind+cold+heat; precip not in dataset)');
  console.log('  ' + line('  penalty ≥ 1.5 (UNDER)', tally(games.filter(g=>g.pen>=1.5))));
  console.log('  ' + line('  penalty ≥ 2.0', tally(games.filter(g=>g.pen>=2.0))));
  console.log('  ' + line('  penalty ≥ 3.0 (strong)', tally(games.filter(g=>g.pen>=3.0))));
  console.log('  ' + line('  no lean (< 1.5)', tally(games.filter(g=>g.pen<1.5))));
  console.log('  ' + '─'.repeat(70));
  console.log(`  ✅ = under rate clears the ${BREAKEVEN}% needed to profit at -110.\n`);
})();
