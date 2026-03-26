/**
 * Hollow Router — pre-pipeline and post-pipeline route overrides.
 *
 * Route 1 — Mobile API Bypass:
 *   Runs BEFORE the Happy DOM pipeline. Detects known mobile API sites,
 *   probes the API endpoint, and returns a structured GDG map if the API
 *   is reachable. Skips HTML fetch + DOM execution entirely.
 *
 * Route 2 — Cache-First Bypass:
 *   Runs BEFORE the Happy DOM pipeline for known paywalled/WAF-heavy domains.
 *   Tries Wayback Machine first, then Bing cache. If found, pipes cached HTML
 *   through the standard DOM+layout pipeline and returns tier: 'cache'.
 *
 * Route 3 — Cache Fallback:
 *   Runs AFTER the pipeline if confidence < 0.5 or a consent wall is detected
 *   on a read-only URL. Same cache fetch logic as Route 2.
 */

// ─── Mobile API Registry ──────────────────────────────────────────────────────

interface MobileAPIConfig {
  apiBase: string;
  userAgent: string;
  headers: Record<string, string>;
  probePath: string;       // path relative to apiBase, or absolute URL
  endpoints: string[];
  authNote: string;
  // Optional: if defined, execute() is called after the probe succeeds and
  // the returned data is passed to format() to produce the real GDG map.
  // If execute() returns null (e.g. auth required), format() is called with
  // null and should return a stub/auth-required message.
  execute?: (url: string) => Promise<unknown>;
  format?: (data: unknown, url: string) => string;
}

// ─── Reddit executor ──────────────────────────────────────────────────────────
// Three-tier fetch strategy for Reddit:
//   1. JSON API with browser Chrome UA  (best — has scores + comment counts)
//   2. JSON API with Reddit mobile UA   (fallback — same data)
//   3. Atom/RSS feed                    (last resort — titles + links only, no scores)
// If all three fail (Reddit blocks server IPs entirely), execute() returns a
// sentinel { blocked: true, subreddit } so format() can emit a redirect stub
// telling the agent to search via Startpage instead.

const REDDIT_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const REDDIT_MOBILE_UA  = 'Reddit/Version/2025.01 android/14';

interface RedditPost {
  title: string;
  score: number;
  num_comments: number;
  author: string;
  url: string;
  permalink: string;
  subreddit: string;
}

interface RedditListing {
  data?: { children?: Array<{ data: RedditPost }> };
}

interface RedditAtomEntry { title: string; href: string; author: string; }
interface RedditAtomResult { type: 'atom'; subreddit: string; entries: RedditAtomEntry[]; }
interface RedditBlockedResult { type: 'blocked'; subreddit: string; }

