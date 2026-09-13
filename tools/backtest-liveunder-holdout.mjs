#!/usr/bin/env node
/* =========================================================================
   UnderCast LIVE-UNDER holdout — out-of-sample check for the YPP signal.

   TRAIN (2019-2022): compute the leaguewide scoring share and PICK the best
   under rule per checkpoint by sweeping candidate thresholds.
   TEST  (2023-2024): apply those frozen rules BLIND and report under%.

   Grading is identical to the main backtest: REST of game vs market-implied
   remainder (train-derived share × closing line). The test seasons never
   touch threshold selection or the share, so a green TEST column is real
   out-of-sample confirmation, not tuning.

   Env: TRAIN="2019-2022"  TEST="2023-2024"   ·   nflverse pbp, no key.
   ========================================================================= */

import zlib from 'node:zlib';

const CSV_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const PBP = s => `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${s}.csv.gz`;
const BREAKEVEN = 52.38;
const TRAIN = String(process.env.TRAIN || '2019-2022').split('-').map(Number);
const TEST  = String(process.env.TEST  || '2023-2024').split('-').map(Number);
const CPS = [ {key:'Q1', gsr:2700}, {key:'HALF', gsr:1800}, {key:'Q3', gsr:900} ];

function parseCSV(text){ const rows=[]; let row=[],f='',q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if(c==='"') q=true; else if(c===','){ row.push(f); f=''; }
    else if(c==='\n'){ row.push(f); rows.push(row); row=[]; f=''; } else if(c!=='\r') f+=c; }
  if(f.length||row.length){ row.push(f); rows.push(row); }
  const h=rows.shift(); return rows.filter(r=>r.length>1).map(r=>{ const o={}; h.forEach((k,i)=>o[k]=r[i]); return o; }); }
const num = v => (v==null||v===''||v==='NA')?null:(isNaN(+v)?null:+v);

function aggregate(text, games){
  const nl=text.indexOf('\n'); const H=text.slice(0,nl).split(',');
  const IG=H.indexOf('game_id'), IS=H.indexOf('game_seconds_remaining'),
        IHS=H.indexOf('total_home_score'), IAS=H.indexOf('total_away_score'),
        IPT=H.indexOf('play_type'), IY=H.indexOf('yards_gained'),
        ITC=H.indexOf('third_down_converted'), ITF=H.indexOf('third_down_failed'), ID=H.indexOf('drive');
  const maxCol=Math.max(IG,IS,IHS,IAS,IPT,IY,ITC,ITF,ID);
  let field='',col=0,q=false,rec={};
  const onField=()=>{ if(col===IG)rec.g=field;else if(col===IS)rec.s=field;else if(col===IHS)rec.hs=field;
    else if(col===IAS)rec.as=field;else if(col===IPT)rec.pt=field;else if(col===IY)rec.y=field;
    else if(col===ITC)rec.tc=field;else if(col===ITF)rec.tf=field;else if(col===ID)rec.d=field; field='';col++; };
  const bucket=()=>({pts:0,plays:0,yds:0,tc:0,tf:0,drives:new Set()});
  const onRow=()=>{ onField(); const gid=rec.g, gsr=+rec.s;
    if(gid&&!isNaN(gsr)){ let G=games[gid]||(games[gid]={Q1:bucket(),HALF:bucket(),Q3:bucket()});
      const pts=(+rec.hs||0)+(+rec.as||0); const isPlay=rec.pt==='pass'||rec.pt==='run';
      const yd=isPlay?(+rec.y||0):0, conv=rec.tc==='1'?1:0, fail=rec.tf==='1'?1:0, dnum=rec.d;
      for(const cp of CPS){ if(gsr>cp.gsr){ const b=G[cp.key];
        if(pts>b.pts)b.pts=pts; if(isPlay){b.plays++;b.yds+=yd;} b.tc+=conv;b.tf+=fail; if(dnum)b.drives.add(dnum); } } }
    field='';col=0;rec={}; };
  for(let i=nl+1;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){field+='"';i++;} else q=false; } else field+=c; }
    else if(c==='"')q=true; else if(c===',')onField();
    else if(c==='\n'){ if(col>=maxCol)onRow(); else {field='';col=0;rec={};} } else if(c!=='\r')field+=c; }
  if(col>=maxCol)onRow();
}

