/**
 * GDG Spatial — generates the structured spatial perception tree.
 *
 * Source: exact Yoga + Grid coordinates.
 * Output: a human/LLM-readable text tree with actionable element IDs,
 * coordinates, and layout context — ~300–500 tokens for a typical page.
 *
 * Format (from spec):
 *
 *   [Viewport: 1280x800]
 *
 *   [nav: flex-row y:0 h:44]
 *     [1] a "Home"          x:0    w:80   h:44  ← actionable
 *
 *   [footer: grid 3-col y:740 h:60]
 *     [7] a "Privacy"       col:1
 */

import type { Window } from 'happy-dom';
import { isActionable, getActionType, getVisibleText, isLayoutElement } from './dom';
import { resolveStyles } from './css-resolver';
import type { LayoutBox } from './yoga-layout';
import type { ElementLayout, LayoutContext } from './types';

const VIEWPORT_WIDTH = parseInt(process.env.HOLLOW_VIEWPORT_WIDTH ?? '1280', 10);
const VIEWPORT_HEIGHT = parseInt(process.env.HOLLOW_VIEWPORT_HEIGHT ?? '800', 10);

// ─── Element tree builder ─────────────────────────────────────────────────────

let nextId = 1;

export function buildElementTree(
  el: Element,
  win: Window,
  layoutMap: Map<Element, LayoutBox>,
  gridLayouts: Map<Element, LayoutBox>,
  parentContext: LayoutContext,
  gridMeta: Map<Element, { col: number; row: number }>,
  gridColCounts: Map<Element, number>
): ElementLayout | null {
  if (!isLayoutElement(el)) return null;

  // Prefer grid layout over Yoga layout for grid children
  const box = gridLayouts.get(el) ?? layoutMap.get(el);
  if (!box) return null;

  const styles = resolveStyles(el, win);
  if (styles.visibility === 'hidden' || styles.display === 'none') return null;

  const tag = el.tagName.toLowerCase();
  const text = getVisibleText(el);
  const actionable = isActionable(el);

  // Determine layout context this element provides to its children
  let myContext: LayoutContext = 'block';
  if (styles.display === 'flex' || styles.display === 'inline-flex') {
    myContext = 'flex';
  } else if (styles.display === 'grid' || styles.display === 'inline-grid') {
    myContext = 'grid';
  } else if (styles.display === 'inline' || styles.display === 'inline-block') {
    myContext = 'inline';
  }

  const gridInfo = gridMeta.get(el);

  const layout: ElementLayout = {
    id: actionable ? nextId++ : null,
    tag,
    text,
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
    isActionable: actionable,
    actionType: actionable ? getActionType(el) : undefined,
    inputType: tag === 'input' ? (el.getAttribute('type') ?? 'text') : undefined,
    href: tag === 'a' ? (el.getAttribute('href') ?? undefined) : undefined,
    placeholder: el.getAttribute('placeholder') ?? undefined,
    isAbsolute: styles.position === 'absolute',
    isFixed: styles.position === 'fixed',
    hasTransform: !!(styles.transform && styles.transform !== 'none'),
    hasJsDrivenResize: false,
    layoutContext: parentContext,
    flexDirection: parentContext === 'flex' ? styles.flexDirection : undefined,
    gridCol: gridInfo?.col,
    gridRow: gridInfo?.row,
    // This element's own layout mode (for container header rendering)
    ownFlexDirection: myContext === 'flex' ? styles.flexDirection : undefined,
    ownGridCols: myContext === 'grid' ? (gridColCounts.get(el) ?? undefined) : undefined,
    children: [],
  };

  // Recurse into children
  for (const child of Array.from(el.children)) {
    const childLayout = buildElementTree(
      child, win, layoutMap, gridLayouts, myContext, gridMeta, gridColCounts
    );
    if (childLayout) layout.children.push(childLayout);
  }

  return layout;
}

// ─── Text renderer ────────────────────────────────────────────────────────────

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function coord(label: string, val: number): string {
  return `${label}:${val}`;
}

function renderElement(el: ElementLayout, indent: string, lines: string[]): void {
  const tag = el.tag;
  const text = el.text ? ` "${el.text}"` : '';

  if (el.isActionable && el.id !== null) {
    // Actionable leaf — full coordinate line
    const parts: string[] = [];

    if (el.layoutContext === 'grid' && el.gridCol !== undefined) {
      // Grid items: show col position instead of absolute coords
      const label = `[${el.id}] ${tag}${text}`;
      parts.push(`${indent}${pad(label, 30)} col:${el.gridCol}`);
      if (el.gridRow !== undefined && el.gridRow > 1) {
        parts[parts.length - 1] += `  row:${el.gridRow}`;
      }
    } else {
      // Flex/block items: show x, y, w, h
      const label = el.inputType
        ? `[${el.id}] input:${el.inputType}${el.placeholder ? ` (${el.placeholder})` : ''}`
        : `[${el.id}] ${tag}${text}`;

      const coords = [
        el.x > 0 || el.layoutContext !== 'flex' ? coord('x', el.x) : '',
        coord('y', el.y),
        coord('w', el.width),
        coord('h', el.height),
      ]
        .filter(Boolean)
        .join('  ');

      parts.push(`${indent}${pad(label, 32)} ${coords}`);
    }

    lines.push(...parts);
  }

  // Render children regardless of whether parent is actionable
  for (const child of el.children) {
    renderElement(child, indent + '  ', lines);
  }
}

