import type { Handler } from "@likego/web"

import { newEnrollmentHandler } from "./http"
import { newEnrollLearner } from "./service"
import {
  newCapacityRuntime,
  newMemoryEnrollmentRepository,
  type CapacityRuntime
} from "./transport"

export interface LearningEnrollmentService {
  readonly capacity: CapacityRuntime
  readonly handler: Handler
}

/** Composes the public enrollment API and internal capacity transport service. */
export function newLearningEnrollmentService(
  initialCapacity: Readonly<Record<string, number>>
): LearningEnrollmentService {
  const capacity = newCapacityRuntime(initialCapacity)
  const repository = newMemoryEnrollmentRepository()
  const enroll = newEnrollLearner(repository, capacity.client)
  return Object.freeze({
    capacity,
    handler: newEnrollmentHandler(enroll)
  })
}