async function redditFetchJson(fetchUrl: string, ua: string): Promise<RedditListing | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(fetchUrl, {
      headers: { 'User-Agent': ua, 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) return await res.json() as RedditListing;
    console.log(`[hollow/router] Reddit JSON ${res.status} (ua: ${ua.slice(0, 20)}…)`);
    return null;
  } catch (err) {
    clearTimeout(timer);
    console.log(`[hollow/router] Reddit JSON fetch failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function redditFetchAtom(subreddit: string): Promise<RedditAtomResult | null> {
  const atomUrl = `https://www.reddit.com/r/${subreddit}/hot.rss?limit=25`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(atomUrl, {
      headers: {
        'User-Agent': REDDIT_BROWSER_UA,
        'Accept': 'application/atom+xml, application/xml, text/xml',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.log(`[hollow/router] Reddit Atom ${res.status} for r/${subreddit}`);
      return null;
    }
    const xml = await res.text();
    // Parse Atom <entry> elements with regex (no DOM available)
    const entries: RedditAtomEntry[] = [];
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    let match: RegExpExecArray | null;
    while ((match = entryRe.exec(xml)) !== null) {
      const block = match[1];
      const titleM = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
      const hrefM  = block.match(/href="(https:\/\/www\.reddit\.com\/r\/[^"]+)"/);
      const authorM = block.match(/<name>(\/u\/[^<]+)<\/name>/);
      if (titleM && hrefM) {
        entries.push({
          title:  titleM[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
          href:   hrefM[1],
          author: authorM ? authorM[1] : 'unknown',
        });
      }
    }
    console.log(`[hollow/router] Reddit Atom OK — ${entries.length} entries for r/${subreddit}`);
    return entries.length > 0 ? { type: 'atom', subreddit, entries } : null;
  } catch (err) {
    clearTimeout(timer);
    console.log(`[hollow/router] Reddit Atom failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function redditExecute(url: string): Promise<unknown> {
  let subreddit = 'popular';
  let apiPath = '/r/popular/hot.json';
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (parts[0] === 'r' && parts[1]) {
      subreddit = parts[1];
      apiPath = `/r/${parts[1]}/hot.json`;
    }
  } catch { /* use defaults */ }

  const jsonUrl = `https://www.reddit.com${apiPath}?limit=25`;

  // Attempt 1 — JSON API, browser UA
  const json1 = await redditFetchJson(jsonUrl, REDDIT_BROWSER_UA);
  if (json1) { console.log('[hollow/router] Reddit execute: JSON/browser-UA OK'); return json1; }

  // Attempt 2 — JSON API, Reddit mobile UA
  const json2 = await redditFetchJson(jsonUrl, REDDIT_MOBILE_UA);
  if (json2) { console.log('[hollow/router] Reddit execute: JSON/mobile-UA OK'); return json2; }

  // Attempt 3 — Atom feed (no scores, but titles + links)
  const atom = await redditFetchAtom(subreddit);
  if (atom) return atom;

  // All methods blocked — return sentinel for the redirect stub
  console.log(`[hollow/router] Reddit execute: all methods blocked — returning blocked sentinel`);
  const blocked: RedditBlockedResult = { type: 'blocked', subreddit };
  return blocked;
}

function redditFormat(data: unknown, _url: string): string {
  const d = data as ({ type?: string });

  // Atom feed result (no scores)
  if (d && d.type === 'atom') {
    const atom = data as RedditAtomResult;
    let map = `[MOBILE API: reddit.com]\n`;
    map += `[Subreddit: r/${atom.subreddit}]\n`;
    map += `[Source: Reddit Atom feed — titles and links only, no scores]\n\n`;
    map += `[Posts:]\n`;
    atom.entries.slice(0, 15).forEach((e, i) => {
      map += `  [${i + 1}] "${e.title}"\n`;
      map += `      author:${e.author}  permalink: ${e.href}\n`;
    });
    if (atom.entries.length === 0) map += `  (no posts in feed)\n`;
    return map.trimEnd();
  }

  // Blocked sentinel — tell the agent to pivot to Startpage search
  if (d && d.type === 'blocked') {
    const b = data as RedditBlockedResult;
    return [
      `[MOBILE API: reddit.com]`,
      `[Subreddit: r/${b.subreddit}]`,
      `[Status: Reddit API and HTML blocked from server IPs]`,
      `[Action: Search for Reddit content via Startpage instead]`,
      `[Search query: site:reddit.com r/${b.subreddit} hot posts]`,
      `[Navigate to https://www.startpage.com/ and search for the above query]`,
    ].join('\n');
  }

  // JSON API result (full data with scores)
  const listing = data as RedditListing;
  const posts = listing?.data?.children ?? [];
  const subreddit = posts[0]?.data?.subreddit ?? 'popular';

  let map = `[MOBILE API: reddit.com]\n`;
  map += `[Subreddit: r/${subreddit}]\n`;
  map += `[Source: Reddit JSON API — real data]\n\n`;
  map += `[Posts:]\n`;

  posts.slice(0, 15).forEach((child, i) => {
    const p = child.data;
    map += `  [${i + 1}] "${p.title}"\n`;
    map += `      score:${p.score} comments:${p.num_comments} author:u/${p.author}\n`;
    if (p.url && !p.url.includes('reddit.com')) {
      map += `      link: ${p.url}\n`;
    }
    map += `      permalink: reddit.com${p.permalink}\n`;
  });

  if (posts.length === 0) map += `  (no posts returned — subreddit may be private or empty)\n`;
  return map.trimEnd();
}

// ─── Mobile API Registry ──────────────────────────────────────────────────────

const MOBILE_API_REGISTRY: Record<string, MobileAPIConfig> = {
  'twitter.com': {
    apiBase: 'https://api.twitter.com/2',
    userAgent: 'TwitterAndroid/10.0.0',
    headers: {
      'x-twitter-client': 'TwitterAndroid',
      'x-twitter-api-version': '5',
    },
    probePath: '/tweets/search/recent?query=test&max_results=10',
    endpoints: [
      'GET /tweets/search/recent',
      'GET /users/me',
      'GET /users/:id/tweets',
    ],
    authNote: 'required — Bearer token or OAuth 1.0a',
    // No execute: auth always required, stub is the correct response
  },
  'x.com': {
    apiBase: 'https://api.twitter.com/2',
    userAgent: 'TwitterAndroid/10.0.0',
    headers: { 'x-twitter-client': 'TwitterAndroid' },
    probePath: '/tweets/search/recent?query=test&max_results=10',
    endpoints: [
      'GET /tweets/search/recent',
      'GET /users/me',
      'GET /users/:id/tweets',
    ],
    authNote: 'required — Bearer token or OAuth 1.0a',
  },
  'reddit.com': {
    apiBase: 'https://www.reddit.com',
    userAgent: 'Reddit/Version/2025.01 android/14',
    headers: { 'Accept': 'application/json' },
    probePath: 'https://www.reddit.com/.json?limit=1',
    endpoints: [
      'GET /r/:subreddit/hot.json',
      'GET /r/:subreddit/new.json',
      'GET /search.json',
    ],
    authNote: 'optional — public subreddits accessible without auth',
    execute: redditExecute,
    format: redditFormat,
  },
  'old.reddit.com': {
    apiBase: 'https://www.reddit.com',
    userAgent: 'Reddit/Version/2025.01 android/14',
    headers: { 'Accept': 'application/json' },
    probePath: 'https://www.reddit.com/.json?limit=1',
    endpoints: [
      'GET /r/:subreddit.json',
      'GET /search.json',
    ],
    authNote: 'optional — public content accessible without auth',
    execute: redditExecute,
    format: redditFormat,
  },
};

// ─── Mobile API result ────────────────────────────────────────────────────────

export interface MobileAPIResult {
  tier: 'mobile-api';
  gdgMap: string;
  endpoint: string;
  domain: string;
  tokenEstimate: number;
}

// ─── Mobile API Bypass ────────────────────────────────────────────────────────

export async function tryMobileAPIBypass(url: string): Promise<MobileAPIResult | null> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }

  const config = MOBILE_API_REGISTRY[hostname];
  if (!config) return null;

  // ── Path A: entries with execute() — execute IS the probe ─────────────────
  // For APIs with public data (e.g. Reddit), we skip the separate probe and
  // call execute() directly. This avoids a double-fetch and keeps total time
  // within Vercel's lambda limit. If execute() returns null, we fall through
  // to the standard pipeline (not a stub — the page should be navigable).
  if (config.execute && config.format) {
    console.log(`[hollow/router] Mobile API execute ${hostname}: fetching live data…`);
    try {
      const data = await config.execute(url);
      if (data !== null) {
        const gdgMap = config.format(data, url);
        console.log(`[hollow/router] Mobile API execute ${hostname}: OK — ${gdgMap.split('\n').length} lines`);
        return {
          tier: 'mobile-api',
          gdgMap,
          endpoint: config.apiBase,
          domain: hostname,
          tokenEstimate: Math.ceil(gdgMap.length / 4),
        };
      }
      console.log(`[hollow/router] Mobile API execute ${hostname}: returned null — falling through to pipeline`);
      return null;
    } catch (err) {
      console.log(`[hollow/router] Mobile API execute ${hostname}: threw (${err instanceof Error ? err.message : err}) — falling through`);
      return null;
    }
  }

  // ── Path B: probe-only entries — return stub description ──────────────────
  // For APIs that require auth (Twitter/X), a probe confirms the API is
  // reachable and we return a stub telling the agent to provide credentials.
  const probeUrl = config.probePath.startsWith('http')
    ? config.probePath
    : config.apiBase + config.probePath;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);

    const res = await fetch(probeUrl, {
      method: 'GET',
      headers: {
        'User-Agent': config.userAgent,
        'Accept': 'application/json',
        ...config.headers,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    // 200 or 401/403 all confirm the API exists and is reachable
    if (res.status !== 200 && res.status !== 401 && res.status !== 403) {
      console.log(`[hollow/router] Mobile API probe ${hostname}: HTTP ${res.status} — falling through`);
      return null;
    }

    console.log(`[hollow/router] Mobile API probe ${hostname}: HTTP ${res.status} — MOBILE-API stub`);
    const gdgMap = buildMobileAPIGDGMap(hostname, config);
    return {
      tier: 'mobile-api',
      gdgMap,
      endpoint: config.apiBase,
      domain: hostname,
      tokenEstimate: Math.ceil(gdgMap.length / 4),
    };
  } catch (err) {
    console.log(`[hollow/router] Mobile API probe ${hostname}: failed (${err instanceof Error ? err.message : err}) — falling through`);
    return null;
  }
}

function buildMobileAPIGDGMap(domain: string, config: MobileAPIConfig): string {
  const apiHost = new URL(config.apiBase).host;
  const endpointLines = config.endpoints.map(e => `  ${e}`).join('\n');
  return [
    `[MOBILE API: ${domain}]`,
    `[Endpoint: ${apiHost}]`,
    `[Auth: ${config.authNote}]`,
    `[Available endpoints detected:]`,
    endpointLines,
    `[Agent: compose API calls directly using session cookies or Bearer token from Hydra state]`,
  ].join('\n');
}

// ─── Cache-First Domains ──────────────────────────────────────────────────────
// These domains are known to WAF-block or paywall direct fetches.
// For them, cache is attempted BEFORE the Happy DOM pipeline.

const CACHE_FIRST_DOMAINS = new Set([
  // Note: arstechnica.com, techcrunch.com, wired.com, theverge.com,
  // thenextweb.com, venturebeat.com, 9to5mac.com, macrumors.com are handled
  // by the TEXT tier fast path in pipeline.ts — do NOT add them here, as
  // cache-first fires before TEXT tier and would prevent the faster route.
  'wsj.com', 'ft.com', 'bloomberg.com',
  'nytimes.com', 'washingtonpost.com', 'economist.com', 'businessinsider.com',
  'theatlantic.com', 'technologyreview.com', 'forbes.com', 'fortune.com',
]);

export function shouldTryCacheFirst(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return CACHE_FIRST_DOMAINS.has(hostname) ||
      Array.from(CACHE_FIRST_DOMAINS).some(d => hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

// ─── Consent Wall Detection ───────────────────────────────────────────────────
// Detects when the pipeline returned a consent/cookie overlay instead of content.

const CONSENT_PATTERNS = [
  /\bcookies?\b/i,
  /\bconsent\b/i,
  /\baccept all\b/i,
  /\bprivacy policy\b/i,
  /\bGDPR\b/i,
  /\bwe use cookies\b/i,
  /\bcookie settings\b/i,
  /\bmanage (preferences|cookies)\b/i,
];

export function isConsentWall(gdgMap: string): boolean {
  // Count actionable elements — consent walls have very few
  const actionableCount = (gdgMap.match(/^\[\d+\]/mg) ?? []).length;
  if (actionableCount > 10) return false; // real page, not just a wall
  const matchCount = CONSENT_PATTERNS.filter(p => p.test(gdgMap)).length;
  return matchCount >= 2;
}

// ─── Cache Bypass ─────────────────────────────────────────────────────────────

const READ_ONLY_PATH_PATTERNS = [
  /\/(article|articles|post|posts|news|blog|blogs|wiki|docs|doc|page|story|stories|read)\//i,
  /\/\d{4}\/\d{2}\/\d{2}\//,  // date-based paths e.g. /2024/01/15/
];

const READ_ONLY_DOMAINS = new Set([
  'nytimes.com', 'bbc.com', 'bbc.co.uk', 'theguardian.com', 'reuters.com',
  'apnews.com', 'washingtonpost.com', 'ft.com', 'economist.com',
  'wikipedia.org', 'medium.com', 'substack.com', 'wired.com',
  'techcrunch.com', 'arstechnica.com', 'theverge.com',
  'news.ycombinator.com', 'bloomberg.com', 'forbes.com',
]);

export function isReadOnlyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, '');
    if (READ_ONLY_DOMAINS.has(hostname)) return true;
    return READ_ONLY_PATH_PATTERNS.some(p => p.test(parsed.pathname));
  } catch {
    return false;
  }
}

export interface CacheResult {
  html: string;
  cacheUrl: string;
  cacheDate: string;
  source: 'bing' | 'wayback';
}

export async function tryCacheBypass(url: string, label = 'Cache bypass'): Promise<CacheResult | null> {
  let hostname = url;
  try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ok */ }

  // Wayback Machine first — most reliable for paywalled content
  const wayback = await tryWaybackCache(url, hostname, label);
  if (wayback) return wayback;

  // Bing cache fallback
  const bing = await tryBingCache(url, hostname, label);
  if (bing) return bing;

  console.log(`[hollow/router] ${label}: cache miss on both Wayback and Bing for ${hostname} — falling through to direct fetch`);
  return null;
}

