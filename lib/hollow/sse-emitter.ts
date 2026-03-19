/**
 * SSE emitter — event transport for Matrix Mirror streaming.
 *
 * Transport selection (checked at runtime via env vars):
 *
 *   Production (KV_REST_API_URL + KV_REST_API_TOKEN set):
 *     emit()  → RPUSH hollow:events:{sessionId}   (fire-and-forget)
 *     stream  → LRANGE polling loop with a per-connection cursor
 *     Uses the same Upstash Redis instance as session storage — no extra DB.
 *     Works correctly across separate serverless function instances.
 *
 *   Local dev (no KV env vars):
 *     In-process globalThis singleton. Zero config. Dev experience unchanged.
 *
 * Event shape is identical in both modes — only the transport changes.
 * Callers (pipeline.ts, act/route.ts) use getEmitter() unchanged.
 */

export type LogTag = 'SYS' | 'GDG' | 'AI' | 'ACT' | 'OK' | 'WARN' | 'ERR';

// Shape of each entry pushed to the Redis List
export interface QueuedEvent {
  event: string;
  data:  unknown;
  ts:    number;
}

// Redis list key for a session's event queue
export const EVENTS_KEY = (sessionId: string) => `hollow:events:${sessionId}`;
const EVENTS_TTL_S = 3600;

// True when Upstash Redis credentials are available
import { hasRedis, getRedis } from './redis';
export { hasRedis as useRedis } from './redis';

// ── In-process emitter (local dev) ────────────────────────────────────────────

type Listener = (event: string, data: unknown) => void;

class InProcessEmitter {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(sessionId: string, listener: Listener): () => void {
    if (!this.listeners.has(sessionId)) this.listeners.set(sessionId, new Set());
    this.listeners.get(sessionId)!.add(listener);
    return () => this.listeners.get(sessionId)?.delete(listener);
  }

  emit(sessionId: string, event: string, data: unknown): void {
    const subs = this.listeners.get(sessionId);
    if (!subs) return;
    for (const fn of subs) {
      try { fn(event, data); } catch { subs.delete(fn); }
    }
  }

  emitLog(sessionId: string, tag: LogTag, message: string): void {
    this.emit(sessionId, 'log_entry', {
      tag,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}

const g = global as typeof globalThis & { __hollowEmitter?: InProcessEmitter };
function localEmitter(): InProcessEmitter {
  if (!g.__hollowEmitter) g.__hollowEmitter = new InProcessEmitter();
  return g.__hollowEmitter;
}

// ── Redis publish (production) ─────────────────────────────────────────────────

async function redisPublish(sessionId: string, event: string, data: unknown): Promise<void> {
  const redis = getRedis();
  const payload: QueuedEvent = { event, data, ts: Date.now() };
  // @upstash/redis auto-serialises objects to JSON on write, auto-parses on read
  await redis.rpush(EVENTS_KEY(sessionId), payload);
  await redis.expire(EVENTS_KEY(sessionId), EVENTS_TTL_S);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * getEmitter() — backwards-compatible shim.
 * pipeline.ts and act/route.ts call this unchanged.
 * Under the hood, emit() routes to Redis or the local emitter.
 */
export function getEmitter() {
  return {
    emit(sessionId: string, event: string, data: unknown): void {
      if (hasRedis()) {
        // Fire-and-forget — pipeline doesn't block on network I/O.
        // Events land in Redis; the stream route picks them up on the next poll.
        redisPublish(sessionId, event, data).catch(err =>
          console.error('[hollow/sse] redis publish error:', err)
        );
      } else {
        localEmitter().emit(sessionId, event, data);
      }
    },

    emitLog(sessionId: string, tag: LogTag, message: string): void {
      this.emit(sessionId, 'log_entry', {
        tag,
        message,
        timestamp: new Date().toISOString(),
      });
    },
  };
}

/**
 * subscribeLocal() — used by the stream route (local dev path only).
 * In production the stream route polls Redis directly; this isn't called.
 */
export function subscribeLocal(sessionId: string, listener: Listener): () => void {
  return localEmitter().subscribe(sessionId, listener);
}
