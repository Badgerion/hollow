/**
 * Shared Upstash Redis client factory.
 *
 * Uses KV_REST_API_URL / KV_REST_API_TOKEN — the same env vars that were
 * injected by the former @vercel/kv integration, so .env.example is unchanged.
 *
 * The client is cached on globalThis so all Next.js per-route webpack chunks
 * share one instance rather than constructing one per request.
 */

import { Redis } from '@upstash/redis';

const g = global as typeof globalThis & { __hollowRedis?: Redis };

export function getRedis(): Redis {
  if (!g.__hollowRedis) {
    g.__hollowRedis = new Redis({
      url:   process.env.KV_REST_API_URL   ?? '',
      token: process.env.KV_REST_API_TOKEN ?? '',
    });
  }
  return g.__hollowRedis;
}

/** True when Redis credentials are present in the environment. */
export function hasRedis(): boolean {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}
