/**
 * GET /api/session/:sessionId
 *
 * Returns the current session state including the last perceive result.
 * Used by the Mirror polling fallback when SSE is unavailable (Hobby tier).
 */

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { loadSession } from '@/lib/hollow/session';

export async function GET(
  _req: NextRequest,
  { params }: { params: { sessionId: string } }
): Promise<NextResponse> {
  const { sessionId: rawId } = params;
  // Strip sess: prefix — internal KV keys use bare UUIDs; accept both formats
  const sessionId = rawId.replace(/^sess:/, '');
  const session = await loadSession(sessionId);

  console.log(`[hollow/session] GET rawId=${rawId} bareId=${sessionId} found=${!!session}`);

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  return NextResponse.json({
    sessionId:     session.sessionId,
    url:           session.url,
    html:          session.html,
    gdgMap:        session.gdgMap        ?? null,
    confidence:    session.confidence    ?? null,
    tier:          session.tier          ?? null,
    tokenEstimate: session.tokenEstimate ?? null,
    stepCount:     session.stepCount,
    updatedAt:     session.updatedAt,
  });
}
