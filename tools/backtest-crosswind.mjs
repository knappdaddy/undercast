#!/usr/bin/env node
/* =========================================================================
   UnderCast CROSSWIND backtest (EXPLORATORY) — does wind DIRECTION matter
   beyond wind speed? A crosswind (perpendicular to the field's long axis)
   wrecks kicking and deep passing more than a wind blowing goal-to-goal.

   For windy outdoor games we split the SAME wind speed into its crosswind
   and along-field components using each stadium's field azimuth, then ask:
   at similar speed, do high-crosswind games go under harder?

   Data: nflverse results + Open-Meteo archive (wind speed + DIRECTION).
   Runs in GitHub Actions (Open-Meteo archive is reachable there). No key.

   ⚠️ FIELD_AZ values are APPROXIMATE best-effort field-long-axis bearings.
      Treat any signal here as a hypothesis to confirm with precise geometry,
      not a validated edge.

   Run:  node tools/backtest-crosswind.mjs 2016-2024
   ========================================================================= */

const CSV_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const ARG = String(process.argv[2] || '2016-2024');
const [LO, HI] = ARG.includes('-') ? ARG.split('-').map(Number) : [ +ARG, +ARG ];
const WINDY = +(process.argv[3] || 10);          // min sustained mph to count a game as "windy"
const BREAKEVEN = 52.38;
const CANON = s => ({OAK:'LV',SD:'LAC',STL:'LAR',LA:'LAR'}[s]||s);

// venue coords (nflverse abbr) — outdoor & retractable venues we might see open
const V = {
  ARI:[33.5277,-112.2626], ATL:[33.7554,-84.4008], BAL:[39.2780,-76.6227], BUF:[42.7738,-78.7870],
  CAR:[35.2258,-80.8528], CHI:[41.8623,-87.6167], CIN:[39.0954,-84.5160], CLE:[41.5061,-81.6995],
  DAL:[32.7473,-97.0945], DEN:[39.7439,-105.0201], GB:[44.5013,-88.0622], HOU:[29.6847,-95.4107],
  IND:[39.7601,-86.1639], JAX:[30.3239,-81.6373], KC:[39.0489,-94.4839], MIA:[25.9580,-80.2389],
  NE:[42.0909,-71.2643], NYG:[40.8135,-74.0745], NYJ:[40.8135,-74.0745], PHI:[39.9008,-75.1675],
  PIT:[40.4468,-80.0158], SF:[37.4030,-121.9698], SEA:[47.5952,-122.3316], TB:[27.9759,-82.5033],
  TEN:[36.1665,-86.7713], WAS:[38.9077,-76.8645]
};
// APPROXIMATE field long-axis bearing (degrees, 0..180). ⚠️ best-effort, not surveyed.
const FIELD_AZ = {
  ARI:100, ATL:150, BAL:165, BUF:16, CAR:30, CHI:0, CIN:150, CLE:0, DAL:130, DEN:10,
  GB:160, HOU:130, IND:0, JAX:70, KC:10, MIA:130, NE:0, NYG:40, NYJ:40, PHI:30,
  PIT:140, SF:150, SEA:0, TB:130, TEN:30, WAS:0
};

function parseCSV(text){ const rows=[]; let row=[],f='',q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if(c==='"') q=true; else if(c===','){ row.push(f); f=''; }
    else if(c==='\n'){ row.push(f); rows.push(row); row=[]; f=''; } else if(c!=='\r') f+=c; }
  if(f.length||row.length){ row.push(f); rows.push(row); }
  const h=rows.shift(); return rows.filter(r=>r.length>1).map(r=>{ const o={}; h.forEach((k,i)=>o[k]=r[i]); return o; }); }
const num = v => (v==null||v===''||v==='NA')?null:(isNaN(+v)?null:+v);
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// crosswind component given wind FROM-direction and field axis bearing
function decompose(speed, windDir, fieldAz){
  if(speed==null||windDir==null||fieldAz==null) return null;
  let d = Math.abs((((windDir - fieldAz) % 180) + 180) % 180); if(d>90) d = 180-d;   // acute angle between lines
  const r = d*Math.PI/180;
  return { cross:+(speed*Math.sin(r)).toFixed(1), along:+(speed*Math.cos(r)).toFixed(1), angle:Math.round(d) };
}

async function archive(abbr, y0, y1){
  const [lat,lon]=V[abbr];
  const u=`${ARCHIVE}?latitude=${lat}&longitude=${lon}&start_date=${y0}-09-01&end_date=${y1}-02-15`
    +`&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=mph&timezone=America%2FNew_York`;
  const r=await fetch(u); if(!r.ok) throw new Error(`archive ${abbr}: HTTP ${r.status}`);
  const d=await r.json(); const H=d.hourly||{}, map={};
  (H.time||[]).forEach((t,i)=>{ map[t.slice(0,13)]={s:H.wind_speed_10m?.[i], dir:H.wind_direction_10m?.[i]}; });
  await sleep(200); return map;
}
function kickKey(gameday, gametime){ let hr=parseInt((gametime||'13:00').split(':')[0],10);
  const mn=parseInt((gametime||'13:00').split(':')[1]||'0',10); if(mn>=30)hr++; if(hr>23)hr=23;
  return `${gameday}T${String(hr).padStart(2,'0')}`; }

