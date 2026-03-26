/**
 * POST /api/perceive
 *
 * Entry point for the Hollow perception pipeline.
 * Fetches a URL, runs it through Happy DOM + Yoga + Grid + GDG Spatial,
 * and returns the structured perception map.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { perceive } from '@/lib/hollow/pipeline';
import { getStateProvider } from '@/lib/hollow/state-provider';
import type { PerceiveRequest } from '@/lib/hollow/types';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// IP-based sliding-window rate limit: 10 requests per minute per IP.
// Initialised lazily so the module loads cleanly in local dev without
// UPSTASH_REDIS_REST_URL/TOKEN set (getRedis() guard keeps it safe).
let _ratelimit: Ratelimit | null = null;
function getRatelimit(): Ratelimit | null {
  if (_ratelimit) return _ratelimit;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  _ratelimit = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(10, '1 m'),
    prefix: 'hollow:rl',
    analytics: false,
  });
  return _ratelimit;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Rate limiting ────────────────────────────────────────────────────────────
  const rl = getRatelimit();
  if (rl) {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? '127.0.0.1';
    const { success, limit, remaining, reset } = await rl.limit(ip);
    if (!success) {
      return NextResponse.json(
        {
          error: 'rate_limited',
          message: 'Hollow is rate limited during beta (10 req/min). Deploy your own instance: github.com/Badgerion/hollow',
        },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit':     String(limit),
            'X-RateLimit-Remaining': String(remaining),
            'X-RateLimit-Reset':     String(reset),
            'Retry-After':           String(Math.ceil((reset - Date.now()) / 1000)),
          },
        },
      );
    }
  }

  let body: Partial<PerceiveRequest>;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.url && !body.html) {
    return NextResponse.json({ error: '`url` or `html` is required' }, { status: 400 });
  }

  // Validate URL format only when a URL was supplied
  if (body.url) {
    try {
      new URL(body.url);
    } catch {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
    }
  }

  try {
    const result = await perceive({
      url: body.url,
      sessionId: body.sessionId,
      html: body.html,
      stateId: body.stateId,
    });

    // Hydra dehydrate — fire after pipeline completes, non-blocking for response
    if (body.stateId) {
      const provider = getStateProvider();
      provider.dehydrate(result.sessionId, body.stateId, {}).catch(err => {
        console.error('[hollow/hydra] dehydrate error:', err);
      });
    }

    return NextResponse.json(result, {
      status: 200,
      headers: {
        'Timing-Allow-Origin': '*',
      },
    });
  } catch (err) {
    // Structured network errors (WAF block, HTTP error) — return as clean JSON
    const networkPayload = (err as { hollowNetworkPayload?: unknown }).hollowNetworkPayload;
    if (networkPayload) {
      return NextResponse.json(networkPayload, { status: 200 });
    }
    const message = err instanceof Error ? err.message : 'Internal pipeline error';
    console.error('[hollow/perceive]', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
