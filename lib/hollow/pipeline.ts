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
import { initYoga, calculateLayout, calculateSubtreeLayout } from './yoga-layout';
import { resolveGridLayout } from './grid-resolver';
import { generateGDGSpatial } from './gdg-spatial';
import { scoreConfidence } from './confidence';
import { loadSession, saveSession, newSession, bumpSession } from './session';
import { getEmitter } from './sse-emitter';
import type { HollowPerceiveResult, PerceiveRequest, SessionState } from './types';
import type { LayoutBox } from './yoga-layout';

export async function perceive(req: PerceiveRequest): Promise<HollowPerceiveResult> {
  // Strip optional sess: prefix — internal IDs are bare UUIDs; prefix is external-only
  const sessionId = req.sessionId ? req.sessionId.replace(/^sess:/, '') : uuidv4();
  const emit = getEmitter();
  const now = () => new Date().toISOString();

  // ── Step 1: Network fetch ───────────────────────────────────────────────────
  let html: string;
  let finalUrl: string;

  const existingSession = req.sessionId ? await loadSession(req.sessionId) : null;

  if (existingSession) {
    html = existingSession.html;
    finalUrl = existingSession.url;
  } else if (req.html) {
    html = req.html;
    finalUrl = req.url ?? 'about:blank';
  } else {
    if (!req.url) throw new Error('`url` is required when `html` is not provided');
    emit.emitLog(sessionId, 'SYS', `Fetching ${req.url}`);
    const fetched = await fetchUrl(req.url);
    html = fetched.html;
    finalUrl = fetched.finalUrl;
  }

  emit.emit(sessionId, 'log_entry', {
    tag: 'SYS',
    message: `Session initialized. url: ${finalUrl}`,
    timestamp: now(),
  });

  // ── Step 2: Happy DOM — parse HTML, execute JS ──────────────────────────────
  const { window, document, vitality } = await buildDOM(html, finalUrl);
  const jsErrors = vitality.getErrors();

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

  // ── Steps 3–4: CSS + Yoga Flexbox layout ────────────────────────────────────
  // Explicitly await WASM init before layout work begins.
  // This surfaces init failures as clear errors in Vercel logs rather than
  // silent downstream misbehaviour, and ensures the cold-start import()
  // resolves fully before calculateLayout() is entered.
  console.log(`[hollow/pipeline] awaiting Yoga WASM init — sessionId=${sessionId}`);
  try {
    await initYoga();
  } catch (err) {
    console.error(`[hollow/pipeline] Yoga WASM init FAILED — sessionId=${sessionId}`, err);
    throw err;
  }
  console.log(`[hollow/pipeline] Yoga WASM ready — sessionId=${sessionId}`);

  const { layoutMap, deductions: layoutDeductions } = await calculateLayout(
    body as unknown as Element,
    window
  );

  // ── Step 5: CSS Grid resolver ────────────────────────────────────────────────
  const gridLayouts = new Map<Element, LayoutBox>();
  const gridMeta = new Map<Element, { col: number; row: number }>();
  const gridColCounts = new Map<Element, number>();

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

  for (const [el, box] of gridLayouts) {
    await calculateSubtreeLayout(el, box, window, layoutMap, layoutDeductions);
  }

  // ── Step 6: GDG Spatial ──────────────────────────────────────────────────────
  const gdg = generateGDGSpatial(
    body as unknown as Element,
    window,
    layoutMap,
    gridLayouts,
    gridMeta,
    gridColCounts
  );

  // ── Step 7: Confidence scoring ───────────────────────────────────────────────
  const { score, deductions, tier } = scoreConfidence(layoutDeductions, jsErrors);
  const confidence = Math.round(score * 100) / 100;

  // ── Step 8: Session persistence ──────────────────────────────────────────────
  const liveHtml = document.documentElement?.outerHTML ?? html;

  const sessionState: SessionState = {
    ...(existingSession
      ? bumpSession(existingSession, liveHtml)
      : newSession(sessionId, finalUrl, liveHtml)),
    // Persist last perceive result so the polling fallback endpoint can serve it
    gdgMap: gdg.map,
    confidence,
    tier,
    tokenEstimate: gdg.tokenEstimate,
  };

  await saveSession(sessionState);
  window.happyDOM.close();

  // ── Step 9: SSE emit → Matrix Mirror ─────────────────────────────────────────
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

  emit.emit(sessionId, 'confidence', {
    score: confidence,
    tier,
    deductions,
    timestamp: ts,
  });

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

  // ── Step 10: Response ─────────────────────────────────────────────────────────
  console.log(
    `[hollow/pipeline] complete sessionId=sess:${sessionId} confidence=${confidence} tier=${tier} elements=${layoutMap.size} redisWrite=OK`
  );

  return {
    sessionId: `sess:${sessionId}`,  // external callers get the prefixed form
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
