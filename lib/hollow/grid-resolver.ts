/**
 * CSS Grid resolver — built in-house since Yoga doesn't cover Grid.
 *
 * Given a grid container's computed styles and its children's grid-column /
 * grid-row placement properties, calculates the X/Y/W/H for each grid item.
 * Returns a LayoutBox for the container and each direct child.
 */

import { parsePx } from './css-resolver';
import type { ComputedStyles, ConfidenceDeduction } from './types';
import type { LayoutBox } from './yoga-layout';

// ─── Track definition parsing ─────────────────────────────────────────────────

type TrackDef = { type: 'px' | 'fr' | 'auto' | 'minmax'; value: number };

/**
 * Parse a grid-template-columns / grid-template-rows value into sized tracks.
 * Resolves fr units against available space after fixed tracks are placed.
 */
export function parseGridTemplate(template: string, availableSize: number): number[] {
  if (!template || template === 'none' || template === '') return [];

  // Expand repeat()
  let expanded = template;
  const repeatRegex = /repeat\(\s*(\d+)\s*,\s*([^)]+)\)/g;
  expanded = expanded.replace(repeatRegex, (_, count: string, track: string) => {
    return Array(parseInt(count)).fill(track.trim()).join(' ');
  });

  // Tokenise — split on whitespace but respect nested parens (for minmax())
  const tokens = tokenizeTracks(expanded.trim());

  const tracks: TrackDef[] = tokens.map((t) => {
    if (t.endsWith('fr')) return { type: 'fr', value: parseFloat(t) };
    if (t === 'auto') return { type: 'auto', value: 0 };
    if (t.startsWith('minmax(')) {
      // minmax(min, max) — use min as fixed size for v1
      const inner = t.slice(7, -1).split(',');
      const min = parsePx(inner[0]?.trim() ?? '0');
      return { type: 'minmax', value: isNaN(min) ? 0 : min };
    }
    const px = parsePx(t);
    return { type: 'px', value: isNaN(px) ? 0 : px };
  });

  const fixedTotal = tracks
    .filter((t) => t.type === 'px' || t.type === 'minmax')
    .reduce((a, t) => a + t.value, 0);

  const totalFr = tracks
    .filter((t) => t.type === 'fr')
    .reduce((a, t) => a + t.value, 0);

  const autoCount = tracks.filter((t) => t.type === 'auto').length;
  const remaining = Math.max(0, availableSize - fixedTotal);
  const frUnit = totalFr > 0 ? remaining / totalFr : 0;

  // Auto tracks share remaining space equally with fr tracks if no fr present
  const autoSize =
    autoCount > 0 && totalFr === 0 ? remaining / autoCount : frUnit > 0 ? frUnit : 0;

  return tracks.map((t) => {
    if (t.type === 'px' || t.type === 'minmax') return t.value;
    if (t.type === 'fr') return t.value * frUnit;
    return autoSize;
  });
}

