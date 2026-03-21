/**
 * Network layer — fetches URLs mimicking Chrome's HTTP headers.
 *
 * Phase 1: uses native fetch with Chrome-realistic headers.
 * Full TLS fingerprint mimicry (got-scraping / node-libcurl JA3/JA4) is
 * documented as a sidecar microservice for production deployments on Fly.io.
 *
 * got-scraping is wired in via dynamic import so it degrades gracefully when
 * the ESM module isn't available in constrained environments (e.g. Vercel edge).
 */

const CHROME_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

// Minimal curl-style headers — some Cloudflare configs block the Chrome
// fingerprint but allow plain bot-like requests through.
const MINIMAL_HEADERS = {
  'User-Agent': 'curl/8.4.0',
  'Accept': '*/*',
};

// WAF / error-page patterns checked against the first 512 bytes of the body.
const WAF_PATTERN =
  /^(An error|Access denied|Forbidden|Just a moment|Attention Required|Sorry, you have been blocked|Please enable JavaScript and cookies|Enable JavaScript and cookies to continue)/i;

function isWAFBlock(html: string): boolean {
  return WAF_PATTERN.test(html.slice(0, 512));
}

// ─── Structured network errors ────────────────────────────────────────────────

export class NetworkFetchError extends Error {
  constructor(
    public readonly code: 'fetch_failed' | 'waf_block',
    public readonly statusCode?: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'NetworkFetchError';
  }
}

export interface FetchResult {
  html: string;
  finalUrl: string;
  statusCode: number;
  usedGotScraping: boolean;
}

// ─── Minimal-header retry ────────────────────────────────────────────────────

async function fetchMinimal(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      headers: MINIMAL_HEADERS as HeadersInit,
      redirect: 'follow',
      signal: controller.signal,
    });
    return {
      html: await res.text(),
      finalUrl: res.url || url,
      statusCode: res.status,
      usedGotScraping: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── WAF check + optional retry ──────────────────────────────────────────────

async function validateAndRetry(result: FetchResult, url: string): Promise<FetchResult> {
  if (result.statusCode >= 400) {
    throw new NetworkFetchError(
      'fetch_failed',
      result.statusCode,
      `Site returned HTTP ${result.statusCode}`,
    );
  }

  if (isWAFBlock(result.html)) {
    console.log('[hollow/network] WAF block detected, retrying with minimal headers');
    const retry = await fetchMinimal(url);

    if (retry.statusCode >= 400) {
      throw new NetworkFetchError(
        'fetch_failed',
        retry.statusCode,
        `Site returned HTTP ${retry.statusCode}`,
      );
    }
    if (isWAFBlock(retry.html)) {
      throw new NetworkFetchError('waf_block', undefined, 'WAF blocked the request');
    }
    return retry;
  }

  return result;
}

// ─── Public fetch entry point ─────────────────────────────────────────────────

/**
 * Fetches a URL and returns the HTML body.
 * Tries got-scraping first (real TLS fingerprint), falls back to native fetch.
 * On HTTP errors or WAF blocks, throws NetworkFetchError.
 * WAF blocks are retried once with minimal headers before giving up.
 */
export async function fetchUrl(url: string): Promise<FetchResult> {
  // Attempt got-scraping for proper TLS fingerprinting
  try {
    const { gotScraping } = await import('got-scraping');
    const response = await gotScraping({
      url,
      headers: CHROME_HEADERS,
      followRedirect: true,
      timeout: { request: 15_000 },
    });
    const result: FetchResult = {
      html: response.body,
      finalUrl: response.url,
      statusCode: response.statusCode,
      usedGotScraping: true,
    };
    return await validateAndRetry(result, url);
  } catch (err) {
    if (err instanceof NetworkFetchError) throw err;
    // got-scraping unavailable or threw — fall back to native fetch
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      headers: CHROME_HEADERS as HeadersInit,
      redirect: 'follow',
      signal: controller.signal,
    });

    const result: FetchResult = {
      html: await response.text(),
      finalUrl: response.url || url,
      statusCode: response.status,
      usedGotScraping: false,
    };
    return await validateAndRetry(result, url);
  } finally {
    clearTimeout(timer);
  }
}
