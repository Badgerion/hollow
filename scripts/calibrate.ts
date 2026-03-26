/**
 * GDG Spatial Ground Truth Calibration
 *
 * Compares Hollow's Yoga-calculated element coordinates against real Chrome
 * DevTools coordinates (getBoundingClientRect) on the same pages.
 *
 * Prerequisites:
 *   Start Chrome:  google-chrome --headless --remote-debugging-port=9222
 *   Run:           npx tsx scripts/calibrate.ts
 *
 * What it does:
 *   1. For each test URL, run Hollow's full pipeline to get GDG coordinates
 *   2. Also navigate to the same URL in Chrome and call getBoundingClientRect()
 *      on every visible text-bearing element
 *   3. Match elements between the two sources by text content + tag
 *   4. Calculate per-axis error (Δx, Δy, Δwidth, Δheight)
 *   5. Report per-URL and aggregate stats; flag systematic offsets
 */

import CDP from 'chrome-remote-interface';
import { buildDOM } from '../lib/hollow/dom';
import { resolveStyles } from '../lib/hollow/css-resolver';
import { calculateLayout, calculateSubtreeLayout } from '../lib/hollow/yoga-layout';
import { resolveGridLayout } from '../lib/hollow/grid-resolver';
import { generateGDGSpatial } from '../lib/hollow/gdg-spatial';
import type { LayoutBox } from '../lib/hollow/yoga-layout';
import type { ElementLayout } from '../lib/hollow/types';
import { spawn } from 'node:child_process';
import path from 'node:path';

// ─── Subprocess worker mode — see entry point at bottom of file ───────────────

// ─── Test URLs ────────────────────────────────────────────────────────────────

const TEST_URLS = [
  'https://news.ycombinator.com',                // table layout
  'https://text.npr.org',                        // block / simple HTML
  'https://github.com/trending',                 // flex layout
  'https://developer.mozilla.org/en-US/docs/Web/CSS/display', // grid layout (single page)
  'https://lite.cnn.com',                        // block, minimal JS
  'https://learnxinyminutes.com',                // block, static docs
  'https://golang.org',                          // flex, small page
  'https://stripe.com/docs/api',                 // docs / left-nav layout
  'https://en.wikipedia.org/wiki/Cascading_Style_Sheets', // wiki article
  'https://info.cern.ch',                        // baseline: original web page
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface HollowElement {
  tag: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ChromeElement {
  tag: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MatchedPair {
  hollow: HollowElement;
  chrome: ChromeElement;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  euclidean: number; // sqrt(dx² + dy²) — positional error
}

interface UrlResult {
  url: string;
  hostname: string;
  hollowCount: number;
  chromeCount: number;
  matchedCount: number;
  pairs: MatchedPair[];
  meanDx: number;
  meanDy: number;
  meanDw: number;
  meanDh: number;
  medianEuclidean: number;
  within5px: number;   // percentage
  within10px: number;
  within20px: number;
  error?: string;
}

// ─── Hollow pipeline runner ───────────────────────────────────────────────────

async function runHollowPipeline(url: string): Promise<HollowElement[]> {
  // Fetch the page HTML the same way the real pipeline does
  const { fetchUrl } = await import('../lib/hollow/network');
  const { html, finalUrl } = await fetchUrl(url);

  const { window, document } = await buildDOM(html, finalUrl);
  const body = document.body as unknown as Element;
  if (!body) {
    window.happyDOM.close();
    return [];
  }

  // Yoga layout
  const { layoutMap, deductions: _d } = await calculateLayout(body, window);

  // Grid resolver
  const gridLayouts = new Map<Element, LayoutBox>();
  const gridMeta    = new Map<Element, { col: number; row: number }>();
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
          if (placement) gridMeta.set(child, { col: placement.colStart, row: placement.rowStart });
        }
      }
    }
    for (const child of Array.from(el.children)) resolveGridContainers(child);
  }
  resolveGridContainers(body);

  for (const [el, box] of gridLayouts) {
    await calculateSubtreeLayout(el, box, window, layoutMap, _d);
  }

  // GDG Spatial — gives us the final coordinate tree
  const gdg = generateGDGSpatial(body, window, layoutMap, gridLayouts, gridMeta, gridColCounts);
  window.happyDOM.close();

  // Flatten the full element tree — actionable elements AND non-actionable
  // containers that carry visible text.  Use gdg.roots so we see everything.
  const elements: HollowElement[] = [];

  function flattenTree(el: ElementLayout): void {
    const text = (el.text ?? '').trim();
    // Include elements with text + non-zero width.
    // Height can be 0 when Yoga lacks font metrics — still useful for x/y calibration.
    if (text && el.width > 0) {
      elements.push({
        tag: el.tag,
        text: text.slice(0, 120),
        x: el.x,
        y: el.y,
        width:  el.width,
        height: el.height,
      });
    }
    for (const child of el.children) flattenTree(child);
  }

  for (const root of gdg.roots) flattenTree(root);
  return elements;
}

