/**
 * GET /api/sessions
 *
 * Returns lightweight metadata for all active sessions.
 * Used by the Matrix Mirror tab bar to poll for concurrent sessions.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { listSessions } from '@/lib/hollow/session';
import { hasRedis, getRedis } from '@/lib/hollow/redis';

const INDEX_KEY = 'hollow:sessions-index';

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const debug = url.searchParams.get('debug') === '1';

  try {
    // Debug probe: write a value and read it back to verify round-trip
    let debugInfo: Record<string, unknown> | null = null;
    if (debug && hasRedis()) {
      const testKey = 'hollow:sessions-debug-probe';
      const testVal = JSON.stringify([{ probe: true, ts: Date.now() }]);
      await getRedis().set(testKey, testVal, { ex: 60 });
      const readBack = await getRedis().get<unknown>(testKey);
      const rawIndex = await getRedis().get<unknown>(INDEX_KEY);
      debugInfo = {
        probeWrote: testVal,
        probeRead: readBack,
        probeMatch: JSON.stringify(readBack) === testVal || (Array.isArray(readBack) && readBack[0]?.probe === true),
        rawIndex,
        rawIndexType: Array.isArray(rawIndex) ? 'array' : typeof rawIndex,
        hasRedis: hasRedis(),
      };
    }

    const sessions = await listSessions();

    const list = sessions
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(s => ({
        sessionId: s.sessionId,
        url: s.url,
        tier: s.tier ?? null,
        confidence: s.confidence ?? null,
        updatedAt: s.updatedAt,
      }));

    return NextResponse.json({ sessions: list, ...(debugInfo ? { _debug: debugInfo } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list sessions';
    console.error('[hollow/sessions]', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
