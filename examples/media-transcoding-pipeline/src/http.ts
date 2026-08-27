import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"

import type { SubmitTranscode } from "./service"
import type { TranscodeJob, TranscodeProfile } from "./transcode-jobs"

/** Decodes one untrusted transcoding request. */
function transcodeJobFrom(value: unknown): TranscodeJob {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid transcode request")
  }
  const jobId = Reflect.get(value, "jobId")
  const inputUrl = Reflect.get(value, "inputUrl")
  const profile = Reflect.get(value, "profile")
  const durationSeconds = Reflect.get(value, "durationSeconds")
  if (
    typeof jobId !== "string" ||
    typeof inputUrl !== "string" ||
    (profile !== "audio-aac" && profile !== "video-720p") ||
    typeof durationSeconds !== "number"
  ) {
    throw new TypeError("invalid transcode request")
  }
  const selectedProfile: TranscodeProfile = profile
  return Object.freeze({ jobId, inputUrl, profile: selectedProfile, durationSeconds })
}

/** Creates the standard Fetch media-submission endpoint. */
export function newMediaTranscodingHandler(submit: SubmitTranscode): Handler {
  return contextHandler(async function mediaTranscodingHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/v1/transcode-jobs") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(submit(ctx, transcodeJobFrom(await request.json())), { status: 201 })
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return Response.json(
          { code: "invalid_transcode_job", message: error.message },
          { status: 400 }
        )
      }
      const message = error instanceof Error ? error.message : "transcode submission failed"
      const status = message === "transcode worker is not running" ? 503 : 409
      return Response.json({ code: "transcode_rejected", message }, { status })
    }
  })
}
