import { background, type Context } from "@likego/context"
import type { Server } from "@likego/core"
import type { Listener, Message, Socket } from "@likego/transport"
import { endpoint as endpointHeader, request as serviceHeader } from "@likego/transport/headers"
import { newMemoryTransport } from "@likego/transport-memory"

import {
  enrollmentFingerprint,
  learnerCourseKey,
  type EnrollCommand,
  type EnrollmentReceipt
} from "./service"

export interface EnrollmentRepository {
  find(ctx: Context, command: EnrollCommand): EnrollmentReceipt | null
  learnerEnrolled(ctx: Context, learnerId: string, courseId: string): boolean
  save(ctx: Context, command: EnrollCommand, remainingSeats: number): EnrollmentReceipt
}

export interface CapacityClient {
  reserve(ctx: Context, requestId: string, courseId: string): Promise<number>
}

export interface CapacityRuntime {
  readonly server: Server
  readonly client: CapacityClient
  readonly remaining: (ctx: Context, courseId: string) => number
}

interface SavedEnrollment {
  readonly fingerprint: string
  readonly receipt: EnrollmentReceipt
}

interface CapacityRequest {
  readonly requestId: string
  readonly courseId: string
}

interface CapacityReply {
  readonly remainingSeats: number
}

const capacityAddress = "memory://learning-capacity"
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Rejects work admitted from an already terminal Context. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

/** Converts unknown JSON into one capacity request without coercion. */
function capacityRequestFrom(value: unknown): CapacityRequest {
  if (value === null || typeof value !== "object") throw new TypeError("invalid capacity request")
  const requestId: unknown = Reflect.get(value, "requestId")
  const courseId: unknown = Reflect.get(value, "courseId")
  if (typeof requestId !== "string" || typeof courseId !== "string") {
    throw new TypeError("invalid capacity request")
  }
  return Object.freeze({ requestId, courseId })
}

/** Converts unknown JSON into one capacity reply without coercion. */
function capacityReplyFrom(value: unknown): CapacityReply {
  if (value === null || typeof value !== "object") throw new TypeError("invalid capacity reply")
  const remainingSeats: unknown = Reflect.get(value, "remainingSeats")
  if (!Number.isSafeInteger(remainingSeats) || typeof remainingSeats !== "number") {
    throw new TypeError("invalid capacity reply")
  }
  return Object.freeze({ remainingSeats })
}

/** Creates the process-local enrollment repository. */
export function newMemoryEnrollmentRepository(): EnrollmentRepository {
  const byRequest = new Map<string, SavedEnrollment>()
  const learnerCourses = new Set<string>()
  return Object.freeze({
    find(ctx: Context, command: EnrollCommand): EnrollmentReceipt | null {
      checkContext(ctx)
      const saved = byRequest.get(command.requestId)
      if (saved === undefined) return null
      if (saved.fingerprint !== enrollmentFingerprint(command)) {
        throw new Error("idempotency conflict")
      }
      return saved.receipt
    },
    learnerEnrolled(ctx: Context, learnerId: string, courseId: string): boolean {
      checkContext(ctx)
      return learnerCourses.has(learnerCourseKey(learnerId, courseId))
    },
    save(ctx: Context, command: EnrollCommand, remainingSeats: number): EnrollmentReceipt {
      checkContext(ctx)
      const previous = byRequest.get(command.requestId)
      if (previous !== undefined) {
        if (previous.fingerprint !== enrollmentFingerprint(command)) {
          throw new Error("idempotency conflict")
        }
        return previous.receipt
      }
      const key = learnerCourseKey(command.learnerId, command.courseId)
      if (learnerCourses.has(key)) throw new Error("learner is already enrolled")
      const receipt = Object.freeze({
        requestId: command.requestId,
        learnerId: command.learnerId,
        courseId: command.courseId,
        remainingSeats
      })
      byRequest.set(
        command.requestId,
        Object.freeze({ fingerprint: enrollmentFingerprint(command), receipt })
      )
      learnerCourses.add(key)
      return receipt
    }
  })
}

