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

export interface FetchResult {
  html: string;
  finalUrl: string;
  statusCode: number;
  usedGotScraping: boolean;
}

/**
 * Fetches a URL and returns the HTML body.
 * Tries got-scraping first (real TLS fingerprint), falls back to native fetch.
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
    return {
      html: response.body,
      finalUrl: response.url,
      statusCode: response.statusCode,
      usedGotScraping: true,
    };
  } catch (gotError) {
    // Fall back to native fetch
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      headers: CHROME_HEADERS as HeadersInit,
      redirect: 'follow',
      signal: controller.signal,
    });

    const html = await response.text();

    return {
      html,
      finalUrl: response.url || url,
      statusCode: response.status,
      usedGotScraping: false,
    };
  } finally {
    clearTimeout(timer);
  }
}
