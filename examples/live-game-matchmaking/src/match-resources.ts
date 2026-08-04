import type { Context } from "@go-like/context"
import { newRoundRobinSelector, type Selector, type ServiceInstance } from "@go-like/registry"

import { canMatch, type JoinMatchCommand, type PlayerPair } from "./service"

export interface MatchQueue {
  join(ctx: Context, command: JoinMatchCommand, maximumSkillGap: number): PlayerPair | null
  pending(ctx: Context, region: string): number
}

export interface GameServerDirectory {
  allocate(ctx: Context, region: string): string
}

/** Rejects work admitted from an already terminal Context. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

/** Creates a process-local queue that pairs the first compatible regional opponent. */
export function newMemoryMatchQueue(): MatchQueue {
  const waitingByRegion = new Map<string, JoinMatchCommand[]>()
  const queuedPlayers = new Set<string>()

  return Object.freeze({
    join(ctx: Context, command: JoinMatchCommand, maximumSkillGap: number): PlayerPair | null {
      checkContext(ctx)
      if (queuedPlayers.has(command.playerId)) throw new Error("player is already queued")
      const waiting = waitingByRegion.get(command.region)
      if (waiting !== undefined) {
        for (let index = 0; index < waiting.length; index += 1) {
          const opponent = waiting[index]
          if (opponent !== undefined && canMatch(opponent, command, maximumSkillGap)) {
            waiting.splice(index, 1)
            queuedPlayers.delete(opponent.playerId)
            if (waiting.length === 0) waitingByRegion.delete(command.region)
            return Object.freeze({ first: opponent, second: command })
          }
        }
      }
      const regionalQueue = waiting ?? []
      regionalQueue.push(command)
      waitingByRegion.set(command.region, regionalQueue)
      queuedPlayers.add(command.playerId)
      return null
    },
    pending(ctx: Context, region: string): number {
      checkContext(ctx)
      return waitingByRegion.get(region)?.length ?? 0
    }
  })
}

/** Creates a regional game-server directory backed by go-like's round-robin selector. */
export function newGameServerDirectory(
  instances: readonly ServiceInstance[],
  selector: Selector = newRoundRobinSelector()
): GameServerDirectory {
  return Object.freeze({
    allocate(ctx: Context, region: string): string {
      checkContext(ctx)
      const regional: ServiceInstance[] = []
      for (const instance of instances) {
        if (instance.metadata.region === region) regional.push(instance)
      }
      const [endpoint, done] = selector.select(ctx, regional)
      done(ctx, { error: null })
      return endpoint.url
    }
  })
}
