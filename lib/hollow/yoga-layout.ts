/**
 * Yoga layout engine — computes Flexbox X/Y/W/H for every DOM element.
 *
 * Uses yoga-layout-prebuilt: a pre-compiled pure-JS build of Yoga with no
 * WASM binary and no async initialisation. Loads synchronously at module
 * level — safe on all Node.js runtimes including Vercel serverless where
 * dynamic WASM loading hangs indefinitely.
 *
 * Maps computed CSS styles → Yoga node properties, builds the parent-child
 * tree, calls calculateLayout(), extracts the coordinate map.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Yoga = require('yoga-layout-prebuilt');

// Immediate health check — fails fast on cold start if the package is broken.
try {
  const _probe = Yoga.Node.create();
  _probe.free();
  console.log('[hollow/yoga] loaded synchronously — Node.create functional');
} catch (err) {
  console.error('[hollow/yoga] yoga-layout-prebuilt failed to initialise:', err);
  throw err; // surface immediately rather than failing silently later
}

import type { Window } from 'happy-dom';
import { isLayoutElement } from './dom';
import { resolveStyles, parsePx, hasCSSVariable } from './css-resolver';
import type { ComputedStyles, ConfidenceDeduction } from './types';

export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface YogaResult {
  layoutMap: Map<Element, LayoutBox>;
  deductions: ConfidenceDeduction[];
}

const VIEWPORT_WIDTH = parseInt(process.env.HOLLOW_VIEWPORT_WIDTH ?? '1280', 10);
const VIEWPORT_HEIGHT = parseInt(process.env.HOLLOW_VIEWPORT_HEIGHT ?? '800', 10);

// ─── Yoga constant helpers ────────────────────────────────────────────────────

function flexDirection(val: string): number {
  switch (val) {
    case 'row': return Yoga.FLEX_DIRECTION_ROW;
    case 'row-reverse': return Yoga.FLEX_DIRECTION_ROW_REVERSE;
    case 'column': return Yoga.FLEX_DIRECTION_COLUMN;
    case 'column-reverse': return Yoga.FLEX_DIRECTION_COLUMN_REVERSE;
    default: return Yoga.FLEX_DIRECTION_ROW;
  }
}

function justifyContent(val: string): number {
  switch (val) {
    case 'flex-start': case 'start': return Yoga.JUSTIFY_FLEX_START;
    case 'center': return Yoga.JUSTIFY_CENTER;
    case 'flex-end': case 'end': return Yoga.JUSTIFY_FLEX_END;
    case 'space-between': return Yoga.JUSTIFY_SPACE_BETWEEN;
    case 'space-around': return Yoga.JUSTIFY_SPACE_AROUND;
    case 'space-evenly': return Yoga.JUSTIFY_SPACE_EVENLY;
    default: return Yoga.JUSTIFY_FLEX_START;
  }
}

function alignItems(val: string): number {
  switch (val) {
    case 'flex-start': case 'start': return Yoga.ALIGN_FLEX_START;
    case 'center': return Yoga.ALIGN_CENTER;
    case 'flex-end': case 'end': return Yoga.ALIGN_FLEX_END;
    case 'stretch': return Yoga.ALIGN_STRETCH;
    case 'baseline': return Yoga.ALIGN_BASELINE;
    default: return Yoga.ALIGN_STRETCH;
  }
}

function alignContent(val: string): number {
  switch (val) {
    case 'flex-start': case 'start': return Yoga.ALIGN_FLEX_START;
    case 'center': return Yoga.ALIGN_CENTER;
    case 'flex-end': case 'end': return Yoga.ALIGN_FLEX_END;
    case 'stretch': return Yoga.ALIGN_STRETCH;
    case 'space-between': return Yoga.ALIGN_SPACE_BETWEEN;
    case 'space-around': return Yoga.ALIGN_SPACE_AROUND;
    default: return Yoga.ALIGN_STRETCH;
  }
}

function flexWrap(val: string): number {
  switch (val) {
    case 'wrap': return Yoga.WRAP_WRAP;
    case 'wrap-reverse': return Yoga.WRAP_WRAP_REVERSE;
    default: return Yoga.WRAP_NO_WRAP;
  }
}

function positionType(val: string): number {
  if (val === 'absolute' || val === 'fixed') return Yoga.POSITION_TYPE_ABSOLUTE;
  return Yoga.POSITION_TYPE_RELATIVE;
}

function overflow(val: string): number {
  switch (val) {
    case 'hidden': return Yoga.OVERFLOW_HIDDEN;
    case 'scroll': return Yoga.OVERFLOW_SCROLL;
    default: return Yoga.OVERFLOW_VISIBLE;
  }
}

// ─── Apply styles to a Yoga node ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyStyles(node: any, styles: ComputedStyles): void {
  node.setPositionType(positionType(styles.position));
  node.setOverflow(overflow(styles.overflow));

  const isFlexContainer = styles.display === 'flex' || styles.display === 'inline-flex';
  if (isFlexContainer) {
    node.setFlexDirection(flexDirection(styles.flexDirection));
    node.setJustifyContent(justifyContent(styles.justifyContent));
    node.setAlignItems(alignItems(styles.alignItems));
    node.setAlignContent(alignContent(styles.alignContent));
    node.setFlexWrap(flexWrap(styles.flexWrap));
  }

  node.setFlexGrow(styles.flexGrow);
  node.setFlexShrink(styles.flexShrink);

  if (styles.flexBasis && styles.flexBasis !== 'auto') {
    const fb = parsePx(styles.flexBasis);
    if (!isNaN(fb) && fb > 0) node.setFlexBasis(fb);
  }

  applyDimension(node, 'width', styles.width);
  applyDimension(node, 'height', styles.height);
  applyDimension(node, 'minWidth', styles.minWidth);
  applyDimension(node, 'maxWidth', styles.maxWidth);
  applyDimension(node, 'minHeight', styles.minHeight);
  applyDimension(node, 'maxHeight', styles.maxHeight);

  node.setMargin(Yoga.EDGE_TOP, styles.marginTop);
  node.setMargin(Yoga.EDGE_RIGHT, styles.marginRight);
  node.setMargin(Yoga.EDGE_BOTTOM, styles.marginBottom);
  node.setMargin(Yoga.EDGE_LEFT, styles.marginLeft);

  node.setPadding(Yoga.EDGE_TOP, styles.paddingTop);
  node.setPadding(Yoga.EDGE_RIGHT, styles.paddingRight);
  node.setPadding(Yoga.EDGE_BOTTOM, styles.paddingBottom);
  node.setPadding(Yoga.EDGE_LEFT, styles.paddingLeft);

  node.setBorder(Yoga.EDGE_TOP, styles.borderTopWidth);
  node.setBorder(Yoga.EDGE_RIGHT, styles.borderRightWidth);
  node.setBorder(Yoga.EDGE_BOTTOM, styles.borderBottomWidth);
  node.setBorder(Yoga.EDGE_LEFT, styles.borderLeftWidth);

  if (styles.position === 'absolute' || styles.position === 'fixed') {
    const top = parsePx(styles.top);
    const left = parsePx(styles.left);
    const right = parsePx(styles.right);
    const bottom = parsePx(styles.bottom);
    if (!isNaN(top) && styles.top !== 'auto') node.setPosition(Yoga.EDGE_TOP, top);
    if (!isNaN(left) && styles.left !== 'auto') node.setPosition(Yoga.EDGE_LEFT, left);
    if (!isNaN(right) && styles.right !== 'auto') node.setPosition(Yoga.EDGE_RIGHT, right);
    if (!isNaN(bottom) && styles.bottom !== 'auto') node.setPosition(Yoga.EDGE_BOTTOM, bottom);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyDimension(node: any, dim: string, value: string): void {
  if (!value || value === 'auto' || value === 'none') return;

  if (value.endsWith('%')) {
    const pct = parseFloat(value);
    if (isNaN(pct)) return;
    switch (dim) {
      case 'width': node.setWidthPercent(pct); break;
      case 'height': node.setHeightPercent(pct); break;
      case 'minWidth': node.setMinWidthPercent(pct); break;
      case 'maxWidth': node.setMaxWidthPercent(pct); break;
      case 'minHeight': node.setMinHeightPercent(pct); break;
      case 'maxHeight': node.setMaxHeightPercent(pct); break;
    }
    return;
  }

  const px = parsePx(value);
  if (isNaN(px) || px === 0) return;

  switch (dim) {
    case 'width': node.setWidth(px); break;
    case 'height': node.setHeight(px); break;
    case 'minWidth': node.setMinWidth(px); break;
    case 'maxWidth': node.setMaxWidth(px); break;
    case 'minHeight': node.setMinHeight(px); break;
    case 'maxHeight': node.setMaxHeight(px); break;
  }
}

// ─── Tree traversal ───────────────────────────────────────────────────────────

interface NodeEntry {
  el: Element;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  yogaNode: any;
  styles: ComputedStyles;
}

// Returns true if the node was inserted into the parent, false if skipped.
// IMPORTANT: callers must only increment their childIndex when this returns
// true — if a skipped child still advances the index, the next sibling's
// insertChild call gets index > parent.getChildCount() and throws, silently
// dropping every sibling that follows.
function buildYogaTree(
  el: Element,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parentNode: any,
  parentIndex: number,
  win: Window,
  nodeMap: Map<Element, NodeEntry>,
  deductions: ConfidenceDeduction[]
): boolean {
  if (!isLayoutElement(el)) return false;

  let styles: ComputedStyles;
  try {
    styles = resolveStyles(el, win);
  } catch (err) {
    console.warn(`[hollow/yoga] resolveStyles threw for <${el.tagName.toLowerCase()}> — skipping element:`, err instanceof Error ? err.message : err);
    return false;
  }

  if (styles.visibility === 'hidden' || styles.display === 'none') return false;

  // Guard: Node.create() can throw on malformed page content.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any;
  try {
    node = Yoga.Node.create();
  } catch (err) {
    console.warn(`[hollow/yoga] Node.create() failed for <${el.tagName.toLowerCase()}>:`, err);
    return false;
  }

  try {
    applyStyles(node, styles);
  } catch {
    // If Yoga rejects a style value, continue with node defaults
  }

  if (styles.position === 'absolute' || styles.position === 'fixed') {
    deductions.push({
      reason: `${styles.position === 'fixed' ? 'fixed' : 'absolute'} element <${el.tagName.toLowerCase()}>`,
      amount: 0.05,
    });
  }

  if (styles.transform && styles.transform !== 'none' && styles.transform !== '') {
    deductions.push({
      reason: `transform on <${el.tagName.toLowerCase()}>`,
      amount: 0.05,
    });
  }

  const layoutProps = [styles.width, styles.height, styles.flexBasis, styles.gridTemplateColumns];
  for (const prop of layoutProps) {
    if (hasCSSVariable(prop)) {
      deductions.push({ reason: 'unresolved CSS variable affecting layout', amount: 0.03 });
      break;
    }
  }

  try {
    parentNode.insertChild(node, parentIndex);
  } catch (err) {
    console.warn(`[hollow/yoga] insertChild failed for <${el.tagName.toLowerCase()}> at index ${parentIndex}:`, err);
    try { node.free(); } catch { /* ignore */ }
    return false;
  }

  nodeMap.set(el, { el, yogaNode: node, styles });

  const isGridContainer = styles.display === 'grid' || styles.display === 'inline-grid';

  if (!isGridContainer) {
    let childIndex = 0;
    for (const child of Array.from(el.children)) {
      try {
        // Only advance the index when the child was actually inserted.
        if (buildYogaTree(child, node, childIndex, win, nodeMap, deductions)) {
          childIndex++;
        }
      } catch (err) {
        console.warn(`[hollow/yoga] child tree failed for <${child.tagName?.toLowerCase()}>:`, err);
        // continue with remaining siblings; do NOT increment childIndex
      }
    }
  }

  return true;
}

