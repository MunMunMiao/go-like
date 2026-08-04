import { background } from "@go-like/context"
import { newApp, server } from "@go-like/core"
import { describe, expect, test } from "bun:test"

import { newLearningEnrollmentService } from "../src/runtime"

/** Starts the internal capacity server and drains it after each assertion. */
async function withService(
  service: ReturnType<typeof newLearningEnrollmentService>,
  run: () => Promise<void>
): Promise<void> {
  const app = newApp(server(service.capacity.server))
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

/** Sends one enrollment command through the public Fetch boundary. */
function enroll(
  service: ReturnType<typeof newLearningEnrollmentService>,
  requestId: string,
  learnerId: string,
  courseId: string
): Promise<Response> {
  return Promise.resolve(
    service.handler(
      new Request("https://example.test/v1/enrollments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, learnerId, courseId })
      })
    )
  )
}

describe("learning enrollment", () => {
  test("never drives course capacity below zero", async () => {
    const service = newLearningEnrollmentService(Object.freeze({ typescript: 1 }))
    await withService(service, async function verify(): Promise<void> {
      expect((await enroll(service, "one", "learner-one", "typescript")).status).toBe(201)
      expect((await enroll(service, "two", "learner-two", "typescript")).status).toBe(409)
      expect(service.capacity.remaining(background(), "typescript")).toBe(0)
    })
  })

  test("keeps one request idempotent across the internal transport boundary", async () => {
    const service = newLearningEnrollmentService(Object.freeze({ distributed: 2 }))
    await withService(service, async function verify(): Promise<void> {
      const first = await enroll(service, "stable", "learner-one", "distributed")
      const second = await enroll(service, "stable", "learner-one", "distributed")
      expect(await first.json()).toEqual(await second.json())
      expect(service.capacity.remaining(background(), "distributed")).toBe(1)
    })
  })

  test("rejects a second enrollment for the same learner and course", async () => {
    const service = newLearningEnrollmentService(Object.freeze({ systems: 2 }))
    await withService(service, async function verify(): Promise<void> {
      expect((await enroll(service, "first", "learner-one", "systems")).status).toBe(201)
      const duplicate = await enroll(service, "second", "learner-one", "systems")
      expect(duplicate.status).toBe(409)
      expect(service.capacity.remaining(background(), "systems")).toBe(1)
    })
  })

  test("rejects conflicting reuse of an enrollment request id", async () => {
    const service = newLearningEnrollmentService(Object.freeze({ architecture: 1, databases: 1 }))
    await withService(service, async function verify(): Promise<void> {
      expect((await enroll(service, "same", "learner-one", "architecture")).status).toBe(201)
      const conflict = await enroll(service, "same", "learner-one", "databases")
      expect(conflict.status).toBe(409)
      expect(service.capacity.remaining(background(), "databases")).toBe(1)
    })
  })
})
