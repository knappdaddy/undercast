# UnderCast odds proxy (Cloudflare Worker)

Serves live book lines to **everyone who opens your UnderCast link** using **one
key you pay for** — without the key ever being public. The key lives only as a
Cloudflare **secret**; it is never in this repo and never reaches any browser.

## What it does

- The site calls this Worker instead of The Odds API directly.
- The Worker adds the key server-side and forwards the request.
- **Origin lock:** it only answers requests coming from your site
  (`ALLOWED_ORIGINS` in `undercast-odds.js`).
- **Shared 60s cache:** all visitors share one upstream call per minute, so a
  busy game day costs a handful of credits — not one per viewer.
- **Optional rate limit:** a per-IP daily cap if you bind a KV namespace.

> A public link isn't a true secret — anyone you send it to can forward it. The
> origin lock + cache + rate limit keep your **key private** and your **credit
> burn bounded**. To cut off access entirely, rotate the key (below).

## Deploy (about 5 minutes)

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.

```bash
cd worker
npx wrangler login                 # opens a browser to authorize
npx wrangler secret put ODDS_API_KEY
#   ↳ paste your Odds API key when prompted (this is the only place it lives)
npx wrangler deploy
```

`deploy` prints a URL like:

```
https://undercast-odds.YOUR-SUBDOMAIN.workers.dev
```

Copy that URL into `index.html` — set the `ODDS_PROXY` constant (search for
`const ODDS_PROXY`) to it, commit, and push. Live odds are now on for anyone
who opens the site, with no key entry.

### If your site domain differs

Edit `ALLOWED_ORIGINS` in `undercast-odds.js` to match where the site is served
(e.g. a custom domain), then `npx wrangler deploy` again.

### Optional: per-IP daily rate limit

```bash
npx wrangler kv namespace create RL      # prints an id
# paste the id into wrangler.toml and uncomment the [[kv_namespaces]] block
npx wrangler deploy
```

Tune `DAILY_CAP` in `undercast-odds.js` (default 300 requests/IP/day).

## Rotate / revoke the key

Generate a new key at the-odds-api.com, then:

```bash
cd worker
npx wrangler secret put ODDS_API_KEY     # paste the new key
```

The old key is now dead everywhere; no site change needed.

## Costs

Cloudflare Workers' free tier (100k requests/day) is far more than this needs.
Odds API credits are spent only on real upstream calls, which the 60s cache
collapses across all viewers.