// ─── Extract layout from calculated tree ─────────────────────────────────────

function extractLayouts(
  el: Element,
  parentX: number,
  parentY: number,
  nodeMap: Map<Element, NodeEntry>,
  layoutMap: Map<Element, LayoutBox>
): void {
  const entry = nodeMap.get(el);
  if (!entry) return;

  const computed = entry.yogaNode.getComputedLayout();
  const x = parentX + computed.left;
  const y = parentY + computed.top;

  layoutMap.set(el, { x, y, width: computed.width, height: computed.height });

  const isGridContainer =
    entry.styles.display === 'grid' || entry.styles.display === 'inline-grid';

  if (!isGridContainer) {
    for (const child of Array.from(el.children)) {
      extractLayouts(child, x, y, nodeMap, layoutMap);
    }
  }
}

// ─── Free all Yoga nodes ──────────────────────────────────────────────────────

function freeAll(nodeMap: Map<Element, NodeEntry>): void {
  for (const { yogaNode } of nodeMap.values()) {
    try { yogaNode.free(); } catch { /* ignore */ }
  }
}

// ─── Sub-tree layout (for grid cell descendants) ─────────────────────────────

export async function calculateSubtreeLayout(
  el: Element,
  parentBox: LayoutBox,
  win: Window,
  layoutMap: Map<Element, LayoutBox>,
  deductions: ConfidenceDeduction[]
): Promise<void> {
  const nodeMap = new Map<Element, NodeEntry>();

  const root = Yoga.Node.create();
  root.setWidth(parentBox.width);
  root.setHeight(parentBox.height);
  root.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);

  let childIndex = 0;
  for (const child of Array.from(el.children)) {
    if (buildYogaTree(child, root, childIndex, win, nodeMap, deductions)) {
      childIndex++;
    }
  }

  root.calculateLayout(parentBox.width, parentBox.height, Yoga.DIRECTION_LTR);

  for (const child of Array.from(el.children)) {
    extractLayouts(child, parentBox.x, parentBox.y, nodeMap, layoutMap);
  }

  freeAll(nodeMap);
  root.free();
}

