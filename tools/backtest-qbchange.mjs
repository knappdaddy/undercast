#!/usr/bin/env node
/* =========================================================================
   UnderCast QB-CHANGE backtest — does a mid-game starting-QB change predict
   the REST of the game going under?

   Thesis: a starter leaving (injury / benching) is a discrete shock that
   downgrades the offense, and the live total is slow to fully re-price it —
   a potentially INDEPENDENT live edge (unlike weather/efficiency).

   Detection (from pbp): per team, the "starter" is the modal passer over the
   first few dropbacks; a "change" is the first point where a different passer
   takes over ≥60% of the REMAINING dropbacks (excludes one-off gadget throws).

   Grading: REST of game vs market-implied remainder at the change time —
       share(t)      = leaguewide pooled cumulative points ÷ final, at that game-time
       expected_rest = closing_line × (1 − share(t))
       actual_rest   = final − points_at_change
       REST-UNDER    = actual_rest < expected_rest

   Confounder control: blowout benchings inflate unders on their own, so we
   also report changes in COMPETITIVE games (score margin ≤ 8 at the change),
   which is closer to a genuine injury shock.

   Data (free): nflverse games.csv + play-by-play. Actions, no key.
   Run:  node tools/backtest-qbchange.mjs 2016-2024
   ========================================================================= */

import zlib from 'node:zlib';

const CSV_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const PBP = s => `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${s}.csv.gz`;
const ARG = String(process.argv[2] || '2016-2024');
const [LO, HI] = ARG.includes('-') ? ARG.split('-').map(Number) : [ +ARG, +ARG ];
const BREAKEVEN = 52.38;
const NBUCKET = 10;   // scoring-share curve resolution

function parseCSV(text){ const rows=[]; let row=[],f='',q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if(c==='"') q=true; else if(c===','){ row.push(f); f=''; }
    else if(c==='\n'){ row.push(f); rows.push(row); row=[]; f=''; } else if(c!=='\r') f+=c; }
  if(f.length||row.length){ row.push(f); rows.push(row); }
  const h=rows.shift(); return rows.filter(r=>r.length>1).map(r=>{ const o={}; h.forEach((k,i)=>o[k]=r[i]); return o; }); }
const num=v=>(v==null||v===''||v==='NA')?null:(isNaN(+v)?null:+v);
function mode(arr){ const c={}; let best=null,bn=0; for(const x of arr){ c[x]=(c[x]||0)+1; if(c[x]>bn){bn=c[x];best=x;} } return best; }