async function tryBingCache(url: string, hostname: string, label: string): Promise<CacheResult | null> {
  const cacheUrl =
    `https://cc.bingj.com/cache.aspx?q=${encodeURIComponent(url)}&url=${encodeURIComponent(url)}`;
  console.log(`[hollow/router] ${label}: Bing cache check for ${hostname}`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);

    const res = await fetch(cacheUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HollowBot/1.0)' },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.log(`[hollow/router] ${label}: Bing cache miss for ${hostname} (HTTP ${res.status})`);
      return null;
    }
    const html = await res.text();

    // Sanity check: must be substantial content, not an error page
    if (html.length < 1000 || /no cache|not found|page not found/i.test(html.slice(0, 300))) {
      console.log(`[hollow/router] ${label}: Bing cache miss for ${hostname} (thin/error page)`);
      return null;
    }

    console.log(`[hollow/router] ${label}: Bing cache hit for ${hostname}`);
    return {
      html,
      cacheUrl,
      cacheDate: new Date().toISOString().slice(0, 10),
      source: 'bing',
    };
  } catch (err) {
    console.log(`[hollow/router] ${label}: Bing cache miss for ${hostname} (${err instanceof Error ? err.message : err})`);
    return null;
  }
}

async function tryWaybackCache(url: string, hostname: string, label: string): Promise<CacheResult | null> {
  console.log(`[hollow/router] ${label}: Wayback check for ${hostname}`);
  try {
    // Step 1 — CDX availability check
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);

    const cdxUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const res = await fetch(cdxUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      console.log(`[hollow/router] ${label}: Wayback CDX check failed for ${hostname} (HTTP ${res.status})`);
      return null;
    }

    const data = await res.json() as {
      archived_snapshots?: {
        closest?: { url?: string; timestamp?: string; available?: boolean };
      };
    };

    const closest = data.archived_snapshots?.closest;
    if (!closest?.available || !closest.url || !closest.timestamp) {
      console.log(`[hollow/router] ${label}: Wayback snapshot not found for ${hostname}`);
      return null;
    }

    const ts = closest.timestamp;
    const cacheDate = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

    // Step 2 — fetch the snapshot. Use 'manual' redirect mode so we can guard
    // against Wayback redirecting to archive.org internal pages (terms.php etc).
    const archiveUrl = closest.url; // raw snapshot URL from CDX, no if_ modifier
    console.log(`[hollow/router] ${label}: Wayback snapshot found for ${hostname} (${cacheDate}), fetching…`);

    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), 10_000);

    const archiveRes = await fetch(archiveUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HollowBot/1.0)' },
      signal: controller2.signal,
      redirect: 'manual', // do NOT follow — guard against redirect to terms/about pages
    });
    clearTimeout(timer2);

    // Step 3 — redirect guard: if Wayback bounced us somewhere else, treat as miss
    if (archiveRes.status >= 300 && archiveRes.status < 400) {
      const location = archiveRes.headers.get('location') ?? '';
      if (!location.includes('web.archive.org/web/')) {
        console.log(`[hollow/router] ${label}: Wayback redirected to non-archive URL for ${hostname} (${location.slice(0, 80)}) — treating as miss`);
        return null;
      }
      // Rare: redirect within the archive itself — fall through as miss to keep it simple
      console.log(`[hollow/router] ${label}: Wayback redirect within archive for ${hostname} — treating as miss`);
      return null;
    }

    if (!archiveRes.ok) {
      console.log(`[hollow/router] ${label}: Wayback fetch failed for ${hostname} (HTTP ${archiveRes.status})`);
      return null;
    }

    let html = await archiveRes.text();

    // Step 4 — strip Wayback toolbar injection to prevent its JS from polluting logs
    html = html.replace(
      /<!-- BEGIN WAYBACK TOOLBAR INSERT -->[\s\S]*?<!-- END WAYBACK TOOLBAR INSERT -->/g,
      ''
    );

    console.log(`[hollow/router] ${label}: Wayback cache hit for ${hostname} (snapshot ${cacheDate})`);
    return { html, cacheUrl: archiveUrl, cacheDate, source: 'wayback' };
  } catch (err) {
    console.log(`[hollow/router] ${label}: Wayback fetch failed for ${hostname} (${err instanceof Error ? err.message : err})`);
    return null;
  }
}