/**
 * A container block is a non-actionable element with multiple children
 * or notable layout properties. We emit a header line for it.
 */
function isContainerBlock(el: ElementLayout): boolean {
  return (
    !el.isActionable &&
    el.children.length > 0 &&
    (el.layoutContext !== 'inline' || el.tag === 'body')
  );
}

function renderContainer(el: ElementLayout, indent: string, lines: string[]): void {
  if (isContainerBlock(el)) {
    const tag = el.tag;
    let header = `[${tag}`;

    // Layout mode annotation — use the element's own layout properties
    if (el.ownFlexDirection !== undefined) {
      const dir = el.ownFlexDirection;
      header += `: flex-${dir === 'column' ? 'col' : 'row'}`;
    } else if (el.ownGridCols !== undefined) {
      header += `: grid ${el.ownGridCols}-col`;
    }

    // Position info
    if (el.y > 0) header += ` y:${el.y}`;
    if (el.height > 0) header += ` h:${el.height}`;

    header += ']';
    lines.push(`${indent}${header}`);

    for (const child of el.children) {
      renderTree(child, indent + '  ', lines);
    }
    lines.push(''); // blank line between sections
  } else {
    for (const child of el.children) {
      renderTree(child, indent, lines);
    }
  }
}

function renderTree(el: ElementLayout, indent: string, lines: string[]): void {
  if (el.isActionable && el.id !== null) {
    renderElement(el, indent, lines);
  } else {
    renderContainer(el, indent, lines);
  }
}

// ─── Fixed/sticky header detection ───────────────────────────────────────────
//
// Hollow computes coordinates relative to document top (y=0 at the very
// beginning of the document).  Chrome's getBoundingClientRect() returns
// coordinates relative to the *viewport* top — so if the page is scrolled,
// or if there is a fixed/sticky header occupying the top of the viewport,
// the two coordinate systems diverge by exactly that offset.
//
// We can't correct for this without knowing the actual scroll position at
// the time Chrome measured, so instead we detect the condition and annotate
// the GDG map so downstream consumers know which coordinate system is in use.

function hasFixedOrStickyHeader(body: Element, win: Window): boolean {
  const MAX_DEPTH = 2; // check body children and grandchildren

  function check(el: Element, depth: number): boolean {
    const styles = resolveStyles(el, win);
    const pos = styles.position;
    if (pos === 'fixed' || pos === 'sticky') {
      // Only flag if the element is near the top of the viewport
      const top = parseFloat(styles.top);
      if (isNaN(top) || top <= 10) return true;
    }
    if (depth < MAX_DEPTH) {
      for (const child of Array.from(el.children)) {
        if (check(child, depth + 1)) return true;
      }
    }
    return false;
  }

  for (const child of Array.from(body.children)) {
    if (check(child, 0)) return true;
  }
  return false;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export interface GDGSpatialOutput {
  map: string;
  elements: Map<number, ElementLayout>;
  /** Full tree from body's direct children — includes non-actionable containers. */
  roots: ElementLayout[];
  actionableCount: number;
  tokenEstimate: number;
  hasFixedHeader: boolean;
}

export function generateGDGSpatial(
  body: Element,
  win: Window,
  layoutMap: Map<Element, LayoutBox>,
  gridLayouts: Map<Element, LayoutBox>,
  gridMeta: Map<Element, { col: number; row: number }>,
  gridColCounts: Map<Element, number>
): GDGSpatialOutput {
  // Reset ID counter per call
  nextId = 1;

  const elements = new Map<number, ElementLayout>();
  const roots: ElementLayout[] = [];

  for (const child of Array.from(body.children)) {
    const layout = buildElementTree(child, win, layoutMap, gridLayouts, 'block', gridMeta, gridColCounts);
    if (layout) roots.push(layout);
  }

  // Collect all actionable elements into the ID map
  function collect(el: ElementLayout): void {
    if (el.id !== null) elements.set(el.id, el);
    for (const child of el.children) collect(child);
  }
  for (const root of roots) collect(root);

  // Detect fixed/sticky header before rendering so we can annotate the map
  const hasFixedHeader = hasFixedOrStickyHeader(body, win);

  // Render the text tree
  const lines: string[] = [`[Viewport: ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}]`];

  if (hasFixedHeader) {
    lines.push('[Note: coordinates relative to document top. Subtract scroll offset for viewport-relative positions.]');
  }

  lines.push('');

  for (const root of roots) {
    renderTree(root, '', lines);
  }

  const map = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();

  // Rough token estimate: ~1 token per 4 chars
  const tokenEstimate = Math.ceil(map.length / 4);

  return { map, elements, roots, actionableCount: elements.size, tokenEstimate, hasFixedHeader };
}
