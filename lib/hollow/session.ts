/**
 * Session store — persists DOM state (serialized HTML) between pipeline steps.
 *
 * Production: Vercel KV (Upstash Redis under the hood).
 * Local development: in-memory Map (no KV credentials needed).
 *
 * The session model: each step loads state → processes → serializes → terminates.
 * Zero idle cost between steps.
 */

import type { SessionState } from './types';

const SESSION_TTL = parseInt(process.env.SESSION_TTL_SECONDS ?? '3600', 10);

// ─── In-memory fallback (local dev / CI) ─────────────────────────────────────

// Stored on globalThis so all Next.js per-route webpack chunks share one Map.
const g = global as typeof globalThis & { __hollowMemStore?: Map<string, string> };
if (!g.__hollowMemStore) g.__hollowMemStore = new Map<string, string>();
const memStore = g.__hollowMemStore;

async function kvGet(key: string): Promise<string | null> {
  try {
    const { kv } = await import('@vercel/kv');
    return await kv.get<string>(key);
  } catch {
    return memStore.get(key) ?? null;
  }
}

async function kvSet(key: string, value: string, ttl: number): Promise<void> {
  try {
    const { kv } = await import('@vercel/kv');
    await kv.set(key, value, { ex: ttl });
    return;
  } catch {
    memStore.set(key, value);
    // In-memory doesn't auto-expire; clean up after TTL
    setTimeout(() => memStore.delete(key), ttl * 1000);
  }
}

async function kvDelete(key: string): Promise<void> {
  try {
    const { kv } = await import('@vercel/kv');
    await kv.del(key);
    return;
  } catch {
    memStore.delete(key);
  }
}

// ─── Session CRUD ─────────────────────────────────────────────────────────────

export async function loadSession(sessionId: string): Promise<SessionState | null> {
  const raw = await kvGet(`hollow:session:${sessionId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

export async function saveSession(state: SessionState): Promise<void> {
  const raw = JSON.stringify(state);
  await kvSet(`hollow:session:${state.sessionId}`, raw, SESSION_TTL);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await kvDelete(`hollow:session:${sessionId}`);
}

export function newSession(sessionId: string, url: string, html: string): SessionState {
  const now = Date.now();
  return {
    sessionId,
    url,
    html,
    createdAt: now,
    updatedAt: now,
    stepCount: 0,
  };
}

export function bumpSession(state: SessionState, html: string): SessionState {
  return {
    ...state,
    html,
    updatedAt: Date.now(),
    stepCount: state.stepCount + 1,
  };
}
