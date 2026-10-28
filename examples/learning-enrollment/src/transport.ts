import { newClient, withEndpoint, withTransport } from "@go-like/client"
import type { Context } from "@go-like/context"
import { address, newServer, transport as serverTransport, type Server } from "@go-like/server"
import { serviceError } from "@go-like/transport"
import { newMemoryTransport } from "@go-like/transport-memory"

import { learningCapacity } from "./contract"
import {
  enrollmentFingerprint,
  learnerCourseKey,
  type EnrollCommand,
  type EnrollmentReceipt
} from "./service"

/** Stores enrollment receipts and learner-course occupancy in process memory. */
export interface EnrollmentRepository {
  find(ctx: Context, command: EnrollCommand): EnrollmentReceipt | null
  learnerEnrolled(ctx: Context, learnerId: string, courseId: string): boolean
  save(ctx: Context, command: EnrollCommand, remainingSeats: number): EnrollmentReceipt
}

/** Reserves one course seat through the internal capacity service. */
export interface CapacityClient {
  reserve(ctx: Context, requestId: string, courseId: string): Promise<number>
}

/** Owns the capacity Server, its caller, and the local remaining-seat view. */
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

const capacityAddress = "memory://learning-capacity.v1"

/** Rejects work admitted from an already terminal Context. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
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
  for (const [courseId, seats] of Object.entries(initialCapacity)) {
    if (!Number.isSafeInteger(seats) || seats < 0) {
      throw new RangeError("course capacity must be a non-negative safe integer")
    }
    remainingByCourse.set(courseId, seats)
  }

  /** Reserves one seat exactly once for the request identity. */
  function reserveSeat(_ctx: Context, request: CapacityRequest): { remainingSeats: number } {
    const previousCourse = reservationByRequest.get(request.requestId)
    if (previousCourse !== undefined) {
      if (previousCourse !== request.courseId) {
        throw serviceError("failed_precondition", "capacity idempotency conflict", 409)
      }
      const previousRemaining = remainingByCourse.get(request.courseId)
      if (previousRemaining === undefined) throw serviceError("not_found", "unknown course", 404)
      return Object.freeze({ remainingSeats: previousRemaining })
    }
    const available = remainingByCourse.get(request.courseId)
    if (available === undefined) throw serviceError("not_found", "unknown course", 404)
    if (available === 0) throw serviceError("resource_exhausted", "course is full", 409)
    const remainingSeats = available - 1
    remainingByCourse.set(request.courseId, remainingSeats)
    reservationByRequest.set(request.requestId, request.courseId)
    return Object.freeze({ remainingSeats })
  }

  const server = newServer(serverTransport(transport), address(capacityAddress))
  learningCapacity.registerHandler(server, {
    reserve(ctx, request) {
      checkContext(ctx)
      return reserveSeat(ctx, request)
    }
  })
  const caller = learningCapacity.newClient(
    newClient(withEndpoint(capacityAddress), withTransport(transport))
  )

  return Object.freeze({
    server,
    client: Object.freeze({
      async reserve(ctx: Context, requestId: string, courseId: string): Promise<number> {
        const reply = await caller.reserve(ctx, { requestId, courseId })
        return reply.remainingSeats
      }
    }),
    remaining(ctx: Context, courseId: string): number {
      checkContext(ctx)
      const remainingSeats = remainingByCourse.get(courseId)
      if (remainingSeats === undefined) throw new Error("unknown course")
      return remainingSeats
    }
  })
}
