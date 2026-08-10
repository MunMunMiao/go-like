import { background, withCancel } from "@go-like/context"
import type { ServiceInstance } from "@go-like/registry"
import { describe, expect, test } from "bun:test"

import { newHandler, newMatchmakingHandler } from "../src/http"
import { newGameServerDirectory, newMemoryMatchQueue } from "../src/match-resources"
import { gameRegistryFromEnvironment } from "../src/registry"
import { canMatch, matchIdentity, newJoinMatch, validateJoinMatch } from "../src/service"

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

  test("validates match commands, route bodies, and deterministic identities", async () => {
    const valid = { requestId: "a", playerId: "player", region: "eu-west", skillRating: 1000 }
    expect(canMatch(valid, { ...valid, region: "us-east" }, 100)).toBe(false)
    expect(canMatch(valid, { ...valid, skillRating: 1100 }, 100)).toBe(true)
    expect(matchIdentity("z", "a")).toBe("a:z")
    expect(() =>
      newJoinMatch(newMemoryMatchQueue(), newGameServerDirectory(gameServers), -1)
    ).toThrow("maximumSkillGap must be a non-negative safe integer")
    expect(() => validateJoinMatch({ ...valid, requestId: "" })).toThrow("invalid requestId")
    expect(() => validateJoinMatch({ ...valid, playerId: "" })).toThrow("invalid playerId")
    expect(() => validateJoinMatch({ ...valid, region: "EU-WEST" })).toThrow("invalid region")
    for (const skillRating of [-1, 5_001, 1.5]) {
      expect(() => validateJoinMatch({ ...valid, skillRating })).toThrow(
        "skillRating must be an integer from 0 through 5000"
      )
    }

    const handler = newMatchmakingHandler(() => {
      throw "non-error failure"
    })
    expect(
      (await handler(new Request("https://example.test/v1/other", { method: "GET" }))).status
    ).toBe(404)
    const invalidBody = await handler(
      new Request("https://example.test/v1/matches", {
        method: "POST",
        body: JSON.stringify({ ...valid, skillRating: "1000" })
      })
    )
    expect(invalidBody.status).toBe(400)
    const rejected = await handler(
      new Request("https://example.test/v1/matches", {
        method: "POST",
        body: JSON.stringify(valid)
      })
    )
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ message: "matchmaking failed" })
  })

  test("rejects canceled queue and directory contexts and supports empty regions", () => {
    const [ctx, cancel] = withCancel(background())
    cancel()
    const queue = newMemoryMatchQueue()
    expect(() =>
      queue.join(
        ctx,
        {
          requestId: "ctx",
          playerId: "ctx-player",
          region: "eu-west",
          skillRating: 1
        },
        100
      )
    ).toThrow()
    expect(() => queue.pending(ctx, "eu-west")).toThrow()
    const directory = newGameServerDirectory(gameServers)
    expect(() => directory.allocate(ctx, "missing")).toThrow()
  })

  test("creates the optional Kubernetes registry from environment inputs", () => {
    expect(gameRegistryFromEnvironment({})).toBeNull()
    expect(() => gameRegistryFromEnvironment({ KUBERNETES_API_ADDRESS: "" })).toThrow(
      "KUBERNETES_API_ADDRESS must not be empty"
    )
    expect(() =>
      gameRegistryFromEnvironment({
        KUBERNETES_API_ADDRESS: "https://kubernetes.example",
        KUBERNETES_TOKEN: ""
      })
    ).toThrow("KUBERNETES_TOKEN must not be empty")
    expect(
      gameRegistryFromEnvironment({
        KUBERNETES_API_ADDRESS: "https://kubernetes.example",
        KUBERNETES_NAMESPACE: "games"
      })
    ).not.toBeNull()
    expect(
      gameRegistryFromEnvironment({
        KUBERNETES_API_ADDRESS: "https://kubernetes.example",
        KUBERNETES_NAMESPACE: "games",
        KUBERNETES_TOKEN: "token"
      })
    ).not.toBeNull()
  })
})
