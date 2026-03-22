/**
 * GET  /api/session/:id — return current session state (gdgMap, tier, confidence, url)
 * DELETE /api/session/:id — close and remove a session from Redis
 *
 * Used by the hollow-mcp server for hollow_session_get and hollow_session_close tools.
 */

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { loadSession, deleteSession } from '@/lib/hollow/session';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const sessionId = params.id;
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }

  const state = await loadSession(sessionId);
  if (!state) {
    return NextResponse.json(
      { error: 'session_not_found', message: `Session ${sessionId} not found or expired.` },
      { status: 404 },
    );
  }

  return NextResponse.json({
    sessionId: state.sessionId,
    url: state.url,
    gdgMap: state.gdgMap ?? '',
    confidence: state.confidence ?? null,
    tier: state.tier ?? null,
    updatedAt: state.updatedAt,
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const sessionId = params.id;
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }

  await deleteSession(sessionId);
  return NextResponse.json({ closed: true, sessionId });
}
