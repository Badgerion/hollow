/**
 * Hollow Router — pre-pipeline and post-pipeline route overrides.
 *
 * Route 1 — Mobile API Bypass:
 *   Runs BEFORE the Happy DOM pipeline. Detects known mobile API sites,
 *   probes the API endpoint, and returns a structured GDG map if the API
 *   is reachable. Skips HTML fetch + DOM execution entirely.
 *
 * Route 2 — Cache Bypass:
 *   Runs AFTER the pipeline if confidence < 0.5 and the URL looks read-only.
 *   Tries Bing cache first, then Wayback Machine. Returns the cached HTML
 *   for the caller to re-run through the DOM+layout pipeline.
 */

// ─── Mobile API Registry ──────────────────────────────────────────────────────

interface MobileAPIConfig {
  apiBase: string;
  userAgent: string;
  headers: Record<string, string>;
  probePath: string;       // path relative to apiBase, or absolute URL
  endpoints: string[];
  authNote: string;
}

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
    apiBase: 'https://oauth.reddit.com',
    userAgent: 'Reddit/Version/2025.01 android/14',
    headers: { 'x-reddit-device-id': 'hollow-agent' },
    probePath: 'https://www.reddit.com/.json?limit=1',
    endpoints: [
      'GET /api/v1/me',
      'GET /r/:subreddit/hot.json',
      'GET /r/:subreddit/new.json',
      'GET /search.json',
    ],
    authNote: 'optional — public subreddits accessible without auth',
  },
  'old.reddit.com': {
    apiBase: 'https://www.reddit.com',
    userAgent: 'Reddit/Version/2025.01 android/14',
    headers: {},
    probePath: 'https://www.reddit.com/.json?limit=1',
    endpoints: [
      'GET /.json',
      'GET /r/:subreddit.json',
      'GET /search.json',
    ],
    authNote: 'optional — public content accessible without auth',
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

export async function tryCacheBypass(url: string): Promise<CacheResult | null> {
  // Bing cache first — faster and often fresher
  const bing = await tryBingCache(url);
  if (bing) return bing;

  // Wayback Machine fallback
  const wayback = await tryWaybackCache(url);
  return wayback;
}

async function tryBingCache(url: string): Promise<CacheResult | null> {
  const cacheUrl =
    `https://cc.bingj.com/cache.aspx?q=${encodeURIComponent(url)}&url=${encodeURIComponent(url)}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);

    const res = await fetch(cacheUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HollowBot/1.0)' },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const html = await res.text();

    // Sanity check: must be substantial content, not an error page
    if (html.length < 1000 || /no cache|not found|page not found/i.test(html.slice(0, 300))) {
      return null;
    }

    console.log('[hollow/router] Cache bypass: Bing cache hit');
    return {
      html,
      cacheUrl,
      cacheDate: new Date().toISOString().slice(0, 10),
      source: 'bing',
    };
  } catch {
    return null;
  }
}

async function tryWaybackCache(url: string): Promise<CacheResult | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);

    const cdxUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const res = await fetch(cdxUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return null;

    const data = await res.json() as {
      archived_snapshots?: {
        closest?: { url?: string; timestamp?: string; available?: boolean };
      };
    };

    const closest = data.archived_snapshots?.closest;
    if (!closest?.available || !closest.url || !closest.timestamp) {
      console.log('[hollow/router] Cache bypass: no Wayback snapshot found');
      return null;
    }

    const ts = closest.timestamp;
    const cacheDate = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

    // Use if_ modifier to prevent Wayback from injecting its toolbar into the HTML
    const archiveUrl = closest.url.replace('/web/', '/web/if_/');

    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), 10_000);

    const archiveRes = await fetch(archiveUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HollowBot/1.0)' },
      signal: controller2.signal,
      redirect: 'follow',
    });
    clearTimeout(timer2);

    if (!archiveRes.ok) return null;
    const html = await archiveRes.text();

    console.log(`[hollow/router] Cache bypass: Wayback snapshot ${cacheDate}`);
    return { html, cacheUrl: archiveUrl, cacheDate, source: 'wayback' };
  } catch {
    console.log('[hollow/router] Cache bypass: no cache found, proceeding with direct fetch');
    return null;
  }
}
