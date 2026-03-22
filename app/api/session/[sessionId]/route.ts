/**
 * GET    /api/session/:sessionId — return session state (gdgMap, tier, confidence, url)
 * DELETE /api/session/:sessionId — close and remove a session from Redis
 *
 * GET is used by the Mirror polling fallback (SSE unavailable) and hollow-mcp
 * (hollow_session_get tool). DELETE is used by hollow-mcp (hollow_session_close tool).
 */

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { loadSession, deleteSession } from '@/lib/hollow/session';

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

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { sessionId: string } },
): Promise<NextResponse> {
  const { sessionId: rawId } = params;
  const sessionId = rawId.replace(/^sess:/, '');
  await deleteSession(sessionId);
  return NextResponse.json({ closed: true, sessionId: rawId });
}
