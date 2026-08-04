import { background } from "@go-like/context"
import type { ServiceInstance } from "@go-like/registry"
import { describe, expect, test } from "bun:test"

import { newHandler } from "../src/http"
import { newGameServerDirectory, newMemoryMatchQueue } from "../src/match-resources"
import { newJoinMatch } from "../src/service"

const gameServers: readonly ServiceInstance[] = Object.freeze([
  Object.freeze({
    id: "eu-a",
    name: "game-session",
    version: "v1",
    endpoints: Object.freeze(["https://game-eu-a.internal/"]),
    metadata: Object.freeze({ region: "eu-west" })
  }),
  Object.freeze({
    id: "eu-b",
    name: "game-session",
    version: "v1",
    endpoints: Object.freeze(["https://game-eu-b.internal/"]),
    metadata: Object.freeze({ region: "eu-west" })
  }),
  Object.freeze({
    id: "us-a",
    name: "game-session",
    version: "v1",
    endpoints: Object.freeze(["https://game-us-a.internal/"]),
    metadata: Object.freeze({ region: "us-east" })
  })
])

describe("live game matchmaking", () => {
  test("never pairs players across regions or outside the configured skill gap", () => {
    const queue = newMemoryMatchQueue()
    const join = newJoinMatch(queue, newGameServerDirectory(gameServers), 100)

    expect(
      join(background(), {
        requestId: "one",
        playerId: "player-one",
        region: "eu-west",
        skillRating: 1_000
      }).status
    ).toBe("waiting")
    expect(
      join(background(), {
        requestId: "two",
        playerId: "player-two",
        region: "us-east",
        skillRating: 1_000
      }).status
    ).toBe("waiting")
    expect(
      join(background(), {
        requestId: "three",
        playerId: "player-three",
        region: "eu-west",
        skillRating: 1_500
      }).status
    ).toBe("waiting")
    expect(queue.pending(background(), "eu-west")).toBe(2)
  })

  test("prevents one player from occupying two pending queue entries", () => {
    const join = newJoinMatch(newMemoryMatchQueue(), newGameServerDirectory(gameServers), 100)
    join(background(), {
      requestId: "first",
      playerId: "same-player",
      region: "eu-west",
      skillRating: 1_000
    })
    expect(() =>
      join(background(), {
        requestId: "second",
        playerId: "same-player",
        region: "eu-west",
        skillRating: 1_020
      })
    ).toThrow("player is already queued")
  })

  test("uses go-like round-robin selection for successive regional matches", () => {
    const join = newJoinMatch(newMemoryMatchQueue(), newGameServerDirectory(gameServers), 100)
    join(background(), {
      requestId: "a",
      playerId: "a",
      region: "eu-west",
      skillRating: 1_000
    })
    const first = join(background(), {
      requestId: "b",
      playerId: "b",
      region: "eu-west",
      skillRating: 1_050
    })
    join(background(), {
      requestId: "c",
      playerId: "c",
      region: "eu-west",
      skillRating: 2_000
    })
    const second = join(background(), {
      requestId: "d",
      playerId: "d",
      region: "eu-west",
      skillRating: 2_040
    })

    expect(first).toMatchObject({
      status: "matched",
      matchId: "a:b",
      gameServer: "https://game-eu-a.internal/"
    })
    expect(second).toMatchObject({
      status: "matched",
      matchId: "c:d",
      gameServer: "https://game-eu-b.internal/"
    })
  })

  test("exposes matchmaking through a standard Fetch handler", async () => {
    const handler = newHandler(gameServers, 100)
    const response = await handler(
      new Request("https://example.test/v1/matches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "web",
          playerId: "web-player",
          region: "eu-west",
          skillRating: 900
        })
      })
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: "waiting", requestId: "web" })
  })
})
