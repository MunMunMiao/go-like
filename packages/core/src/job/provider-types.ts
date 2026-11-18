import type { JobBackoff } from "./types"

/** Enqueue options after defaults are applied. */
export interface ResolvedEnqueueOptions {
  readonly id: string | null
  readonly attempts: number
  readonly backoff: JobBackoff
}

/** Worker options after defaults are applied. */
export interface ResolvedJobWorkerOptions {
  readonly concurrency: number
  readonly drainTimeoutMs: number
}
