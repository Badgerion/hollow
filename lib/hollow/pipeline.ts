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
import { fetchUrl } from './network';
import { buildDOM } from './dom';
import { resolveStyles } from './css-resolver';
import { calculateLayout, calculateSubtreeLayout } from './yoga-layout';
import { resolveGridLayout } from './grid-resolver';
import { generateGDGSpatial } from './gdg-spatial';
import { scoreConfidence } from './confidence';
import { loadSession, saveSession, newSession, bumpSession } from './session';
import { getEmitter } from './sse-emitter';
import type { HollowPerceiveResult, PerceiveRequest, SessionState } from './types';
import type { LayoutBox } from './yoga-layout';

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

export async function perceive(req: PerceiveRequest): Promise<HollowPerceiveResult> {
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
    emit.emitLog(sessionId, 'SYS', `Fetching ${req.url}`);
    const fetched = await step('1-fetch-url', () => fetchUrl(req.url!));
    html = fetched.html;
    finalUrl = fetched.finalUrl;
  }

  emit.emit(sessionId, 'log_entry', {
    tag: 'SYS',
    message: `Session initialized. url: ${finalUrl}`,
    timestamp: now(),
  });

  // ── Step 2: Happy DOM — parse HTML, execute JS ───────────────────────────────
  const { window, document, vitality, jsExecutionTimedOut } = await step('2-happy-dom', () =>
    buildDOM(html, finalUrl)
  );

  const jsErrors = vitality.getErrors();
  console.log(`[hollow/pipeline] 2-happy-dom: jsErrors=${jsErrors.length} timedOut=${jsExecutionTimedOut}`);

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

  // ── Steps 3–4: CSS + Yoga Flexbox layout ────────────────────────────────────
  const { layoutMap, deductions: layoutDeductions } = await step('3-yoga-layout', () =>
    calculateLayout(body as unknown as Element, window)
  );
  console.log(`[hollow/pipeline] 3-yoga-layout: mapped=${layoutMap.size} deductions=${layoutDeductions.length}`);

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

  if (tier === 'baas') {
    emit.emit(sessionId, 'log_entry', {
      tag: 'WARN',
      message: `Confidence ${confidence} below threshold. Routing to BaaS fallback.`,
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
