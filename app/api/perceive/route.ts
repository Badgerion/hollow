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
import type { PerceiveRequest } from '@/lib/hollow/types';

export async function POST(req: NextRequest): Promise<NextResponse> {
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
    });

    return NextResponse.json(result, { status: 200 });
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
