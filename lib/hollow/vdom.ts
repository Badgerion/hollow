/**
 * VDOM Hijack — React Fiber tree extraction.
 *
 * When React boots inside Happy DOM it registers itself on the injected
 * __REACT_DEVTOOLS_GLOBAL_HOOK__. After JS execution completes we walk the
 * committed Fiber tree and produce a GDG-style perception map from the live
 * component state rather than from the partial DOM.
 */

// ─── Fiber tag constants (matches ReactWorkTags) ──────────────────────────────

const TAG_FUNCTION_COMPONENT = 0;
const TAG_CLASS_COMPONENT     = 1;
const TAG_HOST_ROOT           = 3;
const TAG_HOST_COMPONENT      = 5;
const TAG_HOST_TEXT           = 6;
// Skip these tags (infrastructure, context, portals, etc.)
const SKIP_TAGS = new Set([
  2,  // IndeterminateComponent
  3,  // HostRoot — starting point only; don't emit as a node
  4,  // HostPortal
  7,  // Fragment
  8,  // Mode
  9,  // ContextConsumer
  10, // ContextProvider
  11, // ForwardRef
  12, // Profiler
  13, // SuspenseComponent
  16, // LazyComponent
  17, // IncompleteClassComponent
  19, // SuspenseListComponent
  22, // OffscreenComponent
  23, // LegacyHiddenComponent
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VDOMNode {
  id: number | null;      // assigned to actionable elements
  name: string;           // component name or HTML tag
  tag: number;            // fiber tag
  text?: string;          // for HostText / button/link text
  props?: Record<string, unknown>;
  children: VDOMNode[];
  isActionable: boolean;
  actionType?: 'click' | 'fill' | 'select';
}

export interface VDOMResult {
  nodes: VDOMNode[];      // top-level children of HostRoot
  nodeCount: number;
  actionableCount: number;
  gdgMap: string;
  tokenEstimate: number;
}

// ─── Fiber traversal ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fiber = any;

function getFiberName(fiber: Fiber): string {
  const { tag, type } = fiber;
  if (tag === TAG_HOST_COMPONENT) return String(type ?? 'el').toLowerCase();
  if (tag === TAG_HOST_TEXT)      return '#text';
  if (!type) return 'Unknown';
  if (typeof type === 'string')   return type;
  if (typeof type === 'function') return type.displayName ?? type.name ?? 'Component';
  // Memo / ForwardRef wrappers
  if (type.displayName) return String(type.displayName);
  if (type.render)      return type.render.displayName ?? type.render.name ?? 'ForwardRef';
  if (type.type)        return getFiberName({ ...fiber, type: type.type });
  return 'Unknown';
}

const ACTIONABLE_HTML = new Set(['a', 'button', 'input', 'select', 'textarea']);

function isActionableHost(fiber: Fiber): boolean {
  if (fiber.tag !== TAG_HOST_COMPONENT) return false;
  const tag = String(fiber.type ?? '').toLowerCase();
  if (ACTIONABLE_HTML.has(tag)) return true;
  const p = fiber.pendingProps ?? {};
  if (p.onClick || p.onChange || p.role === 'button' || p.role === 'link') return true;
  return false;
}

function getActionType(fiber: Fiber): 'click' | 'fill' | 'select' | undefined {
  if (fiber.tag !== TAG_HOST_COMPONENT) return undefined;
  const tag = String(fiber.type ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return 'fill';
  if (tag === 'select') return 'select';
  if (isActionableHost(fiber)) return 'click';
  return undefined;
}

function getNodeText(fiber: Fiber): string | undefined {
  if (fiber.tag === TAG_HOST_TEXT) {
    return String(fiber.pendingProps ?? '').trim().slice(0, 80) || undefined;
  }
  // For host elements, pull text from single HostText child
  if (fiber.tag === TAG_HOST_COMPONENT) {
    const child = fiber.child;
    if (child && child.tag === TAG_HOST_TEXT && !child.sibling) {
      return String(child.pendingProps ?? '').trim().slice(0, 80) || undefined;
    }
  }
  return undefined;
}

function safeProps(fiber: Fiber): Record<string, unknown> | undefined {
  if (fiber.tag !== TAG_HOST_COMPONENT) return undefined;
  const p = fiber.pendingProps ?? {};
  const out: Record<string, unknown> = {};
  if (p.href)        out.href = String(p.href).slice(0, 200);
  if (p.type)        out.type = p.type;
  if (p.placeholder) out.placeholder = String(p.placeholder).slice(0, 100);
  if (p.role)        out.role = p.role;
  if (p['aria-label']) out['aria-label'] = String(p['aria-label']).slice(0, 100);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Iterative depth-first walk of a Fiber subtree.
 * Skips infrastructure tags (HostRoot, Fragment, Context, etc.).
 * Returns a tree of VDOMNode.
 */
export function traverseFiber(rootFiber: Fiber): VDOMNode[] {
  let actionIdCounter = 1;
  const result: VDOMNode[] = [];

  // Stack entries: [fiber, parentChildren]
  const stack: Array<[Fiber, VDOMNode[]]> = [];

  // Start from children of HostRoot
  let child = rootFiber.child;
  while (child) {
    stack.push([child, result]);
    child = child.sibling;
  }

  while (stack.length > 0) {
    const [fiber, parentChildren] = stack.pop()!;

    const { tag } = fiber;

    // Skip purely infrastructure nodes — but still walk their children
    if (SKIP_TAGS.has(tag) && tag !== TAG_HOST_ROOT) {
      // Walk children, attaching them to the same parent
      let c = fiber.child;
      while (c) {
        stack.push([c, parentChildren]);
        c = c.sibling;
      }
      continue;
    }

    // Skip HostText that is purely whitespace
    if (tag === TAG_HOST_TEXT) {
      const text = String(fiber.pendingProps ?? '').trim();
      if (!text) {
        continue;
      }
    }

    const actionable = isActionableHost(fiber);
    const node: VDOMNode = {
      id: actionable ? actionIdCounter++ : null,
      name: getFiberName(fiber),
      tag,
      text: getNodeText(fiber),
      props: safeProps(fiber),
      children: [],
      isActionable: actionable,
      actionType: getActionType(fiber),
    };

    parentChildren.push(node);

    // Push children (in reverse so left-to-right order is maintained)
    const childFibers: Fiber[] = [];
    let c = fiber.child;
    // Don't expand HostText children — we already grabbed the text above
    if (tag !== TAG_HOST_TEXT) {
      while (c) {
        // Skip the single HostText child we've already inlined as .text
        if (!(tag === TAG_HOST_COMPONENT && c.tag === TAG_HOST_TEXT && !c.sibling)) {
          childFibers.push(c);
        }
        c = c.sibling;
      }
    }
    for (let i = childFibers.length - 1; i >= 0; i--) {
      stack.push([childFibers[i], node.children]);
    }
  }

  return result;
}

// ─── Find Fiber roots ─────────────────────────────────────────────────────────

/**
 * Locate the committed Fiber trees from the injected DevTools hook.
 * Returns an array of HostRoot fibers (root.current).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findFiberRoots(win: any): Fiber[] {
  const hook = win.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return [];

  const roots: Fiber[] = [];

  // Primary path: fiberRoots array populated by onCommitFiberRoot
  if (Array.isArray(hook.fiberRoots) && hook.fiberRoots.length > 0) {
    for (const root of hook.fiberRoots) {
      if (root?.current) roots.push(root.current);
    }
    if (roots.length > 0) return roots;
  }

  // Fallback: scan DOM nodes for __reactFiber$ keys (React 17+)
  try {
    const doc = win.document;
    const walker = doc.createTreeWalker(doc.body, 0x1 /* SHOW_ELEMENT */);
    let node = walker.currentNode;
    while (node) {
      const keys = Object.keys(node);
      for (const key of keys) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          const fiber: Fiber = (node as Record<string, unknown>)[key];
          if (fiber) {
            // Walk up to the HostRoot
            let f = fiber;
            while (f.return) f = f.return;
            if (f.tag === TAG_HOST_ROOT && !roots.includes(f)) {
              roots.push(f);
            }
          }
        }
      }
      node = walker.nextNode();
    }
  } catch {
    // DOM traversal failed — that's OK
  }

  return roots;
}

