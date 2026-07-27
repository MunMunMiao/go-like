import { background } from "@likego/context"
import { name, newApp, server } from "@likego/core"
import { describe, expect, test } from "bun:test"

import { newMediaTranscodingService, newSubmitTranscode } from "../src/service"
import type { TranscodeJob } from "../src/transcode-jobs"
import { newMemoryTranscodeWorker, type TranscodeWorker } from "../src/transcode-worker"

/** Lets Core own one transcode worker for the duration of an assertion. */
async function withWorker(worker: TranscodeWorker, run: () => Promise<void>): Promise<void> {
  const app = newApp(name("media-transcoding-pipeline-test"), server(worker))
  const running = app.run()
  await Promise.resolve()
  await Promise.resolve()
  try {
    await run()
  } finally {
    await app.stop()
    await running
  }
}

describe("media transcoding pipeline", () => {
  test("requires the Core-owned worker to be running", async () => {
    const service = newMediaTranscodingService()
    const response = await service.handler(
      new Request("https://example.test/v1/transcode-jobs", {
        method: "POST",
        body: JSON.stringify({
          jobId: "job-1",
          inputUrl: "https://media.example/input.mov",
          profile: "video-720p",
          durationSeconds: 60
        })
      })
    )
    expect(response.status).toBe(503)
    expect(service.worker.diagnostics()).toEqual({
      status: "idle",
      starts: 0,
      stops: 0,
      completedJobs: 0
    })
  })

  test("rejects insecure media sources before worker admission", async () => {
    const service = newMediaTranscodingService()
    await withWorker(service.worker, async function verify(): Promise<void> {
      const response = await service.handler(
        new Request("https://example.test/v1/transcode-jobs", {
          method: "POST",
          body: JSON.stringify({
            jobId: "job-1",
            inputUrl: "http://media.example/input.mov",
            profile: "video-720p",
            durationSeconds: 60
          })
        })
      )
      expect(response.status).toBe(400)
      expect(service.worker.diagnostics().completedJobs).toBe(0)
    })
  })

  test("uses deterministic output formats and idempotent job identity", async () => {
    const worker = newMemoryTranscodeWorker()
    const submit = newSubmitTranscode(worker)
    const job: TranscodeJob = Object.freeze({
      jobId: "job-1",
      inputUrl: "https://media.example/input.wav",
      profile: "audio-aac",
      durationSeconds: 60
    })
    await withWorker(worker, async function verify(): Promise<void> {
      const first = submit(background(), job)
      expect(first.outputKey).toBe("transcoded/job-1.m4a")
      expect(submit(background(), job)).toBe(first)
      expect(worker.diagnostics().completedJobs).toBe(1)
      expect(() =>
        submit(background(), {
          jobId: "job-1",
          inputUrl: "https://media.example/other.wav",
          profile: "audio-aac",
          durationSeconds: 60
        })
      ).toThrow("transcode job identity conflict")
    })
  })

  test("lets LikeGo Core start and drain the worker without orphans", async () => {
    const service = newMediaTranscodingService()
    const app = newApp(name("media-transcoding-pipeline-test"), server(service.worker))
    const running = app.run()
    await Promise.resolve()
    await Promise.resolve()
    try {
      expect(service.worker.diagnostics().status).toBe("running")
      const response = await service.handler(
        new Request("https://example.test/v1/transcode-jobs", {
          method: "POST",
          body: JSON.stringify({
            jobId: "web-job",
            inputUrl: "https://media.example/input.mov",
            profile: "video-720p",
            durationSeconds: 60
          })
        })
      )
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({
        status: "completed",
        outputKey: "transcoded/web-job.mp4"
      })
    } finally {
      await app.stop()
      await running
    }
    expect(service.worker.diagnostics()).toEqual({
      status: "stopped",
      starts: 1,
      stops: 1,
      completedJobs: 1
    })
  })
})