// ─── Crash-safe Hollow runner ─────────────────────────────────────────────────
//
// Spawns the pipeline in a fresh subprocess.  If the process crashes (e.g.
// HappyDOM's deferred callbacks throw into nbind.js), the subprocess dies
// cleanly and we return empty rather than crashing the orchestrator.

const TSX_BIN = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
const SCRIPT   = path.join(process.cwd(), 'scripts', 'calibrate.ts');

function spawnHollowWorker(url: string, timeoutMs = 45_000): Promise<HollowElement[]> {
  return new Promise(resolve => {
    const proc = spawn(TSX_BIN, [SCRIPT, '--hollow-worker', url], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve([]);
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        // The Hollow pipeline writes debug logs to stdout too, so grab
        // only the final line which is our JSON payload.
        const lastLine = stdout.trimEnd().split('\n').pop() ?? '';
        try { resolve(JSON.parse(lastLine)); return; } catch { /* fall through */ }
      }
      resolve([]);
    });

    proc.on('error', () => { clearTimeout(timer); resolve([]); });
  });
}

// ─── Chrome DevTools extraction ───────────────────────────────────────────────

async function runChromeExtraction(url: string): Promise<ChromeElement[]> {
  let client: CDP.Client | null = null;

  try {
    // Create a new target (tab) for this URL — avoids state bleed between pages
    const newTarget = await CDP.New({ port: 9222 });
    client = await CDP({ port: 9222, target: newTarget.id });

    const { Page, Runtime, DOM, Network } = client;

    await Network.enable();
    await Page.enable();
    await DOM.enable();

    // Navigate and wait for load — cap at 15s so we never hang forever
    await Page.navigate({ url });
    await Promise.race([
      Page.loadEventFired(),
      new Promise(r => setTimeout(r, 15_000)),
    ]).catch(() => { /* timeout or no load event — proceed anyway */ });

    // Extra settle time for SPAs / lazy content
    await new Promise(r => setTimeout(r, 1500));

    // Inject extraction script — collects getBoundingClientRect for every
    // visible element with non-empty text content (max 300 chars each).
    const result = await Runtime.evaluate({
      expression: `
        (function extractElements() {
          const VIEWPORT_W = 1280;
          const VIEWPORT_H = 800;
          const results = [];
          const seen = new Set();

          function getDirectText(el) {
            let text = '';
            for (const node of el.childNodes) {
              if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent;
              }
            }
            return text.replace(/\\s+/g, ' ').trim();
          }

          function walk(el) {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return;
            if (parseFloat(style.opacity) < 0.1) return;

            const rect = el.getBoundingClientRect();
            // Skip zero-size, off-screen, or non-visible elements
            if (rect.width < 2 || rect.height < 2) {
              for (const child of el.children) walk(child);
              return;
            }
            if (rect.top > VIEWPORT_H * 2 || rect.left > VIEWPORT_W * 2) return;
            if (rect.bottom < -VIEWPORT_H || rect.right < -VIEWPORT_W) return;

            const tag = el.tagName.toLowerCase();
            // Focus on interactive and text elements
            const isInteresting = ['a', 'button', 'input', 'select', 'textarea',
              'label', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'p', 'span',
              'nav', 'header', 'footer', 'main', 'section', 'article'].includes(tag);

            if (isInteresting) {
              // Use innerText for user-visible text (respects display:none)
              const text = (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
              if (text.length > 1) {
                const key = tag + '::' + text.slice(0, 60);
                if (!seen.has(key)) {
                  seen.add(key);
                  results.push({
                    tag,
                    text,
                    x: Math.round(rect.left),
                    y: Math.round(rect.top),
                    width:  Math.round(rect.width),
                    height: Math.round(rect.height),
                  });
                }
              }
            }

            for (const child of el.children) walk(child);
          }

          walk(document.body);
          return JSON.stringify(results.slice(0, 500));
        })()
      `,
      returnByValue: true,
      awaitPromise: false,
    });

    // Close the tab
    await CDP.Close({ port: 9222, id: newTarget.id });

    if (result.result?.value) {
      return JSON.parse(result.result.value) as ChromeElement[];
    }
    return [];
  } catch (err) {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
    throw err;
  }
}

