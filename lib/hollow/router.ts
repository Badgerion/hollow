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
// Shared execute + format for reddit.com and old.reddit.com.
// execute() fetches real post data from the public JSON API.
// format() converts the JSON response into a GDG map the agent can read directly.

async function redditExecute(url: string): Promise<unknown> {
  let apiPath = '/r/popular/hot.json';
  try {
    const urlObj = new URL(url);
    const parts = urlObj.pathname.split('/').filter(Boolean);
    if (parts[0] === 'r' && parts[1]) {
      apiPath = `/r/${parts[1]}/hot.json`;
    }
  } catch { /* use default */ }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`https://www.reddit.com${apiPath}?limit=25`, {
      headers: {
        'User-Agent': 'Reddit/Version/2025.01 android/14',
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.log(`[hollow/router] Reddit execute: HTTP ${res.status} for ${apiPath}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    console.log(`[hollow/router] Reddit execute: failed (${err instanceof Error ? err.message : err})`);
    return null;
  }
}

interface RedditPost {
  title: string;
  score: number;
  num_comments: number;
  author: string;
  url: string;
  permalink: string;
  subreddit: string;
  is_self: boolean;
}

interface RedditListing {
  data?: { children?: Array<{ data: RedditPost }> };
}

function redditFormat(data: unknown, _url: string): string {
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

  if (posts.length === 0) {
    map += `  (no posts returned — subreddit may be private or empty)\n`;
  }

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

    // 200 or 401 both confirm the API exists and is reachable
    if (res.status !== 200 && res.status !== 401 && res.status !== 403) {
      console.log(`[hollow/router] Mobile API probe ${hostname}: HTTP ${res.status} — falling through`);
      return null;
    }

    console.log(`[hollow/router] Mobile API probe ${hostname}: HTTP ${res.status} — MOBILE-API tier`);

    // If the registry entry has an executor, fetch real data now.
    // Fall back to the stub-description map only if execute() returns null.
    let gdgMap: string;
    if (config.execute && config.format) {
      console.log(`[hollow/router] Mobile API execute ${hostname}: fetching live data…`);
      const data = await config.execute(url);
      if (data !== null) {
        gdgMap = config.format(data, url);
        console.log(`[hollow/router] Mobile API execute ${hostname}: got real data (${gdgMap.split('\n').length} lines)`);
      } else {
        console.log(`[hollow/router] Mobile API execute ${hostname}: no data returned, using stub`);
        gdgMap = buildMobileAPIGDGMap(hostname, config);
      }
    } else {
      gdgMap = buildMobileAPIGDGMap(hostname, config);
    }

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
