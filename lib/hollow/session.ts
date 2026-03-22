/**
 * Session store — persists DOM state (serialized HTML) between pipeline steps.
 *
 * Production: Upstash Redis via @upstash/redis (KV_REST_API_URL + KV_REST_API_TOKEN).
 * Local development: in-memory Map (no Redis credentials needed).
 *
 * The session model: each step loads state → processes → serializes → terminates.
 * Zero idle cost between steps.
 */

import { promisify } from 'util';
import { brotliCompress, brotliDecompress } from 'zlib';
import type { SessionState } from './types';
import { getRedis, hasRedis } from './redis';

const brotliCompressAsync  = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);

const BROTLI_PREFIX = 'brotli:';

async function compress(json: string): Promise<string> {
  const input = Buffer.from(json, 'utf8');
  const compressed = await brotliCompressAsync(input);
  const encoded = BROTLI_PREFIX + compressed.toString('base64');
  const pct = Math.round((1 - encoded.length / json.length) * 100);
  console.log(
    `[hollow/session] compressed ${(json.length / 1024).toFixed(1)}kb → ${(encoded.length / 1024).toFixed(1)}kb (${pct}%)`
  );
  return encoded;
}

async function decompress(stored: string): Promise<string> {
  if (!stored.startsWith(BROTLI_PREFIX)) return stored; // uncompressed legacy value
  const buf = Buffer.from(stored.slice(BROTLI_PREFIX.length), 'base64');
  const decompressed = await brotliDecompressAsync(buf);
  return decompressed.toString('utf8');
}

const SESSION_TTL = parseInt(process.env.SESSION_TTL_SECONDS ?? '3600', 10);

// ─── Startup log — which store is active ─────────────────────────────────────

if (hasRedis()) {
  console.log('[hollow/session] Using Upstash Redis store');
} else {
  console.log('[hollow/session] WARNING: Redis not configured, using in-memory store — sessions will not persist across lambda instances');
}

// ─── In-memory fallback (local dev / CI) ─────────────────────────────────────

// Stored on globalThis so all Next.js per-route webpack chunks share one Map.
const g = global as typeof globalThis & { __hollowMemStore?: Map<string, string> };
if (!g.__hollowMemStore) g.__hollowMemStore = new Map<string, string>();
const memStore = g.__hollowMemStore;

async function kvGet(key: string): Promise<string | null> {
  if (!hasRedis()) return memStore.get(key) ?? null;
  try {
    return await getRedis().get<string>(key);
  } catch {
    return memStore.get(key) ?? null;
  }
}

async function kvSet(key: string, value: string, ttl: number): Promise<void> {
  if (!hasRedis()) {
    console.log(`[hollow/session] kvSet key=${key} → memStore (no Redis)`);
    memStore.set(key, value);
    setTimeout(() => memStore.delete(key), ttl * 1000);
    return;
  }
  console.log(`[hollow/session] kvSet key=${key} → Redis SET ex=${ttl}`);
  try {
    await getRedis().set(key, value, { ex: ttl });
    console.log(`[hollow/session] kvSet key=${key} → Redis OK`);
  } catch (err) {
    console.error(`[hollow/session] kvSet key=${key} → Redis FAILED, falling back to memStore`, err);
    memStore.set(key, value);
    setTimeout(() => memStore.delete(key), ttl * 1000);
  }
}

async function kvDelete(key: string): Promise<void> {
  if (!hasRedis()) { memStore.delete(key); return; }
  try {
    await getRedis().del(key);
  } catch {
    memStore.delete(key);
  }
}

// ─── Session CRUD ─────────────────────────────────────────────────────────────

export async function loadSession(sessionId: string): Promise<SessionState | null> {
  const stored = await kvGet(`hollow:session:${sessionId}`);
  if (!stored) return null;
  try {
    const json = await decompress(stored);
    return JSON.parse(json) as SessionState;
  } catch {
    return null;
  }
}

export async function saveSession(state: SessionState): Promise<void> {
  const json = JSON.stringify(state);
  const stored = await compress(json);
  await kvSet(`hollow:session:${state.sessionId}`, stored, SESSION_TTL);
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

/**
 * List all active sessions — used by GET /api/sessions for the Mirror tab bar.
 * Returns lightweight metadata only (url, tier, confidence, updatedAt).
 */
export async function listSessions(): Promise<Pick<SessionState, 'sessionId' | 'url' | 'tier' | 'confidence' | 'updatedAt'>[]> {
  const SESSION_PREFIX = 'hollow:session:';

  // Local dev: enumerate in-memory store
  if (!hasRedis()) {
    const results: Pick<SessionState, 'sessionId' | 'url' | 'tier' | 'confidence' | 'updatedAt'>[] = [];
    for (const [key, value] of memStore.entries()) {
      if (!key.startsWith(SESSION_PREFIX)) continue;
      try {
        const json = await decompress(value);
        const state = JSON.parse(json) as SessionState;
        results.push({ sessionId: state.sessionId, url: state.url, tier: state.tier, confidence: state.confidence, updatedAt: state.updatedAt });
      } catch { /* skip corrupt entries */ }
    }
    return results;
  }

  try {
    const keys = await getRedis().keys(`${SESSION_PREFIX}*`);
    const results: Pick<SessionState, 'sessionId' | 'url' | 'tier' | 'confidence' | 'updatedAt'>[] = [];
    for (const key of keys) {
      try {
        const stored = await getRedis().get<string>(key);
        if (!stored) continue;
        const json = await decompress(stored);
        const state = JSON.parse(json) as SessionState;
        results.push({ sessionId: state.sessionId, url: state.url, tier: state.tier, confidence: state.confidence, updatedAt: state.updatedAt });
      } catch { /* skip corrupt entries */ }
    }
    return results;
  } catch {
    return [];
  }
}