// ─── Find fiber stateNode by action ID ───────────────────────────────────────

/**
 * Walk the Fiber tree (same DFS order as traverseFiber) and return the
 * stateNode of the actionable element assigned the given ID.
 * stateNode for a HostComponent is the actual Happy DOM element.
 */
export function findFiberById(roots: Fiber[], targetId: number): Fiber | null {
  let counter = 0;
  const stack: Fiber[] = [];

  for (const root of roots) {
    let child = root.child;
    while (child) {
      stack.push(child);
      child = child.sibling;
    }
  }

  while (stack.length > 0) {
    const fiber = stack.pop()!;
    const { tag } = fiber;

    if (SKIP_TAGS.has(tag) && tag !== TAG_HOST_ROOT) {
      let c = fiber.child;
      while (c) { stack.push(c); c = c.sibling; }
      continue;
    }

    if (tag === TAG_HOST_TEXT) {
      const text = String(fiber.pendingProps ?? '').trim();
      if (!text) continue;
    }

    if (isActionableHost(fiber)) {
      counter++;
      if (counter === targetId) return fiber;
    }

    if (tag !== TAG_HOST_TEXT) {
      const childFibers: Fiber[] = [];
      // Skip inlined single HostText child
      let c = fiber.child;
      while (c) {
        if (!(tag === TAG_HOST_COMPONENT && c.tag === TAG_HOST_TEXT && !c.sibling)) {
          childFibers.push(c);
        }
        c = c.sibling;
      }
      for (let i = childFibers.length - 1; i >= 0; i--) {
        stack.push(childFibers[i]);
      }
    }
  }

  return null;
}

