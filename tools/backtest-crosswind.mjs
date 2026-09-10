#!/usr/bin/env node
/* =========================================================================
   UnderCast CROSSWIND backtest — does wind DIRECTION add signal beyond speed?
   A crosswind (perpendicular to the field's long axis) hurts kicking and deep
   passing more than a wind blowing goal-to-goal.

   v2: field azimuths computed from real OpenStreetMap pitch geometry (PCA on
   the field polygon), with hand estimates only as fallback; Open-Meteo archive
   chunked per season with retry/backoff so no venue rate-limits out.

   Data: nflverse results + OSM field geometry + Open-Meteo archive (wind
   speed + direction). Runs in GitHub Actions. No key.

   Run:  node tools/backtest-crosswind.mjs 2016-2024 10
   ========================================================================= */

const CSV_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const ARG = String(process.argv[2] || '2016-2024');
const [LO, HI] = ARG.includes('-') ? ARG.split('-').map(Number) : [ +ARG, +ARG ];
const WINDY = +(process.argv[3] || 10);
const BREAKEVEN = 52.38;
const CANON = s => ({OAK:'LV',SD:'LAC',STL:'LAR',LA:'LAR'}[s]||s);

const V = {
  ARI:[33.5277,-112.2626], ATL:[33.7554,-84.4008], BAL:[39.2780,-76.6227], BUF:[42.7738,-78.7870],
  CAR:[35.2258,-80.8528], CHI:[41.8623,-87.6167], CIN:[39.0954,-84.5160], CLE:[41.5061,-81.6995],
  DAL:[32.7473,-97.0945], DEN:[39.7439,-105.0201], GB:[44.5013,-88.0622], HOU:[29.6847,-95.4107],
  IND:[39.7601,-86.1639], JAX:[30.3239,-81.6373], KC:[39.0489,-94.4839], MIA:[25.9580,-80.2389],
  NE:[42.0909,-71.2643], NYG:[40.8135,-74.0745], NYJ:[40.8135,-74.0745], PHI:[39.9008,-75.1675],
  PIT:[40.4468,-80.0158], SF:[37.4030,-121.9698], SEA:[47.5952,-122.3316], TB:[27.9759,-82.5033],
  TEN:[36.1665,-86.7713], WAS:[38.9077,-76.8645]
};
const FIELD_EST = { ARI:100,ATL:150,BAL:165,BUF:16,CAR:30,CHI:0,CIN:150,CLE:0,DAL:130,DEN:10,
  GB:160,HOU:130,IND:0,JAX:70,KC:10,MIA:130,NE:0,NYG:40,NYJ:40,PHI:30,PIT:140,SF:150,SEA:0,TB:130,TEN:30,WAS:0 };

function parseCSV(text){ const rows=[]; let row=[],f='',q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if(c==='"') q=true; else if(c===','){ row.push(f); f=''; }
    else if(c==='\n'){ row.push(f); rows.push(row); row=[]; f=''; } else if(c!=='\r') f+=c; }
  if(f.length||row.length){ row.push(f); rows.push(row); }
  const h=rows.shift(); return rows.filter(r=>r.length>1).map(r=>{ const o={}; h.forEach((k,i)=>o[k]=r[i]); return o; }); }
const num = v => (v==null||v===''||v==='NA')?null:(isNaN(+v)?null:+v);
const sleep = ms => new Promise(r=>setTimeout(r,ms));

/* ---- field azimuth from OSM pitch polygon (PCA principal axis) ---- */
function pcaBearing(pts, lat0){
  const clat=Math.cos(lat0*Math.PI/180);
  const xs=pts.map(p=>p[1]*111320*clat), ys=pts.map(p=>p[0]*110540);
  const mx=xs.reduce((a,b)=>a+b,0)/xs.length, my=ys.reduce((a,b)=>a+b,0)/ys.length;
  let sxx=0,syy=0,sxy=0; for(let i=0;i<xs.length;i++){ const dx=xs[i]-mx,dy=ys[i]-my; sxx+=dx*dx; syy+=dy*dy; sxy+=dx*dy; }
  const theta=0.5*Math.atan2(2*sxy, sxx-syy);
  let brg=Math.atan2(Math.cos(theta),Math.sin(theta))*180/Math.PI; return Math.round(((brg%180)+180)%180);
}
function bboxDiag(pts, lat0){ const clat=Math.cos(lat0*Math.PI/180);
  const xs=pts.map(p=>p[1]*111320*clat), ys=pts.map(p=>p[0]*110540);
  return Math.hypot(Math.max(...xs)-Math.min(...xs), Math.max(...ys)-Math.min(...ys)); }
