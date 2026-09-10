# UnderCast — NFL & College Weather Totals

*Forecasting the under.*

A mobile-first web app that flags point totals (over/unders) inflated by **weather** and leans
**UNDER** when the model disagrees with the book. Single, dependency-free `index.html`.

**Live:** deployed via GitHub Pages. Open `index.html` locally or serve it — it runs on live data
straight from the browser (no build, no keys required for the basics).

## The model — calibrated and validated on 15 years of results

The edge is weather, and only weather. Every factor below was tested against real closing lines +
results (2010–2024, nflverse) before being kept; the tooling lives in `tools/` and runs in CI.

`Adjusted Total = Market Total − Weather Penalty`, penalty = sum of:

| Factor | Rule | Backtest |
| --- | --- | --- |
| **Wind** | 0 <10 mph · 0.18/mph to 20 · **flat above 20** | 10–19 mph → **54–56% unders** ✅ |
| **Rain** | 0.8 / 1.8 / 2.8 (light/mod/heavy) | rain → **56–62% unders** ✅ |
| **Snow** | **0 — neutral** | snowy totals trend **over**, so no penalty |
| **Cold** | 0.3 / 0.6 / 1.0 (wind-chill feels-like) | ~coin flip → trimmed |
| **Heat** | 0.5 / 1.0 (>85 / >92 °F) | small |

Penalty ≥ 1.5 → **UNDER** lean; ≥ 2.5 → strong. Weather is read at the **kickoff hour** — a backtest
showed that beats averaging over the game window (61.6% vs 59.2% on flagged unders).

### What we tested and rejected (so the model stays honest)

Rigorous backtests killed every non-weather add-on: **book-vs-sharp inflation** (~44–48%),
**crowd/primetime/situational** (~50%, some backwards), **team pace** (priced in), and
**crosswind direction** (dissolved with correct OSM field geometry + full sample). The market
prices everything it can model; it's slow only on weather.

## Live games — real time

Toggle **🔴 Live** and the board updates itself:

- **Scores** refresh every **~30 s** while any game is in progress (60 s otherwise), from ESPN.
- **Lines** refresh from your book (throttled to ~90 s to save odds-API credits) when a key is set;
  otherwise from ESPN's consensus total.
- **Total-over-time** sparkline builds a live trend as the number moves.
- **Scoring-pace** projection shows whether a game is trending under in real time.
- A freshness indicator shows how many seconds ago it last updated.

## Leagues

**🏈 NFL / 🎓 College** toggle. College adds a conference cycler defaulting to the **AP Top 25**
(SEC, Big Ten, Big 12, ACC + Group of Five). College venue weather is geocoded per stadium.

## Data (free, keyless for the basics)

- **Schedule, venues, scores, totals** — ESPN public scoreboards.
- **Weather** — Open-Meteo, per venue at kickoff.
- **Optional exact book lines + live in-play totals** — add a [The Odds API](https://the-odds-api.com)
  key under ⚙ Settings (stored only in your browser).

## Backtest tools (`tools/`)

`backtest.mjs` (wind/cold), `backtest-precip.mjs` (+ precip), `backtest-situational.mjs`,
`backtest-pace.mjs`, `backtest-market.mjs`, `backtest-crosswind.mjs`, `backtest-gamewindow.mjs`.
Most run free on nflverse; weather/odds ones run in GitHub Actions. All reproducible.

## Disclaimer

For entertainment only. Not betting advice, not a guarantee. 21+. If gambling stops being fun,
call **1-800-GAMBLER**.
