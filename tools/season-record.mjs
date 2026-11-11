#!/usr/bin/env node
/* =========================================================================
   UnderCast SEASON RECORD — grades the pregame weather model, week by week,
   for the NFL and college (all FBS), and writes data/record-<season>.json,
   which the app's Record tab reads.

   For every finished OUTDOOR game with a posted total:
     • weather  = the forecast for the kickoff hour, from Open-Meteo's archive of
                  past forecasts (NOAA NBM first, then the default blend, then
                  observed weather as a last resort). This is the closest
                  reconstruction of what the app showed before kickoff.
     • model    = the app's own functions, pulled out of index.html at run
                  time, so the record always uses exactly the app's math
                  (penalty >= 1.5 is an UNDER call, >= 2.5 is strong).
     • line     = ESPN's total at kickoff (the same number the app grades with).
     • result   = final combined score vs that line.

   A week is FROZEN once every game in it is final, so a graded week never
   changes afterwards. REBUILD=1 regrades everything.

   Run:  node tools/season-record.mjs 2026            # writes data/record-2026.json
         DRY=1 node tools/season-record.mjs 2026      # print only, write nothing
   Needs network access to ESPN and Open-Meteo (runs in GitHub Actions).
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEASON = +(process.argv[2] || new Date().getUTCFullYear());
const OUT = path.join(ROOT, 'data', `record-${SEASON}.json`);
const DRY = !!process.env.DRY, REBUILD = !!process.env.REBUILD;
const ESPN = {
  nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
  cfb: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
};
const MAXWEEK = { nfl: 18, cfb: 16 };
const HOURLY = 'temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m';
const sleep = ms => new Promise(r=>setTimeout(r, ms));

/* ---- the app's model, extracted from index.html ---- */
function grab(src, head){
  const i = src.indexOf(head); if(i<0) throw new Error('index.html: missing '+head);
  let j = src.indexOf('{', i), depth = 0;
  for(let k=j; k<src.length; k++){ const c=src[k];
    if(c==='{') depth++; else if(c==='}' && --depth===0) return src.slice(i, k+1); }
  throw new Error('index.html: unbalanced '+head);
}
const APP = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const M = new Function(
  ['windPenalty','precipPenalty','coldPenalty','heatPenalty','windChill','classifyPrecip','skyText','forecastWx','computeEdge']
    .map(n=>grab(APP, `function ${n}(`)).join('\n')
  + '\n' + grab(APP, 'const VENUES = {') + ';\n' + grab(APP, 'const US_STATE = {') + ';\n'
  + 'const CLOSELINE = {}; const getHist = () => [];\n'
  + 'return { forecastWx, computeEdge, classifyPrecip, VENUES, US_STATE };')();

/* ---- http ---- */
async function getJSON(url, tries=4){
  for(let a=0; a<tries; a++){
    try{ const r = await fetch(url); if(r.ok) return await r.json();
      if(r.status!==429 && r.status<500) throw new Error(`HTTP ${r.status} ${url.slice(0,90)}`);
    }catch(e){ if(a===tries-1) throw e; }
    await sleep(800*(a+1)*(a+1));
  }
}

