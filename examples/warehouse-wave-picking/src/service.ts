import type { Context } from "@likego/context"

export type PickTaskStatus = "pending" | "leased" | "completed"

export interface PickTask {
  readonly taskId: string
  readonly status: PickTaskStatus
  readonly workerId: string | null
  readonly fencingToken: number
  readonly leaseExpiresAt: number | null
}

export interface PickLease {
  readonly taskId: string
  readonly workerId: string
  readonly fencingToken: number
  readonly expiresAt: number
}

export interface AcquirePickLeaseCommand {
  readonly taskId: string
  readonly workerId: string
  readonly leaseMs: number
}

export interface CompletePickTaskCommand {
  readonly taskId: string
  readonly workerId: string
  readonly fencingToken: number
}

export interface PickTaskRepository {
  acquire(ctx: Context, command: AcquirePickLeaseCommand, now: number): PickLease
  complete(ctx: Context, command: CompletePickTaskCommand, now: number): PickTask
  release(ctx: Context, command: CompletePickTaskCommand): PickTask
  get(ctx: Context, taskId: string): PickTask | undefined
}

export interface MemoryPickTaskRepositoryOptions {
  readonly taskIds: readonly string[]
}

export type AcquirePickLease = (ctx: Context, command: AcquirePickLeaseCommand) => PickLease

export type CompletePickTask = (ctx: Context, command: CompletePickTaskCommand) => PickTask

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
}

/** Validates a bounded pick-task lease request. */
export function validateAcquirePickLease(command: AcquirePickLeaseCommand): void {
  if (!validId(command.taskId)) throw new TypeError("invalid taskId")
  if (!validId(command.workerId)) throw new TypeError("invalid workerId")
  if (
    !Number.isSafeInteger(command.leaseMs) ||
    command.leaseMs <= 0 ||
    command.leaseMs > 3_600_000
  ) {
    throw new RangeError("leaseMs must be between 1 and 3600000")
  }
}

/** Validates a fenced completion request. */
export function validateCompletePickTask(command: CompletePickTaskCommand): void {
  if (!validId(command.taskId)) throw new TypeError("invalid taskId")
  if (!validId(command.workerId)) throw new TypeError("invalid workerId")
  if (!Number.isSafeInteger(command.fencingToken) || command.fencingToken <= 0) {
    throw new RangeError("fencingToken must be a positive safe integer")
  }
}

/** Creates an in-memory pick-task repository with monotonically increasing fencing tokens. */
export function newMemoryPickTaskRepository(
  options: MemoryPickTaskRepositoryOptions
): PickTaskRepository {
  const tasks = new Map<string, PickTask>()
  for (const taskId of options.taskIds) {
    if (!validId(taskId)) throw new TypeError("invalid taskId")
    const task: PickTask = Object.freeze({
      taskId,
      status: "pending",
      workerId: null,
      fencingToken: 0,
      leaseExpiresAt: null
    })
    tasks.set(taskId, task)
  }

  return Object.freeze({
    acquire(ctx: Context, command: AcquirePickLeaseCommand, now: number): PickLease {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const task = tasks.get(command.taskId)
      if (task === undefined) throw new Error("pick task not found")
      if (task.status === "completed") throw new Error("pick task already completed")
      if (task.status === "leased" && task.leaseExpiresAt !== null && task.leaseExpiresAt > now) {
        if (task.workerId !== command.workerId) throw new Error("pick task lease is active")
        return Object.freeze({
          taskId: task.taskId,
          workerId: command.workerId,
          fencingToken: task.fencingToken,
          expiresAt: task.leaseExpiresAt
        })
      }
      const fencingToken = task.fencingToken + 1
      const expiresAt = now + command.leaseMs
      const leased: PickTask = Object.freeze({
        taskId: task.taskId,
        status: "leased",
        workerId: command.workerId,
        fencingToken,
        leaseExpiresAt: expiresAt
      })
      tasks.set(task.taskId, leased)
      return Object.freeze({
        taskId: task.taskId,
        workerId: command.workerId,
        fencingToken,
        expiresAt
      })
    },
    complete(ctx: Context, command: CompletePickTaskCommand, now: number): PickTask {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const task = tasks.get(command.taskId)
      if (task === undefined) throw new Error("pick task not found")
      if (task.status === "completed") {
        if (task.workerId === command.workerId && task.fencingToken === command.fencingToken) {
          return task
        }
        throw new Error("stale fencing token")
      }
      if (
        task.status !== "leased" ||
        task.workerId !== command.workerId ||
        task.fencingToken !== command.fencingToken
      ) {
        throw new Error("stale fencing token")
      }
      if (task.leaseExpiresAt === null || task.leaseExpiresAt <= now) {
        throw new Error("pick task lease expired")
      }
      const completed: PickTask = Object.freeze({
        taskId: task.taskId,
        status: "completed",
        workerId: task.workerId,
        fencingToken: task.fencingToken,
        leaseExpiresAt: null
      })
      tasks.set(task.taskId, completed)
      return completed
    },
    release(ctx: Context, command: CompletePickTaskCommand): PickTask {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const task = tasks.get(command.taskId)
      if (task === undefined) throw new Error("pick task not found")
      if (
        task.status !== "leased" ||
        task.workerId !== command.workerId ||
        task.fencingToken !== command.fencingToken
      ) {
        throw new Error("stale fencing token")
      }
      const released: PickTask = Object.freeze({
        taskId: task.taskId,
        status: "pending",
        workerId: null,
        fencingToken: task.fencingToken,
        leaseExpiresAt: null
      })
      tasks.set(task.taskId, released)
      return released
    },
    get(ctx: Context, taskId: string): PickTask | undefined {
      const failure = ctx.err()
      if (failure !== null) throw failure
      return tasks.get(taskId)
    }
  })
}

/** Creates the lease acquisition use case with an injectable clock. */
export function newAcquirePickLease(
  repository: PickTaskRepository,
  now: () => number = Date.now
): AcquirePickLease {
  return function acquirePickLease(ctx: Context, command: AcquirePickLeaseCommand): PickLease {
    validateAcquirePickLease(command)
    return repository.acquire(ctx, command, now())
  }
}

/** Creates the fenced completion use case with an injectable clock. */
export function newCompletePickTask(
  repository: PickTaskRepository,
  now: () => number = Date.now
): CompletePickTask {
  return function completePickTask(ctx: Context, command: CompletePickTaskCommand): PickTask {
    validateCompletePickTask(command)
    return repository.complete(ctx, command, now())
  }
}
