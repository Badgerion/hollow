/**
 * Confidence scorer — computes a 0.0–1.0 score indicating how much Hollow
 * trusts its own layout output for this page.
 *
 * Below 0.8: route to BaaS (Browserbase) fallback.
 */

import type { ConfidenceDeduction, JSError } from './types';

const FLOOR = 0.0;
const BAAS_THRESHOLD = 0.8;

// Per-deduction amounts (from spec)
const DEDUCTION = {
  ABSOLUTE_FIXED: 0.05,
  JS_ERROR: 0.10,
  TRANSFORM: 0.05,
  CSS_VARIABLE: 0.03,
  JS_DRIVEN_RESIZE: 0.05,
} as const;

export interface ScoreResult {
  score: number;
  deductions: ConfidenceDeduction[];
  tier: 'hollow' | 'baas';
}

// Max total deduction from absolute/fixed positioning signals.
// Real-world SPAs commonly have hundreds of overlays, dropdowns, and sticky
// elements. Each one is a genuine uncertainty signal, but penalising all of
// them floors the score for any Tailwind site to 0. Cap at 6 elements worth.
const ABSOLUTE_FIXED_CAP = 0.30; // 6 × 0.05

/**
 * Merge deductions from layout pass + JS errors + any additional signals.
 * Returns a normalised score and the tier to use.
 */
export function scoreConfidence(
  layoutDeductions: ConfidenceDeduction[],
  jsErrors: JSError[]
): ScoreResult {
  // Split absolute/fixed deductions from everything else so we can cap them.
  const absoluteFixed = layoutDeductions.filter(
    d => /^(absolute|fixed) element/.test(d.reason)
  );
  const other = layoutDeductions.filter(
    d => !/^(absolute|fixed) element/.test(d.reason)
  );

  const absoluteFixedTotal = Math.min(
    absoluteFixed.reduce((s, d) => s + d.amount, 0),
    ABSOLUTE_FIXED_CAP
  );

  const deductions: ConfidenceDeduction[] = [...other];

  if (absoluteFixedTotal > 0) {
    deductions.push({
      reason: `absolute/fixed elements (${absoluteFixed.length}, capped at ${ABSOLUTE_FIXED_CAP})`,
      amount: absoluteFixedTotal,
    });
  }

  // Each JS error is a -0.10 deduction
  for (const error of jsErrors) {
    deductions.push({
      reason: `JS error: ${error.type}`,
      amount: DEDUCTION.JS_ERROR,
    });
  }

  const total = deductions.reduce((sum, d) => sum + d.amount, 0);
  const score = Math.max(FLOOR, 1.0 - total);
  const tier = score >= BAAS_THRESHOLD ? 'hollow' : 'baas';

  return { score, deductions, tier };
}

/**
 * Format deductions for the Matrix Mirror log.
 */
export function formatDeductions(deductions: ConfidenceDeduction[]): string {
  if (deductions.length === 0) return 'No deductions.';
  return deductions
    .map((d) => `  -${d.amount.toFixed(2)} ${d.reason}`)
    .join('\n');
}

export { BAAS_THRESHOLD, DEDUCTION };
