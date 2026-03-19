/**
 * Shared Upstash Redis client factory.
 *
 * Supports both Vercel KV env var names (KV_REST_API_URL / KV_REST_API_TOKEN)
 * and standalone Upstash names (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
 *
 * No globalThis caching — each call creates a fresh client so serverless cold
 * starts always pick up the live env vars (caching can capture empty credentials
 * set before the env vars are injected by the platform).
 */

import { Redis } from '@upstash/redis';

export function getRedis(): Redis {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    '';
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    '';
  console.log(`[hollow/redis] getRedis url=${!!url} token=${!!token}`);
  return new Redis({ url, token });
}

/** True when Redis credentials are present in the environment. */
export function hasRedis(): boolean {
  return !!(
    (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
    (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
  );
}