// ─── Element matching ─────────────────────────────────────────────────────────
//
// Strategy: exact text + tag match (first preference), then fuzzy text match.
// We skip elements where text is clearly different.  Each Chrome element is
// matched at most once (greedy first-found, sorted by y position to prefer
// elements visible in the same region).

function matchElements(hollow: HollowElement[], chrome: ChromeElement[]): MatchedPair[] {
  const pairs: MatchedPair[] = [];
  const usedChromeIdx = new Set<number>();

  // Build index: (tag, text) → chrome elements
  const chromeByKey = new Map<string, { el: ChromeElement; idx: number }[]>();
  for (let i = 0; i < chrome.length; i++) {
    const el = chrome[i];
    const key = `${el.tag}::${el.text}`;
    if (!chromeByKey.has(key)) chromeByKey.set(key, []);
    chromeByKey.get(key)!.push({ el, idx: i });
  }

  for (const hEl of hollow) {
    // Strategy 1: exact tag + full text match
    const exactKey = `${hEl.tag}::${hEl.text}`;
    const candidates = chromeByKey.get(exactKey) ?? [];

    let matched: { el: ChromeElement; idx: number } | null = null;

    for (const c of candidates) {
      if (!usedChromeIdx.has(c.idx)) {
        matched = c;
        break;
      }
    }

    // Strategy 2: exact tag + text prefix match (Hollow may truncate)
    if (!matched) {
      for (const [key, list] of chromeByKey) {
        if (!key.startsWith(`${hEl.tag}::`)) continue;
        const chromeText = key.slice(hEl.tag.length + 2);
        if (chromeText.startsWith(hEl.text) || hEl.text.startsWith(chromeText)) {
          for (const c of list) {
            if (!usedChromeIdx.has(c.idx)) {
              matched = c;
              break;
            }
          }
          if (matched) break;
        }
      }
    }

    if (!matched) continue;

    usedChromeIdx.add(matched.idx);
    const cEl = matched.el;

    const dx = hEl.x - cEl.x;
    const dy = hEl.y - cEl.y;
    const dw = hEl.width  - cEl.width;
    const dh = hEl.height - cEl.height;

    pairs.push({
      hollow: hEl,
      chrome: cEl,
      dx, dy, dw, dh,
      euclidean: Math.sqrt(dx * dx + dy * dy),
    });
  }

  return pairs;
}

// ─── Statistics helpers ───────────────────────────────────────────────────────

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function pct(nums: number[], threshold: number): number {
  if (nums.length === 0) return 0;
  const count = nums.filter(v => Math.abs(v) <= threshold).length;
  return Math.round((count / nums.length) * 100);
}

function fmt(n: number, dp = 1): string {
  return n.toFixed(dp);
}

// ─── Systematic offset detection ─────────────────────────────────────────────
//
// A "systematic offset" is when the mean signed error in one axis is large
// enough that it can't be explained by random noise — it suggests a bug in
// the coordinate calculation (e.g. menu bar not subtracted from y).

const SYSTEMATIC_THRESHOLD = 8; // px — flag if |mean signed error| exceeds this

interface SystematicOffset {
  axis: string;
  meanSignedError: number;
  description: string;
}

function detectSystematicOffsets(pairs: MatchedPair[]): SystematicOffset[] {
  if (pairs.length < 5) return [];
  const offsets: SystematicOffset[] = [];

  const meanDx = mean(pairs.map(p => p.dx));
  const meanDy = mean(pairs.map(p => p.dy));
  const meanDw = mean(pairs.map(p => p.dw));
  const meanDh = mean(pairs.map(p => p.dh));

  if (Math.abs(meanDx) > SYSTEMATIC_THRESHOLD) {
    offsets.push({
      axis: 'x',
      meanSignedError: meanDx,
      description: meanDx > 0
        ? `Hollow x is +${fmt(meanDx)}px too large — possible scrollbar width or padding miscalculation`
        : `Hollow x is ${fmt(meanDx)}px too small — possible left margin/indent not applied`,
    });
  }

  if (Math.abs(meanDy) > SYSTEMATIC_THRESHOLD) {
    offsets.push({
      axis: 'y',
      meanSignedError: meanDy,
      description: meanDy > 0
        ? `Systematic y-offset of +${fmt(meanDy)}px — likely caused by sticky header/menu bar height not being subtracted`
        : `Systematic y-offset of ${fmt(meanDy)}px — elements positioned higher than Chrome sees them`,
    });
  }

  if (Math.abs(meanDw) > SYSTEMATIC_THRESHOLD) {
    offsets.push({
      axis: 'width',
      meanSignedError: meanDw,
      description: meanDw > 0
        ? `Hollow widths run +${fmt(meanDw)}px wide — padding or border-box calculation off`
        : `Hollow widths run ${fmt(meanDw)}px narrow — content width not including padding`,
    });
  }

  if (Math.abs(meanDh) > SYSTEMATIC_THRESHOLD) {
    offsets.push({
      axis: 'height',
      meanSignedError: meanDh,
      description: meanDh > 0
        ? `Hollow heights run +${fmt(meanDh)}px tall — line-height or padding miscalculation`
        : `Hollow heights run ${fmt(meanDh)}px short — possibly clipping multi-line text height`,
    });
  }

  return offsets;
}