/* ---- venues ---- */
const GEO = {};
async function geocode(city, state){
  const k = `${city}|${state||''}`.toLowerCase(); if(k in GEO) return GEO[k];
  const d = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=5&language=en&format=json`);
  let hits = (d.results||[]).filter(r=>r.country_code==='US'); if(!hits.length) hits = d.results||[];
  let hit = hits[0];
  if(state){ const m = hits.find(r=>r.admin1 && (r.admin1.toLowerCase().startsWith(state.toLowerCase()) || r.admin1===M.US_STATE[state])); if(m) hit=m; }
  return GEO[k] = hit ? { lat:hit.latitude, lon:hit.longitude } : null;
}
async function venueOf(league, c, homeAb){
  const v = c.venue || {}, addr = v.address || {};
  if(league==='nfl' && !c.neutralSite && M.VENUES[homeAb]){
    const s = M.VENUES[homeAb];
    const roof = (v.indoor && s.roof==='open') ? 'retractable' : s.roof;
    return { roof, lat:s.lat, lon:s.lon, name:s.name };
  }
  const roof = v.indoor ? 'dome' : 'open';
  if(roof!=='open' || !addr.city) return { roof, name:v.fullName||'' };
  const geo = await geocode(addr.city, addr.state);
  return { roof, lat:geo?.lat ?? null, lon:geo?.lon ?? null, name:v.fullName||'' };
}

/* ---- kickoff-hour forecast: ONE request per venue covering every date it hosts ---- */
const WX = {};      // "lat,lon" -> { source -> hourly }
const vkey = g => `${g.lat.toFixed(3)},${g.lon.toFixed(3)}`;
async function hourlyFor(lat, lon, dates, source){
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`; (WX[key] ||= {});
  if(WX[key][source]) return WX[key][source];          // dates = the venue's full season set
  const s = dates[0], e = new Date(Date.parse(dates[dates.length-1])+864e5).toISOString().slice(0,10);
  const q = `latitude=${lat}&longitude=${lon}&start_date=${s}&end_date=${e}&hourly=${HOURLY}&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC`;
  const url = source==='nbm' ? `https://historical-forecast-api.open-meteo.com/v1/forecast?${q}&models=ncep_nbm_conus`
    : source==='blend' ? `https://historical-forecast-api.open-meteo.com/v1/forecast?${q}`
    : `https://archive-api.open-meteo.com/v1/archive?${q.replace(',precipitation_probability','')}`;
  await sleep(150);
  return WX[key][source] = (await getJSON(url)).hourly || {};
}
function nearest(H, t){ let bi=-1, bd=Infinity;
  (H.time||[]).forEach((x,i)=>{ const d=Math.abs(Date.parse(x+(x.endsWith('Z')?'':'Z'))-t); if(d<bd){ bd=d; bi=i; } });
  return bd<=90*60e3 ? bi : -1; }
async function kickoffWx(g, dates){
  for(const [source, label] of [['nbm','forecast · NOAA NBM'], ['blend','forecast · blend'], ['archive','observed']]){
    try{ const H = await hourlyFor(g.lat, g.lon, dates, source), bi = nearest(H, g.kickT);
      if(bi<0 || H.wind_speed_10m?.[bi]==null || H.temperature_2m?.[bi]==null) continue;
      return Object.assign(M.forecastWx(H, bi), { src:label });
    }catch(e){ /* try the next source */ }
  }
  return null;
}

/* ---- one league-week ---- */
async function gradeWeek(league, week){
  const q = league==='cfb' ? `?groups=80&limit=300&seasontype=2&week=${week}&dates=${SEASON}` : `?seasontype=2&week=${week}&dates=${SEASON}`;
  const d = await getJSON(ESPN[league]+q);
  const evs = d.events || [];
  const now = Date.now();
  const done = ev => ev.competitions[0].status.type.state==='post' || Date.parse(ev.date) < now-3*864e5;
  const complete = evs.length>0 && evs.every(done);
  const games = [];
  for(const ev of evs){
    const c = ev.competitions[0];
    if(c.status.type.state!=='post' || c.status.type.completed===false) continue;
    const home = c.competitors.find(x=>x.homeAway==='home') || c.competitors[0];
    const away = c.competitors.find(x=>x.homeAway==='away') || c.competitors[1];
    const line = c.odds?.[0]?.overUnder; if(line==null) continue;
    const homeAb = home.team.abbreviation || home.team.shortDisplayName, awayAb = away.team.abbreviation || away.team.shortDisplayName;
    const v = await venueOf(league, c, homeAb);
    games.push({ id:ev.id, league, kickT:Date.parse(ev.date), kickISO:ev.date, away:awayAb, home:homeAb,
      line:+line, final:(+home.score||0)+(+away.score||0), roof:v.roof, lat:v.lat, lon:v.lon, venue:v.name });
  }
  return { complete, events:evs.length, games };
}