/** Creates an internal capacity microservice and its unary Memory Transport client. */
export function newCapacityRuntime(
  initialCapacity: Readonly<Record<string, number>>
): CapacityRuntime {
  const transport = newMemoryTransport()
  const remainingByCourse = new Map<string, number>()
  const reservationByRequest = new Map<string, string>()
  let started = false
  let listener: Listener | null = null
  for (const [courseId, seats] of Object.entries(initialCapacity)) {
    if (!Number.isSafeInteger(seats) || seats < 0) {
      throw new RangeError("course capacity must be a non-negative safe integer")
    }
    remainingByCourse.set(courseId, seats)
  }

  /** Reserves one seat exactly once for the request identity. */
  function reserveSeat(ctx: Context, request: CapacityRequest): CapacityReply {
    checkContext(ctx)
    const previousCourse = reservationByRequest.get(request.requestId)
    if (previousCourse !== undefined) {
      if (previousCourse !== request.courseId) throw new Error("capacity idempotency conflict")
      const previousRemaining = remainingByCourse.get(request.courseId)
      if (previousRemaining === undefined) throw new Error("unknown course")
      return Object.freeze({ remainingSeats: previousRemaining })
    }
    const available = remainingByCourse.get(request.courseId)
    if (available === undefined) throw new Error("unknown course")
    if (available === 0) throw new Error("course is full")
    const remainingSeats = available - 1
    remainingByCourse.set(request.courseId, remainingSeats)
    reservationByRequest.set(request.requestId, request.courseId)
    return Object.freeze({ remainingSeats })
  }

  /** Handles one internal capacity exchange over a transport Socket. */
  async function handleCapacity(ctx: Context, socket: Socket): Promise<void> {
    const message = await socket.recv(ctx)
    try {
      const request = capacityRequestFrom(JSON.parse(decoder.decode(message.body)))
      const reply = reserveSeat(ctx, request)
      await socket.send(ctx, {
        header: Object.freeze({ status: "ok" }),
        body: encoder.encode(JSON.stringify(reply))
      })
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "capacity request failed"
      await socket.send(ctx, {
        header: Object.freeze({ status: "error" }),
        body: encoder.encode(messageText)
      })
    }
  }

  const capacityServer: Server = Object.freeze({
    async start(ctx: Context): Promise<void> {
      if (started) throw new Error("capacity service already started")
      checkContext(ctx)
      listener = await transport.listen(ctx, capacityAddress)
      started = true
      await listener.accept(ctx, handleCapacity)
    },
    async stop(ctx: Context): Promise<void> {
      if (listener !== null) await listener.close(ctx)
    }
  })

  const client: CapacityClient = Object.freeze({
    async reserve(ctx: Context, requestId: string, courseId: string): Promise<number> {
      const socket = await transport.dial(ctx, capacityAddress)
      try {
        const message: Message = Object.freeze({
          header: Object.freeze({
            [serviceHeader]: "learning-capacity",
            [endpointHeader]: "Capacity.Reserve"
          }),
          body: encoder.encode(JSON.stringify({ requestId, courseId }))
        })
        await socket.send(ctx, message)
        const reply = await socket.recv(ctx)
        if (reply.header.status !== "ok") throw new Error(decoder.decode(reply.body))
        return capacityReplyFrom(JSON.parse(decoder.decode(reply.body))).remainingSeats
      } finally {
        await socket.close(background())
      }
    }
  })

  return Object.freeze({
    server: capacityServer,
    client,
    remaining(ctx: Context, courseId: string): number {
      checkContext(ctx)
      const remainingSeats = remainingByCourse.get(courseId)
      if (remainingSeats === undefined) throw new Error("unknown course")
      return remainingSeats
    }
  })
}
