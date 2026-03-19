import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const memStore = new Map<string, string>();

async function storeIntervention(sessionId: string, text: string): Promise<void> {
  const key = `hollow:intervention:${sessionId}`;
  const value = JSON.stringify({ text, stagedAt: Date.now() });
  try {
    const { kv } = await import('@vercel/kv');
    await kv.set(key, value, { ex: 3600 });
    return;
  } catch {
    memStore.set(key, value);
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { sessionId, text } = body as { sessionId: string; text: string };

  if (!sessionId || !text) {
    return NextResponse.json({ error: 'sessionId and text required' }, { status: 400 });
  }

  await storeIntervention(sessionId, text);

  return NextResponse.json({ ok: true, sessionId, text });
}
