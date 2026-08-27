import type { Handler } from "@go-like/web"

import { newGetPermit, newMemoryPermitRepository, newSubmitPermit } from "./permits"
import { newPermitHandler } from "./http"
import { newPermitReviewWorker, type PermitReviewWorker } from "./worker"

export interface GovernmentPermitService {
  readonly handler: Handler
  readonly worker: PermitReviewWorker
}

/** Composes the permit Handler and exposes its approval worker to the process lifecycle owner. */
export function newGovernmentPermitService(): GovernmentPermitService {
  const repository = newMemoryPermitRepository()
  const worker = newPermitReviewWorker(repository)
  return Object.freeze({
    handler: newPermitHandler(newSubmitPermit(repository), newGetPermit(repository)),
    worker
  })
}
