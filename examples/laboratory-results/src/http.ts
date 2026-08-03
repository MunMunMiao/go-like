import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"
import type { RecordLaboratoryResult, RecordLaboratoryResultCommand } from "./service"

function commandFrom(
  encounterHeader: string | null,
  value: unknown
): RecordLaboratoryResultCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const resultId: unknown = Reflect.get(value, "resultId")
  const encounterId: unknown = Reflect.get(value, "encounterId")
  const patientId: unknown = Reflect.get(value, "patientId")
  const orderingClinicianId: unknown = Reflect.get(value, "orderingClinicianId")
  const testCode: unknown = Reflect.get(value, "testCode")
  const resultValue: unknown = Reflect.get(value, "value")
  if (
    typeof resultId !== "string" ||
    typeof encounterId !== "string" ||
    typeof patientId !== "string" ||
    typeof orderingClinicianId !== "string" ||
    typeof testCode !== "string" ||
    typeof resultValue !== "string"
  ) {
    throw new TypeError("invalid laboratory result command")
  }
  if (encounterHeader === null || encounterHeader !== encounterId) {
    throw new TypeError("encounter metadata mismatch")
  }
  return Object.freeze({
    resultId,
    encounterId,
    patientId,
    orderingClinicianId,
    testCode,
    value: resultValue
  })
}

/** Creates a Fetch entrypoint that binds transport metadata to the result body. */
export function newLaboratoryResultHandler(
  recordLaboratoryResult: RecordLaboratoryResult
): Handler {
  return contextHandler(async function laboratoryResultHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/v1/laboratory-results") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      const command = commandFrom(request.headers.get("x-encounter-id"), await request.json())
      return Response.json(recordLaboratoryResult(ctx, command), { status: 202 })
    } catch (error) {
      const message = error instanceof Error ? error.message : "result rejected"
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json({ code: "laboratory_result_rejected", message }, { status })
    }
  })
}
