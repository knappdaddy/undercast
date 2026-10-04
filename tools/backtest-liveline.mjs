#!/usr/bin/env node
/* =========================================================================
   UnderCast LIVE-LINE backtest. Does the live under signal beat the REAL
   in-play total?

   The earlier live backtest (backtest-liveunder*.mjs) graded the rest of each
   game against a PROXY: the pregame close scaled down for time remaining.
   But a live bet is placed against the book's in-play total, which has already
   reacted to a slow first half. This test uses the actual in-play totals from
   The Odds API historical archive, captured during halftime and just after
   the end of Q3, and grades the final score against them.

     signal  : combined yards/play (and 3rd-down rate) through the checkpoint
               (nflverse play-by-play, known live, no lookahead)
     line    : median in-play total across US books, from a snapshot taken
               after the checkpoint, keeping only lines updated after it
     grade   : final total vs that line, under% vs the 52.38% break-even.
               ROI also uses the real under price, since live vig is often
               higher than -110.

   One archive snapshot (10 credits) covers every game in progress at that
   moment, so games are batched into the fewest snapshot times.

   Run:  node tools/backtest-liveline.mjs 2023-2025 dry     # plan + credit estimate, no API calls
         node tools/backtest-liveline.mjs 2023-2025 signal  # fetch only for games where a signal fired
         node tools/backtest-liveline.mjs 2023-2025 all     # every game (baseline too)
   ========================================================================= */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARG = String(process.argv[2] || '2023-2025');
const [LO, HI] = ARG.includes('-') ? ARG.split('-').map(Number) : [+ARG, +ARG];
const MODE = (process.argv[3] || 'dry').toLowerCase();
const CAP = +(process.argv[4] || 1200);                 // max snapshots (×10 credits)
const KEY = process.env.ODDS_API_KEY;
if(MODE!=='dry' && !KEY){ console.error('Missing ODDS_API_KEY'); process.exit(1); }
const BREAKEVEN = 52.38;
const CSV_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const PBP = s => `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${s}.csv.gz`;
const HIST = 'https://api.the-odds-api.com/v4/historical/sports/americanfootball_nfl/odds';
const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.livecache');
const PREF = ['draftkings','fanduel','betmgm','williamhill_us','betrivers','bovada','betonlineag','mybookieag','lowvig'];
const MIN = 60e3, SNAP = 5*MIN;
const CPS = [
  { key:'HALF', q:2, open: 1*MIN, close: 13*MIN },     // halftime break ≈ 13–15 min
  { key:'Q3',   q:3, open: 1*MIN, close: 10*MIN },     // early Q4 — line can only know MORE than our signal (conservative)
];
const FULL = {ARI:'Arizona Cardinals',ATL:'Atlanta Falcons',BAL:'Baltimore Ravens',BUF:'Buffalo Bills',
  CAR:'Carolina Panthers',CHI:'Chicago Bears',CIN:'Cincinnati Bengals',CLE:'Cleveland Browns',
  DAL:'Dallas Cowboys',DEN:'Denver Broncos',DET:'Detroit Lions',GB:'Green Bay Packers',
  HOU:'Houston Texans',IND:'Indianapolis Colts',JAX:'Jacksonville Jaguars',KC:'Kansas City Chiefs',
  LV:'Las Vegas Raiders',LAC:'Los Angeles Chargers',LA:'Los Angeles Rams',MIA:'Miami Dolphins',
  MIN:'Minnesota Vikings',NE:'New England Patriots',NO:'New Orleans Saints',NYG:'New York Giants',
  NYJ:'New York Jets',PHI:'Philadelphia Eagles',PIT:'Pittsburgh Steelers',SF:'San Francisco 49ers',
  SEA:'Seattle Seahawks',TB:'Tampa Bay Buccaneers',TEN:'Tennessee Titans',WAS:'Washington Commanders'};
const norm = s => (s||'').toLowerCase().replace(/[^a-z]/g,'');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const median = a => { const s=[...a].sort((x,y)=>x-y), m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };

function parseCSV(text){ const rows=[]; let row=[],f='',q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if(c==='"') q=true; else if(c===','){ row.push(f); f=''; }
    else if(c==='\n'){ row.push(f); rows.push(row); row=[]; f=''; } else if(c!=='\r') f+=c; }
  if(f.length||row.length){ row.push(f); rows.push(row); }
  const h=rows.shift(); return rows.filter(r=>r.length>1).map(r=>{ const o={}; h.forEach((k,i)=>o[k]=r[i]); return o; }); }

