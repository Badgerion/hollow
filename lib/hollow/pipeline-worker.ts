/**
 * Worker thread entry point for local development.
 *
 * Runs the full Happy DOM pipeline in a separate thread so the main
 * event loop stays free to handle incoming HTTP requests (preventing
 * UND_ERR_HEADERS_TIMEOUT from undici's 10-second header deadline).
 *
 * Used only when process.env.VERCEL is not set. On Vercel, each
 * lambda is an isolated process so there's no event loop sharing.
 */

import { workerData, parentPort } from 'worker_threads';
import { perceiveCore } from './pipeline';
import type { PerceiveRequest } from './types';

const req = workerData as PerceiveRequest;

perceiveCore(req)
  .then(result => parentPort!.postMessage({ ok: true, result }))
  .catch(err =>
    parentPort!.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  );
