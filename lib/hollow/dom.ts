/**
 * Happy DOM setup — parses HTML, executes JS, and captures the live DOM.
 *
 * Returns the window + document for CSS resolution and layout.
 * All JS errors are forwarded to the VitalityMonitor.
 */

import { Window } from 'happy-dom';
import { createVitalityMonitor, type VitalityMonitor } from './vitality';

export interface DOMResult {
  window: Window;
  document: Window['document'];
  vitality: VitalityMonitor;
  html: string;
  jsExecutionTimedOut: boolean;
}

const VIEWPORT_WIDTH = parseInt(process.env.HOLLOW_VIEWPORT_WIDTH ?? '1280', 10);
const VIEWPORT_HEIGHT = parseInt(process.env.HOLLOW_VIEWPORT_HEIGHT ?? '800', 10);

export async function buildDOM(html: string, url: string): Promise<DOMResult> {
  const vitality = createVitalityMonitor();

  const window = new Window({
    url,
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
    settings: {
      disableJavaScriptFileLoading: false,
      disableJavaScriptEvaluation: false,
      disableCSSFileLoading: false,
      enableFileSystemHttpRequests: false,
    },
  });

  // Intercept JS runtime errors → Vitality Monitor
  window.addEventListener('error', (event) => {
    const errEvent = event as unknown as ErrorEvent;
    vitality.capture(
      errEvent.message ?? String(errEvent),
      errEvent.filename,
      errEvent.lineno,
      errEvent.colno
    );
  });

  // Intercept unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const promiseEvent = event as unknown as PromiseRejectionEvent;
    const reason = promiseEvent.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'Unhandled promise rejection';
    vitality.capture(message);
  });

  // ── Polyfills ──────────────────────────────────────────────────────────────
  // Happy DOM does not expose these globals. Injecting them before document.write
  // means any inline <script> that runs during parsing sees them immediately.

  // TextEncoder / TextDecoder — missing in Happy DOM, needed by most modern
  // bundles (webpack runtime, React 18+, fetch polyfills, etc.)
  // Node's built-in TextEncoder is fully spec-compliant; expose it directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;
  if (!win.TextEncoder) win.TextEncoder = TextEncoder;   // Node global
  if (!win.TextDecoder) win.TextDecoder = TextDecoder;   // Node global

  // IntersectionObserver — stub that never fires callbacks.
  // Sites use it for lazy-load, scroll-triggered animations, and sticky
  // headers. None of those affect initial DOM structure. A no-op constructor
  // prevents the "IntersectionObserver is not defined" throw that aborts
  // bundle execution before the rest of the page renders.
  if (!win.IntersectionObserver) {
    win.IntersectionObserver = class IntersectionObserver {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      constructor(_cb: unknown, _opts?: unknown) {}
      observe()    {}
      unobserve()  {}
      disconnect() {}
      takeRecords() { return []; }
    };
  }

  // Write the HTML into the document
  window.document.write(html);
  window.document.close();

  // Wait for microtasks, timers, and pending scripts to settle.
  // Cap at JS_EXECUTION_TIMEOUT ms so complex bundles don't exhaust Vercel's
  // 60s function limit. On timeout we proceed with the partial DOM.
  const JS_EXECUTION_TIMEOUT = 10_000;
  let jsExecutionTimedOut = false;

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      jsExecutionTimedOut = true;
      console.log('[hollow/dom] JS execution timeout after 10s — proceeding with partial DOM');
      resolve();
    }, JS_EXECUTION_TIMEOUT);
  });

  try {
    await Promise.race([window.happyDOM.waitUntilComplete(), timeoutPromise]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vitality.capture(message);
  }

  const finalHtml = window.document.documentElement?.outerHTML ?? html;

  return {
    window,
    document: window.document,
    vitality,
    html: finalHtml,
    jsExecutionTimedOut,
  };
}

// ─── Element utilities ────────────────────────────────────────────────────────

const SKIP_TAGS = new Set([
  'script', 'style', 'head', 'meta', 'link', 'noscript',
  'template', 'svg', 'path', 'defs', 'symbol',
]);

export function isLayoutElement(el: Element): boolean {
  return !SKIP_TAGS.has(el.tagName.toLowerCase());
}

const ACTIONABLE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'textbox',
  'combobox', 'listbox', 'menuitem', 'tab', 'switch',
]);

export function isActionable(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (ACTIONABLE_TAGS.has(tag)) return true;

  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;

  if (el.hasAttribute('onclick')) return true;

  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && tabindex !== '-1') return true;

  return false;
}

export function getActionType(el: Element): 'click' | 'fill' | 'select' | 'hover' {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    const fillTypes = ['text', 'email', 'password', 'number', 'tel', 'url', 'search', 'date', 'time'];
    if (fillTypes.includes(type)) return 'fill';
    return 'click';
  }
  if (tag === 'textarea') return 'fill';
  if (tag === 'select') return 'select';
  return 'click';
}

export function getVisibleText(el: Element): string {
  // Walk text nodes directly inside this element (not children)
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      text += (node as Text).textContent ?? '';
    }
  }
  return text.trim().replace(/\s+/g, ' ').slice(0, 80);
}