let OSM_ERR='';
async function overpass(q){
  for(let att=0; att<4; att++){
    const r=await fetch(OVERPASS,{method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded',
      'User-Agent':'UnderCast-research/1.0 (nfl weather backtest; contact via github)'}, body:'data='+encodeURIComponent(q)});
    if(r.ok) return r.json();
    OSM_ERR=`HTTP ${r.status}`;
    if(r.status===429||r.status>=500){ await sleep(1500*(att+1)); continue; }
    throw new Error('overpass '+r.status);
  }
  throw new Error('overpass retries exhausted '+OSM_ERR);
}
async function osmAzimuth(lat,lon){
  const tryQ = async filt => { const d=await overpass(`[out:json][timeout:25];way(around:230,${lat},${lon})${filt};out geom;`);
    return (d.elements||[]).filter(e=>e.geometry&&e.geometry.length>=4); };
  let ways=[]; try{ ways=await tryQ('[leisure=pitch][sport=american_football]'); }catch(e){}
  if(!ways.length){ try{ ways=await tryQ('[leisure=pitch]'); }catch(e){} }
  if(!ways.length) return null;
  let best=null,bs=-1; for(const w of ways){ const pts=w.geometry.map(g=>[g.lat,g.lon]); const s=bboxDiag(pts,lat);
    if(s>60 && s<200 && s>bs){ bs=s; best=w; } }  // a football field's diagonal ~110-130m
  if(!best){ for(const w of ways){ const pts=w.geometry.map(g=>[g.lat,g.lon]); const s=bboxDiag(pts,lat); if(s>bs){bs=s;best=w;} } }
  return best ? pcaBearing(best.geometry.map(g=>[g.lat,g.lon]), lat) : null;
}

/* ---- Open-Meteo archive, chunked per season with retry ---- */
async function archive(abbr){
  const [lat,lon]=V[abbr]; const map={};
  for(let y=LO;y<=HI;y++){
    const u=`${ARCHIVE}?latitude=${lat}&longitude=${lon}&start_date=${y}-09-01&end_date=${y+1}-02-15`
      +`&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=mph&timezone=America%2FNew_York`;
    let r,att=0;
    while(true){ r=await fetch(u); if(r.ok) break; if((r.status===429||r.status>=500)&&att<4){ att++; await sleep(700*att); continue; } break; }
    if(!r.ok){ await sleep(300); continue; }
    const d=await r.json(); const H=d.hourly||{};
    (H.time||[]).forEach((t,i)=>{ map[t.slice(0,13)]={s:H.wind_speed_10m?.[i],dir:H.wind_direction_10m?.[i]}; });
    await sleep(350);
  }
  return map;
}
function kickKey(gameday, gametime){ let hr=parseInt((gametime||'13:00').split(':')[0],10);
  const mn=parseInt((gametime||'13:00').split(':')[1]||'0',10); if(mn>=30)hr++; if(hr>23)hr=23;
  return `${gameday}T${String(hr).padStart(2,'0')}`; }
