#!/usr/bin/env node
/* Dump one NFL week's ESPN scoreboard: matchup, over/under + provider, state,
   and final total — to see exactly what line/total a settled game carries.
   Run: node tools/espn-week.mjs 2 2026   (week, season) */
const WK = process.argv[2] || '';
const YR = process.argv[3] || '2026';
const url = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'
  + (WK ? `?seasontype=2&week=${WK}&dates=${YR}` : '');
const d = await (await fetch(url)).json();
console.log('week', d.week && d.week.number, 'season', d.season && d.season.year, '· events', (d.events||[]).length, '\n');
for(const ev of (d.events||[])){
  const c = ev.competitions[0];
  const home = c.competitors.find(x=>x.homeAway==='home')||c.competitors[0];
  const away = c.competitors.find(x=>x.homeAway==='away')||c.competitors[1];
  const o = (c.odds&&c.odds[0])||{};
  const st = c.status.type.state;
  const fin = (st==='post') ? ((+home.score||0)+(+away.score||0)) : '';
  const oddsList = (c.odds||[]).map(x=>`${x.provider&&x.provider.name}:${x.overUnder}`).join(' | ');
  console.log(
    (away.team.abbreviation+' @ '+home.team.abbreviation).padEnd(14),
    'OU', String(o.overUnder).padStart(5), '('+(o.provider&&o.provider.name||'—')+')',
    '· state', st, '· final', String(fin).padStart(3),
    '\n    all odds:', oddsList || '(none)');
}