(async()=>{
  const prev = (!REBUILD && fs.existsSync(OUT)) ? JSON.parse(fs.readFileSync(OUT,'utf8')) : null;
  const out = { season:SEASON, updated:new Date().toISOString(),
    method:'Kickoff-hour forecast (Open-Meteo forecast archive, NOAA NBM first) run through the app model; graded vs ESPN total at kickoff. Penalty >= 1.5 = UNDER call, >= 2.5 = strong. Complete weeks are frozen.',
    leagues:{ nfl:{weeks:{}}, cfb:{weeks:{}} } };

  // 1) collect every finished game from each week that isn't frozen yet
  const pending = [];                                  // { league, wk, W }
  for(const league of ['nfl','cfb']){
    const cur = await getJSON(ESPN[league] + (league==='cfb' ? '?groups=80' : ''));
    const type = cur.season?.type, curWeek = cur.week?.number || 1;
    const last = (type===2 && cur.season?.year===SEASON) ? Math.min(curWeek, MAXWEEK[league]) : MAXWEEK[league];
    for(let wk=1; wk<=last; wk++){
      const old = prev?.leagues?.[league]?.weeks?.[wk];
      if(old?.complete){ out.leagues[league].weeks[wk] = old; continue; }       // frozen
      const W = await gradeWeek(league, wk);
      if(W.events) pending.push({ league, wk, W });
    }
  }
  // 2) every date each outdoor venue hosts, so its forecast is ONE request
  const venueDates = {};
  for(const {W} of pending) W.games.filter(g=>g.roof==='open' && g.lat!=null)
    .forEach(g=>(venueDates[vkey(g)] ||= new Set()).add(g.kickISO.slice(0,10)));
  console.log(`${pending.length} league-weeks to grade · ${Object.keys(venueDates).length} outdoor venues\n`);

  // 3) grade
  for(const {league, wk, W} of pending){
      const outdoor = W.games.filter(g=>g.roof==='open' && g.lat!=null);
      const calls = []; let graded = 0, noWx = 0;
      for(const g of outdoor){
          const wx = await kickoffWx(g, [...venueDates[vkey(g)]].sort());
          if(!wx){ noWx++; continue; }
          graded++;
          const e = M.computeEdge({ roof:'open', weather:wx, marketTotal:g.line, live:{state:'pre'} });
          if(e.lean!=='under') continue;
          const top = Object.entries(e.comps).sort((a,b)=>b[1]-a[1])[0];
          calls.push({ id:g.id, away:g.away, home:g.home, kick:g.kickISO, venue:g.venue,
            line:g.line, final:g.final, pen:e.penalty, strong:e.penalty>=2.5,
            driver: top && top[1]>0 ? top[0] : '—',
            wind:wx.windMph, tempF:wx.tempF,
            precip: wx.precipType==='none' ? 'dry' : `${wx.precipIntensity} ${wx.precipType}`,
            src: wx.src,
            result: g.final<g.line ? 'W' : g.final>g.line ? 'L' : 'P' });
      }
      calls.sort((a,b)=>b.pen-a.pen);
      out.leagues[league].weeks[wk] = { complete:W.complete, games:W.games.length, outdoor:outdoor.length,
        graded, noWx, calls };
      const rec = calls.reduce((a,c)=>(a[c.result]++,a), {W:0,L:0,P:0});
      console.log(`${league.toUpperCase()} wk ${String(wk).padStart(2)} ${W.complete?'final  ':'partial'}  games ${String(W.games.length).padStart(3)}  outdoor ${String(outdoor.length).padStart(3)}  graded ${String(graded).padStart(3)}${noWx?` (no wx ${noWx})`:''}  calls ${calls.length}  ${rec.W}-${rec.L}-${rec.P}`);
      calls.forEach(c=>console.log(`      ${c.result}  ${(c.away+' @ '+c.home).padEnd(16)} line ${String(c.line).padStart(5)} final ${String(c.final).padStart(3)}  pen ${c.pen.toFixed(1)} ${c.driver}${c.strong?' (strong)':''}  · ${c.wind} mph ${c.tempF}° ${c.precip} · ${c.src}`));
  }
  // keep weeks in numeric order in the file
  for(const league of ['nfl','cfb']){ const w = out.leagues[league].weeks;
    out.leagues[league].weeks = Object.fromEntries(Object.keys(w).sort((x,y)=>x-y).map(k=>[k, w[k]])); }

  // season totals in the log
  for(const league of ['nfl','cfb']){
    const all = Object.values(out.leagues[league].weeks).flatMap(w=>w.calls);
    const t = all.reduce((a,c)=>(a[c.result]++,a), {W:0,L:0,P:0});
    console.log(`\n${league.toUpperCase()} season: ${t.W}-${t.L}-${t.P}` + (t.W+t.L ? `  (${(t.W/(t.W+t.L)*100).toFixed(1)}%)` : ''));
  }
  if(DRY){ console.log('\nDRY run — nothing written.'); return; }
  fs.mkdirSync(path.dirname(OUT), { recursive:true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
})().catch(e=>{ console.error(e); process.exit(1); });
