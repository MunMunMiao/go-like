import type { Context } from "@go-like/context"
import type { CapacityClient, EnrollmentRepository } from "./transport"

export interface EnrollCommand {
  readonly requestId: string
  readonly learnerId: string
  readonly courseId: string
}

export interface EnrollmentReceipt {
  readonly requestId: string
  readonly learnerId: string
  readonly courseId: string
  readonly remainingSeats: number
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

/** Validates one enrollment command at the application trust boundary. */
export function validateEnrollment(command: EnrollCommand): void {
  if (!identifierPattern.test(command.requestId)) throw new TypeError("invalid requestId")
  if (!identifierPattern.test(command.learnerId)) throw new TypeError("invalid learnerId")
  if (!identifierPattern.test(command.courseId)) throw new TypeError("invalid courseId")
}

/** Produces the stable payload fingerprint for idempotency-key conflict detection. */
export function enrollmentFingerprint(command: EnrollCommand): string {
  return `${command.learnerId}\u0000${command.courseId}`
}

/** Produces the unique learner-course key used to prevent duplicate enrollment. */
export function learnerCourseKey(learnerId: string, courseId: string): string {
  return `${learnerId}\u0000${courseId}`
}

export type EnrollLearner = (ctx: Context, command: EnrollCommand) => Promise<EnrollmentReceipt>

/** Creates the enrollment use case around an internal capacity service boundary. */
export function newEnrollLearner(
  repository: EnrollmentRepository,
  capacity: CapacityClient
): EnrollLearner {
  return async function enrollLearner(
    ctx: Context,
    command: EnrollCommand
  ): Promise<EnrollmentReceipt> {
    validateEnrollment(command)
    const previous = repository.find(ctx, command)
    if (previous !== null) return previous
    if (repository.learnerEnrolled(ctx, command.learnerId, command.courseId)) {
      throw new Error("learner is already enrolled")
    }
    const remainingSeats = await capacity.reserve(ctx, command.requestId, command.courseId)
    return repository.save(ctx, command, remainingSeats)
  }
}
