import { background, withCancel } from "@go-like/context"
import { newApp, server } from "@go-like/core"
import { describe, expect, spyOn, test } from "bun:test"

import { newEnrollmentHandler } from "../src/http"
import { newLearningEnrollmentService } from "../src/runtime"
import { newCapacityRuntime, newMemoryEnrollmentRepository } from "../src/transport"
import { newEnrollLearner } from "../src/service"

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

  test("validates HTTP commands and preserves the not-found route", async () => {
    const service = newLearningEnrollmentService({ typescript: 1 })
    const notFound = await service.handler(
      new Request("https://example.test/v1/other", { method: "GET" })
    )
    expect(notFound.status).toBe(404)
    const malformed = await service.handler(
      new Request("https://example.test/v1/enrollments", {
        method: "POST",
        body: JSON.stringify({ requestId: "r", learnerId: "learner" })
      })
    )
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ code: "enrollment_rejected" })

    await withService(service, async function verify(): Promise<void> {
      for (const [field, value] of [
        ["requestId", ""],
        ["learnerId", ""],
        ["courseId", ""]
      ] as const) {
        const response = await enroll(
          service,
          field === "requestId" ? value : `invalid-${field}`,
          field === "learnerId" ? value : "learner",
          field === "courseId" ? value : "course"
        )
        expect(response.status).toBe(400)
      }
    })
  })

  test("covers repository idempotency, transport validation, and context failures", async () => {
    const repository = newMemoryEnrollmentRepository()
    const command = { requestId: "request", learnerId: "learner", courseId: "course" }
    expect(repository.find(background(), command)).toBeNull()
    expect(repository.learnerEnrolled(background(), "learner", "course")).toBe(false)
    const receipt = repository.save(background(), command, 2)
    expect(repository.find(background(), command)).toEqual(receipt)
    expect(repository.save(background(), command, 1)).toBe(receipt)
    expect(repository.learnerEnrolled(background(), "learner", "course")).toBe(true)
    expect(() => repository.find(background(), { ...command, courseId: "other" })).toThrow(
      "idempotency conflict"
    )
    expect(() => repository.save(background(), { ...command, courseId: "other" }, 1)).toThrow(
      "idempotency conflict"
    )
    const duplicateRepository = newMemoryEnrollmentRepository()
    duplicateRepository.save(background(), command, 2)
    expect(() =>
      duplicateRepository.save(
        background(),
        {
          requestId: "other-request",
          learnerId: command.learnerId,
          courseId: command.courseId
        },
        1
      )
    ).toThrow("learner is already enrolled")

    expect(() => newCapacityRuntime({ invalid: -1 })).toThrow(
      "course capacity must be a non-negative safe integer"
    )
    expect(() => newCapacityRuntime({ invalid: 1.5 })).toThrow(
      "course capacity must be a non-negative safe integer"
    )

    const [ctx, cancel] = withCancel(background())
    cancel()
    expect(() => repository.find(ctx, command)).toThrow()
    expect(() => repository.learnerEnrolled(ctx, "learner", "course")).toThrow()
    expect(() => repository.save(ctx, command, 1)).toThrow()
    const capacity = newCapacityRuntime({ course: 1 })
    expect(() => capacity.remaining(ctx, "course")).toThrow()
    expect(() => capacity.remaining(background(), "missing")).toThrow("unknown course")
    const originalParse = JSON.parse
    const parse = spyOn(JSON, "parse").mockImplementation((text) => {
      if (text.includes('"requestId":"bad-request"')) {
        return { requestId: "bad-request" }
      }
      return originalParse(text)
    })
    const runtime = newCapacityRuntime({ course: 1 })
    const running = runtime.server.start(background())
    void running.catch(() => {})
    await Promise.resolve()
    try {
      await expect(runtime.client.reserve(background(), "bad-request", "course")).rejects.toThrow(
        "invalid capacity request"
      )
    } finally {
      parse.mockRestore()
      await runtime.server.stop(background())
      await running
    }

    const replayRuntime = newCapacityRuntime({ course: 2, other: 1 })
    const replayRunning = replayRuntime.server.start(background())
    void replayRunning.catch(() => {})
    await Promise.resolve()
    try {
      expect(await replayRuntime.client.reserve(background(), "replay", "course")).toBe(1)
      expect(await replayRuntime.client.reserve(background(), "replay", "course")).toBe(1)
      await expect(replayRuntime.client.reserve(background(), "replay", "other")).rejects.toThrow(
        "capacity idempotency conflict"
      )
    } finally {
      await replayRuntime.server.stop(background())
      await replayRunning
    }

    const originalReplyParse = JSON.parse
    const invalidReplyParse = spyOn(JSON, "parse").mockImplementation((text) => {
      if (text.includes('"remainingSeats"')) return { remainingSeats: "bad" }
      return originalReplyParse(text)
    })
    const invalidReplyRuntime = newCapacityRuntime({ course: 1 })
    const invalidReplyRunning = invalidReplyRuntime.server.start(background())
    void invalidReplyRunning.catch(() => {})
    await Promise.resolve()
    try {
      await expect(
        invalidReplyRuntime.client.reserve(background(), "invalid-reply", "course")
      ).rejects.toThrow("invalid capacity reply")
    } finally {
      invalidReplyParse.mockRestore()
      await invalidReplyRuntime.server.stop(background())
      await invalidReplyRunning
    }

    const handler = newEnrollmentHandler(async () => {
      throw "non-error failure"
    })
    const response = await handler(
      new Request("https://example.test/v1/enrollments", {
        method: "POST",
        body: JSON.stringify(command)
      })
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ message: "enrollment failed" })
  })

  test("rejects invalid enrollment commands before any capacity call", async () => {
    const capacityCalls: string[] = []
    const enroll = newEnrollLearner(newMemoryEnrollmentRepository(), {
      reserve: async (_ctx, requestId) => {
        capacityCalls.push(requestId)
        return 0
      }
    })
    await expect(
      enroll(background(), { requestId: "", learnerId: "learner", courseId: "course" })
    ).rejects.toThrow("invalid requestId")
    expect(capacityCalls).toEqual([])
  })
})
