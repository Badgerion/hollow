/**
 * Core pipeline — orchestrates the full Hollow perception pass.
 *
 * Step sequence (per spec):
 *   1. Network fetch (Chrome TLS headers)
 *   2. Happy DOM — parse + execute JS
 *   3. CSS resolver — extract computed styles
 *   4. Yoga — Flexbox layout
 *   5. Grid resolver — CSS Grid layout
 *   6. GDG Spatial — structured perception tree
 *   7. Confidence scoring
 *   8. Session persistence (KV)
 *   9. SSE emit → Matrix Mirror
 *  10. Response
 */

import { v4 as uuidv4 } from 'uuid';
import { join } from 'path';
import { Worker, isMainThread } from 'worker_threads';
import { fetchUrl, NetworkFetchError } from './network';
import { tryMobileAPIBypass, tryCacheBypass, isReadOnlyUrl, shouldTryCacheFirst, isConsentWall } from './router';
import { buildDOM } from './dom';
import { resolveStyles } from './css-resolver';
import { calculateLayout, calculateSubtreeLayout } from './yoga-layout';
import { resolveGridLayout } from './grid-resolver';
import { generateGDGSpatial } from './gdg-spatial';
import { findFiberRoots, traverseFiber, generateVDOMMap } from './vdom';
import { scoreConfidence } from './confidence';
import { loadSession, saveSession, newSession, bumpSession } from './session';
import { getEmitter } from './sse-emitter';
import type { HollowPerceiveResult, PerceiveRequest, SessionState } from './types';
import type { LayoutBox } from './yoga-layout';

// ─── Text-heavy page detection ───────────────────────────────────────────────

function isTextHeavyPage(html: string, url: string): boolean {
  const isLarge = html.length > 80_000;

  const textDomains = [
    'news.ycombinator.com',
    'reddit.com',
    'old.reddit.com',
    'lobste.rs',
    'tildes.net',
  ];

  let domain: string;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return false;
  }

  const isKnownTextSite = textDomains.some(d => domain === d || domain.endsWith('.' + d));

  const scriptCount = (html.match(/<script/gi) ?? []).length;
  const htmlKb = html.length / 1024;
  const isLowJS = scriptCount < 10 && htmlKb > 50;

  return isKnownTextSite || (isLarge && isLowJS);
}

// ─── Lightweight text-tier GDG generator ─────────────────────────────────────

function generateTextTierGDG(
  html: string,
  url: string,
): { gdgMap: string; actionableCount: number; tokenEstimate: number } {
  function stripTags(s: string): string {
    return s
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).slice(0, 200) : '(no title)';

  // Headings h1–h3
  const headings: { level: string; text: string }[] = [];
  const headingRe = /<(h[123])[^>]*>([\s\S]*?)<\/h[123]>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = headingRe.exec(html)) !== null) {
    const text = stripTags(hm[2]).slice(0, 150);
    if (text) headings.push({ level: hm[1].toLowerCase(), text });
    if (headings.length >= 30) break;
  }

  // Links — skip anchors and javascript: hrefs
  const links: { text: string; href: string }[] = [];
  const linkRe = /<a\s[^>]*href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html)) !== null) {
    const href = lm[2].trim();
    const text = stripTags(lm[3]).slice(0, 120);
    if (text && !href.startsWith('#') && !href.startsWith('javascript:')) {
      links.push({ text, href });
    }
    if (links.length >= 200) break;
  }

  // Paragraphs
  const paragraphs: string[] = [];
  const paraRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pm: RegExpExecArray | null;
  while ((pm = paraRe.exec(html)) !== null) {
    const text = stripTags(pm[1]).slice(0, 400);
    if (text.length > 20) paragraphs.push(text);
    if (paragraphs.length >= 60) break;
  }

  let domain: string;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    domain = url;
  }

  const lines: string[] = [
    `[TEXT: ${domain} — direct extraction]`,
    `[Title: ${title}]`,
    `[Mode: fast text extract — no layout engine]`,
    '',
  ];

  if (headings.length > 0) {
    lines.push('[Headings:]');
    for (const h of headings) lines.push(`  ${h.level}: ${h.text}`);
    lines.push('');
  }

  if (links.length > 0) {
    lines.push('[Links:]');
    links.forEach((l, i) => lines.push(`  [${i + 1}] a "${l.text}"  href:${l.href}`));
    lines.push('');
  }

  if (paragraphs.length > 0) {
    lines.push('[Content:]');
    for (const p of paragraphs) lines.push(`  p: "${p}"`);
  }

  const gdgMap = lines.join('\n');
  return {
    gdgMap,
    actionableCount: links.length,
    tokenEstimate: Math.ceil(gdgMap.length / 4),
  };
}

