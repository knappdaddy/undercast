#!/usr/bin/env node
/* Probe Open-Meteo forecast for the exact params the app uses, plus variants,
   to see which combination errors. Prints HTTP status + a body snippet. */
const LAT=42.7738, LON=-78.7870;   // Buffalo (outdoor stadium)
const BASE=`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
  +`&hourly=temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m`
  +`&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC`;
const variants = {
  'CURRENT app (past_days=14&forecast_days=10)': BASE+'&past_days=14&forecast_days=10',
  'forecast_days=10 only'                      : BASE+'&forecast_days=10',
  'forecast_days=16 only'                      : BASE+'&forecast_days=16',
  'forecast_days=7 only'                       : BASE+'&forecast_days=7',
  'past_days=14&forecast_days=16'              : BASE+'&past_days=14&forecast_days=16',
  'past_days=7&forecast_days=7'                : BASE+'&past_days=7&forecast_days=7',
  'bare (defaults)'                            : BASE,
};
for(const [name,u] of Object.entries(variants)){
  try{
    const r = await fetch(u);
    const txt = await r.text();
    let hours = '';
    try{ const j=JSON.parse(txt); hours = j.hourly && j.hourly.time ? `${j.hourly.time.length} hours` : (j.error?('ERROR: '+j.reason):''); }catch{}
    console.log(String(r.status).padStart(3), name.padEnd(44), hours || txt.slice(0,120));
  }catch(e){ console.log('ERR', name.padEnd(44), e.message); }
}