// ─── Parallel route racing ────────────────────────────────────────────────────
//
// For URLs in MOBILE_API_REGISTRY or CACHE_FIRST_DOMAINS the fast route and
// the full Happy DOM pipeline are fired simultaneously.  Promise.race() picks
// whichever resolves first; if the fast-route result meets the confidence
// threshold the pipeline result is discarded.

export type FastRouteRaw =
  | { kind: 'mobile-api'; mobileResult: MobileAPIResult }
  | { kind: 'cache';      cacheResult: CacheResult };

/**
 * Returns true when the URL has a registered fast route — a mobile-API
 * endpoint or a paywall-bypassing cache entry in CACHE_FIRST_DOMAINS.
 */
export function isFastRouteCandidate(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return !!MOBILE_API_REGISTRY[hostname] || shouldTryCacheFirst(url);
  } catch {
    return false;
  }
}

/**
 * Fire all applicable fast routes for `url` concurrently and return the first
 * non-null result.
 *
 * Race this against the full Happy DOM pipeline in pipeline.ts:
 *
 *   const winner = await Promise.race([fetchFastRoute(url), pipelinePromise]);
 *
 * Returns null when all fast routes miss (every check resolves to null).
 */
export function fetchFastRoute(url: string): Promise<FastRouteRaw | null> {
  const tasks: Promise<FastRouteRaw | null>[] = [];

  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    if (MOBILE_API_REGISTRY[hostname]) {
      tasks.push(
        tryMobileAPIBypass(url)
          .then(r => r ? ({ kind: 'mobile-api', mobileResult: r } as FastRouteRaw) : null)
          .catch(() => null),
      );
    }
  } catch { /* ignore bad URL */ }

  if (shouldTryCacheFirst(url)) {
    tasks.push(
      tryCacheBypass(url, 'Parallel cache')
        .then(r => r ? ({ kind: 'cache', cacheResult: r } as FastRouteRaw) : null)
        .catch(() => null),
    );
  }

  if (tasks.length === 0) return Promise.resolve(null);

  // Resolve with the first non-null result; resolve null only after all settle.
  return new Promise<FastRouteRaw | null>(resolve => {
    let remaining = tasks.length;
    for (const t of tasks) {
      t.then(result => {
        if (result !== null) resolve(result);
        else if (--remaining === 0) resolve(null);
      }).catch(() => {
        if (--remaining === 0) resolve(null);
      });
    }
  });
}
