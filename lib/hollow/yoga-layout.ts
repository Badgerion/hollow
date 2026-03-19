/**
 * Yoga layout engine — computes Flexbox X/Y/W/H for every DOM element.
 *
 * Uses yoga-layout (pure ESM, WASM-backed). The module uses top-level await
 * internally and cannot be require()'d — we load it once via dynamic import()
 * and cache the ready instance on globalThis so all serverless invocations
 * within the same warm container share one initialised copy.
 *
 * Maps computed CSS styles → Yoga node properties, builds the parent-child
 * tree, calls calculateLayout(), extracts the coordinate map.
 */

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

// ─── Yoga async init ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YogaModule = any;

const g = global as typeof globalThis & { __hollowYoga?: YogaModule };

async function getYoga(): Promise<YogaModule> {
  if (g.__hollowYoga) return g.__hollowYoga;
  console.log('[hollow/yoga] init start — loading yoga-layout WASM');
  let mod: { default: YogaModule };
  try {
    mod = await import('yoga-layout');
  } catch (err) {
    console.error('[hollow/yoga] import("yoga-layout") threw:', err);
    throw err;
  }
  const Yoga = mod.default;
  if (!Yoga || typeof Yoga.Node?.create !== 'function') {
    const msg = `[hollow/yoga] unexpected module shape — default=${typeof Yoga}`;
    console.error(msg);
    throw new Error(msg);
  }
  g.__hollowYoga = Yoga;
  console.log('[hollow/yoga] init complete — Node.create functional');
  return Yoga;
}

/**
 * Exported warm-up helper.
 * Call `await initYoga()` before entering the layout pipeline so that
 * the WASM init is explicit, logged, and clearly separated from layout work.
 */
export async function initYoga(): Promise<void> {
  await getYoga();
}

// ─── Yoga constant helpers ────────────────────────────────────────────────────

function flexDirection(Yoga: YogaModule, val: string): number {
  switch (val) {
    case 'row': return Yoga.FLEX_DIRECTION_ROW;
    case 'row-reverse': return Yoga.FLEX_DIRECTION_ROW_REVERSE;
    case 'column': return Yoga.FLEX_DIRECTION_COLUMN;
    case 'column-reverse': return Yoga.FLEX_DIRECTION_COLUMN_REVERSE;
    default: return Yoga.FLEX_DIRECTION_ROW;
  }
}

