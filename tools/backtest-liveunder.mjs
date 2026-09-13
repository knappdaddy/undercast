#!/usr/bin/env node
/* =========================================================================
   UnderCast LIVE-UNDER backtest — which in-game stats, known at the end of
   Q1 / halftime / Q3, predict the REST of the game staying low-scoring?

   HONEST TEST (this is the important part):
   We do NOT grade the full-game final against the closing line — that hands
   any early-under a free hindsight win (a 0-0 first half "predicts" an under
   trivially). Instead we grade the REST of the game against the market's
   implied remaining points:

       share(cp)     = pooled points scored by checkpoint ÷ final   (leaguewide)
       expected_rest = closing_line × (1 − share(cp))               (market's fair remainder)
       actual_rest   = final_total − points_at_checkpoint
       REST-UNDER    = actual_rest < expected_rest

   A live under bet is essentially betting actual_rest < the live line, and the
   live line ≈ points_so_far + expected_rest. Mean-reversion pulls a low-scoring
   first half's remainder back UP, which works AGAINST a low-scoring signal — so
   any signal that still clears break-even here is real, not hindsight.

   Signals tested at each checkpoint (all known live, no lookahead):
     • pace     — points/scoring-share projects a full total under the line
     • ppd      — low points per drive so far
     • ypp      — low yards per play so far
     • third    — low 3rd-down conversion so far
     • combos   — pace AND (a low-efficiency signal)

   Data (free): nflverse games.csv + play-by-play releases. Runs in Actions.
   Run:  node tools/backtest-liveunder.mjs 2016-2024
   ========================================================================= */

import zlib from 'node:zlib';

const CSV_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const PBP = s => `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${s}.csv.gz`;
const ARG = String(process.argv[2] || '2016-2024');
const [LO, HI] = ARG.includes('-') ? ARG.split('-').map(Number) : [ +ARG, +ARG ];
const BREAKEVEN = 52.38;

function parseCSV(text){ const rows=[]; let row=[],f='',q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if(c==='"') q=true; else if(c===','){ row.push(f); f=''; }
    else if(c==='\n'){ row.push(f); rows.push(row); row=[]; f=''; } else if(c!=='\r') f+=c; }
  if(f.length||row.length){ row.push(f); rows.push(row); }
  const h=rows.shift(); return rows.filter(r=>r.length>1).map(r=>{ const o={}; h.forEach((k,i)=>o[k]=r[i]); return o; }); }
const num = v => (v==null||v===''||v==='NA')?null:(isNaN(+v)?null:+v);

// Checkpoints by game_seconds_remaining (regulation = 3600s).
const CPS = [ {key:'Q1', gsr:2700}, {key:'HALF', gsr:1800}, {key:'Q3', gsr:900} ];

