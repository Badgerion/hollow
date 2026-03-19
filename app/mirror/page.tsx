import { Suspense } from 'react';
import { MatrixMirror } from './MatrixMirror';

export default function MirrorPage({
  searchParams,
}: {
  searchParams: { session?: string };
}) {
  // Normalise: internal IDs are bare UUIDs; API responses return sess:{uuid}.
  // Accept both forms and ensure the Mirror always works with the prefixed form
  // so the poll URL /api/session/sess:{uuid} reaches the correct server handler.
  const raw = searchParams.session ?? null;
  const sessionId = raw
    ? raw.startsWith('sess:') ? raw : `sess:${raw}`
    : null;

  return (
    <Suspense>
      <MatrixMirror sessionId={sessionId} />
    </Suspense>
  );
}
