#!/usr/bin/env node
/* One-shot probe (~10 credits): does The Odds API historical archive contain
   IN-PLAY totals? Pulls a single snapshot taken mid-game and compares each
   in-progress game's total to its pregame closing line (nflverse). If the
   archive is in-play, mid-game totals will differ sharply from the close. */
const KEY = process.env.ODDS_API_KEY;
if(!KEY){ console.error('Missing ODDS_API_KEY'); process.exit(1); }
const WHEN = process.argv[2] || '2024-10-06T18:40:00Z';   // ~halftime of 2024 Wk5 1pm ET games
const url = `https://api.the-odds-api.com/v4/historical/sports/americanfootball_nfl/odds/?apiKey=${encodeURIComponent(KEY)}`
  + `&regions=us&markets=totals&oddsFormat=american&date=${encodeURIComponent(WHEN)}`;
const r = await fetch(url);
console.log('HTTP', r.status, '| credits used', r.headers.get('x-requests-last'), '| remaining', r.headers.get('x-requests-remaining'));
if(!r.ok){ console.log((await r.text()).slice(0,300)); process.exit(1); }
const j = await r.json();
console.log('snapshot', j.timestamp, '| events', (j.data||[]).length);
const csv = await (await fetch('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv')).text();
const [h,...rows] = csv.trim().split('\n').map(l=>l.split(','));
const ix = k=>h.indexOf(k), close={};
rows.forEach(c=>{ if(c[ix('gameday')]===WHEN.slice(0,10)) close[c[ix('home_team')]]={line:c[ix('total_line')], fin:(+c[ix('home_score')])+(+c[ix('away_score')])}; });
const AB = {'Arizona Cardinals':'ARI','Atlanta Falcons':'ATL','Baltimore Ravens':'BAL','Buffalo Bills':'BUF','Carolina Panthers':'CAR','Chicago Bears':'CHI','Cincinnati Bengals':'CIN','Cleveland Browns':'CLE','Dallas Cowboys':'DAL','Denver Broncos':'DEN','Detroit Lions':'DET','Green Bay Packers':'GB','Houston Texans':'HOU','Indianapolis Colts':'IND','Jacksonville Jaguars':'JAX','Kansas City Chiefs':'KC','Las Vegas Raiders':'LV','Los Angeles Chargers':'LAC','Los Angeles Rams':'LA','Miami Dolphins':'MIA','Minnesota Vikings':'MIN','New England Patriots':'NE','New Orleans Saints':'NO','New York Giants':'NYG','New York Jets':'NYJ','Philadelphia Eagles':'PHI','Pittsburgh Steelers':'PIT','San Francisco 49ers':'SF','Seattle Seahawks':'SEA','Tampa Bay Buccaneers':'TB','Tennessee Titans':'TEN','Washington Commanders':'WAS'};
for(const e of (j.data||[])){
  const started = Date.parse(e.commence_time) < Date.parse(j.timestamp);
  const pts = (e.bookmakers||[]).map(b=>{ const m=(b.markets||[]).find(x=>x.key==='totals'); const o=m&&m.outcomes.find(x=>x.name==='Over');
    return o ? `${b.key}:${o.point}@${(m.last_update||'').slice(11,16)}` : null; }).filter(Boolean);
  const c = close[AB[e.home_team]] || {};
  console.log(`${started?'IN-PLAY':'pre    '} ${e.away_team} @ ${e.home_team} (kick ${e.commence_time.slice(11,16)}Z) close ${c.line??'?'} final ${c.fin??'?'}`);
  console.log('   ', pts.slice(0,6).join('  ') || '(no totals)');
}
