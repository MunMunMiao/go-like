import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"
import type {
  CancelPrescription,
  DispensePrescription,
  DispensePrescriptionCommand
} from "./service"

function commandFrom(prescriptionId: string, value: unknown): DispensePrescriptionCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const requestId: unknown = Reflect.get(value, "requestId")
  if (typeof requestId !== "string") throw new TypeError("invalid requestId")
  return Object.freeze({ requestId, prescriptionId })
}

function prescriptionIdFrom(pathname: string, suffix: string): string | null {
  const prefix = "/v1/prescriptions/"
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null
  const end = pathname.length - suffix.length
  const prescriptionId = decodeURIComponent(pathname.slice(prefix.length, end))
  return prescriptionId.length === 0 ? null : prescriptionId
}

/** Creates the standard Fetch entrypoint for prescription operations. */
export function newPrescriptionHandler(
  dispensePrescription: DispensePrescription,
  cancelPrescription: CancelPrescription
): Handler {
  return contextHandler(async function prescriptionHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    try {
      const dispenseId = prescriptionIdFrom(url.pathname, "/dispense")
      if (request.method === "POST" && dispenseId !== null) {
        const command = commandFrom(dispenseId, await request.json())
        return Response.json(await dispensePrescription(ctx, command))
      }
      const prefix = "/v1/prescriptions/"
      if (
        request.method === "DELETE" &&
        url.pathname.startsWith(prefix) &&
        url.pathname.length > prefix.length
      ) {
        const prescriptionId = decodeURIComponent(url.pathname.slice(prefix.length))
        return Response.json(cancelPrescription(ctx, prescriptionId))
      }
      return Response.json({ code: "not_found" }, { status: 404 })
    } catch (error) {
      const message = error instanceof Error ? error.message : "prescription operation failed"
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json({ code: "prescription_rejected", message }, { status })
    }
  })
}
