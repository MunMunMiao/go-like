const JobId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type TranscodeProfile = "audio-aac" | "video-720p"

export interface TranscodeJob {
  readonly jobId: string
  readonly inputUrl: string
  readonly profile: TranscodeProfile
  readonly durationSeconds: number
}

export interface TranscodeResult extends TranscodeJob {
  readonly outputKey: string
  readonly status: "completed"
}

/** Validates one job before it reaches the worker. */
export function validateTranscodeJob(job: TranscodeJob): void {
  if (!JobId.test(job.jobId)) throw new TypeError("invalid transcode jobId")
  let url: URL
  try {
    url = new URL(job.inputUrl)
  } catch {
    throw new TypeError("invalid media input URL")
  }
  if (url.protocol !== "https:") throw new TypeError("media input URL must use HTTPS")
  if (job.profile !== "audio-aac" && job.profile !== "video-720p") {
    throw new TypeError("unsupported transcode profile")
  }
  if (!Number.isSafeInteger(job.durationSeconds) || job.durationSeconds <= 0) {
    throw new RangeError("durationSeconds must be a positive safe integer")
  }
}

/** Builds the deterministic object key for one admitted profile. */
export function outputKey(job: TranscodeJob): string {
  validateTranscodeJob(job)
  const extension = job.profile === "audio-aac" ? "m4a" : "mp4"
  return `transcoded/${job.jobId}.${extension}`
}

/** Reports whether a result came from the exact same idempotent job. */
export function sameTranscodeJob(result: TranscodeResult, job: TranscodeJob): boolean {
  return (
    result.jobId === job.jobId &&
    result.inputUrl === job.inputUrl &&
    result.profile === job.profile &&
    result.durationSeconds === job.durationSeconds
  )
}
