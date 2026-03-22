/**
 * GET /api/sessions
 *
 * Returns lightweight metadata for all active sessions.
 * Used by the Matrix Mirror tab bar to poll for concurrent sessions.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { listSessions } from '@/lib/hollow/session';

export async function GET(): Promise<NextResponse> {
  try {
    const sessions = await listSessions();

    // Sort newest-updated first; strip html/gdgMap (too large for a list response)
    const list = sessions
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(s => ({
        sessionId: s.sessionId,
        url: s.url,
        tier: s.tier ?? null,
        confidence: s.confidence ?? null,
        updatedAt: s.updatedAt,
      }));

    return NextResponse.json({ sessions: list });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list sessions';
    console.error('[hollow/sessions]', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
