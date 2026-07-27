import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"

import type { EnrollCommand, EnrollLearner } from "./service"

/** Converts unknown JSON into the explicit enrollment command shape. */
function commandFrom(value: unknown): EnrollCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const requestId: unknown = Reflect.get(value, "requestId")
  const learnerId: unknown = Reflect.get(value, "learnerId")
  const courseId: unknown = Reflect.get(value, "courseId")
  if (
    typeof requestId !== "string" ||
    typeof learnerId !== "string" ||
    typeof courseId !== "string"
  ) {
    throw new TypeError("invalid enrollment command")
  }
  return Object.freeze({ requestId, learnerId, courseId })
}

/** Creates the standard Fetch entrypoint for learner enrollment. */
export function newEnrollmentHandler(enroll: EnrollLearner): Handler {
  return contextHandler(async function enrollmentHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/v1/enrollments") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(await enroll(ctx, commandFrom(await request.json())), { status: 201 })
    } catch (error) {
      const message = error instanceof Error ? error.message : "enrollment failed"
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json({ code: "enrollment_rejected", message }, { status })
    }
  })
}
