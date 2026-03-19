import { NextRequest, NextResponse } from 'next/server';
import { getRedis, hasRedis } from '@/lib/hollow/redis';

export const runtime = 'nodejs';

const memStore = new Map<string, string>();

async function storeIntervention(sessionId: string, text: string): Promise<void> {
  const key = `hollow:intervention:${sessionId}`;
  const value = JSON.stringify({ text, stagedAt: Date.now() });
  if (!hasRedis()) { memStore.set(key, value); return; }
  try {
    await getRedis().set(key, value, { ex: 3600 });
  } catch {
    memStore.set(key, value);
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { sessionId: rawId, text } = body as { sessionId: string; text: string };
  // Strip sess: prefix — internal KV keys use bare UUIDs
  const sessionId = rawId?.replace(/^sess:/, '');

  if (!sessionId || !text) {
    return NextResponse.json({ error: 'sessionId and text required' }, { status: 400 });
  }

  await storeIntervention(sessionId, text);

  return NextResponse.json({ ok: true, sessionId, text });
}
