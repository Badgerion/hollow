/**
 * JS Vitality Monitor — intercepts all JS errors during Happy DOM execution
 * and surfaces them as observable signals in the API response and Matrix Mirror.
 *
 * These are a trust feature: silent failures become explicit deductions.
 */

import type { JSError } from './types';

// Known Happy DOM limitation signatures — map to human-readable type codes
const ERROR_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /window\.crypto\.subtle/i, type: 'CRYPTO_SUBTLE_UNAVAILABLE' },
  { pattern: /IntersectionObserver/i, type: 'INTERSECTION_OBSERVER_MISSING' },
  { pattern: /ResizeObserver/i, type: 'RESIZE_OBSERVER_MISSING' },
  { pattern: /localStorage/i, type: 'LOCAL_STORAGE_UNAVAILABLE' },
  { pattern: /sessionStorage/i, type: 'SESSION_STORAGE_UNAVAILABLE' },
  { pattern: /customElements/i, type: 'CUSTOM_ELEMENTS_UNSUPPORTED' },
  { pattern: /WebSocket/i, type: 'WEBSOCKET_UNAVAILABLE' },
  { pattern: /fetch/i, type: 'FETCH_UNAVAILABLE' },
  { pattern: /XMLHttpRequest/i, type: 'XHR_UNAVAILABLE' },
  { pattern: /document\.cookie/i, type: 'COOKIE_UNAVAILABLE' },
  { pattern: /MutationObserver/i, type: 'MUTATION_OBSERVER_MISSING' },
  { pattern: /requestAnimationFrame/i, type: 'RAF_UNAVAILABLE' },
  { pattern: /canvas/i, type: 'CANVAS_UNSUPPORTED' },
  { pattern: /Worker/i, type: 'WEB_WORKER_UNAVAILABLE' },
];

function classifyError(message: string): string {
  for (const { pattern, type } of ERROR_PATTERNS) {
    if (pattern.test(message)) return type;
  }
  return 'JS_RUNTIME_ERROR';
}

export function createVitalityMonitor() {
  const errors: JSError[] = [];

  function capture(message: string, source?: string, line?: number, col?: number): void {
    const type = classifyError(message);

    // Deduplicate identical errors
    const isDuplicate = errors.some((e) => e.type === type && e.message === message);
    if (isDuplicate) return;

    errors.push({ type, message, source, line, col });
  }

  function getErrors(): JSError[] {
    return [...errors];
  }

  function formatForLog(): string {
    return errors
      .map((e) => `⚠ ${e.type}: ${e.message}${e.source ? ` (${e.source})` : ''}`)
      .join('\n');
  }

  return { capture, getErrors, formatForLog };
}

export type VitalityMonitor = ReturnType<typeof createVitalityMonitor>;
