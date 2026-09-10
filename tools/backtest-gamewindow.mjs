#!/usr/bin/env node
/* =========================================================================
   UnderCast GAME-WINDOW backtest — does averaging weather over the ~3-hour
   game window sharpen the model vs. using only the kickoff hour?

   We run the SAME calibrated weather model two ways per game:
     • KICKOFF  — conditions at the kickoff hour (what the app uses today)
     • WINDOW   — mean conditions over kickoff..+3h (wind/temp/precip averaged,
                  gust = peak), so the model sees the whole game, not one hour
   …then compare the UNDER-flagged sets. Higher under% in the flagged bucket
   = the better input.

   Data: nflverse results + Open-Meteo archive. Runs in GitHub Actions. No key.
   Run:  node tools/backtest-gamewindow.mjs 2016-2024
   ========================================================================= */

const CSV_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const ARG = String(process.argv[2] || '2016-2024');
const [LO, HI] = ARG.includes('-') ? ARG.split('-').map(Number) : [ +ARG, +ARG ];
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

/* ---- calibrated model (identical to the app) ---- */
function windPenalty(w){ if(w<10)return 0; return Math.min((Math.min(w,20)-10)*0.18,1.8); }
function precipPenalty(type,intensity){ const t={rain:{light:0.8,moderate:1.8,heavy:2.8},snow:{light:0,moderate:0,heavy:0}};
  if(!type||type==='none'||!t[type])return 0; return t[type][intensity]||0; }
function coldPenalty(f){ if(f>=32)return 0; if(f>=20)return 0.3; if(f>=10)return 0.6; return 1.0; }
function heatPenalty(f){ if(f<=85)return 0; if(f<=92)return 0.5; return 1.0; }
function windChill(t,w){ if(t==null||t>50||w==null||w<3)return t; const v=Math.pow(w,0.16); return 35.74+0.6215*t-35.75*v+0.4275*t*v; }
const SNOW=[71,73,75,77,85,86], WET=[51,53,55,56,57,61,63,65,66,67,80,81,82,95,96,99];
function classify(codes, mm){ const snow=codes.some(c=>SNOW.includes(c));
  const wet=mm>0.1||codes.some(c=>WET.includes(c));
  if(snow) return {type:'snow',intensity:mm>2?'heavy':mm>0.6?'moderate':'light'};
  if(wet)  return {type:'rain',intensity:mm>4?'heavy':mm>1?'moderate':'light'};
  return {type:'none',intensity:'none'}; }
function penalty(wx){ const feels=Math.round(windChill(wx.temp,wx.wind));
  return +(windPenalty(wx.wind)+precipPenalty(wx.type,wx.intensity)+coldPenalty(feels)+heatPenalty(wx.temp)).toFixed(2); }

/* ---- utils ---- */
function parseCSV(text){ const rows=[]; let row=[],f='',q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if(c==='"') q=true; else if(c===','){ row.push(f); f=''; }
    else if(c==='\n'){ row.push(f); rows.push(row); row=[]; f=''; } else if(c!=='\r') f+=c; }
  if(f.length||row.length){ row.push(f); rows.push(row); }
  const h=rows.shift(); return rows.filter(r=>r.length>1).map(r=>{ const o={}; h.forEach((k,i)=>o[k]=r[i]); return o; }); }
const num=v=>(v==null||v===''||v==='NA')?null:(isNaN(+v)?null:+v);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;

async function archive(abbr){ const [lat,lon]=V[abbr]; const map={};
  for(let y=LO;y<=HI;y++){
    const u=`${ARCHIVE}?latitude=${lat}&longitude=${lon}&start_date=${y}-09-01&end_date=${y+1}-02-15`
      +`&hourly=temperature_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m`
      +`&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York`;
    let r,att=0;
    while(true){ r=await fetch(u); if(r.ok)break; if((r.status===429||r.status>=500)&&att<4){att++;await sleep(700*att);continue;} break; }
    if(!r.ok){ await sleep(300); continue; }
    const d=await r.json(),H=d.hourly||{};
    (H.time||[]).forEach((t,i)=>{ map[t.slice(0,13)]={temp:H.temperature_2m?.[i],mm:H.precipitation?.[i],
      code:H.weather_code?.[i],wind:H.wind_speed_10m?.[i],gust:H.wind_gusts_10m?.[i]}; });
    await sleep(350);
  } return map; }
