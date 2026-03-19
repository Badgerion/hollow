/**
 * GET /api/stream/:sessionId
 *
 * Server-Sent Events endpoint. Matrix Mirror connects here to receive
 * DOM deltas, GDG maps, confidence scores, and log entries.
 *
 * Transport:
 *   Production (KV env vars set):
 *     Polls hollow:events:{sessionId} Redis List every 400 ms, forwarding
 *     new entries to the SSE response. Closes at 55 s and sends a `reconnect`
 *     event — EventSource reconnects automatically, resuming from cursor 0
 *     (events persist in the list until TTL expires, so no events are lost).
 *
 *   Local dev (no KV env vars):
 *     Subscribes to the in-process globalThis emitter. Identical behaviour
 *     to before, zero config required.
 */

export const runtime     = 'nodejs';
export const maxDuration = 60; // Vercel limit; stream self-closes at 55 s

import { NextRequest } from 'next/server';
import { loadSession } from '@/lib/hollow/session';
import {
  subscribeLocal,
  useRedis,
  EVENTS_KEY,
  type QueuedEvent,
} from '@/lib/hollow/sse-emitter';

// Close a few seconds before Vercel would hard-kill the function, so the
// client receives a clean `reconnect` event instead of a broken connection.
const MAX_STREAM_MS    = 55_000;
const POLL_INTERVAL_MS =    400;

export async function GET(
  _req: NextRequest,
  { params }: { params: { sessionId: string } }
): Promise<Response> {
  const { sessionId } = params;
  const session = await loadSession(sessionId);
  const encoder = new TextEncoder();

  let localUnsub: (() => void) | null = null;
  const abort = new AbortController();

  const stream = new ReadableStream({
    start(controller) {
      // ── Initial events (synchronous — sent before polling begins) ────────────
      controller.enqueue(encoder.encode(formatSSE('connect', {
        sessionId,
        message: session
          ? 'Session found'
          : 'Session not found — waiting for first perceive',
        timestamp: new Date().toISOString(),
      })));

      if (session) {
        controller.enqueue(encoder.encode(formatSSE('log_entry', {
          tag: 'SYS',
          message: `Session resumed. url: ${session.url}. Steps: ${session.stepCount}`,
          timestamp: new Date().toISOString(),
        })));
      }

      // ── Transport ─────────────────────────────────────────────────────────────
      if (useRedis()) {
        // Production: kick off async polling loop — does not block start()
        pollRedis(controller, encoder, sessionId, abort.signal);
      } else {
        // Local dev: in-process subscription
        localUnsub = subscribeLocal(sessionId, (event, data) => {
          try {
            controller.enqueue(encoder.encode(formatSSE(event, data)));
          } catch {
            localUnsub?.();
          }
        });
      }
    },

    cancel() {
      abort.abort();
      localUnsub?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ── Redis polling loop ─────────────────────────────────────────────────────────

async function pollRedis(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  sessionId: string,
  signal: AbortSignal
): Promise<void> {
  const { kv } = await import('@vercel/kv');
  const key = EVENTS_KEY(sessionId);
  let cursor = 0;
  const deadline = Date.now() + MAX_STREAM_MS;

  while (!signal.aborted && Date.now() < deadline) {
    try {
      // kv auto-parses JSON on read, so items come back as QueuedEvent objects
      const items = await kv.lrange<QueuedEvent>(key, cursor, -1);
      if (items.length > 0) {
        cursor += items.length;
        for (const { event, data } of items) {
          controller.enqueue(encoder.encode(formatSSE(event, data)));
        }
      }
    } catch (err) {
      console.error('[hollow/stream] poll error:', err);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Graceful close — EventSource auto-reconnects when the stream ends.
  // On reconnect the Mirror re-opens the SSE and the stream starts a fresh
  // poll from cursor 0, replaying any events still in the Redis list.
  if (!signal.aborted) {
    try {
      controller.enqueue(encoder.encode(formatSSE('reconnect', {
        reason:    'poll_timeout',
        sessionId,
        timestamp: new Date().toISOString(),
      })));
      controller.close();
    } catch { /* already closed by client */ }
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