// ─── Per-URL calibration ──────────────────────────────────────────────────────

async function calibrateUrl(url: string): Promise<UrlResult> {
  const hostname = new URL(url).hostname.replace(/^www\./, '');
  const base: UrlResult = {
    url, hostname,
    hollowCount: 0, chromeCount: 0, matchedCount: 0,
    pairs: [],
    meanDx: 0, meanDy: 0, meanDw: 0, meanDh: 0,
    medianEuclidean: 0,
    within5px: 0, within10px: 0, within20px: 0,
  };

  // Run both in parallel where possible — Chrome fetch and Hollow pipeline
  // are independent (both hit the live network separately).
  let hollowElements: HollowElement[] = [];
  let chromeElements: ChromeElement[] = [];

  const [hollowResult, chromeResult] = await Promise.allSettled([
    spawnHollowWorker(url),
    runChromeExtraction(url),
  ]);

  if (hollowResult.status === 'rejected') {
    return { ...base, error: `Hollow pipeline failed: ${hollowResult.reason?.message ?? hollowResult.reason}` };
  }
  if (chromeResult.status === 'rejected') {
    return { ...base, error: `Chrome extraction failed: ${chromeResult.reason?.message ?? chromeResult.reason}` };
  }

  hollowElements = hollowResult.value;
  chromeElements = chromeResult.value;

  const pairs = matchElements(hollowElements, chromeElements);

  if (pairs.length === 0) {
    return {
      ...base,
      hollowCount: hollowElements.length,
      chromeCount: chromeElements.length,
      error: 'No elements matched between Hollow and Chrome',
    };
  }

  const dxs = pairs.map(p => p.dx);
  const dys = pairs.map(p => p.dy);
  const dws = pairs.map(p => p.dw);
  const dhs = pairs.map(p => p.dh);
  const eucs = pairs.map(p => p.euclidean);

  return {
    url, hostname,
    hollowCount: hollowElements.length,
    chromeCount: chromeElements.length,
    matchedCount: pairs.length,
    pairs,
    meanDx:           mean(dxs),
    meanDy:           mean(dys),
    meanDw:           mean(dws),
    meanDh:           mean(dhs),
    medianEuclidean:  median(eucs),
    within5px:  pct(eucs, 5),
    within10px: pct(eucs, 10),
    within20px: pct(eucs, 20),
  };
}

// ─── Report rendering ─────────────────────────────────────────────────────────

function hr(char = '─', len = 66): string {
  return char.repeat(len);
}

