/**
 * SSE emitter — pub/sub for Matrix Mirror streaming.
 *
 * Singleton per Node.js process. In a multi-instance serverless deployment,
 * a Redis pub/sub channel would be needed. Phase 1 uses in-process pub/sub,
 * which works correctly when Vercel routes a session's requests to the same
 * instance (not guaranteed in production — acceptable Phase 1 trade-off).
 */

type Listener = (event: string, data: unknown) => void;

class SSEEmitter {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(sessionId: string, listener: Listener): () => void {
    if (!this.listeners.has(sessionId)) {
      this.listeners.set(sessionId, new Set());
    }
    this.listeners.get(sessionId)!.add(listener);

    return () => {
      this.listeners.get(sessionId)?.delete(listener);
    };
  }

  emit(sessionId: string, event: string, data: unknown): void {
    const subs = this.listeners.get(sessionId);
    if (!subs || subs.size === 0) return;
    for (const listener of subs) {
      try {
        listener(event, data);
      } catch {
        // Remove dead listeners
        subs.delete(listener);
      }
    }
  }

  emitLog(
    sessionId: string,
    tag: 'SYS' | 'GDG' | 'AI' | 'OK' | 'WARN' | 'ERR',
    message: string
  ): void {
    this.emit(sessionId, 'log_entry', {
      tag,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}

// Global singleton — stored on globalThis so it survives across Next.js
// per-route webpack chunk boundaries (each route gets its own module scope,
// but they all share the same globalThis in the Node.js process).
const g = global as typeof globalThis & { __hollowEmitter?: SSEEmitter };

export function getEmitter(): SSEEmitter {
  if (!g.__hollowEmitter) g.__hollowEmitter = new SSEEmitter();
  return g.__hollowEmitter;
}