function justifyContent(Yoga: YogaModule, val: string): number {
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

function alignItems(Yoga: YogaModule, val: string): number {
  switch (val) {
    case 'flex-start': case 'start': return Yoga.ALIGN_FLEX_START;
    case 'center': return Yoga.ALIGN_CENTER;
    case 'flex-end': case 'end': return Yoga.ALIGN_FLEX_END;
    case 'stretch': return Yoga.ALIGN_STRETCH;
    case 'baseline': return Yoga.ALIGN_BASELINE;
    default: return Yoga.ALIGN_STRETCH;
  }
}

function alignContent(Yoga: YogaModule, val: string): number {
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

function flexWrap(Yoga: YogaModule, val: string): number {
  switch (val) {
    case 'wrap': return Yoga.WRAP_WRAP;
    case 'wrap-reverse': return Yoga.WRAP_WRAP_REVERSE;
    default: return Yoga.WRAP_NO_WRAP;
  }
}

function positionType(Yoga: YogaModule, val: string): number {
  if (val === 'absolute' || val === 'fixed') return Yoga.POSITION_TYPE_ABSOLUTE;
  return Yoga.POSITION_TYPE_RELATIVE;
}

function overflow(Yoga: YogaModule, val: string): number {
  switch (val) {
    case 'hidden': return Yoga.OVERFLOW_HIDDEN;
    case 'scroll': return Yoga.OVERFLOW_SCROLL;
    default: return Yoga.OVERFLOW_VISIBLE;
  }
}

// ─── Apply styles to a Yoga node ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyStyles(Yoga: YogaModule, node: any, styles: ComputedStyles): void {
  // Display / position
  node.setPositionType(positionType(Yoga, styles.position));
  node.setOverflow(overflow(Yoga, styles.overflow));

  // Flexbox container properties
  const isFlexContainer = styles.display === 'flex' || styles.display === 'inline-flex';
  if (isFlexContainer) {
    node.setFlexDirection(flexDirection(Yoga, styles.flexDirection));
    node.setJustifyContent(justifyContent(Yoga, styles.justifyContent));
    node.setAlignItems(alignItems(Yoga, styles.alignItems));
    node.setAlignContent(alignContent(Yoga, styles.alignContent));
    node.setFlexWrap(flexWrap(Yoga, styles.flexWrap));
  }

  // Flex item properties
  node.setFlexGrow(styles.flexGrow);
  node.setFlexShrink(styles.flexShrink);

  // Flex basis
  if (styles.flexBasis === 'auto' || !styles.flexBasis) {
    // leave unset — Yoga defaults
  } else {
    const fb = parsePx(styles.flexBasis);
    if (!isNaN(fb) && fb > 0) node.setFlexBasis(fb);
  }

  // Width / Height
  applyDimension(node, 'width', styles.width);
  applyDimension(node, 'height', styles.height);
  applyDimension(node, 'minWidth', styles.minWidth);
  applyDimension(node, 'maxWidth', styles.maxWidth);
  applyDimension(node, 'minHeight', styles.minHeight);
  applyDimension(node, 'maxHeight', styles.maxHeight);

  // Margins
  node.setMargin(Yoga.EDGE_TOP, styles.marginTop);
  node.setMargin(Yoga.EDGE_RIGHT, styles.marginRight);
  node.setMargin(Yoga.EDGE_BOTTOM, styles.marginBottom);
  node.setMargin(Yoga.EDGE_LEFT, styles.marginLeft);

  // Padding
  node.setPadding(Yoga.EDGE_TOP, styles.paddingTop);
  node.setPadding(Yoga.EDGE_RIGHT, styles.paddingRight);
  node.setPadding(Yoga.EDGE_BOTTOM, styles.paddingBottom);
  node.setPadding(Yoga.EDGE_LEFT, styles.paddingLeft);

  // Borders
  node.setBorder(Yoga.EDGE_TOP, styles.borderTopWidth);
  node.setBorder(Yoga.EDGE_RIGHT, styles.borderRightWidth);
  node.setBorder(Yoga.EDGE_BOTTOM, styles.borderBottomWidth);
  node.setBorder(Yoga.EDGE_LEFT, styles.borderLeftWidth);

  // Absolute/fixed positioning offsets
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

function buildYogaTree(
  Yoga: YogaModule,
  el: Element,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parentNode: any,
  parentIndex: number,
  win: Window,
  nodeMap: Map<Element, NodeEntry>,
  deductions: ConfidenceDeduction[]
): void {
  if (!isLayoutElement(el)) return;

  const styles = resolveStyles(el, win);

  // Skip invisible elements
  if (styles.visibility === 'hidden' || styles.display === 'none') return;

  const node = Yoga.Node.create();

  try {
    applyStyles(Yoga, node, styles);
  } catch {
    // If Yoga rejects a value, continue with defaults
  }

  // Collect confidence signals
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

  // Check for unresolved CSS variables in layout-relevant properties
  const layoutProps = [styles.width, styles.height, styles.flexBasis, styles.gridTemplateColumns];
  for (const prop of layoutProps) {
    if (hasCSSVariable(prop)) {
      deductions.push({ reason: 'unresolved CSS variable affecting layout', amount: 0.03 });
      break;
    }
  }

  nodeMap.set(el, { el, yogaNode: node, styles });
  parentNode.insertChild(node, parentIndex);

  // Grid containers are handled by the Grid resolver, not Yoga
  const isGridContainer = styles.display === 'grid' || styles.display === 'inline-grid';

  if (!isGridContainer) {
    let childIndex = 0;
    for (const child of Array.from(el.children)) {
      buildYogaTree(Yoga, child, node, childIndex, win, nodeMap, deductions);
      childIndex++;
    }
  }
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

  layoutMap.set(el, {
    x,
    y,
    width: computed.width,
    height: computed.height,
  });

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
    try {
      yogaNode.free();
    } catch {
      // ignore
    }
  }
}

// ─── Sub-tree layout (for grid cell descendants) ─────────────────────────────
//
// After the Grid resolver places direct grid children, this runs a fresh Yoga
// pass on each grid cell's contents using the cell's bounding box as the origin.
// This surfaces layout, absolute elements, and transforms inside grid cells.

export async function calculateSubtreeLayout(
  el: Element,
  parentBox: LayoutBox,
  win: Window,
  layoutMap: Map<Element, LayoutBox>,
  deductions: ConfidenceDeduction[]
): Promise<void> {
  const Yoga = await getYoga();
  const nodeMap = new Map<Element, NodeEntry>();

  // Root sized to the grid cell's box
  const root = Yoga.Node.create();
  root.setWidth(parentBox.width);
  root.setHeight(parentBox.height);
  root.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);

  let childIndex = 0;
  for (const child of Array.from(el.children)) {
    buildYogaTree(Yoga, child, root, childIndex, win, nodeMap, deductions);
    childIndex++;
  }

  root.calculateLayout(parentBox.width, parentBox.height, Yoga.DIRECTION_LTR);

  for (const child of Array.from(el.children)) {
    extractLayouts(child, parentBox.x, parentBox.y, nodeMap, layoutMap);
  }

  freeAll(nodeMap);
  root.free();
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function calculateLayout(body: Element, win: Window): Promise<YogaResult> {
  const Yoga = await getYoga();
  const nodeMap = new Map<Element, NodeEntry>();
  const deductions: ConfidenceDeduction[] = [];

  // Root node = viewport
  const root = Yoga.Node.create();
  root.setWidth(VIEWPORT_WIDTH);
  root.setHeight(VIEWPORT_HEIGHT);
  root.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);

  console.log(`[hollow/yoga] root node set to ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}, building tree…`);

  let childIndex = 0;
  for (const child of Array.from(body.children)) {
    buildYogaTree(Yoga, child, root, childIndex, win, nodeMap, deductions);
    childIndex++;
  }

  console.log(`[hollow/yoga] tree built — ${nodeMap.size} nodes, ${root.getChildCount()} direct body children`);

  // Run the layout pass
  root.calculateLayout(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, Yoga.DIRECTION_LTR);

  // Spot-check: log the first direct child's computed layout to detect zero-dimension issues
  const firstChild = Array.from(body.children)[0];
  if (firstChild) {
    const firstEntry = nodeMap.get(firstChild);
    if (firstEntry) {
      const spot = firstEntry.yogaNode.getComputedLayout();
      console.log(`[hollow/yoga] first child <${firstChild.tagName.toLowerCase()}> computed: w=${spot.width} h=${spot.height} x=${spot.left} y=${spot.top}`);
    } else {
      console.log(`[hollow/yoga] first child <${firstChild.tagName.toLowerCase()}> not in nodeMap (invisible/skipped)`);
    }
  }

  // Extract coordinates
  const layoutMap = new Map<Element, LayoutBox>();
  for (const child of Array.from(body.children)) {
    extractLayouts(child, 0, 0, nodeMap, layoutMap);
  }

  console.log(`[hollow/yoga] layout complete — ${layoutMap.size} elements mapped`);

  // Cleanup WASM memory
  freeAll(nodeMap);
  root.free();

  return { layoutMap, deductions };
}
