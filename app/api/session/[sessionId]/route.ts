/**
 * DELETE /api/session/:sessionId
 *
 * Clears DOM state from the KV store. Terminates the session.
 */

export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { deleteSession, loadSession } from '@/lib/hollow/session';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { sessionId: string } }
): Promise<NextResponse> {
  const { sessionId } = params;

  const session = await loadSession(sessionId);
  if (!session) {
    return NextResponse.json(
      { error: `Session ${sessionId} not found` },
      { status: 404 }
    );
  }

  await deleteSession(sessionId);

  return NextResponse.json({ deleted: true, sessionId }, { status: 200 });
}
