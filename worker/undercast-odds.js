/* =========================================================================
   UnderCast odds proxy — Cloudflare Worker

   Keeps your The Odds API key server-side. The static site calls THIS worker;
   the worker injects the key (a Worker secret, never in the repo) and forwards
   to The Odds API. The key never reaches any browser.

   Protections:
     • Origin lock   — only answers requests from ALLOWED_ORIGINS (your site).
     • Endpoint lock — only forwards the NFL/NCAAF odds endpoints.
     • Shared cache  — one upstream call per 60s is reused by all visitors, so a
                       busy Sunday burns a handful of credits, not one per view.
     • Rate limit    — optional per-IP daily cap (needs a KV binding named RL).

   Deploy: see worker/README.md
   ========================================================================= */

const UPSTREAM  = 'https://api.the-odds-api.com';
const ALLOWED_ORIGINS = [
  'https://knappdaddy.github.io',   // GitHub Pages (UnderCast)
];
const PATH_OK   = /^\/v4\/sports\/americanfootball_(nfl|ncaaf)\/odds\/?$/;
const DAILY_CAP = 300;   // per-IP requests/day (only enforced if RL KV is bound)
const CACHE_TTL = 60;    // seconds; shared across every visitor

function corsHeaders(origin){
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(req, env, ctx){
    const url     = new URL(req.url);
    const origin  = req.headers.get('Origin')  || '';
    const referer = req.headers.get('Referer') || '';
    const cors    = corsHeaders(origin);

    if(req.method === 'OPTIONS') return new Response(null, {status:204, headers:cors});
    if(req.method !== 'GET')     return new Response('Method not allowed', {status:405, headers:cors});

    // Origin lock — allow browser calls only from our own site.
    const okOrigin = ALLOWED_ORIGINS.some(o => origin === o || referer.startsWith(o));
    if(!okOrigin) return new Response('Forbidden', {status:403, headers:cors});

    // Endpoint lock.
    if(!PATH_OK.test(url.pathname)) return new Response('Not found', {status:404, headers:cors});

    if(!env.ODDS_API_KEY)
      return new Response('Proxy not configured: set the ODDS_API_KEY secret.', {status:500, headers:cors});

    // Optional per-IP daily rate limit (best-effort; needs a KV namespace bound as RL).
    if(env.RL){
      const ip  = req.headers.get('CF-Connecting-IP') || 'anon';
      const day = new Date().toISOString().slice(0,10);
      const k   = `rl:${ip}:${day}`;
      const n   = parseInt(await env.RL.get(k) || '0', 10);
      if(n >= DAILY_CAP) return new Response('Daily limit reached', {status:429, headers:cors});
      ctx.waitUntil(env.RL.put(k, String(n+1), {expirationTtl: 90000}));
    }

    // Cache key WITHOUT the secret, so all visitors share the same cached upstream call.
    const publicParams = new URLSearchParams(url.search); publicParams.delete('apiKey');
    const cacheKey = new Request(`${UPSTREAM}${url.pathname}?${publicParams.toString()}`, {method:'GET'});
    const cache = caches.default;

    let res = await cache.match(cacheKey);
    if(!res){
      const upParams = new URLSearchParams(url.search);
      upParams.delete('apiKey');
      upParams.set('apiKey', env.ODDS_API_KEY);       // inject the secret here only
      const upstream = `${UPSTREAM}${url.pathname}?${upParams.toString()}`;
      const up = await fetch(upstream, {headers:{'Accept':'application/json'}});
      res = new Response(up.body, up);
      res.headers.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
      if(up.status === 200) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }

    const out = new Response(res.body, res);
    for(const [k,v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  }
};