/* ---- play-by-play → per-game stats + wall-clock end of Q2 / Q3 ---- */
function aggregate(text, games){
  const nl=text.indexOf('\n'); const H=text.slice(0,nl).split(',').map(s=>s.replace(/"/g,''));
  const col = k => { const i=H.indexOf(k); if(i<0) throw new Error('pbp missing '+k); return i; };
  const I = { g:col('game_id'), q:col('qtr'), t:col('time_of_day'), pt:col('play_type'), y:col('yards_gained'),
    hs:col('total_home_score'), as:col('total_away_score'), tc:col('third_down_converted'), tf:col('third_down_failed') };
  const want = new Map(Object.entries(I).map(([k,i])=>[i,k])), maxCol=Math.max(...Object.values(I));
  let field='',c=0,q=false,rec={};
  const onField=()=>{ const k=want.get(c); if(k) rec[k]=field; field=''; c++; };
  const onRow=()=>{ onField();
    const gid=rec.g, qtr=+rec.q;
    if(gid && qtr>=1){
      const G = games[gid] || (games[gid]={ HALF:{plays:0,yds:0,tc:0,tf:0,pts:0,end:0}, Q3:{plays:0,yds:0,tc:0,tf:0,pts:0,end:0} });
      const pts=(+rec.hs||0)+(+rec.as||0), isPlay=rec.pt==='pass'||rec.pt==='run', t=rec.t?Date.parse(rec.t):NaN;
      for(const cp of CPS){ const b=G[cp.key];
        if(qtr<=cp.q){ if(isPlay){ b.plays++; b.yds+=(+rec.y||0); } if(rec.tc==='1') b.tc++; if(rec.tf==='1') b.tf++;
          if(pts>b.pts) b.pts=pts; }
        if(qtr===cp.q && !isNaN(t) && t>b.end) b.end=t; } }
    field=''; c=0; rec={}; };
  for(let i=nl+1;i<text.length;i++){ const ch=text[i];
    if(q){ if(ch==='"'){ if(text[i+1]==='"'){field+='"';i++;} else q=false; } else field+=ch; }
    else if(ch==='"') q=true; else if(ch===',') onField();
    else if(ch==='\n'){ if(c>=maxCol) onRow(); else { field=''; c=0; rec={}; } } else if(ch!=='\r') field+=ch; }
  if(c>=maxCol) onRow();
}

/* ---- archive snapshot (cached on disk; the workflow persists the cache) ---- */
let used=0, remaining=null;
async function snapshot(t){
  fs.mkdirSync(CACHE,{recursive:true});
  const iso=new Date(t).toISOString().slice(0,19)+'Z', f=path.join(CACHE, iso.replace(/:/g,'-')+'.json');
  if(fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8'));
  const url=`${HIST}/?apiKey=${encodeURIComponent(KEY)}&regions=us&markets=totals&oddsFormat=american&date=${encodeURIComponent(iso)}`;
  let r, n=0; while(true){ r=await fetch(url); if(r.ok || r.status<500 || n>=2) break; n++; await sleep(1500); }
  remaining = r.headers.get('x-requests-remaining') ?? remaining;
  if(!r.ok) throw new Error(`snapshot ${iso}: HTTP ${r.status} ${(await r.text()).slice(0,160)}`);
  const j=await r.json(); used++;
  const slim={ ts:j.timestamp, data:(j.data||[]).map(e=>({ home:e.home_team, away:e.away_team, kick:e.commence_time,
    books:(e.bookmakers||[]).map(b=>{ const m=(b.markets||[]).find(x=>x.key==='totals'); if(!m) return null;
      const o=m.outcomes.find(x=>x.name==='Over'), u=m.outcomes.find(x=>x.name==='Under');
      return o&&u ? { key:b.key, pt:+o.point, under:+u.price, over:+o.price, upd:m.last_update||b.last_update } : null; }).filter(Boolean) })) };
  fs.writeFileSync(f, JSON.stringify(slim)); await sleep(250);
  return slim;
}

const ypp = b => b.plays ? b.yds/b.plays : null;
const third = b => (b.tc+b.tf) ? b.tc/(b.tc+b.tf) : null;
const fired = b => { const y=ypp(b); return y!=null && (y<5.0 || (process.env.OVERS==='1' && y>6.5)); };   // under signal (+ the informational over if OVERS=1)

(async()=>{
  console.log(`LIVE-LINE backtest · seasons ${LO}-${HI} · mode ${MODE} · cap ${CAP} snapshots\n`);
  const meta={};
  for(const r of parseCSV(await (await fetch(CSV_URL)).text())){
    const s=+r.season; if(s<LO||s>HI||r.game_type!=='REG') continue;
    if(r.total===''||r.total==='NA') continue;
    meta[r.game_id]={ season:s, home:r.home_team, away:r.away_team, total:+r.total, close:+r.total_line };
  }
  const games={};
  for(let s=LO;s<=HI;s++){ process.stdout.write(`pbp ${s}… `); const r=await fetch(PBP(s));
    if(!r.ok) throw new Error(`pbp ${s} HTTP ${r.status}`);
    aggregate(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'), games); console.log('ok'); }

  // windows to capture
  const need=[];
  for(const gid in games){ const m=meta[gid]; if(!m) continue;
    for(const cp of CPS){ const b=games[gid][cp.key]; if(!b.end || !b.plays) continue;
      if((MODE==='signal'||process.env.PLAN==='signal') && !fired(b)) continue;
      // RULE narrows the fetch to one candidate, e.g. for an out-of-sample check:
      //   q3strong = end of Q3 with YPP<4.5 · halfover = halftime with YPP>6.5
      if(process.env.RULE==='q3strong' && !(cp.key==='Q3' && ypp(b)<4.5)) continue;
      if(process.env.RULE==='halfover' && !(cp.key==='HALF' && ypp(b)>6.5)) continue;
      need.push({ gid, cp:cp.key, start:b.end+cp.open, end:b.end+cp.close, cpEnd:b.end }); } }
  // Greedy cover, adaptive: request at the earliest uncovered window's end. The archive returns the
  // latest snapshot <= t, so the snapshot lands inside that window; it then covers every window
  // containing its actual timestamp. A dry run simulates the timestamp as t - 2.5 min.
  need.sort((a,b)=>a.end-b.end);
  const snaps=[]; const covered=new Array(need.length).fill(false); let planned=0;
  for(let i=0;i<need.length;i++){ if(covered[i]) continue;
    if(planned>=CAP){ console.log(`hit cap of ${CAP} snapshots — stopping early`); break; }
    const t=need[i].end; planned++;
    let ts=t-SNAP/2;
    if(MODE!=='dry'){ try{ const s=await snapshot(t); snaps.push(s); ts=Date.parse(s.ts); }catch(e){ console.log('  ', e.message); covered[i]=true; continue; } }
    for(let j=i;j<need.length && need[j].start<=ts+SNAP*3;j++) if(need[j].start<=ts && need[j].end>=ts) covered[j]=true;
    covered[i]=true;
    if(MODE!=='dry' && planned%100===0) console.log(`  … ${planned} snapshots (${used} new) · credits remaining ${remaining ?? '?'}`); }
  console.log(`\nwindows: ${need.length} · snapshots ${MODE==='dry'?'planned':'used'}: ${planned} · ${MODE==='dry'?'est. ':''}credits: ${MODE==='dry'?planned*10:used*10}`);
  if(MODE==='dry') return;
  console.log(`credits remaining ${remaining ?? '?'}\n`);

  const rows=[]; let stale=0, nomatch=0;
  for(const cp of CPS){
    for(const gid in games){ const m=meta[gid]; if(!m) continue; const b=games[gid][cp.key]; if(!b.end||!b.plays) continue;
      const start=b.end+cp.open, end=b.end+cp.close;
      let best=null;
      for(const s of snaps){ const ts=Date.parse(s.ts); if(ts<start||ts>end) continue;
        const ev=s.data.find(e=>norm(e.home)===norm(FULL[m.home]) && norm(e.away)===norm(FULL[m.away])); if(!ev) continue;
        const fresh=ev.books.filter(x=>Date.parse(x.upd)>=b.end);    // line set after the checkpoint
        if(fresh.length && (!best || ts<best.ts)) best={ts, fresh}; }
      if(!best){ const any=snaps.some(s=>{ const ts=Date.parse(s.ts); return ts>=start&&ts<=end; });
        if(any) stale++; else nomatch++; continue; }
      const line=median(best.fresh.map(x=>x.pt));
      const pb=PREF.map(k=>best.fresh.find(x=>x.key===k)).find(Boolean) || best.fresh[0];
      rows.push({ gid, cp:cp.key, season:m.season, ypp:ypp(b), third:third(b), pts:b.pts, line, total:m.total, close:m.close,
        bookPt:pb.pt, price:pb.under, oprice:pb.over });
    }
  }
  console.log(`graded rows: ${rows.length} · skipped: ${stale} no fresh line · ${nomatch} not in any snapshot\n`);

  const tally=(rs, side='under')=>{ let w=0,l=0,p=0,roi=0,roiN=0,diff=0,vig=0;
    for(const r of rs){ diff+=r.total-r.line; vig+=r.price;
      if(r.total===r.line) p++; else if((r.total<r.line)===(side==='under')) w++; else l++;
      const pr = side==='under' ? r.price : r.oprice;            // over prices only in newer cached snapshots
      if(pr!=null && !isNaN(pr) && r.total!==r.bookPt){ roiN++;
        const won = side==='under' ? r.total<r.bookPt : r.total>r.bookPt;
        roi += won ? (pr>0?pr/100:100/-pr) : -1; } }
    const d=w+l; return { n:rs.length, w, l, p, pct:d?w/d*100:0, roi:roiN?roi/roiN*100:null, diff:rs.length?diff/rs.length:0, vig:rs.length?vig/rs.length:0 }; };
  const fmt=(label,t,side='under')=>'  '+label.padEnd(28)+`${String(t.n).padStart(4)}  ${String(t.w).padStart(3)}-${String(t.l).padStart(3)}-${t.p}  `
    +`${t.pct.toFixed(1).padStart(5)}% ${side.padEnd(5)}`
    +`  ROI ${t.roi==null?'  —  ':((t.roi>=0?'+':'')+t.roi.toFixed(1)+'%').padStart(6)}`
    +`  final−line ${(t.diff>=0?'+':'')+t.diff.toFixed(1)}`+(t.n>=30&&t.pct>=BREAKEVEN?'  ✅':'');
  const RULES=[
    ['All captured games',          r=>true],
    ['YPP < 4.5',                   r=>r.ypp<4.5],
    ['YPP 4.5–5.0',                 r=>r.ypp>=4.5&&r.ypp<5.0],
    ['YPP < 5.0  (app UNDER)',      r=>r.ypp<5.0],
    ['YPP<5.0 & 3rd<40%',           r=>r.ypp<5.0&&r.third!=null&&r.third<0.40],
    ['YPP 5.0–6.5 (no signal)',     r=>r.ypp>=5.0&&r.ypp<=6.5],
  ];
  for(const cp of CPS){ const rs=rows.filter(r=>r.cp===cp.key);
    console.log(`══ ${cp.key==='HALF'?'HALFTIME':'END OF Q3'} · graded vs real in-play total (break-even ${BREAKEVEN}% at -110) ══`);
    console.log('  rule                           n   W-L-P     win%   side    ROI    final−line');
    for(const [l,fn] of RULES) console.log(fmt(l, tally(rs.filter(fn))));
    for(const cut of [6.0, 6.5, 7.0]) console.log(fmt(`OVER · YPP > ${cut.toFixed(1)}`, tally(rs.filter(r=>r.ypp>cut),'over'),'over'));
    for(let s=LO;s<=HI;s++){ const t=tally(rs.filter(r=>r.season===s&&r.ypp>6.5),'over'); if(t.n) console.log(fmt(`  OVER YPP>6.5 · ${s}`, t,'over')); }
    for(const cut of [4.5, 5.0]) for(let s=LO;s<=HI;s++){ const t=tally(rs.filter(r=>r.season===s&&r.ypp<cut)); if(t.n) console.log(fmt(`  YPP<${cut.toFixed(1)} · ${s}`, t)); }
    console.log('');
  }
  console.log('Also: how far had the live line already dropped below the pregame close when the app said UNDER?');
  for(const cp of CPS){ const rs=rows.filter(r=>r.cp===cp.key && r.ypp<5.0); if(!rs.length) continue;
    const drop=rs.reduce((a,r)=>a+(r.close-r.line),0)/rs.length;
    console.log(`  ${cp.key.padEnd(5)} YPP<5.0: live total averaged ${drop.toFixed(1)} pts below the pregame close (n=${rs.length})`); }
})();