// Stream a season's pbp: per game, cumulative-score checkpoints + per-team passer sequence.
function aggregate(text, games, seqs){
  const nl=text.indexOf('\n'); const H=text.slice(0,nl).split(',');
  const IG=H.indexOf('game_id'), IS=H.indexOf('game_seconds_remaining'),
        IHS=H.indexOf('total_home_score'), IAS=H.indexOf('total_away_score'),
        IPO=H.indexOf('posteam'), IPN=H.indexOf('passer_player_name');
  const maxCol=Math.max(IG,IS,IHS,IAS,IPO,IPN);
  let field='',col=0,q=false,r={};
  const onField=()=>{ if(col===IG)r.g=field;else if(col===IS)r.s=field;else if(col===IHS)r.hs=field;
    else if(col===IAS)r.as=field;else if(col===IPO)r.po=field;else if(col===IPN)r.pn=field; field='';col++; };
  const onRow=()=>{ onField(); const gid=r.g, gsr=+r.s;
    if(gid && !isNaN(gsr)){
      const pts=(+r.hs||0)+(+r.as||0);
      let G=games[gid]||(games[gid]={pts:new Array(NBUCKET).fill(0)});
      for(let k=1;k<=NBUCKET;k++){ if(gsr > 3600*(1-k/NBUCKET)){ if(pts>G.pts[k-1])G.pts[k-1]=pts; } }
      if(r.pn && r.po){ const key=gid+'|'+r.po; (seqs[key]||(seqs[key]=[])).push({gsr, name:r.pn, hs:+r.hs||0, as:+r.as||0}); }
    }
    field='';col=0;r={}; };
  for(let i=nl+1;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){field+='"';i++;} else q=false; } else field+=c; }
    else if(c==='"')q=true; else if(c===',')onField();
    else if(c==='\n'){ if(col>=maxCol)onRow(); else {field='';col=0;r={};} } else if(c!=='\r')field+=c; }
  if(col>=maxCol)onRow();
}
async function season(s, games, seqs){ const r=await fetch(PBP(s)); if(!r.ok)throw new Error(`pbp ${s} HTTP ${r.status}`);
  aggregate(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'), games, seqs); }

function detectChange(seq){ // seq chronological (decreasing gsr); returns first real takeover
  if(seq.length<6) return null;
  seq.sort((a,b)=>b.gsr-a.gsr);
  const starter = mode(seq.slice(0,4).map(x=>x.name));
  for(let i=2;i<seq.length;i++){
    if(seq[i].name!==starter){
      const rest=seq.slice(i), backup=seq[i].name;
      const share=rest.filter(x=>x.name===backup).length/rest.length;
      if(share>=0.6 && rest.length>=3) return {at:seq[i], starter, backup};
    }
  }
  return null;
}
function tally(items){ let u=0,o=0,p=0; for(const it of items){ if(it.push)p++; else if(it.u)u++; else o++; }
  const d=u+o; return {n:items.length,u,o,pct:d?u/d*100:0}; }
function line(l,t){ const flag=t.n>=25&&t.pct>=BREAKEVEN?'  ✅':''; return '  '+l.padEnd(38)+`${String(t.n).padStart(5)}  ${t.pct.toFixed(1).padStart(5)}%  (${t.u}-${t.o})${flag}`; }

(async()=>{
  process.stdout.write('games.csv… ');
  const all=parseCSV(await (await fetch(CSV_URL)).text()); console.log('ok');
  const meta={}; for(const g of all){ const s=+g.season; if(s<LO||s>HI||g.game_type!=='REG')continue;
    const total=num(g.total), lineT=num(g.total_line); if(total==null||lineT==null)continue; meta[g.game_id]={total,line:lineT}; }

  const games={}, seqs={};
  for(let s=LO;s<=HI;s++){ process.stdout.write(`pbp ${s}… `); await season(s, games, seqs); console.log('ok'); }

  // leaguewide pooled scoring-share curve (share at frac k/NBUCKET)
  const share=new Array(NBUCKET).fill(0);
  for(let k=0;k<NBUCKET;k++){ let sp=0,sf=0; for(const gid in games){ const m=meta[gid]; if(!m)continue; sp+=games[gid].pts[k]; sf+=m.total; } share[k]=sf?sp/sf:0; }
  const shareAt=frac=>{ if(frac<=0)return 0; if(frac>=1)return share[NBUCKET-1];
    const x=frac*NBUCKET, lo=Math.floor(x)-1, hi=lo+1;
    const sLo = lo<0?0:share[lo], sHi = share[Math.min(hi,NBUCKET-1)];
    return sLo + (sHi-sLo)*(x-Math.floor(x)); };

  // collect QB-change games
  const changes=[];
  for(const key in seqs){ const gid=key.split('|')[0]; const m=meta[gid]; if(!m)continue;
    const ch=detectChange(seqs[key]); if(!ch)continue;
    const R=ch.at.gsr; if(R<120||R>3300) continue;           // ignore first/last ~2 min noise
    const ptsAt=ch.at.hs+ch.at.as, margin=Math.abs(ch.at.hs-ch.at.as);
    const frac=(3600-R)/3600, sh=shareAt(frac);
    const expRest=m.line*(1-sh), actRest=m.total-ptsAt;
    changes.push({ gid, R, margin, u:actRest<expRest, push:actRest===expRest, quarter: R>2700?1:R>1800?2:R>900?3:4 });
  }

  console.log(`\n  UNDERCAST QB-CHANGE BACKTEST — ${LO}–${HI}`);
  console.log(`  ${changes.length} games with a detected mid-game starter change`);
  console.log(`  grading REST of game vs market-implied remainder · break-even ${BREAKEVEN}%\n`);
  console.log('  set                                     n   under%  (U-O)');
  console.log('  '+'─'.repeat(60));
  console.log(line('ALL QB changes', tally(changes)));
  console.log(line('competitive (margin ≤ 8)', tally(changes.filter(c=>c.margin<=8))));
  console.log(line('close (margin ≤ 3)', tally(changes.filter(c=>c.margin<=3))));
  console.log(line('blowout (margin ≥ 17) — confound', tally(changes.filter(c=>c.margin>=17))));
  console.log(line('change by halftime, margin ≤ 8', tally(changes.filter(c=>c.R>=1800&&c.margin<=8))));
  console.log(line('change in 2nd half, margin ≤ 8', tally(changes.filter(c=>c.R<1800&&c.margin<=8))));
  console.log('\n  A real QB-injury edge = competitive-game under% > break-even with meaningful n.');
  console.log('  (Blowout benchings trend under on game-script alone — that is the confound to beat.)\n');
})();
