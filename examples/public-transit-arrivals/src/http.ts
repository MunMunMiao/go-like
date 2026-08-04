import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"
import type { ArrivalPrediction, ArrivalQuery, ListFreshArrivals, PublishArrival } from "./service"

function predictionFrom(value: unknown): ArrivalPrediction {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const stopId: unknown = Reflect.get(value, "stopId")
  const vehicleId: unknown = Reflect.get(value, "vehicleId")
  const arrivalAt: unknown = Reflect.get(value, "arrivalAt")
  const observedAt: unknown = Reflect.get(value, "observedAt")
  if (
    typeof stopId !== "string" ||
    typeof vehicleId !== "string" ||
    typeof arrivalAt !== "number" ||
    typeof observedAt !== "number"
  ) {
    throw new TypeError("invalid arrival prediction")
  }
  return Object.freeze({ stopId, vehicleId, arrivalAt, observedAt })
}

function stopIdFrom(pathname: string): string | undefined {
  const parts = pathname.split("/")
  if (parts.length !== 5 || parts[1] !== "v1" || parts[2] !== "stops" || parts[4] !== "arrivals") {
    return undefined
  }
  return parts[3]
}

function queryFrom(url: URL, stopId: string): ArrivalQuery {
  const rawNow = url.searchParams.get("now")
  const rawMaxAge = url.searchParams.get("maxAgeMs")
  if (rawNow === null || rawMaxAge === null || rawNow.trim() === "" || rawMaxAge.trim() === "") {
    throw new TypeError("now and maxAgeMs are required")
  }
  return Object.freeze({
    stopId,
    now: Number(rawNow),
    maxAgeMs: Number(rawMaxAge)
  })
}

/** Creates standard Fetch endpoints for arrival publication and fresh reads. */
export function newArrivalHandler(publish: PublishArrival, listFresh: ListFreshArrivals): Handler {
  return contextHandler(async function arrivalHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === "POST" && url.pathname === "/v1/arrival-predictions") {
        return Response.json(publish(ctx, predictionFrom(await request.json())), {
          status: 201
        })
      }
      const stopId = stopIdFrom(url.pathname)
      if (request.method === "GET" && stopId !== undefined) {
        return Response.json({ arrivals: listFresh(ctx, queryFrom(url, stopId)) })
      }
      return Response.json({ code: "not_found" }, { status: 404 })
    } catch (error) {
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json(
        {
          code: "arrival_operation_rejected",
          message: error instanceof Error ? error.message : "arrival operation failed"
        },
        { status }
      )
    }
  })
}