// Stream one season's pbp, building per-game cumulative stats at each checkpoint.
function aggregate(text, games){
  const nl = text.indexOf('\n');
  const H = text.slice(0,nl).split(',');
  const IG=H.indexOf('game_id'), IS=H.indexOf('game_seconds_remaining'),
        IHS=H.indexOf('total_home_score'), IAS=H.indexOf('total_away_score'),
        IPT=H.indexOf('play_type'), IY=H.indexOf('yards_gained'),
        ITC=H.indexOf('third_down_converted'), ITF=H.indexOf('third_down_failed'),
        ID=H.indexOf('drive');
  const need = [IG,IS,IHS,IAS,IPT,IY,ITC,ITF,ID];
  const maxCol = Math.max(...need);
  let field='', col=0, q=false, rec={};
  const blank = () => ({});
  const onField = () => {
    if(col===IG)rec.g=field; else if(col===IS)rec.s=field; else if(col===IHS)rec.hs=field;
    else if(col===IAS)rec.as=field; else if(col===IPT)rec.pt=field; else if(col===IY)rec.y=field;
    else if(col===ITC)rec.tc=field; else if(col===ITF)rec.tf=field; else if(col===ID)rec.d=field;
    field=''; col++;
  };
  const bucket = () => ({pts:0,plays:0,yds:0,tc:0,tf:0,drives:new Set()});
  const onRow = () => {
    onField();
    const gid=rec.g, gsr=+rec.s;
    if(gid && !isNaN(gsr)){
      let G=games[gid]; if(!G){ G=games[gid]={Q1:bucket(),HALF:bucket(),Q3:bucket()}; }
      const pts=(+rec.hs||0)+(+rec.as||0);
      const isPlay = rec.pt==='pass'||rec.pt==='run';
      const yd = isPlay ? (+rec.y||0) : 0;
      const conv = rec.tc==='1'?1:0, fail = rec.tf==='1'?1:0;
      const dnum = rec.d;
      for(const cp of CPS){ if(gsr>cp.gsr){ const b=G[cp.key];
        if(pts>b.pts)b.pts=pts;                       // cumulative score at boundary
        if(isPlay){ b.plays++; b.yds+=yd; }
        b.tc+=conv; b.tf+=fail;
        if(dnum) b.drives.add(dnum);
      } }
    }
    field=''; col=0; rec={};
  };
  for(let i=nl+1;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){field+='"';i++;} else q=false; } else field+=c; }
    else if(c==='"') q=true; else if(c===',') onField();
    else if(c==='\n'){ if(col>=maxCol) onRow(); else { field='';col=0;rec={}; } }
    else if(c!=='\r') field+=c; }
  if(col>=maxCol) onRow();
}

async function seasonPBP(s, games){
  const r = await fetch(PBP(s)); if(!r.ok) throw new Error(`pbp ${s}: HTTP ${r.status}`);
  const csv = zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8');
  aggregate(csv, games);
}

// ---- stat helpers per (game, checkpoint) ----
const ypp   = b => b.plays ? b.yds/b.plays : null;
const third = b => (b.tc+b.tf) ? b.tc/(b.tc+b.tf) : null;
const ppd   = b => b.drives.size ? b.pts/b.drives.size : null;

function tally(items){ // items: [{restUnder, push}]
  let u=0,o=0,p=0; for(const it of items){ if(it.push)p++; else if(it.restUnder)u++; else o++; }
  const dec=u+o; return {n:items.length, u, o, p, pctU: dec?u/dec*100:0, pctO: dec?o/dec*100:0};
}
function row(label, t, dir){ const pct = dir==='over'?t.pctO:t.pctU;
  const flag = t.n>=40 && pct>=BREAKEVEN ? '  ✅' : '';
  return '  '+label.padEnd(40)+`${String(t.n).padStart(5)}  ${pct.toFixed(1).padStart(5)}%  (${t.u}-${t.o})${flag}`; }