function renderUrlResult(r: UrlResult): void {
  console.log(`\n  URL: ${r.url}`);
  if (r.error) {
    console.log(`  ⚠  ${r.error}`);
    return;
  }

  const matchRate = r.hollowCount > 0
    ? Math.round((r.matchedCount / r.hollowCount) * 100)
    : 0;

  console.log(`  Elements matched : ${r.matchedCount} / ${r.hollowCount} Hollow  (${matchRate}%)  |  Chrome saw ${r.chromeCount}`);
  console.log(`  Mean error       : x=${fmt(r.meanDx)}px  y=${fmt(r.meanDy)}px  w=${fmt(r.meanDw)}px  h=${fmt(r.meanDh)}px`);
  console.log(`  Median Euclidean : ${fmt(r.medianEuclidean)}px`);
  console.log(`  Within  5px      : ${r.within5px}%`);
  console.log(`  Within 10px      : ${r.within10px}%`);
  console.log(`  Within 20px      : ${r.within20px}%`);

  // Show worst outliers (largest Euclidean error)
  if (r.pairs.length > 0) {
    const worst = [...r.pairs]
      .sort((a, b) => b.euclidean - a.euclidean)
      .slice(0, 3);
    console.log(`  Worst mismatches :`);
    for (const p of worst) {
      const label = `"${p.hollow.text.slice(0, 40)}"`;
      console.log(`    ${p.hollow.tag} ${label}`);
      console.log(`      Hollow  x:${p.hollow.x} y:${p.hollow.y} w:${p.hollow.width} h:${p.hollow.height}`);
      console.log(`      Chrome  x:${p.chrome.x} y:${p.chrome.y} w:${p.chrome.width} h:${p.chrome.height}`);
      console.log(`      Delta   dx:${fmt(p.dx)} dy:${fmt(p.dy)} dw:${fmt(p.dw)} dh:${fmt(p.dh)}  eucl:${fmt(p.euclidean)}px`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(hr('━'));
  console.log('  Hollow GDG Spatial — Ground Truth Calibration');
  console.log('  Comparing Yoga coordinates vs Chrome getBoundingClientRect');
  console.log(hr('━'));
  console.log(`\n  Test URLs: ${TEST_URLS.length}`);
  console.log('  Chrome:    localhost:9222\n');

  // Quick ping to confirm Chrome is reachable before doing any work
  try {
    const version = await CDP.Version({ port: 9222 });
    console.log(`  Chrome OK: ${version.Browser ?? 'unknown version'}\n`);
  } catch {
    console.error('\n  ✗  Cannot connect to Chrome on port 9222.');
    console.error('     Start it with:');
    console.error('       google-chrome --headless --remote-debugging-port=9222');
    console.error('     or on macOS:');
    console.error('       /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --headless --remote-debugging-port=9222\n');
    process.exit(1);
  }

  const results: UrlResult[] = [];

  for (let i = 0; i < TEST_URLS.length; i++) {
    const url = TEST_URLS[i];
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    process.stdout.write(`  [${i + 1}/${TEST_URLS.length}] ${hostname} ... `);

    const start = Date.now();
    const result = await calibrateUrl(url);
    const elapsed = Date.now() - start;

    if (result.error) {
      console.log(`SKIP (${result.error.slice(0, 60)})`);
    } else {
      console.log(`${result.matchedCount} matched  ${fmt(result.medianEuclidean)}px median  [${elapsed}ms]`);
    }

    results.push(result);
  }

  // ── Per-URL details ──────────────────────────────────────────────────────────
  console.log(`\n${hr('━')}`);
  console.log('  Per-URL Results');
  console.log(hr('━'));

  for (const r of results) {
    renderUrlResult(r);
    console.log(`  ${hr()}`);
  }

  // ── Aggregate summary ────────────────────────────────────────────────────────
  const goodResults = results.filter(r => !r.error && r.matchedCount > 0);
  const allPairs = goodResults.flatMap(r => r.pairs);

  console.log(`\n${hr('━')}`);
  console.log('  OVERALL SUMMARY');
  console.log(hr('━'));

  if (allPairs.length === 0) {
    console.log('\n  No elements matched across any URL — check Chrome connection and pipeline.');
    process.exit(1);
  }

  const totalUrls      = results.length;
  const successfulUrls = goodResults.length;
  const skippedUrls    = totalUrls - successfulUrls;
  const totalElements  = allPairs.length;

  const allDxs  = allPairs.map(p => p.dx);
  const allDys  = allPairs.map(p => p.dy);
  const allDws  = allPairs.map(p => p.dw);
  const allDhs  = allPairs.map(p => p.dh);
  const allEucs = allPairs.map(p => p.euclidean);

  // Signed means (for offset detection)
  const globalMeanDx = mean(allDxs);
  const globalMeanDy = mean(allDys);
  const globalMeanDw = mean(allDws);
  const globalMeanDh = mean(allDhs);

  // Absolute means (for accuracy reporting)
  const globalMAE_x = mean(allDxs.map(Math.abs));
  const globalMAE_y = mean(allDys.map(Math.abs));
  const globalMAE_w = mean(allDws.map(Math.abs));
  const globalMAE_h = mean(allDhs.map(Math.abs));
  const globalMAE   = mean(allEucs);
  const globalMedian = median(allEucs);

  const globalWithin5  = pct(allEucs, 5);
  const globalWithin10 = pct(allEucs, 10);
  const globalWithin20 = pct(allEucs, 20);

  console.log(`\n  URLs tested        : ${totalUrls}  (${successfulUrls} succeeded, ${skippedUrls} skipped)`);
  console.log(`  Total elements     : ${totalElements} matched pairs`);
  console.log(`\n  Mean absolute error (MAE):`);
  console.log(`    x-axis  : ${fmt(globalMAE_x)}px`);
  console.log(`    y-axis  : ${fmt(globalMAE_y)}px`);
  console.log(`    width   : ${fmt(globalMAE_w)}px`);
  console.log(`    height  : ${fmt(globalMAE_h)}px`);
  console.log(`    overall : ${fmt(globalMAE)}px  (Euclidean)`);
  console.log(`\n  Median Euclidean error : ${fmt(globalMedian)}px`);
  console.log(`\n  Accuracy thresholds:`);
  console.log(`    Within  5px : ${globalWithin5}%`);
  console.log(`    Within 10px : ${globalWithin10}%`);
  console.log(`    Within 20px : ${globalWithin20}%`);

  // Signed offset summary (direction of error)
  console.log(`\n  Signed mean errors (positive = Hollow reads larger than Chrome):`);
  console.log(`    x : ${globalMeanDx >= 0 ? '+' : ''}${fmt(globalMeanDx)}px`);
  console.log(`    y : ${globalMeanDy >= 0 ? '+' : ''}${fmt(globalMeanDy)}px`);
  console.log(`    w : ${globalMeanDw >= 0 ? '+' : ''}${fmt(globalMeanDw)}px`);
  console.log(`    h : ${globalMeanDh >= 0 ? '+' : ''}${fmt(globalMeanDh)}px`);

  // ── Systematic offset detection ─────────────────────────────────────────────
  const systematics = detectSystematicOffsets(allPairs);

  if (systematics.length > 0) {
    console.log(`\n${hr('━')}`);
    console.log('  SYSTEMATIC OFFSETS DETECTED');
    console.log(hr('━'));
    for (const s of systematics) {
      const sign = s.meanSignedError >= 0 ? '+' : '';
      console.log(`\n  ⚠  Axis: ${s.axis}  |  Mean signed error: ${sign}${fmt(s.meanSignedError)}px`);
      console.log(`     ${s.description}`);
    }
    console.log('');
  } else {
    console.log(`\n  ✓  No systematic offsets detected (all axes within ±${SYSTEMATIC_THRESHOLD}px threshold)`);
  }

  // ── Per-URL quick table ─────────────────────────────────────────────────────
  console.log(`\n${hr('━')}`);
  console.log('  Quick comparison table');
  console.log(hr('━'));
  console.log('');
  console.log(`  ${'Hostname'.padEnd(32)} ${'Matched'.padStart(7)} ${'Med'.padStart(7)} ${'≤5px'.padStart(5)} ${'≤10px'.padStart(6)} ${'≤20px'.padStart(6)}`);
  console.log(`  ${hr('-', 70)}`);

  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.hostname.padEnd(32)} ${'SKIPPED'.padStart(7)}`);
    } else {
      console.log(
        `  ${r.hostname.padEnd(32)} ${String(r.matchedCount).padStart(7)} ` +
        `${fmt(r.medianEuclidean).padStart(7)}px ` +
        `${String(r.within5px).padStart(4)}% ` +
        `${String(r.within10px).padStart(5)}% ` +
        `${String(r.within20px).padStart(5)}%`
      );
    }
  }

  console.log('');
  console.log(hr('━'));
  console.log('  Calibration complete.');
  console.log(hr('━'));
  console.log('');
}

// ─── Entry point ─────────────────────────────────────────────────────────────
//
// Worker mode: tsx calibrate.ts --hollow-worker <url>
//   Runs only runHollowPipeline(url), writes JSON to stdout, exits.
//   Crash-isolated — the parent process spawns this per URL.
//
// Normal mode: tsx calibrate.ts
//   Runs the full calibration against all TEST_URLS.

if (process.argv.includes('--hollow-worker')) {
  const workerUrl = process.argv[process.argv.indexOf('--hollow-worker') + 1];
  if (!workerUrl) { process.stderr.write('No URL given to --hollow-worker\n'); process.exit(1); }
  runHollowPipeline(workerUrl)
    .then(elements => { process.stdout.write(JSON.stringify(elements)); process.exit(0); })
    .catch(err => { process.stderr.write(String(err instanceof Error ? err.message : err) + '\n'); process.exit(2); });
} else {
  main().catch(err => {
    console.error('\n✗ Calibration failed:', err);
    process.exit(1);
  });
}
