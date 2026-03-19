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

/**
 * Merge deductions from layout pass + JS errors + any additional signals.
 * Returns a normalised score and the tier to use.
 */
export function scoreConfidence(
  layoutDeductions: ConfidenceDeduction[],
  jsErrors: JSError[]
): ScoreResult {
  const deductions: ConfidenceDeduction[] = [...layoutDeductions];

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
