/**
 * GET /api/stream/:sessionId
 *
 * Server-Sent Events endpoint. Matrix Mirror connects here to receive
 * a live stream of DOM deltas, log entries, GDG maps, and confidence scores.
 *
 * Phase 1: emits the current session state on connect, then stays open
 * for events pushed via the sseEmitter module.
 */

export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { loadSession } from '@/lib/hollow/session';
import { getEmitter } from '@/lib/hollow/sse-emitter';

export async function GET(
  _req: NextRequest,
  { params }: { params: { sessionId: string } }
): Promise<Response> {
  const { sessionId } = params;

  const session = await loadSession(sessionId);

  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection event
      const connectEvent = formatSSE('connect', {
        sessionId,
        message: session ? 'Session found' : 'Session not found — waiting for first perceive',
        timestamp: new Date().toISOString(),
      });
      controller.enqueue(encoder.encode(connectEvent));

      // If session exists, emit current state
      if (session) {
        const stateEvent = formatSSE('log_entry', {
          tag: 'SYS',
          message: `Session resumed. url: ${session.url}. Steps: ${session.stepCount}`,
          timestamp: new Date().toISOString(),
        });
        controller.enqueue(encoder.encode(stateEvent));
      }

      // Register this stream with the SSE emitter
      const emitter = getEmitter();
      unsubscribe = emitter.subscribe(sessionId, (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(formatSSE(event, data)));
        } catch {
          // Client disconnected — clean up
          unsubscribe?.();
        }
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    },
  });
}

function formatSSE(event: string, data: unknown): string {
  const json = JSON.stringify(data);
  return `event: ${event}\ndata: ${json}\n\n`;
}
