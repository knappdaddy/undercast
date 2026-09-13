#!/usr/bin/env node
/* =========================================================================
   UnderCast LIVE-WEATHER backtest — does weather WORSENING during the game
   predict the REST of the game (2nd half) going under?

   We price weather only at kickoff today. But wind that picks up, or rain that
   arrives, in the 2nd half physically suppresses scoring — and the live total
   reacts to the field, not the forecast, so it should lag. Test:

     1st-half weather  ≈ kickoff hour + next hour   (offsets 0,1)
     2nd-half weather  ≈ kickoff + 2h and + 3h      (offsets 2,3)

   Grade the REST of the game vs the market-implied remainder (same honest test
   as the live-under backtest):
       halfShare     = pooled 1st-half points ÷ final   (leaguewide)
       expected_rest = closing_line × (1 − halfShare)
       actual_rest   = final − 1st-half points
       REST-UNDER    = actual_rest < expected_rest

   Signals: wind picked up (Δ≥5, ≥8 mph), 2nd half windy (≥15,≥18), rain onset
   (dry 1H → wet 2H), and precip heavier in 2H.

   Data (free): nflverse games.csv + play-by-play + Open-Meteo archive. Actions.
   Run:  node tools/backtest-liveweather.mjs 2016-2024
   ========================================================================= */

import zlib from 'node:zlib';

const CSV_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const PBP = s => `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${s}.csv.gz`;
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
const SNOW=[71,73,75,77,85,86], WET=[51,53,55,56,57,61,63,65,66,67,80,81,82,95,96,99];
const isWet=(codes,mm)=> mm>0.1 || codes.some(c=>WET.includes(c));

