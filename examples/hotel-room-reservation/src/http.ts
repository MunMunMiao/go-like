import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"
import type { HoldRoom, HoldRoomCommand, ReleaseRoomHold } from "./service"

function commandFrom(value: unknown): HoldRoomCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const holdId: unknown = Reflect.get(value, "holdId")
  const roomType: unknown = Reflect.get(value, "roomType")
  const checkInNight: unknown = Reflect.get(value, "checkInNight")
  const checkOutNight: unknown = Reflect.get(value, "checkOutNight")
  const rooms: unknown = Reflect.get(value, "rooms")
  if (
    typeof holdId !== "string" ||
    typeof roomType !== "string" ||
    typeof checkInNight !== "number" ||
    typeof checkOutNight !== "number" ||
    typeof rooms !== "number"
  ) {
    throw new TypeError("invalid room hold command")
  }
  return Object.freeze({ holdId, roomType, checkInNight, checkOutNight, rooms })
}

function releaseId(pathname: string): string | undefined {
  const parts = pathname.split("/")
  if (
    parts.length !== 5 ||
    parts[1] !== "v1" ||
    parts[2] !== "room-holds" ||
    parts[4] !== "release"
  ) {
    return undefined
  }
  return parts[3]
}

function failureResponse(error: unknown): Response {
  const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
  return Response.json(
    {
      code: "room_hold_rejected",
      message: error instanceof Error ? error.message : "room hold failed"
    },
    { status }
  )
}

/** Creates standard Fetch endpoints for room hold and release operations. */
export function newRoomHoldHandler(holdRoom: HoldRoom, releaseRoomHold: ReleaseRoomHold): Handler {
  return contextHandler(async function roomHoldHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === "POST" && url.pathname === "/v1/room-holds") {
        return Response.json(holdRoom(ctx, commandFrom(await request.json())), {
          status: 201
        })
      }
      const holdId = releaseId(url.pathname)
      if (request.method === "POST" && holdId !== undefined) {
        return Response.json(releaseRoomHold(ctx, holdId))
      }
      return Response.json({ code: "not_found" }, { status: 404 })
    } catch (error) {
      return failureResponse(error)
    }
  })
}
