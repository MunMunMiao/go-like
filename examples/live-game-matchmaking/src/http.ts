import type { Context } from "@likego/context"
import type { ServiceInstance } from "@likego/registry"
import { contextHandler, type Handler } from "@likego/web"

import { newGameServerDirectory, newMemoryMatchQueue } from "./match-resources"
import { newJoinMatch, type JoinMatch, type JoinMatchCommand } from "./service"

/** Converts unknown JSON into the explicit matchmaking command shape. */
function commandFrom(value: unknown): JoinMatchCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const requestId: unknown = Reflect.get(value, "requestId")
  const playerId: unknown = Reflect.get(value, "playerId")
  const region: unknown = Reflect.get(value, "region")
  const skillRating: unknown = Reflect.get(value, "skillRating")
  if (
    typeof requestId !== "string" ||
    typeof playerId !== "string" ||
    typeof region !== "string" ||
    typeof skillRating !== "number"
  ) {
    throw new TypeError("invalid matchmaking command")
  }
  return Object.freeze({ requestId, playerId, region, skillRating })
}

/** Creates the standard Fetch entrypoint for live matchmaking. */
export function newMatchmakingHandler(joinMatch: JoinMatch): Handler {
  return contextHandler(async function matchmakingHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/v1/matches") {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      const result = joinMatch(ctx, commandFrom(await request.json()))
      return Response.json(result, { status: result.status === "matched" ? 201 : 202 })
    } catch (error) {
      const message = error instanceof Error ? error.message : "matchmaking failed"
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json({ code: "matchmaking_rejected", message }, { status })
    }
  })
}

/** Composes the matchmaking microservice around Registry-native endpoint selection. */
export function newHandler(
  instances: readonly ServiceInstance[],
  maximumSkillGap: number
): Handler {
  const queue = newMemoryMatchQueue()
  const servers = newGameServerDirectory(instances)
  return newMatchmakingHandler(newJoinMatch(queue, servers, maximumSkillGap))
}