// ---- halftime points from pbp (max cumulative score while game_seconds_remaining > 1800) ----
function halfPoints(text, out){
  const nl=text.indexOf('\n'); const H=text.slice(0,nl).split(',');
  const IG=H.indexOf('game_id'), IS=H.indexOf('game_seconds_remaining'),
        IHS=H.indexOf('total_home_score'), IAS=H.indexOf('total_away_score');
  const maxCol=Math.max(IG,IS,IHS,IAS);
  let field='',col=0,q=false,g='',s='',hs='',as='';
  const onField=()=>{ if(col===IG)g=field;else if(col===IS)s=field;else if(col===IHS)hs=field;else if(col===IAS)as=field; field='';col++; };
  const onRow=()=>{ onField(); const gsr=+s; if(g&&!isNaN(gsr)&&gsr>1800){ const pts=(+hs||0)+(+as||0);
      if(out[g]==null||pts>out[g]) out[g]=pts; } field='';col=0;g='';s='';hs='';as=''; };
  for(let i=nl+1;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){field+='"';i++;} else q=false; } else field+=c; }
    else if(c==='"')q=true; else if(c===',')onField();
    else if(c==='\n'){ if(col>=maxCol)onRow(); else {field='';col=0;g='';s='';hs='';as='';} } else if(c!=='\r')field+=c; }
  if(col>=maxCol)onRow();
}
async function seasonHalf(s, out){ const r=await fetch(PBP(s)); if(!r.ok)throw new Error(`pbp ${s} HTTP ${r.status}`);
  halfPoints(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'), out); }

// ---- Open-Meteo hourly archive per venue ----
async function archive(abbr){ const [lat,lon]=V[abbr]; const map={};
  for(let y=LO;y<=HI;y++){
    const u=`${ARCHIVE}?latitude=${lat}&longitude=${lon}&start_date=${y}-09-01&end_date=${y+1}-02-15`
      +`&hourly=precipitation,weather_code,wind_speed_10m&wind_speed_unit=mph&timezone=America%2FNew_York`;
    let r,att=0; while(true){ r=await fetch(u); if(r.ok)break; if((r.status===429||r.status>=500)&&att<4){att++;await sleep(700*att);continue;} break; }
    if(!r.ok){ await sleep(300); continue; }
    const d=await r.json(), Hh=d.hourly||{};
    (Hh.time||[]).forEach((t,i)=>{ map[t.slice(0,13)]={mm:Hh.precipitation?.[i], code:Hh.weather_code?.[i], wind:Hh.wind_speed_10m?.[i]}; });
    await sleep(350);
  } return map; }
function baseHour(gt){ let hr=parseInt((gt||'13:00').split(':')[0],10); const mn=parseInt((gt||'13:00').split(':')[1]||'0',10); if(mn>=30)hr++; return Math.min(hr,23); }
function hourKey(day, baseHr, n){ const d=new Date(`${day}T00:00:00Z`); d.setUTCHours(baseHr+n); return `${d.toISOString().slice(0,10)}T${String(d.getUTCHours()).padStart(2,'0')}`; }

function tally(items){ let u=0,o=0,p=0; for(const it of items){ if(it.push)p++; else if(it.restUnder)u++; else o++; }
  const d=u+o; return {n:items.length,u,o,pct:d?u/d*100:0}; }
function row(l,t){ const flag=t.n>=40&&t.pct>=BREAKEVEN?'  ✅':''; return '  '+l.padEnd(40)+`${String(t.n).padStart(5)}  ${t.pct.toFixed(1).padStart(5)}%  (${t.u}-${t.o})${flag}`; }

(async()=>{
  process.stdout.write('games.csv… ');
  const all=parseCSV(await (await fetch(CSV_URL)).text()); console.log('ok');
  const games=all.filter(r=>+r.season>=LO&&+r.season<=HI&&r.game_type==='REG'&&(r.roof==='outdoors'||r.roof==='open'))
    .map(r=>({id:r.game_id, home:CANON(r.home_team), gameday:r.gameday, gametime:r.gametime, total:num(r.total), line:num(r.total_line)}))
    .filter(g=>g.total!=null&&g.line!=null&&V[g.home]);

  process.stdout.write('pbp halftime… ');
  const half={}; for(let s=LO;s<=HI;s++){ await seasonHalf(s, half); } console.log('ok');

  const groups={}; for(const g of games){ (groups[g.home]||=[]).push(g); }
  const venues=Object.keys(groups); let done=0;
  console.log(`${games.length} outdoor games · ${venues.length} venues · weather…`);
  for(const abbr of venues){ let map; try{ map=await archive(abbr); }catch(e){ console.error('  '+e.message); continue; }
    for(const g of groups[abbr]){ const bh=baseHour(g.gametime);
      const h=n=>map[hourKey(g.gameday,bh,n)];
      const first=[h(0),h(1)].filter(x=>x&&x.wind!=null), second=[h(2),h(3)].filter(x=>x&&x.wind!=null);
      if(first.length<1||second.length<1) continue;
      g.w1=mean(first.map(x=>x.wind)); g.w2=mean(second.map(x=>x.wind));
      g.mm1=first.reduce((a,x)=>a+(x.mm||0),0); g.mm2=second.reduce((a,x)=>a+(x.mm||0),0);
      g.wet1=first.some(x=>isWet([x.code],x.mm||0)); g.wet2=second.some(x=>isWet([x.code],x.mm||0));
    }
    done++; if(done%8===0) process.stdout.write(`  …${done}/${venues.length}\n`);
  }

  const recs=games.filter(g=>g.w1!=null&&g.w2!=null&&half[g.id]!=null);
  const halfShare = recs.reduce((a,g)=>a+half[g.id],0) / recs.reduce((a,g)=>a+g.total,0);
  recs.forEach(g=>{ const hp=half[g.id]; const expRest=g.line*(1-halfShare), actRest=g.total-hp;
    g.restUnder=actRest<expRest; g.push=actRest===expRest; g.dWind=g.w2-g.w1; });

  console.log(`\n  UNDERCAST LIVE-WEATHER BACKTEST — ${LO}–${HI} · ${recs.length} outdoor games`);
  console.log(`  grading 2nd half vs market-implied remainder · halfShare ${(halfShare*100).toFixed(0)}% · break-even ${BREAKEVEN}%`);
  console.log(`  baseline 2nd-half under ${tally(recs).pct.toFixed(1)}%\n`);
  console.log('  signal                                       n   under%  (U-O)');
  console.log('  '+'─'.repeat(64));
  const sig=[
    ['wind picked up ≥5 mph (2H−1H)', g=>g.dWind>=5],
    ['wind picked up ≥8 mph',         g=>g.dWind>=8],
    ['2nd-half wind ≥15 mph',         g=>g.w2>=15],
    ['2nd-half wind ≥18 mph',         g=>g.w2>=18],
    ['rain onset (dry 1H → wet 2H)',  g=>!g.wet1&&g.wet2],
    ['2H rain heavier (mm2 > mm1+1)', g=>g.mm2>g.mm1+1],
    ['wind ≥5 up AND 2H ≥15',         g=>g.dWind>=5&&g.w2>=15],
    ['— reference: 2H wind ≥15 OR rain onset', g=>g.w2>=15||(!g.wet1&&g.wet2)],
  ];
  sig.map(([l,fn])=>({l,t:tally(recs.filter(fn))})).filter(x=>x.t.n>=25)
     .sort((a,b)=>b.t.pct-a.t.pct).forEach(s=>console.log(row(s.l,s.t)));
  console.log(`\n  A worsening-weather signal is real if 2nd-half under% > ${BREAKEVEN}% with meaningful n.`);
  console.log('  (Graded vs the implied remainder; mean-reversion works against it.)\n');
})();