function decompose(speed, windDir, fieldAz){ if(speed==null||windDir==null||fieldAz==null) return null;
  let d=Math.abs((((windDir-fieldAz)%180)+180)%180); if(d>90)d=180-d; const r=d*Math.PI/180;
  return { cross:+(speed*Math.sin(r)).toFixed(1), along:+(speed*Math.cos(r)).toFixed(1) }; }

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

  // 1) accurate field azimuths from OSM (fallback to estimates)
  console.log('field azimuths (OSM pitch geometry):');
  const AZ={}; let osmN=0;
  for(const abbr of Object.keys(V)){
    let az=null; try{ az=await osmAzimuth(...V[abbr]); }catch(e){}
    if(az!=null){ AZ[abbr]=az; osmN++; } else AZ[abbr]=FIELD_EST[abbr];
    const est=FIELD_EST[abbr], diff=az!=null?Math.min(Math.abs(az-est),180-Math.abs(az-est)):null;
    console.log(`  ${abbr.padEnd(4)} ${az!=null?String(az).padStart(3)+'° (osm)':' —  (est '+est+'°)'}${diff!=null?`  Δest ${diff}°`:''}`);
    await sleep(500);
  }
  console.log(`  → ${osmN}/${Object.keys(V).length} venues from OSM${osmN===0&&OSM_ERR?` (overpass said: ${OSM_ERR})`:''}\n`);

  // 2) games + weather
  const games=all.filter(r=>+r.season>=LO && +r.season<=HI && r.game_type==='REG' && (r.roof==='outdoors'||r.roof==='open'))
    .map(r=>({ home:CANON(r.home_team), gameday:r.gameday, gametime:r.gametime, total:num(r.total), line:num(r.total_line) }))
    .filter(g=>g.total!=null && g.line!=null && V[g.home] && AZ[g.home]!=null);
  const groups={}; for(const g of games){ (groups[g.home] ||= []).push(g); }
  const venues=Object.keys(groups); let done=0;
  console.log(`${games.length} outdoor games · fetching wind for ${venues.length} venues…`);
  for(const abbr of venues){
    let map; try{ map=await archive(abbr); }catch(e){ console.error('  '+e.message); continue; }
    for(const g of groups[abbr]){ const h=map[kickKey(g.gameday,g.gametime)]; if(!h||h.s==null) continue;
      g.wind=Math.round(h.s); const dc=decompose(h.s,h.dir,AZ[g.home]); if(dc){ g.cross=dc.cross; g.along=dc.along; } }
    done++; if(done%8===0) process.stdout.write(`  …${done}/${venues.length} venues\n`);
  }

  const wx=games.filter(g=>g.wind!=null && g.cross!=null);
  const windy=wx.filter(g=>g.wind>=WINDY); const base=tally(windy).pct;
  console.log(`\n  UNDERCAST CROSSWIND BACKTEST v2 — ${LO}–${HI} · outdoor · wind ≥ ${WINDY} mph`);
  console.log(`  ${windy.length} windy games · windy baseline under ${base.toFixed(1)}% · break-even ${BREAKEVEN}%\n`);
  console.log('  bucket                          n    U -  O -P   under%  avgΔ         vs windy');
  console.log('  '+'─'.repeat(80));
  console.log(line('ALL windy (baseline)', tally(windy), null));
  console.log('  —— same wind, split by direction ——');
  console.log(line('High crosswind (cross ≥ 8)', tally(windy.filter(g=>g.cross>=8)), base));
  console.log(line('Mid crosswind (5–8)', tally(windy.filter(g=>g.cross>=5&&g.cross<8)), base));
  console.log(line('Low crosswind (along-field)', tally(windy.filter(g=>g.cross<5)), base));
  console.log(line('High along-wind (along ≥ 8)', tally(windy.filter(g=>g.along>=8)), base));
  const strong=wx.filter(g=>g.wind>=15); const sb=tally(strong).pct;
  console.log(`  —— strong wind ≥15 (base ${sb.toFixed(0)}%) ——`);
  console.log(line('  crosswind ≥ 10', tally(strong.filter(g=>g.cross>=10)), sb));
  console.log(line('  along-dominant (cross<8)', tally(strong.filter(g=>g.cross<8)), sb));
  console.log('  '+'─'.repeat(80));
  console.log(`  ✅ = under rate ≥ ${BREAKEVEN}%. Signal = high-crosswind under% > along-wind at same speed.\n`);
})();