/** Wraps a step with named entry/exit logs and a rethrowing catch. */
async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  console.log(`[hollow/pipeline] ${name}: start`);
  try {
    const result = await fn();
    console.log(`[hollow/pipeline] ${name}: done`);
    return result;
  } catch (err) {
    console.error(`[hollow/pipeline] ${name}: FAILED —`, err);
    throw err;
  }
}

// ─── Shared: run DOM+layout+GDG on cached HTML ───────────────────────────────

async function processCachedHtml(
  cacheResult: import('./router').CacheResult,
  finalUrl: string,
  sessionId: string,
  existingSession: import('./types').SessionState | null,
): Promise<{
  gdgMap: string; html: string; confidence: number; tier: 'cache';
  elementCount: number; actionableCount: number; tokenEstimate: number;
  jsErrors: import('./types').JSError[];
  deductions: import('./types').ConfidenceDeduction[];
}> {
  const { window: cWin, document: cDoc, vitality: cVit } =
    await buildDOM(cacheResult.html, finalUrl);

  const { layoutMap: cLayoutMap, deductions: cDeductions } =
    await calculateLayout(cDoc.body as unknown as Element, cWin);

  const cGdg = generateGDGSpatial(
    cDoc.body as unknown as Element, cWin, cLayoutMap,
    new Map(), new Map(), new Map()
  );

  const source = cacheResult.source === 'bing' ? 'Bing Cache' : 'Wayback Machine';
  const cacheHeader = `[CACHE: ${source} snapshot from ${cacheResult.cacheDate}]\n[Note: content may be out of date]\n\n`;
  const gdgMap = cacheHeader + cGdg.map;
  const confidence = 0.70;

  cWin.happyDOM.close();

  const sessionState: import('./types').SessionState = {
    ...(existingSession
      ? bumpSession(existingSession, cacheResult.html)
      : newSession(sessionId, finalUrl, cacheResult.html)),
    gdgMap,
    confidence,
    tier: 'cache',
    tokenEstimate: cGdg.tokenEstimate,
  };
  await saveSession(sessionState);

  return {
    gdgMap, html: cacheResult.html, confidence, tier: 'cache',
    elementCount: cLayoutMap.size, actionableCount: cGdg.actionableCount,
    tokenEstimate: cGdg.tokenEstimate, jsErrors: cVit.getErrors(),
    deductions: cDeductions,
  };
}

/**
 * Public entry point.
 *
 * - On Vercel (process.env.VERCEL set): each lambda is an isolated process,
 *   so there is no shared event loop to block — run inline.
 * - In a worker thread (isMainThread === false): already off the main thread,
 *   run inline to avoid infinite recursion.
 * - Locally (main thread, no VERCEL): spawn a worker thread so Happy DOM's
 *   synchronous JS execution doesn't block the HTTP event loop.
 */
export async function perceive(req: PerceiveRequest): Promise<HollowPerceiveResult> {
  if (process.env.VERCEL || !isMainThread) {
    return perceiveCore(req);
  }
  return perceiveInWorker(req);
}

async function perceiveInWorker(req: PerceiveRequest): Promise<HollowPerceiveResult> {
  return new Promise((resolve, reject) => {
    // process.cwd() is the project root — reliable across Next.js webpack transforms
    const workerPath = join(process.cwd(), 'lib', 'hollow', 'pipeline-worker.ts');
    const worker = new Worker(workerPath, {
      workerData: req,
      // tsx v4: --import tsx registers the TypeScript loader for the worker
      execArgv: ['--import', 'tsx'],
    });

    worker.on('message', (msg: { ok: boolean; result?: HollowPerceiveResult; error?: string }) => {
      if (msg.ok) resolve(msg.result!);
      else reject(new Error(msg.error ?? 'Pipeline worker failed'));
    });
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code !== 0) reject(new Error(`Pipeline worker exited with code ${code}`));
    });
  });
}

