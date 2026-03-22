/**
 * Unified Redis client factory.
 *
 * Supports two connection modes detected from environment variables:
 *
 * 1. Upstash REST (HTTPS) — preferred for Vercel serverless:
 *    KV_REST_API_URL + KV_REST_API_TOKEN  (Vercel KV names)
 *    UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (standalone Upstash)
 *
 * 2. Raw Redis TCP — for Redis Labs / self-hosted:
 *    REDIS_URL = redis://[:password@]host:port[/db]
 *    Uses ioredis under the hood.
 *
 * Both modes expose the same minimal interface (get/set/del) used by session.ts.
 */

import { Redis as UpstashRedis } from '@upstash/redis';
import IORedisCtor from 'ioredis';

// ─── Unified interface ────────────────────────────────────────────────────────

export interface RedisClient {
  get<T = string>(key: string): Promise<T | null>;
  set(key: string, value: string, opts?: { ex: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  rpush(key: string, ...values: (string | object)[]): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  lrange<T = string>(key: string, start: number, stop: number): Promise<T[]>;
  /** Glob-pattern key scan. Only supports trailing-wildcard patterns (e.g. "prefix:*"). */
  keys(pattern: string): Promise<string[]>;
}

// ─── Upstash REST adapter ─────────────────────────────────────────────────────

function makeUpstashClient(): RedisClient {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    '';
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    '';
  const client = new UpstashRedis({ url, token });
  return {
    get: <T>(key: string) => client.get<T>(key),
    set: (key: string, value: string, opts?: { ex: number }) =>
      opts ? client.set(key, value, { ex: opts.ex }) : client.set(key, value),
    del: (key: string) => client.del(key),
    rpush: (key: string, ...values: (string | object)[]) => client.rpush(key, ...values as string[]),
    expire: (key: string, seconds: number) => client.expire(key, seconds),
    lrange: <T>(key: string, start: number, stop: number) => client.lrange<T>(key, start, stop),
    keys: (pattern: string) => client.keys(pattern),
  };
}

// ─── ioredis TCP adapter ──────────────────────────────────────────────────────

// Cache the ioredis connection on globalThis so it persists across hot-reloads
// without opening new TCP connections each time.
const g = global as typeof globalThis & { __hollowIORedis?: IORedisCtor };

function makeIORedisClient(): RedisClient {
  if (!g.__hollowIORedis) {
    g.__hollowIORedis = new IORedisCtor(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    g.__hollowIORedis.on('error', (err: Error) => {
      console.error('[hollow/redis] ioredis error:', err.message);
    });
  }
  const redis = g.__hollowIORedis;
  return {
    get: async <T>(key: string) => {
      const val = await redis.get(key);
      if (val === null) return null;
      // ioredis returns strings; upstash returns parsed JSON — normalise
      try { return JSON.parse(val) as T; } catch { return val as unknown as T; }
    },
    set: async (key: string, value: string, opts?: { ex: number }) => {
      if (opts?.ex) return redis.set(key, value, 'EX', opts.ex);
      return redis.set(key, value);
    },
    del: (key: string) => redis.del(key),
    rpush: (key: string, ...values: (string | object)[]) =>
      redis.rpush(key, ...values.map(v => typeof v === 'string' ? v : JSON.stringify(v))),
    expire: (key: string, seconds: number) => redis.expire(key, seconds),
    lrange: async <T>(key: string, start: number, stop: number): Promise<T[]> => {
      const items = await redis.lrange(key, start, stop);
      return items.map(item => {
        try { return JSON.parse(item) as T; } catch { return item as unknown as T; }
      });
    },
    keys: (pattern: string) => redis.keys(pattern),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** True when any Redis configuration is present in the environment. */
export function hasRedis(): boolean {
  return !!(
    ((process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
     (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)) ||
    process.env.REDIS_URL
  );
}

/** Returns a unified Redis client using the best available credentials. */
export function getRedis(): RedisClient {
  const hasUpstash =
    (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
    (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN);

  if (hasUpstash) {
    console.log('[hollow/redis] getRedis → Upstash REST client');
    return makeUpstashClient();
  }

  if (process.env.REDIS_URL) {
    console.log('[hollow/redis] getRedis → ioredis TCP client');
    return makeIORedisClient();
  }

  throw new Error('[hollow/redis] getRedis called but hasRedis() is false — no credentials');
}
