import type { Context } from "@go-like/context"

import type { GameServerDirectory, MatchQueue } from "./match-resources"

/** Describes one player's regional matchmaking request. */
export interface JoinMatchCommand {
  readonly requestId: string
  readonly playerId: string
  readonly region: string
  readonly skillRating: number
}

export interface PlayerPair {
  readonly first: JoinMatchCommand
  readonly second: JoinMatchCommand
}

export interface WaitingResult {
  readonly status: "waiting"
  readonly requestId: string
}

export interface MatchedResult {
  readonly status: "matched"
  readonly matchId: string
  readonly region: string
  readonly playerIds: readonly [string, string]
  readonly gameServer: string
}

export type MatchmakingResult = WaitingResult | MatchedResult

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const regionPattern = /^[a-z][a-z0-9-]{0,31}$/

/** Validates one matchmaking command at the application trust boundary. */
export function validateJoinMatch(command: JoinMatchCommand): void {
  if (!identifierPattern.test(command.requestId)) throw new TypeError("invalid requestId")
  if (!identifierPattern.test(command.playerId)) throw new TypeError("invalid playerId")
  if (!regionPattern.test(command.region)) throw new TypeError("invalid region")
  if (
    !Number.isSafeInteger(command.skillRating) ||
    command.skillRating < 0 ||
    command.skillRating > 5_000
  ) {
    throw new RangeError("skillRating must be an integer from 0 through 5000")
  }
}

/** Reports whether two players can share one fair regional match. */
export function canMatch(
  first: JoinMatchCommand,
  second: JoinMatchCommand,
  maximumSkillGap: number
): boolean {
  return (
    first.region === second.region &&
    Math.abs(first.skillRating - second.skillRating) <= maximumSkillGap
  )
}

/** Builds a deterministic match identity from the two admitted request identities. */
export function matchIdentity(firstRequestId: string, secondRequestId: string): string {
  return firstRequestId < secondRequestId
    ? `${firstRequestId}:${secondRequestId}`
    : `${secondRequestId}:${firstRequestId}`
}

export type JoinMatch = (ctx: Context, command: JoinMatchCommand) => MatchmakingResult

/** Creates the matchmaking use case with one explicit acceptable skill gap. */
export function newJoinMatch(
  queue: MatchQueue,
  servers: GameServerDirectory,
  maximumSkillGap: number
): JoinMatch {
  if (!Number.isSafeInteger(maximumSkillGap) || maximumSkillGap < 0) {
    throw new RangeError("maximumSkillGap must be a non-negative safe integer")
  }

  return function joinMatch(ctx: Context, command: JoinMatchCommand): MatchmakingResult {
    validateJoinMatch(command)
    const pair = queue.join(ctx, command, maximumSkillGap)
    if (pair === null) {
      return Object.freeze({ status: "waiting", requestId: command.requestId })
    }
    const gameServer = servers.allocate(ctx, command.region)
    const playerIds: readonly [string, string] = [pair.first.playerId, pair.second.playerId]
    return Object.freeze({
      status: "matched",
      matchId: matchIdentity(pair.first.requestId, pair.second.requestId),
      region: command.region,
      playerIds: Object.freeze(playerIds),
      gameServer
    })
  }
}