async function loadRange(lo,hi){
  const all=parseCSV(await (await fetch(CSV_URL)).text());
  const meta={};
  for(const r of all){ const s=+r.season; if(s<lo||s>hi||r.game_type!=='REG')continue;
    const total=num(r.total), line=num(r.total_line); if(total==null||line==null)continue; meta[r.game_id]={total,line}; }
  const games={};
  for(let s=lo;s<=hi;s++){ process.stdout.write(`pbp ${s}… `); const r=await fetch(PBP(s));
    if(!r.ok)throw new Error(`pbp ${s} HTTP ${r.status}`);
    aggregate(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'), games); console.log('ok'); }
  return {games, meta};
}
const ypp=b=>b.plays?b.yds/b.plays:null, third=b=>(b.tc+b.tf)?b.tc/(b.tc+b.tf):null, ppd=b=>b.drives.size?b.pts/b.drives.size:null;
function shareOf(games,meta,key){ let sp=0,sf=0; for(const g in games){ const m=meta[g]; if(!m)continue; sp+=games[g][key].pts; sf+=m.total; } return sf?sp/sf:0; }
function recsAt(games,meta,share,key){ const out=[];
  for(const g in games){ const m=meta[g]; if(!m)continue; const b=games[g][key]; if(!b.plays)continue;
    const expRest=m.line*(1-share), actRest=m.total-b.pts;
    out.push({ypp:ypp(b),third:third(b),ppd:ppd(b),projFull:b.pts/share,line:m.line,
      restUnder:actRest<expRest, push:actRest===expRest}); } return out; }
function tally(items){ let u=0,o=0,p=0; for(const it of items){ if(it.push)p++; else if(it.restUnder)u++; else o++; }
  const d=u+o; return {n:items.length,u,o,pct:d?u/d*100:0}; }

// candidate under rules to sweep on TRAIN
const RULES=[
  ['YPP < 4.5', r=>r.ypp!=null&&r.ypp<4.5],
  ['YPP < 5.0', r=>r.ypp!=null&&r.ypp<5.0],
  ['YPP < 5.3', r=>r.ypp!=null&&r.ypp<5.3],
  ['ppd < 1.5', r=>r.ppd!=null&&r.ppd<1.5],
  ['3rd < 30%', r=>r.third!=null&&r.third<0.30],
  ['YPP<5.0 AND 3rd<40%', r=>r.ypp!=null&&r.ypp<5.0&&r.third!=null&&r.third<0.40],
];

(async()=>{
  console.log(`TRAIN ${TRAIN[0]}-${TRAIN[1]}  ·  TEST ${TEST[0]}-${TEST[1]}\n`);
  process.stdout.write('load train… ');   const tr=await loadRange(TRAIN[0],TRAIN[1]);
  process.stdout.write('load test…  ');   const te=await loadRange(TEST[0],TEST[1]);

  for(const cp of CPS){
    const share=shareOf(tr.games,tr.meta,cp.key);       // share frozen on TRAIN
    const trRecs=recsAt(tr.games,tr.meta,share,cp.key);
    const teRecs=recsAt(te.games,te.meta,share,cp.key);
    const teBase=tally(teRecs);
    console.log(`\n══ ${cp.key} · train share ${(share*100).toFixed(0)}% · TEST baseline ${teBase.pct.toFixed(1)}% (n=${teRecs.length}) ══`);
    console.log('  rule                          TRAIN under%   TEST under%   TEST n');
    console.log('  '+'─'.repeat(62));
    // rank rules by TRAIN under%, then show blind TEST
    const ranked=RULES.map(([l,fn])=>({l,fn,tr:tally(trRecs.filter(fn))})).filter(x=>x.tr.n>=40)
      .sort((a,b)=>b.tr.pct-a.tr.pct);
    ranked.forEach((x,i)=>{ const t=tally(teRecs.filter(x.fn));
      const flag = t.n>=40 && t.pct>=BREAKEVEN ? '  ✅' : '';
      const pick = i===0 ? ' «train pick' : '';
      console.log('  '+x.l.padEnd(26)+`${x.tr.pct.toFixed(1).padStart(7)}%   ${t.pct.toFixed(1).padStart(8)}%   ${String(t.n).padStart(5)}${flag}${pick}`); });
  }
  console.log(`\n  Blind TEST under% above ${BREAKEVEN}% with decent n = the signal holds out of sample.\n`);
})();