export async function perceiveCore(req: PerceiveRequest): Promise<HollowPerceiveResult> {
  // Strip optional sess: prefix — internal IDs are bare UUIDs; prefix is external-only
  const sessionId = req.sessionId ? req.sessionId.replace(/^sess:/, '') : uuidv4();
  const emit = getEmitter();
  const now = () => new Date().toISOString();

  console.log(`[hollow/pipeline] start sessionId=${sessionId} url=${req.url ?? '(html)'}`);

  // ── Step 1: Load or fetch HTML ───────────────────────────────────────────────
  let html: string;
  let finalUrl: string;

  const existingSession = await step('1-load-session', () =>
    req.sessionId ? loadSession(req.sessionId) : Promise.resolve(null)
  );

  if (existingSession) {
    html = existingSession.html;
    finalUrl = existingSession.url;
    console.log(`[hollow/pipeline] 1-load-session: resuming existing session url=${finalUrl}`);
  } else if (req.html) {
    html = req.html;
    finalUrl = req.url ?? 'about:blank';
    console.log(`[hollow/pipeline] 1-load-session: using provided html length=${html.length}`);
  } else {
    if (!req.url) throw new Error('`url` is required when `html` is not provided');

    // ── Step 1b: Mobile API Bypass (before HTML fetch) ──────────────────────────
    const mobileResult = await step('1b-mobile-api', () => tryMobileAPIBypass(req.url!));
    if (mobileResult) {
      const ts = now();
      const sessionState: SessionState = {
        ...newSession(sessionId, req.url!, ''),
        gdgMap: mobileResult.gdgMap,
        confidence: 1.0,
        tier: 'mobile-api',
        tokenEstimate: mobileResult.tokenEstimate,
      };
      await step('8-session-save', () => saveSession(sessionState));

      emit.emit(sessionId, 'dom_delta', { html: '', url: req.url! });
      emit.emit(sessionId, 'gdg_map', {
        map: mobileResult.gdgMap,
        confidence: 1.0,
        tier: 'mobile-api',
        actionableCount: 0,
        tokenEstimate: mobileResult.tokenEstimate,
        timestamp: ts,
      });
      emit.emit(sessionId, 'confidence', { score: 1.0, tier: 'mobile-api', deductions: [], timestamp: ts });
      emit.emit(sessionId, 'log_entry', {
        tag: 'GDG',
        message: `Mobile API bypass: ${mobileResult.domain}. Tier: mobile-api.`,
        timestamp: ts,
      });
      emit.emit(sessionId, 'tier', { tier: 'mobile-api' });

      console.log(`[hollow/pipeline] complete sessionId=sess:${sessionId} tier=mobile-api domain=${mobileResult.domain}`);
      return {
        sessionId: `sess:${sessionId}`,
        gdgMap: mobileResult.gdgMap,
        domDelta: '',
        confidence: 1.0,
        confidenceDeductions: [],
        jsErrors: [],
        tier: 'mobile-api',
        elementCount: 0,
        actionableCount: 0,
        tokenEstimate: mobileResult.tokenEstimate,
      };
    }

    // ── Step 1c: Cache-First — skip direct fetch for known paywalled domains ─────
    if (shouldTryCacheFirst(req.url!)) {
      const hostname = new URL(req.url!).hostname.replace(/^www\./, '');
      emit.emitLog(sessionId, 'SYS', `Cache-first route: trying cached version of ${hostname}`);
      const cacheResult = await step('1c-cache-first', () => tryCacheBypass(req.url!, 'Cache first'));
      if (cacheResult) {
        const cached = await step('1c-cache-pipeline', () =>
          processCachedHtml(cacheResult, req.url!, sessionId, existingSession)
        );
        const ts = now();
        const source = cacheResult.source === 'bing' ? 'Bing Cache' : 'Wayback Machine';
        emit.emit(sessionId, 'dom_delta', { html: cached.html, url: req.url! });
        emit.emit(sessionId, 'gdg_map', { map: cached.gdgMap, confidence: cached.confidence, tier: 'cache', actionableCount: cached.actionableCount, tokenEstimate: cached.tokenEstimate, timestamp: ts });
        emit.emit(sessionId, 'confidence', { score: cached.confidence, tier: 'cache', deductions: cached.deductions, timestamp: ts });
        emit.emit(sessionId, 'log_entry', { tag: 'GDG', message: `Cache-first hit: ${source} snapshot from ${cacheResult.cacheDate}. ${cached.tokenEstimate} tokens.`, timestamp: ts });
        emit.emit(sessionId, 'tier', { tier: 'cache' });
        console.log(`[hollow/pipeline] complete sessionId=sess:${sessionId} tier=cache source=${cacheResult.source}`);
        return { sessionId: `sess:${sessionId}`, gdgMap: cached.gdgMap, domDelta: cached.html, confidence: cached.confidence, confidenceDeductions: cached.deductions, jsErrors: cached.jsErrors, tier: 'cache', elementCount: cached.elementCount, actionableCount: cached.actionableCount, tokenEstimate: cached.tokenEstimate };
      }
      // Cache miss — fall through to direct fetch
    }

    emit.emitLog(sessionId, 'SYS', `Fetching ${req.url}`);
    try {
      const fetched = await step('1-fetch-url', () => fetchUrl(req.url!));
      html = fetched.html;
      finalUrl = fetched.finalUrl;
    } catch (fetchErr) {
      if (fetchErr instanceof NetworkFetchError) {
        const isWAF = fetchErr.code === 'waf_block';
        const payload = isWAF
          ? { error: 'waf_block', message: 'WAF blocked the request', tier: 'partial' as const, route: 'pwa_relay_candidate' }
          : { error: 'fetch_failed', status: fetchErr.statusCode, message: `Site returned HTTP ${fetchErr.statusCode}`, tier: 'partial' as const };

        emit.emit(sessionId, 'log_entry', {
          tag: 'ERR',
          message: payload.message,
          timestamp: now(),
        });
        emit.emit(sessionId, 'tier', { tier: 'partial' });

        // Attach structured payload so the API route can return it as JSON
        const wrapped = new Error(payload.message) as Error & { hollowNetworkPayload: typeof payload };
        wrapped.hollowNetworkPayload = payload;
        throw wrapped;
      }
      throw fetchErr;
    }
  }

  emit.emit(sessionId, 'log_entry', {
    tag: 'SYS',
    message: `Session initialized. url: ${finalUrl}`,
    timestamp: now(),
  });

  // ── Text-tier fast path — skip Happy DOM + Yoga for large text-heavy pages ────
  if (isTextHeavyPage(html, finalUrl)) {
    console.log(`[hollow/pipeline] text-tier fast path: url=${finalUrl} htmlKb=${(html.length / 1024).toFixed(1)}`);
    emit.emitLog(sessionId, 'SYS', 'Text-heavy page detected — using fast text extraction (no layout engine)');

    const textResult = generateTextTierGDG(html, finalUrl);
    const confidence = 0.95;
    const tier = 'text' as const;

    const sessionState: SessionState = {
      ...(existingSession
        ? bumpSession(existingSession, html)
        : newSession(sessionId, finalUrl, html)),
      gdgMap: textResult.gdgMap,
      confidence,
      tier,
      tokenEstimate: textResult.tokenEstimate,
    };

    await step('2t-session-save', () => saveSession(sessionState));

    const ts = now();
    emit.emit(sessionId, 'dom_delta', { html, url: finalUrl });
    emit.emit(sessionId, 'gdg_map', {
      map: textResult.gdgMap,
      confidence,
      tier,
      actionableCount: textResult.actionableCount,
      tokenEstimate: textResult.tokenEstimate,
      timestamp: ts,
    });
    emit.emit(sessionId, 'confidence', { score: confidence, tier, deductions: [], timestamp: ts });
    emit.emit(sessionId, 'log_entry', {
      tag: 'GDG',
      message: `Text extraction complete. ${textResult.actionableCount} links. ${textResult.tokenEstimate} tokens. Confidence: ${confidence}. Tier: text.`,
      timestamp: ts,
    });
    emit.emit(sessionId, 'tier', { tier });

    console.log(`[hollow/pipeline] complete sessionId=sess:${sessionId} tier=text links=${textResult.actionableCount} tokens=${textResult.tokenEstimate}`);
    return {
      sessionId: `sess:${sessionId}`,
      gdgMap: textResult.gdgMap,
      domDelta: html,
      confidence,
      confidenceDeductions: [],
      jsErrors: [],
      tier,
      elementCount: 0,
      actionableCount: textResult.actionableCount,
      tokenEstimate: textResult.tokenEstimate,
    };
  }

  // ── Step 2: Happy DOM — parse HTML, execute JS ───────────────────────────────
  const { window, document, vitality, jsExecutionTimedOut, reactDetected } = await step('2-happy-dom', () =>
    buildDOM(html, finalUrl)
  );

  const jsErrors = vitality.getErrors();
  console.log(`[hollow/pipeline] 2-happy-dom: jsErrors=${jsErrors.length} timedOut=${jsExecutionTimedOut} reactDetected=${reactDetected}`);

  if (jsExecutionTimedOut) {
    emit.emit(sessionId, 'log_entry', {
      tag: 'WARN',
      message: 'JS execution timeout (10s) — proceeding with partial DOM.',
      timestamp: now(),
    });
  }

  if (jsErrors.length > 0) {
    for (const err of jsErrors) {
      emit.emit(sessionId, 'log_entry', {
        tag: 'WARN',
        message: `${err.type}: ${err.message}`,
        timestamp: now(),
      });
    }
    emit.emit(sessionId, 'js_errors', { errors: jsErrors });
  }

  const body = document.body;
  if (!body) {
    throw new Error('Happy DOM produced no document.body — HTML may be invalid');
  }
  console.log(`[hollow/pipeline] 2-happy-dom: body children=${body.children.length}`);

  // ── Step 2b: VDOM Hijack — React Fiber tree extraction ───────────────────────
  // If React registered itself on the injected DevTools hook, walk the Fiber
  // tree and emit a state-based GDG map. Skip the full yoga/grid pipeline.
  if (reactDetected) {
    const vdomResult = await step('2b-vdom-hijack', () => {
      const roots = findFiberRoots(window);
      console.log(`[hollow/pipeline] 2b-vdom-hijack: fiberRoots=${roots.length}`);
      if (roots.length === 0) return null;
      const allNodes = roots.flatMap(root => traverseFiber(root));
      if (allNodes.length < 10) return null;
      return generateVDOMMap(allNodes);
    });

    if (vdomResult) {
      console.log(`[hollow/pipeline] 2b-vdom-hijack: nodes=${vdomResult.nodeCount} actionable=${vdomResult.actionableCount}`);

      const confidence = 0.85;
      const tier = 'vdom' as const;
      const deductions: import('./types').ConfidenceDeduction[] = [];

      const liveHtml = document.documentElement?.outerHTML ?? html;

      const sessionState: SessionState = {
        ...(existingSession
          ? bumpSession(existingSession, liveHtml)
          : newSession(sessionId, finalUrl, liveHtml)),
        gdgMap: vdomResult.gdgMap,
        confidence,
        tier,
        tokenEstimate: vdomResult.tokenEstimate,
      };

      await step('8-session-save', () => saveSession(sessionState));
      window.happyDOM.close();

      const ts = now();
      emit.emit(sessionId, 'dom_delta', { html: liveHtml, url: finalUrl });
      emit.emit(sessionId, 'gdg_map', {
        map: vdomResult.gdgMap,
        confidence,
        tier,
        actionableCount: vdomResult.actionableCount,
        tokenEstimate: vdomResult.tokenEstimate,
        timestamp: ts,
      });
      emit.emit(sessionId, 'confidence', { score: confidence, tier, deductions, timestamp: ts });
      emit.emit(sessionId, 'log_entry', {
        tag: 'VDOM',
        message: `React Fiber tree extracted. ${vdomResult.nodeCount} nodes. ${vdomResult.actionableCount} actionable. Confidence: ${confidence}. Tier: vdom.`,
        timestamp: ts,
      });
      emit.emit(sessionId, 'tier', { tier });

      console.log(
        `[hollow/pipeline] complete sessionId=sess:${sessionId} confidence=${confidence} tier=${tier} elements=${vdomResult.nodeCount} redisWrite=OK`
      );

      return {
        sessionId: `sess:${sessionId}`,
        gdgMap: vdomResult.gdgMap,
        domDelta: liveHtml,
        confidence,
        confidenceDeductions: deductions,
        jsErrors,
        tier,
        elementCount: vdomResult.nodeCount,
        actionableCount: vdomResult.actionableCount,
        tokenEstimate: vdomResult.tokenEstimate,
      };
    }

    console.log('[hollow/pipeline] 2b-vdom-hijack: insufficient nodes — falling through to spatial pipeline');
  }

  // ── Steps 3–4: CSS + Yoga Flexbox layout ────────────────────────────────────
  let layoutMap: Awaited<ReturnType<typeof calculateLayout>>['layoutMap'];
  let layoutDeductions: Awaited<ReturnType<typeof calculateLayout>>['deductions'];
  try {
    const layoutResult = await step('3-yoga-layout', () =>
      calculateLayout(body as unknown as Element, window)
    );
    layoutMap = layoutResult.layoutMap;
    layoutDeductions = layoutResult.deductions;
    console.log(`[hollow/pipeline] 3-yoga-layout: mapped=${layoutMap.size} deductions=${layoutDeductions.length}`);
  } catch (err) {
    console.warn(`[hollow/pipeline] 3-yoga-layout: layout failed, continuing with empty map — ${err instanceof Error ? err.message : err}`);
    layoutMap = new Map();
    layoutDeductions = [{ reason: 'yoga layout failed (CSS parse error)', amount: 0.25 }];
    emit.emit(sessionId, 'log_entry', {
      tag: 'WARN',
      message: 'Layout engine failed — falling back to structure-only map (lower confidence)',
      timestamp: now(),
    });
  }

  // ── Step 5: CSS Grid resolver ─────────────────────────────────────────────────
  const gridLayouts = new Map<Element, LayoutBox>();
  const gridMeta = new Map<Element, { col: number; row: number }>();
  const gridColCounts = new Map<Element, number>();

  await step('5-grid-resolver', async () => {
    function resolveGridContainers(el: Element): void {
      const styles = resolveStyles(el, window);
      const isGrid = styles.display === 'grid' || styles.display === 'inline-grid';

      if (isGrid) {
        const containerBox = layoutMap.get(el);
        if (containerBox) {
          const childStyles = new Map<Element, ReturnType<typeof resolveStyles>>();
          for (const child of Array.from(el.children)) {
            childStyles.set(child, resolveStyles(child, window));
          }
          const { childLayouts, resolvedPlacements, colCount } = resolveGridLayout(
            el, containerBox, styles, childStyles
          );
          gridColCounts.set(el, colCount);
          for (const [child, box] of childLayouts) {
            gridLayouts.set(child, box);
            const placement = resolvedPlacements.get(child);
            if (placement) {
              gridMeta.set(child, { col: placement.colStart, row: placement.rowStart });
            }
          }
        }
      }

      for (const child of Array.from(el.children)) {
        resolveGridContainers(child);
      }
    }

    resolveGridContainers(body as unknown as Element);
    console.log(`[hollow/pipeline] 5-grid-resolver: grid cells=${gridLayouts.size}`);

    for (const [el, box] of gridLayouts) {
      await calculateSubtreeLayout(el, box, window, layoutMap, layoutDeductions);
    }
  });

  // ── Step 6: GDG Spatial ──────────────────────────────────────────────────────
  const gdg = await step('6-gdg-spatial', () =>
    Promise.resolve(generateGDGSpatial(
      body as unknown as Element,
      window,
      layoutMap,
      gridLayouts,
      gridMeta,
      gridColCounts
    ))
  );
  console.log(`[hollow/pipeline] 6-gdg-spatial: tokens=${gdg.tokenEstimate} actionable=${gdg.actionableCount}`);

  // ── Step 7: Confidence scoring ────────────────────────────────────────────────
  if (jsExecutionTimedOut) {
    layoutDeductions.push({ reason: 'JS execution timeout — partial DOM', amount: 0.15 });
  }

  const { score, deductions, tier } = await step('7-confidence', () =>
    Promise.resolve(scoreConfidence(layoutDeductions, jsErrors))
  );
  const confidence = Math.round(score * 100) / 100;
  console.log(`[hollow/pipeline] 7-confidence: score=${confidence} tier=${tier}`);

  // ── Step 7b: Cache Bypass ─────────────────────────────────────────────────────
  // Triggers when: (a) confidence < 0.5 on a read-only URL, OR
  //                (b) GDG map looks like a consent/cookie wall.
  const consentWall = !req.html && isConsentWall(gdg.map);
  if (consentWall) {
    emit.emit(sessionId, 'log_entry', { tag: 'WARN', message: 'Consent wall detected — attempting cache bypass.', timestamp: now() });
    console.log('[hollow/pipeline] 7b: consent wall detected, triggering cache bypass');
  }

  if (!req.html && (confidence < 0.5 || consentWall) && isReadOnlyUrl(finalUrl)) {
    const cacheResult = await step('7b-cache-bypass', () => tryCacheBypass(finalUrl, 'Cache fallback'));
    if (cacheResult) {
      window.happyDOM.close();
      const cached = await step('7b-cache-pipeline', () =>
        processCachedHtml(cacheResult, finalUrl, sessionId, existingSession)
      );
      const cTs = now();
      const source = cacheResult.source === 'bing' ? 'Bing Cache' : 'Wayback Machine';
      emit.emit(sessionId, 'dom_delta', { html: cached.html, url: finalUrl });
      emit.emit(sessionId, 'gdg_map', { map: cached.gdgMap, confidence: cached.confidence, tier: 'cache', actionableCount: cached.actionableCount, tokenEstimate: cached.tokenEstimate, timestamp: cTs });
      emit.emit(sessionId, 'confidence', { score: cached.confidence, tier: 'cache', deductions: cached.deductions, timestamp: cTs });
      emit.emit(sessionId, 'log_entry', { tag: 'GDG', message: `Cache bypass: ${source} snapshot from ${cacheResult.cacheDate}. ${cached.tokenEstimate} tokens. Confidence: ${cached.confidence}.`, timestamp: cTs });
      emit.emit(sessionId, 'tier', { tier: 'cache' });
      console.log(`[hollow/pipeline] complete sessionId=sess:${sessionId} tier=cache source=${cacheResult.source}`);
      return { sessionId: `sess:${sessionId}`, gdgMap: cached.gdgMap, domDelta: cached.html, confidence: cached.confidence, confidenceDeductions: cached.deductions, jsErrors: cached.jsErrors, tier: 'cache', elementCount: cached.elementCount, actionableCount: cached.actionableCount, tokenEstimate: cached.tokenEstimate };
    }
  }

  // ── Step 8: Session persistence ───────────────────────────────────────────────
  const liveHtml = document.documentElement?.outerHTML ?? html;

  const sessionState: SessionState = {
    ...(existingSession
      ? bumpSession(existingSession, liveHtml)
      : newSession(sessionId, finalUrl, liveHtml)),
    gdgMap: gdg.map,
    confidence,
    tier,
    tokenEstimate: gdg.tokenEstimate,
  };

  await step('8-session-save', () => saveSession(sessionState));

  window.happyDOM.close();

  // ── Step 9: SSE emit → Matrix Mirror ──────────────────────────────────────────
  const ts = now();

  emit.emit(sessionId, 'dom_delta', { html: liveHtml, url: finalUrl });
  emit.emit(sessionId, 'gdg_map', {
    map: gdg.map,
    confidence,
    tier,
    actionableCount: gdg.actionableCount,
    tokenEstimate: gdg.tokenEstimate,
    timestamp: ts,
  });
  emit.emit(sessionId, 'confidence', { score: confidence, tier, deductions, timestamp: ts });
  emit.emit(sessionId, 'log_entry', {
    tag: 'GDG',
    message: `Perception map generated. ${gdg.tokenEstimate} tokens. Confidence: ${confidence}. Tier: ${tier}.`,
    timestamp: ts,
  });

  if (deductions.length > 0) {
    for (const d of deductions) {
      emit.emit(sessionId, 'log_entry', {
        tag: 'WARN',
        message: `Confidence deduction -${d.amount.toFixed(2)}: ${d.reason}`,
        timestamp: ts,
      });
    }
  }

  if (tier === 'partial') {
    emit.emit(sessionId, 'log_entry', {
      tag: 'WARN',
      message: `Confidence ${confidence} below threshold. Returning partial map — consider VDOM Hijack or Router upgrade.`,
      timestamp: ts,
    });
  }

  emit.emit(sessionId, 'tier', { tier });

  // ── Step 10: Response ──────────────────────────────────────────────────────────
  console.log(
    `[hollow/pipeline] complete sessionId=sess:${sessionId} confidence=${confidence} tier=${tier} elements=${layoutMap.size} redisWrite=OK`
  );

  return {
    sessionId: `sess:${sessionId}`,
    gdgMap: gdg.map,
    domDelta: liveHtml,
    confidence,
    confidenceDeductions: deductions,
    jsErrors,
    tier,
    elementCount: layoutMap.size,
    actionableCount: gdg.actionableCount,
    tokenEstimate: gdg.tokenEstimate,
  };
}
