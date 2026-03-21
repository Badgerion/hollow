// ─── JS Errors ──────────────────────────────────────────────────────────────

export interface JSError {
  type: string;
  message: string;
  source?: string;
  line?: number;
  col?: number;
}

// ─── Confidence ──────────────────────────────────────────────────────────────

export interface ConfidenceDeduction {
  reason: string;
  amount: number;
}

// ─── Element Layout ──────────────────────────────────────────────────────────

export type ActionType = 'click' | 'fill' | 'select' | 'scroll' | 'hover';
export type LayoutContext = 'flex' | 'grid' | 'block' | 'inline';

export interface ElementLayout {
  // Assigned to actionable elements; null for containers
  id: number | null;
  tag: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;

  isActionable: boolean;
  actionType?: ActionType;
  inputType?: string;
  href?: string;
  placeholder?: string;

  // Confidence signals
  isAbsolute: boolean;
  isFixed: boolean;
  hasTransform: boolean;
  hasJsDrivenResize: boolean;

  // Layout context of this element's parent
  layoutContext: LayoutContext;
  flexDirection?: string;
  gridCol?: number;
  gridRow?: number;

  // Container annotations (when this element IS a flex/grid container)
  ownFlexDirection?: string; // e.g. 'row' | 'column' (if element is flex container)
  ownGridCols?: number;      // column count (if element is grid container)

  children: ElementLayout[];
}

// ─── Computed Styles ─────────────────────────────────────────────────────────

export interface ComputedStyles {
  display: string;
  visibility: string;
  opacity: string;

  // Box model
  width: string;
  height: string;
  minWidth: string;
  maxWidth: string;
  minHeight: string;
  maxHeight: string;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  borderTopWidth: number;
  borderRightWidth: number;
  borderBottomWidth: number;
  borderLeftWidth: number;
  boxSizing: string;

  // Position
  position: string;
  top: string;
  left: string;
  right: string;
  bottom: string;
  transform: string;
  overflow: string;

  // Flexbox
  flexDirection: string;
  justifyContent: string;
  alignItems: string;
  alignContent: string;
  flexWrap: string;
  flexGrow: number;
  flexShrink: number;
  flexBasis: string;
  order: number;

  // Grid
  gridTemplateColumns: string;
  gridTemplateRows: string;
  gridAutoColumns: string;
  gridAutoRows: string;
  gridColumn: string;
  gridRow: string;
  gap: string;
  columnGap: string;
  rowGap: string;
}

// ─── Session ─────────────────────────────────────────────────────────────────

export interface SessionState {
  sessionId: string;
  url: string;
  html: string;
  createdAt: number;
  updatedAt: number;
  stepCount: number;
  // Snapshot of the last perceive result — used by the polling fallback endpoint
  gdgMap?: string;
  confidence?: number;
  tier?: 'hollow' | 'partial' | 'vdom' | 'mobile-api' | 'cache' | 'text';
  tokenEstimate?: number;
}

// ─── Pipeline Result ─────────────────────────────────────────────────────────

export interface HollowPerceiveResult {
  sessionId: string;
  gdgMap: string;
  domDelta: string;
  confidence: number;
  confidenceDeductions: ConfidenceDeduction[];
  jsErrors: JSError[];
  tier: 'hollow' | 'partial' | 'vdom' | 'mobile-api' | 'cache' | 'text';
  elementCount: number;
  actionableCount: number;
  tokenEstimate: number;
}

// ─── API Request / Response ───────────────────────────────────────────────────

export interface PerceiveRequest {
  /** Target URL. Required unless `html` is provided directly. */
  url?: string;
  sessionId?: string;
  /** Skip network fetch — parse this HTML directly. Useful for testing or pre-fetched content. */
  html?: string;
}

export interface ActAction {
  type: 'fill' | 'click' | 'navigate' | 'scroll' | 'select' | 'hover';
  elementId?: number;
  value?: string;
  url?: string;
}

export interface ActRequest {
  sessionId: string;
  action: ActAction;
  intervention?: string;
}
