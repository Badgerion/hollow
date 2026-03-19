import { Suspense } from 'react';
import { MatrixMirror } from './MatrixMirror';

export default function MirrorPage({
  searchParams,
}: {
  searchParams: { session?: string };
}) {
  return (
    <Suspense>
      <MatrixMirror sessionId={searchParams.session ?? null} />
    </Suspense>
  );
}