// ─── Count nodes ─────────────────────────────────────────────────────────────

function countNodes(nodes: VDOMNode[]): { total: number; actionable: number } {
  let total = 0;
  let actionable = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const n = stack.pop()!;
    total++;
    if (n.isActionable) actionable++;
    stack.push(...n.children);
  }
  return { total, actionable };
}

// ─── GDG Map generation ───────────────────────────────────────────────────────

function renderNode(node: VDOMNode, indent: number): string {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];

  const idPart   = node.id !== null ? ` [${node.id}]` : '';
  const textPart = node.text ? ` "${node.text}"` : '';
  const actPart  = node.isActionable ? ` <${node.actionType ?? 'click'}>` : '';

  let propPart = '';
  if (node.props) {
    const pairs = Object.entries(node.props)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ');
    if (pairs) propPart = ` {${pairs}}`;
  }

  lines.push(`${pad}${node.name}${idPart}${textPart}${actPart}${propPart}`);

  for (const child of node.children) {
    lines.push(renderNode(child, indent + 1));
  }

  return lines.join('\n');
}

/**
 * Convert a VDOM node tree into a GDG-style perception string.
 */
export function generateVDOMMap(nodes: VDOMNode[]): VDOMResult {
  const { total, actionable } = countNodes(nodes);

  const header = [
    '[VDOM: React — Fiber tree extracted]',
    `Components: ${total}  Actionable: ${actionable}`,
    '',
  ].join('\n');

  const body = nodes.map(n => renderNode(n, 0)).join('\n');
  const gdgMap = header + body;

  // Rough token estimate: 1 token ≈ 4 chars
  const tokenEstimate = Math.ceil(gdgMap.length / 4);

  return {
    nodes,
    nodeCount: total,
    actionableCount: actionable,
    gdgMap,
    tokenEstimate,
  };
}
