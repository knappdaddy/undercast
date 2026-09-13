#!/usr/bin/env node
/* =========================================================================
   UnderCast ODDS DIAGNOSTIC — pulls the two LIVE feeds the app uses and lays
   them side by side so we can see exactly why displayed totals differ from
   the sportsbook.

     • ESPN scoreboard  → overUnder + provider (what the app shows with no key)
     • The Odds API     → per-book totals incl. DraftKings/FanDuel (with a key)

   Uses the SAME team-name normalization the app uses, so we also see which
   ESPN games fail to match an odds record (those silently fall back to ESPN).

   Env: ODDS_API_KEY (repo secret). Runs in GitHub Actions. Prints credits.
   ========================================================================= */

const KEY   = process.env.ODDS_API_KEY;
const SPORT = process.env.SPORT || 'americanfootball_nfl';
const ESPN  = process.env.SPORT === 'americanfootball_ncaaf'
  ? 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard'
  : 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const BOOKS = 'draftkings,fanduel,betmgm,caesars,betrivers,espnbet';
const normTeam = s => (s||'').toLowerCase().replace(/[^a-z]/g,'');

async function getJSON(u){ const r = await fetch(u); const rem = r.headers.get('x-requests-remaining');
  const txt = await r.text(); let j=null; try{ j=JSON.parse(txt); }catch{}
  return { ok:r.ok, status:r.status, rem, j, raw:txt.slice(0,300) }; }

(async()=>{
  if(!KEY){ console.log('NO ODDS_API_KEY set'); process.exit(1); }

  // 1) ESPN
  const e = await getJSON(ESPN);
  console.log('ESPN status', e.status, '· events', (e.j?.events||[]).length,
    '· week', e.j?.week?.number, '· season', e.j?.season?.year);
  const espnGames = (e.j?.events||[]).map(ev=>{
    const c = ev.competitions[0];
    const home = c.competitors.find(x=>x.homeAway==='home')||c.competitors[0];
    const away = c.competitors.find(x=>x.homeAway==='away')||c.competitors[1];
    const o = (c.odds&&c.odds[0])||{};
    return { short: ev.shortName,
      home: home.team.displayName, away: away.team.displayName,
      hkey: normTeam(home.team.displayName),
      ou: o.overUnder ?? null, prov: o.provider?.name || '—',
      state: c.status.type.state };
  });

  // 2) Odds API
  const u = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds/?apiKey=${encodeURIComponent(KEY)}`
    + `&regions=us&markets=totals&oddsFormat=american&bookmakers=${BOOKS}`;
  const o = await getJSON(u.replace(KEY,'***'));   // print the key-masked URL
  const real = await getJSON(u);
  console.log('OddsAPI status', real.status, '· games', (real.j||[]).length,
    '· credits remaining:', real.rem);
  if(!real.ok){ console.log('OddsAPI error body:', real.raw); }
  console.log('  (Odds API returns the whole season — that is why keying by home team alone collides.)');
  const recs = (real.j||[]).map(g=>{
    const tot = {};
    (g.bookmakers||[]).forEach(b=>{ const m=(b.markets||[]).find(x=>x.key==='totals');
      const ov=m&&(m.outcomes||[]).find(x=>x.name==='Over'); if(ov&&ov.point!=null) tot[b.key]=+ov.point; });
    return { home:normTeam(g.home_team), away:normTeam(g.away_team), commence:Date.parse(g.commence_time||''), tot };
  }).filter(r=>Object.keys(r.tot).length);

  // OLD (home-only) vs NEW (home+away nearest kickoff) matching, per current-week game.
  const homeOnly = {}; recs.forEach(r=>{ homeOnly[r.home]=r.tot; });   // last write wins = the bug

  console.log('\n  matchup                       ESPN DK   OLD-map DK   FIXED DK   FIXED FD');
  console.log('  '+'─'.repeat(74));
  for(const g of espnGames){
    const kt = Date.now();  // current-week games kick within days; nearest-to-now is fine for the demo
    const cands = recs.filter(r=>r.home===g.hkey && r.away===normTeam(g.away));
    cands.sort((x,y)=>Math.abs(x.commence-kt)-Math.abs(y.commence-kt));
    const fixed = cands[0]?.tot || null;
    const oldDK = homeOnly[g.hkey]?.draftkings ?? '—';
    const label = (g.away.split(' ').pop()+' @ '+g.home.split(' ').pop()).padEnd(28);
    console.log(`  ${label} ${String(g.ou).padStart(5)}    ${String(oldDK).padStart(5)}      ${String(fixed?.draftkings ?? '—').padStart(5)}      ${String(fixed?.fanduel ?? '—').padStart(5)}`);
  }
  console.log('\n  ESPN DK and FIXED DK should now agree; OLD-map DK is the wrong-week bug.');
})();
