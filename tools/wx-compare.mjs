#!/usr/bin/env node
/* Compare forecast sources for a stadium around an upcoming kickoff.
   Finds this week's game at the venue on ESPN, then prints hour-by-hour
   precipitation from Open-Meteo (several models) and the National Weather
   Service, plus what UnderCast's current logic would conclude. */
const LAT=40.8135, LON=-74.0745, TEAMS=['NYG','NYJ'];   // MetLife
const UA={'User-Agent':'UnderCast-research/1.0 (github.com/knappdaddy/undercast)','Accept':'application/geo+json'};

// 1) find the MetLife game this week
const sb = await (await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard')).json();
let kick=null, label='';
for(const ev of sb.events||[]){ const c=ev.competitions[0];
  const h=c.competitors.find(x=>x.homeAway==='home'); const a=c.competitors.find(x=>x.homeAway==='away');
  if(TEAMS.includes(h.team.abbreviation)){ kick=ev.date; label=`${a.team.abbreviation} @ ${h.team.abbreviation}`; } }
console.log('ESPN week', sb.week&&sb.week.number, '· MetLife game:', label||'(none found)', '· kickoff', kick);
const K = kick ? new Date(kick).getTime() : Date.now()+3*864e5;
const win = t => { const d=(t-K)/36e5; return d>=-2 && d<=4.5; };
const hh = t => new Date(t).toISOString().slice(5,16).replace('T',' ')+'Z';

// 2) Open-Meteo, several models
const models=['best_match','gfs_seamless','ecmwf_ifs025','icon_seamless','gem_seamless','ncep_nbm_conus'];
for(const m of models){
  const u=`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&hourly=precipitation,precipitation_probability,weather_code,rain,showers&timezone=UTC&forecast_days=7&models=${m}`;
  try{ const r=await fetch(u); const d=await r.json();
    if(!d.hourly){ console.log(`\n[open-meteo ${m}] no data:`, d.reason||r.status); continue; }
    console.log(`\n[open-meteo ${m}]  hour(UTC)        mm   prob  code`);
    d.hourly.time.forEach((t,i)=>{ const ts=new Date(t+'Z').getTime(); if(!win(ts)) return;
      const mark = Math.abs(ts-K)<1800e3?'  <- kickoff':'';
      console.log(`   ${hh(ts)}   ${String(d.hourly.precipitation[i]??'-').padStart(4)}  ${String(d.hourly.precipitation_probability?.[i]??'-').padStart(4)}  ${String(d.hourly.weather_code[i]).padStart(3)}${mark}`); });
  }catch(e){ console.log(`\n[open-meteo ${m}] error`, e.message); }
}

// 3) National Weather Service hourly
try{
  const pt=await (await fetch(`https://api.weather.gov/points/${LAT},${LON}`,{headers:UA})).json();
  const fh=await (await fetch(pt.properties.forecastHourly,{headers:UA})).json();
  console.log(`\n[NWS hourly · ${pt.properties.gridId}]  hour(UTC)      PoP   forecast`);
  for(const p of fh.properties.periods){ const ts=new Date(p.startTime).getTime(); if(!win(ts)) continue;
    const mark = Math.abs(ts-K)<1800e3?'  <- kickoff':'';
    console.log(`   ${hh(ts)}   ${String(p.probabilityOfPrecipitation?.value??'-').padStart(3)}%  ${p.shortForecast}${mark}`); }
  // quantitative precip from the gridpoint (6h blocks)
  const gp=await (await fetch(pt.properties.forecastGridData,{headers:UA})).json();
  console.log(`\n[NWS gridpoint QPF, inches]`);
  for(const v of (gp.properties.quantitativePrecipitation?.values||[])){ const ts=new Date(v.validTime.split('/')[0]).getTime();
    if(ts>K-6*36e5 && ts<K+6*36e5) console.log(`   ${v.validTime}   ${(v.value/25.4).toFixed(2)} in`); }
}catch(e){ console.log('\n[NWS] error', e.message); }
