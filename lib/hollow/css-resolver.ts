/**
 * CSS Resolver — extracts computed styles from DOM elements.
 *
 * Uses happy-dom's getComputedStyle where available, supplemented by
 * direct attribute parsing for reliability. Returns a normalized
 * ComputedStyles object ready to be fed into Yoga or the Grid resolver.
 */

import type { Window } from 'happy-dom';
import type { ComputedStyles } from './types';

// ─── Numeric CSS value parsing ────────────────────────────────────────────────

/**
 * Parse a CSS pixel value. Returns 0 for auto/none/inherit/unresolvable.
 * Em/rem treated at 16px base. Percent returns NaN (caller decides).
 */
export function parsePx(value: string | null | undefined): number {
  if (!value || value === 'auto' || value === 'none' || value === 'inherit' || value === 'initial') {
    return 0;
  }
  const trimmed = value.trim();

  const match = trimmed.match(/^(-?\d+(?:\.\d+)?)(px|em|rem|%|vh|vw|pt|cm|mm)?$/);
  if (!match) return 0;

  const num = parseFloat(match[1]);
  const unit = match[2] ?? 'px';

  switch (unit) {
    case 'px': return num;
    case 'em':
    case 'rem': return num * 16;
    case 'pt': return num * 1.333;
    case '%': return NaN; // signal: percentage — caller uses Yoga percent API
    case 'vh': return num * 8; // viewport 800px / 100
    case 'vw': return num * 12.8; // viewport 1280px / 100
    default: return num;
  }
}

function parseFloat0(value: string | null | undefined): number {
  if (!value) return 0;
  const n = parseFloat(value);
  return isNaN(n) ? 0 : n;
}

// ─── Computed style extraction ────────────────────────────────────────────────

const DEFAULTS: ComputedStyles = {
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  width: 'auto',
  height: 'auto',
  minWidth: '0',
  maxWidth: 'none',
  minHeight: '0',
  maxHeight: 'none',
  marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
  paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
  borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0, borderLeftWidth: 0,
  boxSizing: 'content-box',
  position: 'static',
  top: 'auto', left: 'auto', right: 'auto', bottom: 'auto',
  transform: 'none',
  overflow: 'visible',
  flexDirection: 'row',
  justifyContent: 'flex-start',
  alignItems: 'stretch',
  alignContent: 'stretch',
  flexWrap: 'nowrap',
  flexGrow: 0,
  flexShrink: 1,
  flexBasis: 'auto',
  order: 0,
  gridTemplateColumns: 'none',
  gridTemplateRows: 'none',
  gridAutoColumns: 'auto',
  gridAutoRows: 'auto',
  gridColumn: 'auto',
  gridRow: 'auto',
  gap: 'normal',
  columnGap: 'normal',
  rowGap: 'normal',
};

export function resolveStyles(el: Element, win: Window): ComputedStyles {
  let computed: CSSStyleDeclaration | null = null;

  try {
    computed = win.getComputedStyle(el as unknown as Parameters<typeof win.getComputedStyle>[0]) as unknown as CSSStyleDeclaration;
  } catch {
    // Happy DOM may throw on certain element types; fall through to inline
  }

  function get(prop: string): string {
    // Prefer computed style
    if (computed) {
      const val = computed.getPropertyValue(prop);
      if (val && val !== '') return val.trim();
    }
    // Fall back to inline style
    const el2 = el as unknown as HTMLElement;
    if ('style' in el2) {
      const val = (el2.style as CSSStyleDeclaration).getPropertyValue(prop);
      if (val && val !== '') return val.trim();
    }
    return '';
  }

  const display = get('display') || getDefaultDisplay(el);

  return {
    display,
    visibility: get('visibility') || DEFAULTS.visibility,
    opacity: get('opacity') || DEFAULTS.opacity,

    width: get('width') || DEFAULTS.width,
    height: get('height') || DEFAULTS.height,
    minWidth: get('min-width') || DEFAULTS.minWidth,
    maxWidth: get('max-width') || DEFAULTS.maxWidth,
    minHeight: get('min-height') || DEFAULTS.minHeight,
    maxHeight: get('max-height') || DEFAULTS.maxHeight,

    marginTop: parsePx(get('margin-top')),
    marginRight: parsePx(get('margin-right')),
    marginBottom: parsePx(get('margin-bottom')),
    marginLeft: parsePx(get('margin-left')),

    paddingTop: parsePx(get('padding-top')),
    paddingRight: parsePx(get('padding-right')),
    paddingBottom: parsePx(get('padding-bottom')),
    paddingLeft: parsePx(get('padding-left')),

    borderTopWidth: parsePx(get('border-top-width')),
    borderRightWidth: parsePx(get('border-right-width')),
    borderBottomWidth: parsePx(get('border-bottom-width')),
    borderLeftWidth: parsePx(get('border-left-width')),

    boxSizing: get('box-sizing') || DEFAULTS.boxSizing,
    position: get('position') || DEFAULTS.position,
    top: get('top') || DEFAULTS.top,
    left: get('left') || DEFAULTS.left,
    right: get('right') || DEFAULTS.right,
    bottom: get('bottom') || DEFAULTS.bottom,
    transform: get('transform') || DEFAULTS.transform,
    overflow: get('overflow') || DEFAULTS.overflow,

    // Flexbox
    flexDirection: get('flex-direction') || DEFAULTS.flexDirection,
    justifyContent: get('justify-content') || DEFAULTS.justifyContent,
    alignItems: get('align-items') || DEFAULTS.alignItems,
    alignContent: get('align-content') || DEFAULTS.alignContent,
    flexWrap: get('flex-wrap') || DEFAULTS.flexWrap,
    flexGrow: parseFloat0(get('flex-grow')),
    flexShrink: parseFloat0(get('flex-shrink') || '1'),
    flexBasis: get('flex-basis') || DEFAULTS.flexBasis,
    order: parseFloat0(get('order')),

    // Grid
    gridTemplateColumns: get('grid-template-columns') || DEFAULTS.gridTemplateColumns,
    gridTemplateRows: get('grid-template-rows') || DEFAULTS.gridTemplateRows,
    gridAutoColumns: get('grid-auto-columns') || DEFAULTS.gridAutoColumns,
    gridAutoRows: get('grid-auto-rows') || DEFAULTS.gridAutoRows,
    gridColumn: get('grid-column') || DEFAULTS.gridColumn,
    gridRow: get('grid-row') || DEFAULTS.gridRow,
    gap: get('gap') || DEFAULTS.gap,
    columnGap: get('column-gap') || DEFAULTS.columnGap,
    rowGap: get('row-gap') || DEFAULTS.rowGap,
  };
}

/** HTML elements with non-block default display values */
function getDefaultDisplay(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const inlineTags = new Set([
    'span', 'a', 'strong', 'em', 'b', 'i', 'u', 's', 'small',
    'abbr', 'cite', 'code', 'kbd', 'mark', 'q', 'samp', 'sub',
    'sup', 'time', 'var', 'label', 'button',
  ]);
  const inlineBlockTags = new Set(['img', 'input', 'textarea', 'select', 'button']);
  const flexTags = new Set(['nav', 'header', 'footer', 'main']);
  const tableTags = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td']);

  if (inlineTags.has(tag)) return 'inline';
  if (inlineBlockTags.has(tag)) return 'inline-block';
  if (flexTags.has(tag)) return 'block'; // default; CSS may override
  if (tableTags.has(tag)) return 'table';
  return 'block';
}

/** Return true if CSS variables are present in a value (unresolved in happy-dom) */
export function hasCSSVariable(value: string): boolean {
  return value.includes('var(--');
}