/** Split track string into tokens, respecting nested parentheses */
function tokenizeTracks(s: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of s) {
    if (ch === '(') { depth++; current += ch; }
    else if (ch === ')') { depth--; current += ch; }
    else if (ch === ' ' && depth === 0) {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

// ─── Grid item placement ──────────────────────────────────────────────────────

export interface GridPlacement {
  colStart: number; // 1-indexed
  colSpan: number;
  rowStart: number; // 1-indexed
  rowSpan: number;
}

/** Parse a grid-column or grid-row value into start/span */
function parseLine(value: string): { start: number; span: number } {
  if (!value || value === 'auto') return { start: -1, span: 1 }; // -1 = auto-place

  const parts = value.split('/').map((s) => s.trim());
  if (parts.length === 2) {
    const startStr = parts[0];
    const endStr = parts[1];

    const start = parseInt(startStr);
    if (endStr.trim().startsWith('span')) {
      const span = parseInt(endStr.replace('span', '').trim()) || 1;
      return { start: isNaN(start) ? -1 : start, span };
    }
    const end = parseInt(endStr);
    return {
      start: isNaN(start) ? -1 : start,
      span: isNaN(end) || isNaN(start) ? 1 : Math.max(1, end - start),
    };
  }

  const v = parseInt(parts[0]);
  return { start: isNaN(v) ? -1 : v, span: 1 };
}

export function parseGridPlacement(styles: ComputedStyles): GridPlacement {
  const col = parseLine(styles.gridColumn);
  const row = parseLine(styles.gridRow);
  return {
    colStart: col.start,
    colSpan: col.span,
    rowStart: row.start,
    rowSpan: row.span,
  };
}

// ─── Gap resolution ───────────────────────────────────────────────────────────

function resolveGap(styles: ComputedStyles): { colGap: number; rowGap: number } {
  const colGap = parsePx(styles.columnGap !== 'normal' ? styles.columnGap : styles.gap);
  const rowGap = parsePx(styles.rowGap !== 'normal' ? styles.rowGap : styles.gap);
  return {
    colGap: isNaN(colGap) ? 0 : colGap,
    rowGap: isNaN(rowGap) ? 0 : rowGap,
  };
}

// ─── Main grid layout calculation ─────────────────────────────────────────────

export interface GridChildLayout {
  element: Element;
  box: LayoutBox;
  placement: GridPlacement;
}

export interface GridResult {
  childLayouts: Map<Element, LayoutBox>;
  /** Resolved placements with auto-placed items filled in (1-indexed) */
  resolvedPlacements: Map<Element, GridPlacement>;
  deductions: ConfidenceDeduction[];
  colCount: number;
  rowCount: number;
}

export function resolveGridLayout(
  container: Element,
  containerBox: LayoutBox,
  containerStyles: ComputedStyles,
  childStyles: Map<Element, ComputedStyles>
): GridResult {
  const deductions: ConfidenceDeduction[] = [];
  const childLayouts = new Map<Element, LayoutBox>();
  const resolvedPlacements = new Map<Element, GridPlacement>();

  const { colGap, rowGap } = resolveGap(containerStyles);

  const children = Array.from(container.children);
  if (children.length === 0) return { childLayouts, resolvedPlacements, deductions, colCount: 0, rowCount: 0 };

  // Inner dimensions = container box minus padding
  const padLeft   = containerStyles.paddingLeft;
  const padRight  = containerStyles.paddingRight;
  const padTop    = containerStyles.paddingTop;
  const padBottom = containerStyles.paddingBottom;
  const innerWidth  = Math.max(0, containerBox.width  - padLeft - padRight);
  const innerHeight = Math.max(0, containerBox.height - padTop  - padBottom);

  // Parse column/row templates against inner dimensions
  const colSizes = parseGridTemplate(containerStyles.gridTemplateColumns, innerWidth);
  const rowSizes = parseGridTemplate(containerStyles.gridTemplateRows,    innerHeight);

  const colCount = colSizes.length || 1;

  // Auto-place children that don't specify explicit positions
  // Build a grid occupancy map
  const occupied = new Set<string>(); // "col,row"
  const placements: Array<{ el: Element; placement: GridPlacement }> = [];

  // First pass: place explicitly positioned children
  for (const child of children) {
    const styles = childStyles.get(child);
    if (!styles) continue;
    const p = parseGridPlacement(styles);
    placements.push({ el: child, placement: p });
  }

  // Auto-place algorithm (simplified: left-to-right, top-to-bottom)
  let autoCol = 1;
  let autoRow = 1;

  for (const item of placements) {
    const { placement } = item;
    if (placement.colStart === -1 && placement.rowStart === -1) {
      // Find next free cell
      while (isCellOccupied(occupied, autoCol, autoRow, placement.colSpan, placement.rowSpan, colCount)) {
        autoCol++;
        if (autoCol + placement.colSpan - 1 > colCount) {
          autoCol = 1;
          autoRow++;
        }
      }
      placement.colStart = autoCol;
      placement.rowStart = autoRow;

      // Advance cursor
      autoCol += placement.colSpan;
      if (autoCol > colCount) {
        autoCol = 1;
        autoRow++;
      }
    } else if (placement.colStart === -1) {
      placement.colStart = autoCol;
    } else if (placement.rowStart === -1) {
      placement.rowStart = autoRow;
    }

    // Mark cells occupied
    for (let c = placement.colStart; c < placement.colStart + placement.colSpan; c++) {
      for (let r = placement.rowStart; r < placement.rowStart + placement.rowSpan; r++) {
        occupied.add(`${c},${r}`);
      }
    }
  }

  // Determine actual row count
  const maxRow = Math.max(...placements.map((p) => p.placement.rowStart + p.placement.rowSpan - 1), 1);

  // Build row sizes — auto rows distribute remaining innerHeight equally
  const resolvedRowSizes: number[] = [];
  const templateRowCount = rowSizes.length;

  if (templateRowCount >= maxRow) {
    // All rows defined by template
    for (let r = 0; r < maxRow; r++) resolvedRowSizes.push(rowSizes[r]);
  } else {
    // Some or all rows are auto — distribute available height
    const fixedRowTotal = rowSizes.reduce((a, b) => a + b, 0);
    const fixedGapTotal = Math.max(0, templateRowCount - 1) * rowGap;
    const autoRowCount  = maxRow - templateRowCount;
    const autoRowGaps   = Math.max(0, autoRowCount - 1) * rowGap;
    const autoRowHeight = autoRowCount > 0
      ? Math.max(0, (innerHeight - fixedRowTotal - fixedGapTotal - autoRowGaps) / autoRowCount)
      : 0;

    for (let r = 1; r <= maxRow; r++) {
      if (r <= templateRowCount) {
        resolvedRowSizes.push(rowSizes[r - 1]);
      } else {
        // Prefer grid-auto-rows if explicitly set, else distribute from container height
        const explicitAuto = parsePx(containerStyles.gridAutoRows);
        resolvedRowSizes.push(!isNaN(explicitAuto) && explicitAuto > 0 ? explicitAuto : autoRowHeight);
      }
    }
  }

  // Calculate cumulative column/row offsets (origin = container inner top-left)
  const originX = containerBox.x + padLeft;
  const originY = containerBox.y + padTop;
  const colOffsets = buildOffsets(colSizes, colGap);
  const rowOffsets = buildOffsets(resolvedRowSizes, rowGap);

  // Store resolved placements
  for (const { el, placement } of placements) {
    resolvedPlacements.set(el, { ...placement });
  }

  // Lay out each child
  for (const { el, placement } of placements) {
    const colIdx = placement.colStart - 1; // 0-indexed
    const rowIdx = placement.rowStart - 1;

    const x = originX + (colOffsets[colIdx] ?? 0);
    const y = originY + (rowOffsets[rowIdx] ?? 0);

    const width = sumSizes(colSizes, colIdx, placement.colSpan, colGap);
    const height = sumSizes(resolvedRowSizes, rowIdx, placement.rowSpan, rowGap);

    childLayouts.set(el, { x, y, width, height });
  }

  return { childLayouts, resolvedPlacements, deductions, colCount, rowCount: maxRow };
}

function buildOffsets(sizes: number[], gap: number): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const size of sizes) {
    offsets.push(acc);
    acc += size + gap;
  }
  return offsets;
}

function sumSizes(sizes: number[], startIdx: number, span: number, gap: number): number {
  let total = 0;
  for (let i = 0; i < span; i++) {
    total += sizes[startIdx + i] ?? 0;
    if (i < span - 1) total += gap;
  }
  return total;
}

function isCellOccupied(
  occupied: Set<string>,
  col: number,
  row: number,
  colSpan: number,
  rowSpan: number,
  colCount: number
): boolean {
  if (col + colSpan - 1 > colCount) return true;
  for (let c = col; c < col + colSpan; c++) {
    for (let r = row; r < row + rowSpan; r++) {
      if (occupied.has(`${c},${r}`)) return true;
    }
  }
  return false;
}
