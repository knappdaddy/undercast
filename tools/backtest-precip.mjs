#!/usr/bin/env node
/* =========================================================================
   UnderCast FULL-model backtest — wind + precipitation + cold + heat.

   nflverse games.csv gives closing total, final score, roof, temp, wind.
   It has NO precipitation, so this script enriches every OUTDOOR home game
   with hourly precip from Open-Meteo's free historical archive (no key),
   matched to the venue + kickoff hour, then runs the complete app model.

   Run:  node tools/backtest-precip.mjs             # 2024 regular season
         node tools/backtest-precip.mjs 2020-2024   # a range (more calls)
         node tools/backtest-precip.mjs 2024 all    # include playoffs

   Responses are cached under tools/.wxcache/ (one file per venue-season),
   so the first run makes ~32 archive calls per season and re-runs are free.
   Requires Node 18+ (global fetch). No npm install, no API key.
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSV_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const ARG = String(process.argv[2] || '2024');
const [LO, HI] = ARG.includes('-') ? ARG.split('-').map(Number) : [ +ARG, +ARG ];
const SCOPE = (process.argv[3] || 'reg').toLowerCase();
const BREAKEVEN = 52.38;
const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.wxcache');

/* ---- venue coords, keyed by nflverse home_team abbr (incl. relocations) ---- */
const V = {
  ARI:[33.5277,-112.2626], ATL:[33.7554,-84.4008], BAL:[39.2780,-76.6227], BUF:[42.7738,-78.7870],
  CAR:[35.2258,-80.8528], CHI:[41.8623,-87.6167], CIN:[39.0954,-84.5160], CLE:[41.5061,-81.6995],
  DAL:[32.7473,-97.0945], DEN:[39.7439,-105.0201], DET:[42.3400,-83.0456], GB:[44.5013,-88.0622],
  HOU:[29.6847,-95.4107], IND:[39.7601,-86.1639], JAX:[30.3239,-81.6373], KC:[39.0489,-94.4839],
  LV:[36.0909,-115.1833], LAC:[33.9535,-118.3392], LAR:[33.9535,-118.3392], MIA:[25.9580,-80.2389],
  MIN:[44.9736,-93.2575], NE:[42.0909,-71.2643], NO:[29.9511,-90.0812], NYG:[40.8135,-74.0745],
  NYJ:[40.8135,-74.0745], PHI:[39.9008,-75.1675], PIT:[40.4468,-80.0158], SEA:[47.5952,-122.3316],
  SF:[37.4030,-121.9698], TB:[27.9759,-82.5033], TEN:[36.1665,-86.7713], WAS:[38.9077,-76.8645],
  OAK:[37.7516,-122.2005], SD:[32.7831,-117.1196], STL:[38.6329,-90.1885], LA:[34.0141,-118.2879]
};

/* ---- weather model (identical to the app, precip included) ---- */
function windPenalty(w){ if(w<10) return 0; let p=(Math.min(w,20)-10)*0.18; if(w>20) p+=(w-20)*0.32; return Math.min(p,5.5); }
function precipPenalty(type,intensity){ const t={rain:{light:0.6,moderate:1.6,heavy:2.6},snow:{light:1.4,moderate:2.4,heavy:3.6}};
  if(!type||type==='none'||!t[type]) return 0; return t[type][intensity]||0; }
function coldPenalty(f){ if(f>=32) return 0; if(f>=20) return 0.6; if(f>=10) return 1.1; return 1.7; }
function heatPenalty(f){ if(f<=85) return 0; if(f<=92) return 0.5; return 1.0; }
function windChill(t,w){ if(t==null||t>50||w==null||w<3) return t; const v=Math.pow(w,0.16); return 35.74+0.6215*t-35.75*v+0.4275*t*v; }
function fullPenalty(g){
  if(g.roof==='dome' || g.roof==='closed') return 0;
  if(g.temp==null || g.wind==null) return 0;
  const feels = Math.round(windChill(g.temp, g.wind));
  return +(windPenalty(g.wind) + precipPenalty(g.precipType,g.precipIntensity) + coldPenalty(feels) + heatPenalty(g.temp)).toFixed(2);
}
function classifyPrecip(code, mm, snowCm){
  const snow = (snowCm||0)>0 || [71,73,75,77,85,86].includes(code);
  const wet  = (mm||0)>0.1 || [51,53,55,56,57,61,63,65,66,67,80,81,82,95,96,99].includes(code);
  if(snow) return {type:'snow', intensity: mm>2?'heavy':mm>0.6?'moderate':'light'};
  if(wet)  return {type:'rain', intensity: mm>4?'heavy':mm>1?'moderate':'light'};
  return {type:'none', intensity:'none'};
}