(async()=>{
  process.stdout.write('games.csv… ');
  const all = parseCSV(await (await fetch(CSV_URL)).text()); console.log('ok');
  const meta = {};
  for(const r of all){ const s=+r.season; if(s<LO||s>HI||r.game_type!=='REG')continue;
    const total=num(r.total), line=num(r.total_line); if(total==null||line==null)continue;
    meta[r.game_id]={total,line}; }

  const games={};
  for(let s=LO;s<=HI;s++){ process.stdout.write(`pbp ${s}… `); await seasonPBP(s, games); console.log('ok'); }

  // pooled scoring share by checkpoint (leaguewide, from this sample)
  const share={};
  for(const cp of CPS){ let sp=0, sf=0;
    for(const gid in games){ const m=meta[gid]; if(!m)continue; sp+=games[gid][cp.key].pts; sf+=m.total; }
    share[cp.key]= sf? sp/sf : 0;
  }

  console.log(`\n  UNDERCAST LIVE-UNDER BACKTEST — ${LO}–${HI}`);
  console.log(`  grading REST-of-game vs market-implied remainder · break-even ${BREAKEVEN}%`);
  console.log(`  leaguewide scoring share → Q1 ${(share.Q1*100).toFixed(0)}% · HALF ${(share.HALF*100).toFixed(0)}% · Q3 ${(share.Q3*100).toFixed(0)}%`);

  for(const cp of CPS){
    const sh=share[cp.key];
    // build per-game record at this checkpoint
    const recs=[];
    for(const gid in games){ const m=meta[gid]; if(!m)continue; const b=games[gid][cp.key];
      if(!b.plays) continue;
      const expRest=m.line*(1-sh), actRest=m.total-b.pts;
      const restUnder=actRest<expRest, push=actRest===expRest;
      recs.push({ pts:b.pts, projFull:b.pts/sh, line:m.line,
        ypp:ypp(b), third:third(b), ppd:ppd(b), restUnder, push });
    }
    const base=tally(recs);
    console.log(`\n  ══ ${cp.key} (n=${recs.length}) · baseline rest-under ${base.pctU.toFixed(1)}% / rest-over ${base.pctO.toFixed(1)}% ══`);

    // ---- UNDER signals (low early efficiency) ----
    const under=[];
    for(const M of [0.5,1.5,2.5]) under.push([`pace: proj full < line − ${M}`, r=>r.projFull < r.line - M]);
    for(const T of [1.2,1.5,1.8])  under.push([`ppd < ${T}`,   r=>r.ppd!=null   && r.ppd < T]);
    for(const T of [4.5,5.0,5.3])  under.push([`ypp < ${T}`,   r=>r.ypp!=null   && r.ypp < T]);
    for(const T of [0.30,0.35,0.40])under.push([`3rd-down < ${Math.round(T*100)}%`, r=>r.third!=null && r.third < T]);
    under.push(['pace≥1.5 AND ypp<5.0', r=>r.projFull < r.line-1.5 && r.ypp!=null && r.ypp<5.0]);
    under.push(['pace≥1.5 AND ppd<1.5', r=>r.projFull < r.line-1.5 && r.ppd!=null && r.ppd<1.5]);
    under.push(['pace≥1.5 AND 3rd<35%', r=>r.projFull < r.line-1.5 && r.third!=null && r.third<0.35]);

    console.log('  UNDER signals                                n   under%  (U-O)');
    console.log('  '+'─'.repeat(64));
    under.map(([l,fn])=>({l,t:tally(recs.filter(fn))})).filter(x=>x.t.n>=30)
      .sort((a,b)=>b.t.pctU-a.t.pctU).forEach(s=>console.log(row(s.l,s.t,'under')));

    // ---- OVER signals (high early efficiency) ----
    const over=[];
    for(const M of [0.5,1.5,2.5]) over.push([`pace: proj full > line + ${M}`, r=>r.projFull > r.line + M]);
    for(const T of [2.5,2.8,3.2])  over.push([`ppd > ${T}`,   r=>r.ppd!=null   && r.ppd > T]);
    for(const T of [6.0,6.5,7.0])  over.push([`ypp > ${T}`,   r=>r.ypp!=null   && r.ypp > T]);
    for(const T of [0.50,0.55,0.60])over.push([`3rd-down > ${Math.round(T*100)}%`, r=>r.third!=null && r.third > T]);
    over.push(['pace≥1.5 AND ypp>6.5', r=>r.projFull > r.line+1.5 && r.ypp!=null && r.ypp>6.5]);
    over.push(['pace≥1.5 AND ppd>2.8', r=>r.projFull > r.line+1.5 && r.ppd!=null && r.ppd>2.8]);
    over.push(['pace≥1.5 AND 3rd>55%', r=>r.projFull > r.line+1.5 && r.third!=null && r.third>0.55]);

    console.log('  OVER signals                                 n    over%  (U-O)');
    console.log('  '+'─'.repeat(64));
    over.map(([l,fn])=>({l,t:tally(recs.filter(fn))})).filter(x=>x.t.n>=30)
      .sort((a,b)=>b.t.pctO-a.t.pctO).forEach(s=>console.log(row(s.l,s.t,'over')));
  }
  console.log('\n  A signal beats the live market only if its side% > break-even with meaningful n.');
  console.log('  (Grading is vs the market-implied remainder, so mean-reversion works against the signal.)\n');
})();