function tally(games){ let u=0,o=0,p=0,ds=0;
  for(const g of games){ if(g.total<g.line)u++; else if(g.total>g.line)o++; else p++; ds+=g.total-g.line; }
  const dec=u+o; return {n:games.length,u,o,p,pct:dec?u/dec*100:0,avg:games.length?ds/games.length:0}; }
function line(label,t,base){ const flag=t.pct>=BREAKEVEN?'  ✅':(t.pct<=100-BREAKEVEN&&t.n>30?'  ⤴over':'');
  const vs=base!=null?`${(t.pct-base>=0?'+':'')+(t.pct-base).toFixed(1)} vs windy`:'';
  return '  '+label.padEnd(30)+`${String(t.n).padStart(4)}  ${String(t.u).padStart(4)}-${String(t.o).padStart(4)}-${t.p}  `
    +`${t.pct.toFixed(1).padStart(5)}%  ${(t.avg>=0?'+':'')+t.avg.toFixed(1)}  ${vs.padStart(13)}${flag}`; }

(async()=>{
  process.stdout.write('results… ');
  const all=parseCSV(await (await fetch(CSV_URL)).text()); console.log('ok');
  const games=all.filter(r=>+r.season>=LO && +r.season<=HI && r.game_type==='REG' && (r.roof==='outdoors'||r.roof==='open'))
    .map(r=>({ home:CANON(r.home_team), gameday:r.gameday, gametime:r.gametime, total:num(r.total), line:num(r.total_line) }))
    .filter(g=>g.total!=null && g.line!=null && V[g.home] && FIELD_AZ[g.home]!=null);

  const groups={}; for(const g of games){ (groups[g.home] ||= []).push(g); }   // one archive call per venue (full range)
  const venues=Object.keys(groups); let done=0;
  console.log(`${games.length} outdoor games · ${venues.length} venues to fetch`);
  for(const abbr of venues){
    let map; try{ map=await archive(abbr, LO, HI); }catch(e){ console.error('  '+e.message); continue; }
    for(const g of groups[abbr]){ const key=kickKey(g.gameday, g.gametime);   // archive is ET-keyed
      const h=map[key]; if(!h||h.s==null) continue;
      g.wind=Math.round(h.s); const dc=decompose(h.s, h.dir, FIELD_AZ[g.home]);
      if(dc){ g.cross=dc.cross; g.along=dc.along; g.angle=dc.angle; } }
    done++; if(done%8===0) process.stdout.write(`  …${done}/${venues.length} venues\n`);
  }

  const wx=games.filter(g=>g.wind!=null && g.cross!=null);
  const windy=wx.filter(g=>g.wind>=WINDY);
  const base=tally(windy).pct;
  console.log(`\n  UNDERCAST CROSSWIND BACKTEST — ${LO}–${HI} · outdoor · wind ≥ ${WINDY} mph`);
  console.log(`  ⚠️ field azimuths APPROXIMATE · ${windy.length} windy games · windy baseline under ${base.toFixed(1)}%\n`);
  console.log('  bucket                          n    U -  O -P   under%  avgΔ         vs windy');
  console.log('  '+'─'.repeat(80));
  console.log(line('ALL windy (baseline)', tally(windy), null));
  console.log('  —— split same wind into components ——');
  console.log(line('High crosswind (cross ≥ 8)', tally(windy.filter(g=>g.cross>=8)), base));
  console.log(line('Mid crosswind (5–8)', tally(windy.filter(g=>g.cross>=5&&g.cross<8)), base));
  console.log(line('Low crosswind (along-field)', tally(windy.filter(g=>g.cross<5)), base));
  console.log(line('High along-wind (along ≥ 8)', tally(windy.filter(g=>g.along>=8)), base));
  console.log('  —— strong wind only (≥ 15) ——');
  const strong=wx.filter(g=>g.wind>=15); const sb=tally(strong).pct;
  console.log(line(`ALL wind ≥15 (base ${sb.toFixed(0)}%)`, tally(strong), null));
  console.log(line('  ≥15 & crosswind ≥ 10', tally(strong.filter(g=>g.cross>=10)), sb));
  console.log(line('  ≥15 & along-dominant', tally(strong.filter(g=>g.cross<8)), sb));
  console.log('  '+'─'.repeat(80));
  console.log(`  ✅ = under rate ≥ ${BREAKEVEN}%. If crosswind matters, high-cross > along at the same speed.`);
  console.log(`  ⚠️ azimuths are approximate — exploratory only.\n`);
})();
