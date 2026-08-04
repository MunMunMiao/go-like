import { background } from "@go-like/context"
import { name, newApp, server } from "@go-like/core"
import { describe, expect, test } from "bun:test"
import { newWarehousePickingHandler } from "../src/http"
import {
  newAcquirePickLease,
  newCompletePickTask,
  newMemoryPickTaskRepository
} from "../src/service"
import { newPickWorkerServer } from "../src/worker"

describe("warehouse wave picking", () => {
  test("allows only one worker to hold an active lease", () => {
    const repository = newMemoryPickTaskRepository({ taskIds: ["task-1"] })
    const acquire = newAcquirePickLease(repository, () => 1_000)

    expect(
      acquire(background(), { taskId: "task-1", workerId: "worker-1", leaseMs: 500 }).fencingToken
    ).toBe(1)
    expect(() =>
      acquire(background(), { taskId: "task-1", workerId: "worker-2", leaseMs: 500 })
    ).toThrow("pick task lease is active")
  })

  test("increments fencing tokens after expiry and rejects the stale holder", () => {
    const repository = newMemoryPickTaskRepository({ taskIds: ["task-1"] })
    let observedNow = 1_000
    const now = () => observedNow
    const acquire = newAcquirePickLease(repository, now)
    const complete = newCompletePickTask(repository, now)
    const oldLease = acquire(background(), {
      taskId: "task-1",
      workerId: "worker-1",
      leaseMs: 100
    })
    observedNow = 1_101
    const recovered = acquire(background(), {
      taskId: "task-1",
      workerId: "worker-2",
      leaseMs: 100
    })

    expect(recovered.fencingToken).toBe(2)
    expect(() =>
      complete(background(), {
        taskId: "task-1",
        workerId: "worker-1",
        fencingToken: oldLease.fencingToken
      })
    ).toThrow("stale fencing token")
    expect(
      complete(background(), {
        taskId: "task-1",
        workerId: "worker-2",
        fencingToken: recovered.fencingToken
      }).status
    ).toBe("completed")
  })

  test("keeps completion idempotent through the standard Fetch handler", async () => {
    const repository = newMemoryPickTaskRepository({ taskIds: ["task-1"] })
    const handler = newWarehousePickingHandler(
      newAcquirePickLease(repository, () => 1_000),
      newCompletePickTask(repository, () => 1_000)
    )
    const leased = await handler(
      new Request("https://example.test/v1/pick-tasks/task-1/lease", {
        method: "POST",
        body: JSON.stringify({ workerId: "worker-1", leaseMs: 500 }),
        headers: { "content-type": "application/json" }
      })
    )
    expect(leased.status).toBe(201)

    const completionRequest = () =>
      new Request("https://example.test/v1/pick-tasks/task-1/complete", {
        method: "POST",
        body: JSON.stringify({ workerId: "worker-1", fencingToken: 1 }),
        headers: { "content-type": "application/json" }
      })
    const completed = await handler(completionRequest())
    const repeated = await handler(completionRequest())
    expect(completed.status).toBe(200)
    expect(repeated.status).toBe(200)
    expect(await repeated.json()).toMatchObject({
      taskId: "task-1",
      status: "completed",
      fencingToken: 1
    })
  })

  test("lets Core own the structural worker Server and release its lease on drain", async () => {
    const repository = newMemoryPickTaskRepository({ taskIds: ["task-core"] })
    const worker = newPickWorkerServer(
      repository,
      { taskId: "task-core", workerId: "worker-core", leaseMs: 5_000 },
      () => 1_000
    )
    const app = newApp(name("warehouse-wave"), server(worker))
    const running = app.run()
    await Promise.resolve()
    await Promise.resolve()

    expect(worker.lease()).toMatchObject({ workerId: "worker-core", fencingToken: 1 })
    expect(() =>
      newAcquirePickLease(repository, () => 1_000)(background(), {
        taskId: "task-core",
        workerId: "worker-other",
        leaseMs: 5_000
      })
    ).toThrow("pick task lease is active")

    await app.stop()
    await running

    expect(repository.get(background(), "task-core")).toMatchObject({
      status: "pending",
      workerId: null,
      fencingToken: 1
    })
    expect(
      newAcquirePickLease(repository, () => 1_001)(background(), {
        taskId: "task-core",
        workerId: "worker-other",
        leaseMs: 5_000
      }).fencingToken
    ).toBe(2)
  })
})
