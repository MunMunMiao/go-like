import type { Context } from "@likego/context"
import { contextHandler, type Handler } from "@likego/web"

import type { GetPermit, PermitType, SubmitPermit, SubmitPermitCommand } from "./permits"

/** Narrows an unknown permit type to the supported public values. */
function permitTypeFrom(value: unknown): PermitType {
  if (value !== "renovation" && value !== "restaurant") {
    throw new TypeError("invalid permitType")
  }
  return value
}

/** Converts an unknown document list without accepting mixed values. */
function documentsFrom(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError("documents must be an array")
  const documents: string[] = []
  for (const document of value) {
    if (typeof document !== "string") throw new TypeError("documents must contain strings")
    documents.push(document)
  }
  return Object.freeze(documents)
}

/** Converts unknown JSON into the explicit permit-submission command. */
function commandFrom(value: unknown): SubmitPermitCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const applicationId: unknown = Reflect.get(value, "applicationId")
  const applicantId: unknown = Reflect.get(value, "applicantId")
  if (typeof applicationId !== "string" || typeof applicantId !== "string") {
    throw new TypeError("invalid permit submission")
  }
  return Object.freeze({
    applicationId,
    applicantId,
    permitType: permitTypeFrom(Reflect.get(value, "permitType")),
    documents: documentsFrom(Reflect.get(value, "documents"))
  })
}

/** Creates the standard Fetch entrypoint for permit submission and status queries. */
export function newPermitHandler(submit: SubmitPermit, get: GetPermit): Handler {
  return contextHandler(async function permitHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === "POST" && url.pathname === "/v1/permits") {
        return Response.json(submit(ctx, commandFrom(await request.json())), { status: 202 })
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/permits/")) {
        const applicationId = url.pathname.slice("/v1/permits/".length)
        return Response.json(get(ctx, applicationId))
      }
      return Response.json({ code: "not_found" }, { status: 404 })
    } catch (error) {
      const message = error instanceof Error ? error.message : "permit request failed"
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json({ code: "permit_rejected", message }, { status })
    }
  })
}
