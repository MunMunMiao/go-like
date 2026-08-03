import type { Context } from "@likego/context"
import type { Handler } from "@likego/web"

import { newMediaTranscodingHandler } from "./http"
import { validateTranscodeJob, type TranscodeJob, type TranscodeResult } from "./transcode-jobs"
import { newMemoryTranscodeWorker, type TranscodeWorker } from "./transcode-worker"

export type SubmitTranscode = (ctx: Context, job: TranscodeJob) => TranscodeResult

/** Creates the Context-first media submission use case. */
export function newSubmitTranscode(worker: TranscodeWorker): SubmitTranscode {
  return function submitTranscode(ctx: Context, job: TranscodeJob): TranscodeResult {
    validateTranscodeJob(job)
    return worker.submit(ctx, job)
  }
}

export interface MediaTranscodingService {
  readonly handler: Handler
  readonly worker: TranscodeWorker
}

/** Composes the Fetch Handler and exposes its worker to the process lifecycle owner. */
export function newMediaTranscodingService(): MediaTranscodingService {
  const worker = newMemoryTranscodeWorker()
  return Object.freeze({
    handler: newMediaTranscodingHandler(newSubmitTranscode(worker)),
    worker
  })
}
