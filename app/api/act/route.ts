/**
 * POST /api/act
 *
 * Performs an action (click, fill, navigate, scroll, select, hover) against
 * the session DOM state, then re-runs the full perception pipeline.
 */

export const runtime = 'nodejs';
export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { loadSession } from '@/lib/hollow/session';
import { buildDOM } from '@/lib/hollow/dom';
import { perceive } from '@/lib/hollow/pipeline';
import { getEmitter } from '@/lib/hollow/sse-emitter';
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

  const session = await loadSession(body.sessionId);
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
      // We need to find the element by its GDG Spatial ID.
      // For now, we inject a data attribute mapping during perceive (Phase 1 limitation:
      // we use DOM query by position as a bridge). In Phase 2, element IDs will be
      // embedded as data-hollow-id attributes in the serialized HTML.
      //
      // Interim approach: re-generate the perception map to resolve element IDs,
      // then apply the action.

      const allInteractive = Array.from(
        document.querySelectorAll('a, button, input, select, textarea, [role], [onclick], [tabindex]')
      );

      // The element ID is 1-indexed in the order actionable elements were encountered
      const target = allInteractive[action.elementId - 1] as HTMLElement | undefined;

      if (!target) {
        window.happyDOM.close();
        return NextResponse.json(
          { error: `Element ID ${action.elementId} not found` },
          { status: 404 }
        );
      }

      if (action.type === 'fill' && action.value !== undefined) {
        (target as HTMLInputElement).value = action.value;
        target.dispatchEvent(new window.Event('input', { bubbles: true }));
        target.dispatchEvent(new window.Event('change', { bubbles: true }));
      } else if (action.type === 'click') {
        target.click();
      } else if (action.type === 'select' && action.value !== undefined) {
        (target as HTMLSelectElement).value = action.value;
        target.dispatchEvent(new window.Event('change', { bubbles: true }));
      }

      // Wait for any JS reactions
      try {
        await window.happyDOM.waitUntilComplete();
      } catch { /* ignore */ }
    }

    // Emit ACT event for Matrix Mirror highlight before re-perception
    if (action.elementId !== undefined) {
      getEmitter().emit(body.sessionId, 'log_entry', {
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
      sessionId: body.sessionId,
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
