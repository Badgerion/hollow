/**
 * POST /api/act
 *
 * Performs an action (click, fill, navigate, scroll, select, hover) against
 * the session DOM state, then re-runs the full perception pipeline.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { loadSession } from '@/lib/hollow/session';
import { buildDOM } from '@/lib/hollow/dom';
import { perceive } from '@/lib/hollow/pipeline';
import { getEmitter } from '@/lib/hollow/sse-emitter';
import { findFiberRoots, findFiberById } from '@/lib/hollow/vdom';
import type { ActRequest } from '@/lib/hollow/types';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Partial<ActRequest>;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.sessionId) {
    return NextResponse.json({ error: '`sessionId` is required' }, { status: 400 });
  }

  if (!body.action || !body.action.type) {
    return NextResponse.json({ error: '`action.type` is required' }, { status: 400 });
  }

  // Strip sess: prefix — internal KV keys use bare UUIDs
  const sessionId = body.sessionId.replace(/^sess:/, '');

  const session = await loadSession(sessionId);
  if (!session) {
    return NextResponse.json(
      { error: `Session ${body.sessionId} not found or expired` },
      { status: 404 }
    );
  }

  try {
    // Load the persisted DOM and apply the action
    const { window, document, vitality } = await buildDOM(session.html, session.url);
    const jsErrors = vitality.getErrors();

    const action = body.action;

    // ── Apply the action to the DOM ─────────────────────────────────────────
    if (action.type === 'navigate' && action.url) {
      // Navigate: treat as a new perceive with the new URL
      window.happyDOM.close();
      return NextResponse.json(
        await perceive({ url: action.url, sessionId: body.sessionId }),
        { status: 200 }
      );
    }

    if (action.elementId !== undefined) {
      let target: HTMLElement | undefined;

      if (session.tier === 'vdom') {
        // VDOM session: resolve element ID via the Fiber tree.
        // React re-registers on the hook during buildDOM, so findFiberRoots
        // returns the committed Fiber tree. The stateNode of a HostComponent
        // (tag=5) is the actual Happy DOM element.
        const roots = findFiberRoots(window as unknown as Record<string, unknown>);
        const fiber = roots.length > 0 ? findFiberById(roots, action.elementId) : null;
        if (fiber?.stateNode) {
          target = fiber.stateNode as HTMLElement;
        }
      } else {
        // Spatial session: resolve by position in interactive element list.
        const allInteractive = Array.from(
          document.querySelectorAll('a, button, input, select, textarea, [role], [onclick], [tabindex]')
        );
        target = allInteractive[action.elementId - 1] as unknown as HTMLElement | undefined;
      }

      if (!target) {
        window.happyDOM.close();
        return NextResponse.json(
          { error: `Element ID ${action.elementId} not found` },
          { status: 404 }
        );
      }

      if (action.type === 'fill' && action.value !== undefined) {
        (target as unknown as HTMLInputElement).value = action.value;
        target.dispatchEvent(new (window.Event as unknown as typeof Event)('input', { bubbles: true }));
        target.dispatchEvent(new (window.Event as unknown as typeof Event)('change', { bubbles: true }));
      } else if (action.type === 'click') {
        target.click();
      } else if (action.type === 'select' && action.value !== undefined) {
        (target as unknown as HTMLSelectElement).value = action.value;
        target.dispatchEvent(new (window.Event as unknown as typeof Event)('change', { bubbles: true }));
      }

      // Wait for any JS reactions
      try {
        await window.happyDOM.waitUntilComplete();
      } catch { /* ignore */ }
    }

    // Emit ACT event for Matrix Mirror highlight before re-perception
    if (action.elementId !== undefined) {
      getEmitter().emit(sessionId, 'log_entry', {
        tag: 'ACT',
        message: `${action.type} element #${action.elementId}${action.value !== undefined ? ` → "${action.value}"` : ''}`,
        timestamp: new Date().toISOString(),
        elementId: action.elementId,
      });
    }

    window.happyDOM.close();

    // Re-run perception on the mutated session
    const intervention = body.intervention;
    const result = await perceive({
      url: session.url,
      sessionId,
    });

    // Surface any intervention in the response for Matrix Mirror
    return NextResponse.json(
      { ...result, intervention: intervention ?? null, jsErrors },
      { status: 200 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed';
    console.error('[hollow/act]', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