// ─── Main entry point ─────────────────────────────────────────────────────────

// Maximum DOM elements before skipping Yoga layout to avoid serverless timeouts.
// Large pages (HN comment threads, Reddit etc.) can have 1000+ elements.
// Above this threshold we return an empty layoutMap; GDG Spatial falls back to
// tree-structure-only mode (no x/y positions, lower confidence but no timeout).
const MAX_YOGA_ELEMENTS = 400;

export async function calculateLayout(body: Element, win: Window): Promise<YogaResult> {
  const nodeMap = new Map<Element, NodeEntry>();
  const deductions: ConfidenceDeduction[] = [];

  // Fast element count guard — querySelectorAll is synchronous and cheap
  const totalElements = body.querySelectorAll('*').length;
  if (totalElements > MAX_YOGA_ELEMENTS) {
    console.log(
      `[hollow/yoga] skipping layout — ${totalElements} elements exceeds MAX_YOGA_ELEMENTS=${MAX_YOGA_ELEMENTS}`
    );
    deductions.push({ reason: `page too large for layout (${totalElements} elements) — structure-only map`, amount: 0.15 });
    return { layoutMap: new Map<Element, LayoutBox>(), deductions };
  }

  const root = Yoga.Node.create();
  root.setWidth(VIEWPORT_WIDTH);
  root.setHeight(VIEWPORT_HEIGHT);
  root.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);

  console.log(`[hollow/yoga] VIEWPORT_WIDTH=${VIEWPORT_WIDTH} VIEWPORT_HEIGHT=${VIEWPORT_HEIGHT}`);
  console.log(`[hollow/yoga] root node set to ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}, building tree…`);

  // Log raw CSS of first body child before building tree — tells us whether
  // getComputedStyle is returning real values or empty strings in serverless.
  const firstChild = Array.from(body.children)[0];
  if (firstChild) {
    let rawStyles: ComputedStyles;
    try {
      rawStyles = resolveStyles(firstChild, win);
    } catch {
      rawStyles = { display: 'block', visibility: 'visible', opacity: '1', width: 'auto', height: 'auto', minWidth: '0', maxWidth: 'none', minHeight: '0', maxHeight: 'none', marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0, borderLeftWidth: 0, boxSizing: 'content-box', position: 'static', top: 'auto', left: 'auto', right: 'auto', bottom: 'auto', transform: 'none', overflow: 'visible', flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'stretch', alignContent: 'stretch', flexWrap: 'nowrap', flexGrow: 0, flexShrink: 1, flexBasis: 'auto', order: 0, gridTemplateColumns: 'none', gridTemplateRows: 'none', gridAutoColumns: 'auto', gridAutoRows: 'auto', gridColumn: 'auto', gridRow: 'auto', gap: 'normal', columnGap: 'normal', rowGap: 'normal' };
    }
    console.log(
      `[hollow/yoga] first child <${firstChild.tagName.toLowerCase()}> raw styles:` +
      ` display=${rawStyles.display}` +
      ` width=${rawStyles.width}` +
      ` height=${rawStyles.height}` +
      ` position=${rawStyles.position}` +
      ` flexGrow=${rawStyles.flexGrow}` +
      ` flexShrink=${rawStyles.flexShrink}` +
      ` visibility=${rawStyles.visibility}`
    );
  }

  let childIndex = 0;
  for (const child of Array.from(body.children)) {
    // Only advance childIndex when the node was actually inserted.
    // Skipped nodes (script/style/invisible) must NOT consume an index slot —
    // insertChild(node, index) throws when index > current child count.
    if (buildYogaTree(child, root, childIndex, win, nodeMap, deductions)) {
      childIndex++;
    }
  }

  console.log(`[hollow/yoga] tree built — ${nodeMap.size} nodes, ${root.getChildCount()} direct body children inserted`);

  // Confirm root is sized before we ask Yoga to compute layout.
  console.log(`[hollow/yoga] root before calculateLayout: setWidth=${VIEWPORT_WIDTH} setHeight=${VIEWPORT_HEIGHT} childCount=${root.getChildCount()}`);

  root.calculateLayout(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, Yoga.DIRECTION_LTR);

  const rootComputed = root.getComputedLayout();
  console.log(
    `[hollow/yoga] root after calculateLayout: w=${rootComputed.width} h=${rootComputed.height}` +
    ` (expected ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT})`
  );

  if (firstChild) {
    const firstEntry = nodeMap.get(firstChild);
    if (firstEntry) {
      const spot = firstEntry.yogaNode.getComputedLayout();
      console.log(
        `[hollow/yoga] first child <${firstChild.tagName.toLowerCase()}> computed:` +
        ` w=${spot.width} h=${spot.height} x=${spot.left} y=${spot.top}`
      );
    } else {
      console.log(`[hollow/yoga] first child <${firstChild.tagName.toLowerCase()}> not in nodeMap (invisible/skipped)`);
    }
  }

  const layoutMap = new Map<Element, LayoutBox>();
  for (const child of Array.from(body.children)) {
    extractLayouts(child, 0, 0, nodeMap, layoutMap);
  }

  console.log(`[hollow/yoga] layout complete — ${layoutMap.size} elements mapped`);

  freeAll(nodeMap);
  root.free();

  return { layoutMap, deductions };
}