/* ---- csv + utils ---- */
function parseCSV(text){
  const rows=[]; let row=[], field='', q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){ field+='"'; i++; } else q=false; } else field+=c; }
    else if(c==='"') q=true; else if(c===','){ row.push(field); field=''; }
    else if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=''; }
    else if(c!=='\r') field+=c; }
  if(field.length||row.length){ row.push(field); rows.push(row); }
  const hdr=rows.shift();
  return rows.filter(r=>r.length>1).map(r=>{ const o={}; hdr.forEach((h,i)=>o[h]=r[i]); return o; });
}
const num = v => (v==null||v===''||v==='NA') ? null : (isNaN(+v)?null:+v);
const sleep = ms => new Promise(r=>setTimeout(r,ms));

/* ---- per venue-season archive (cached to disk) ---- */
async function getArchive(abbr, season, start, end){
  fs.mkdirSync(CACHE_DIR, {recursive:true});
  const f = path.join(CACHE_DIR, `${abbr}-${season}.json`);
  if(fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8'));
  const [lat,lon] = V[abbr];
  const url = `${ARCHIVE}?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}`
    + `&hourly=temperature_2m,precipitation,rain,snowfall,weather_code,wind_speed_10m`
    + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York`;
  const r = await fetch(url);
  if(!r.ok) throw new Error(`archive ${abbr} ${season}: HTTP ${r.status}`);
  const d = await r.json();
  const map = {};                                   // "YYYY-MM-DDTHH" -> {mm, snow, code, temp, wind}
  const H = d.hourly || {};
  (H.time||[]).forEach((t,i)=>{ map[t.slice(0,13)] = {
    mm:H.precipitation?.[i], snow:H.snowfall?.[i], code:H.weather_code?.[i],
    temp:H.temperature_2m?.[i], wind:H.wind_speed_10m?.[i] }; });
  fs.writeFileSync(f, JSON.stringify(map));
  await sleep(250);                                 // be polite to the free API
  return map;
}
function kickoffKey(gameday, gametime){
  let hr = parseInt((gametime||'13:00').split(':')[0], 10);
  const mn = parseInt((gametime||'13:00').split(':')[1]||'0', 10);
  if(mn>=30) hr++; if(hr>23) hr=23;
  return `${gameday}T${String(hr).padStart(2,'0')}`;
}

/* ---- tally + report ---- */
function tally(games){ let u=0,o=0,p=0,ds=0;
  for(const g of games){ if(g.total<g.line)u++; else if(g.total>g.line)o++; else p++; ds+=g.total-g.line; }
  const dec=u+o; return {n:games.length,u,o,p,underPct:dec?u/dec*100:0,avg:games.length?ds/games.length:0}; }
function row(label,t){ const flag=t.underPct>=BREAKEVEN?'  ✅':'';
  return '  '+label.padEnd(26)+`${String(t.n).padStart(4)}  ${String(t.u).padStart(4)}-${String(t.o).padStart(3)}-${t.p}  `
    +`${t.underPct.toFixed(1).padStart(5)}%  ${(t.avg>=0?'+':'')+t.avg.toFixed(1)} pts${flag}`; }

(async()=>{
  process.stdout.write('Fetching nflverse games… ');
  const all = parseCSV(await (await fetch(CSV_URL)).text());
  console.log('ok');
  const types = SCOPE==='all' ? ['REG','WC','DIV','CON','SB'] : ['REG'];
  const games = all.filter(r=>+r.season>=LO && +r.season<=HI && types.includes(r.game_type))
    .map(r=>({ season:+r.season, home:r.home_team, loc:(r.location||'Home'),
      gameday:r.gameday, gametime:r.gametime, roof:(r.roof||'').trim(),
      total:num(r.total), line:num(r.total_line), temp:num(r.temp), wind:num(r.wind),
      precipType:'none', precipIntensity:'none' }))
    .filter(g=>g.total!=null && g.line!=null);

  // outdoor home games needing precip enrichment, grouped by venue-season
  const need = games.filter(g=>(g.roof==='outdoors'||g.roof==='open') && g.loc==='Home' && V[g.home]);
  const groups = {};
  for(const g of need){ (groups[`${g.home}|${g.season}`] ||= []).push(g); }
  const keys = Object.keys(groups);
  console.log(`Enriching ${need.length} outdoor games across ${keys.length} venue-seasons with precip…`);

  let done=0, miss=0;
  for(const key of keys){
    const [abbr, season] = key.split('|');
    const gs = groups[key];
    const days = gs.map(g=>g.gameday).sort();
    const start = days[0], end = days[days.length-1];
    let map;
    try{ map = await getArchive(abbr, +season, start, end); }
    catch(e){ console.error('  '+e.message); continue; }
    for(const g of gs){
      const h = map[kickoffKey(g.gameday, g.gametime)];
      if(!h){ miss++; continue; }
      const p = classifyPrecip(h.code, h.mm, h.snow);
      g.precipType = p.type; g.precipIntensity = p.intensity;
      if(g.wind==null && h.wind!=null) g.wind = Math.round(h.wind);   // fallback if nflverse blank
      if(g.temp==null && h.temp!=null) g.temp = Math.round(h.temp);
    }
    done++; if(done%16===0) process.stdout.write(`  …${done}/${keys.length} venue-seasons\n`);
  }
  if(miss) console.log(`  (${miss} games had no matching archive hour — left dry)`);

  games.forEach(g=>g.pen = fullPenalty(g));
  const wet = games.filter(g=>g.precipType!=='none');
  const span = LO===HI?`${LO}`:`${LO}–${HI}`;

  console.log(`\n  UNDERCAST FULL-MODEL BACKTEST — ${span} ${SCOPE==='all'?'(incl. playoffs)':'regular season'}`);
  console.log(`  nflverse results + Open-Meteo precip · break-even -110 = ${BREAKEVEN}%  (✅ beats it)\n`);
  console.log('  bucket                       n   U-O-P    under%   avg(actual−line)');
  console.log('  '+'─'.repeat(70));
  console.log(row('ALL games', tally(games)));
  console.log();
  console.log('  PRECIPITATION');
  console.log(row('  any precip', tally(wet)));
  console.log(row('  rain (any)', tally(games.filter(g=>g.precipType==='rain'))));
  console.log(row('  rain moderate+', tally(games.filter(g=>g.precipType==='rain'&&g.precipIntensity!=='light'))));
  console.log(row('  snow (any)', tally(games.filter(g=>g.precipType==='snow'))));
  console.log(row('  dry outdoor', tally(games.filter(g=>(g.roof==='outdoors'||g.roof==='open')&&g.precipType==='none'))));
  console.log();
  console.log('  FULL MODEL LEAN (wind+precip+cold+heat)');
  console.log(row('  penalty ≥ 1.5 (UNDER)', tally(games.filter(g=>g.pen>=1.5))));
  console.log(row('  penalty ≥ 2.0', tally(games.filter(g=>g.pen>=2.0))));
  console.log(row('  penalty ≥ 3.0 (strong)', tally(games.filter(g=>g.pen>=3.0))));
  console.log(row('  no lean (< 1.5)', tally(games.filter(g=>g.pen<1.5))));
  console.log('  '+'─'.repeat(70));
  console.log(`  ✅ = under rate clears the ${BREAKEVEN}% needed to profit at -110.\n`);
})();