function baseHour(gametime){ let hr=parseInt((gametime||'13:00').split(':')[0],10);
  const mn=parseInt((gametime||'13:00').split(':')[1]||'0',10); if(mn>=30)hr++; return Math.min(hr,23); }
function hourKey(gameday, baseHr, n){ const d=new Date(`${gameday}T00:00:00Z`); d.setUTCHours(baseHr+n);
  return `${d.toISOString().slice(0,10)}T${String(d.getUTCHours()).padStart(2,'0')}`; }

function tally(games,pKey){ let u=0,o=0,p=0;
  for(const g of games){ if(g.total<g.line)u++; else if(g.total>g.line)o++; else p++; }
  const dec=u+o; return {n:games.length,u,o,p,pct:dec?u/dec*100:0}; }
function row(label,t){ const flag=t.pct>=BREAKEVEN?'  ✅':'';
  return '  '+label.padEnd(34)+`${String(t.n).padStart(4)}  ${String(t.u).padStart(4)}-${String(t.o).padStart(4)}-${t.p}  ${t.pct.toFixed(1).padStart(5)}%${flag}`; }

(async()=>{
  process.stdout.write('results… ');
  const all=parseCSV(await (await fetch(CSV_URL)).text()); console.log('ok');
  const games=all.filter(r=>+r.season>=LO&&+r.season<=HI&&r.game_type==='REG'&&(r.roof==='outdoors'||r.roof==='open'))
    .map(r=>({home:CANON(r.home_team),gameday:r.gameday,gametime:r.gametime,total:num(r.total),line:num(r.total_line)}))
    .filter(g=>g.total!=null&&g.line!=null&&V[g.home]);
  const groups={}; for(const g of games){ (groups[g.home]||=[]).push(g); }
  const venues=Object.keys(groups); let done=0;
  console.log(`${games.length} outdoor games · ${venues.length} venues…`);
  for(const abbr of venues){ let map; try{ map=await archive(abbr); }catch(e){ console.error('  '+e.message); continue; }
    for(const g of groups[abbr]){ const bh=baseHour(g.gametime);
      const k=map[hourKey(g.gameday,bh,0)]; if(!k||k.wind==null) continue;
      g.kick=penalty({temp:k.temp,wind:Math.round(k.wind),...classify([k.code],k.mm||0)});
      const win=[0,1,2,3].map(n=>map[hourKey(g.gameday,bh,n)]).filter(h=>h&&h.wind!=null);
      if(win.length>=2){ const w={temp:Math.round(mean(win.map(h=>h.temp))), wind:Math.round(mean(win.map(h=>h.wind))),
        ...classify(win.map(h=>h.code), mean(win.map(h=>h.mm||0)))}; g.win=penalty(w); }
    }
    done++; if(done%8===0) process.stdout.write(`  …${done}/${venues.length}\n`);
  }
  const rows=games.filter(g=>g.kick!=null&&g.win!=null);
  console.log(`\n  UNDERCAST GAME-WINDOW BACKTEST — ${LO}–${HI} · ${rows.length} outdoor games`);
  console.log(`  same calibrated model, two inputs · break-even ${BREAKEVEN}%\n`);
  console.log('  set                                  n    U -  O -P   under%');
  console.log('  '+'─'.repeat(64));
  console.log('  —— model UNDER lean (penalty ≥ 1.5) ——');
  console.log(row('KICKOFF-hour flags', tally(rows.filter(g=>g.kick>=1.5))));
  console.log(row('GAME-WINDOW flags', tally(rows.filter(g=>g.win>=1.5))));
  console.log('  —— strong lean (penalty ≥ 2.5) ——');
  console.log(row('KICKOFF-hour', tally(rows.filter(g=>g.kick>=2.5))));
  console.log(row('GAME-WINDOW', tally(rows.filter(g=>g.win>=2.5))));
  console.log('  —— where they disagree ——');
  console.log(row('WINDOW flags, kickoff did NOT', tally(rows.filter(g=>g.win>=1.5&&g.kick<1.5))));
  console.log(row('KICKOFF flags, window did NOT', tally(rows.filter(g=>g.kick>=1.5&&g.win<1.5))));
  console.log('  '+'─'.repeat(64));
  console.log(`  Better input = higher under% on the flagged set (ideally with similar/larger n).\n`);
})();
