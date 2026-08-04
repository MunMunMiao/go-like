import { background } from "@go-like/context"
import { describe, expect, test } from "bun:test"
import {
  newHandler,
  newHoldRoom,
  newMemoryRoomHoldRepository,
  newReleaseRoomHold,
  newRuntime
} from "../src/service"

describe("hotel room reservation", () => {
  test("prevents overselling on every night of a stay", () => {
    const repository = newMemoryRoomHoldRepository({ standard: 2 })
    const hold = newHoldRoom(repository)
    hold(background(), {
      holdId: "hold-1",
      roomType: "standard",
      checkInNight: 20_000,
      checkOutNight: 20_003,
      rooms: 2
    })
    expect(repository.available(background(), "standard", 20_001)).toBe(0)
    expect(() =>
      hold(background(), {
        holdId: "hold-2",
        roomType: "standard",
        checkInNight: 20_002,
        checkOutNight: 20_004,
        rooms: 1
      })
    ).toThrow("insufficient room-night inventory")
    expect(repository.available(background(), "standard", 20_003)).toBe(2)
  })

  test("releases all room nights and keeps release idempotent", () => {
    const repository = newMemoryRoomHoldRepository({ suite: 1 })
    const hold = newHoldRoom(repository)
    const release = newReleaseRoomHold(repository)
    hold(background(), {
      holdId: "hold-3",
      roomType: "suite",
      checkInNight: 21_000,
      checkOutNight: 21_002,
      rooms: 1
    })
    expect(release(background(), "hold-3")).toEqual(release(background(), "hold-3"))
    expect(repository.available(background(), "suite", 21_000)).toBe(1)
    expect(repository.available(background(), "suite", 21_001)).toBe(1)
  })

  test("rejects conflicting reuse of a hold identity", () => {
    const hold = newHoldRoom(newMemoryRoomHoldRepository({ standard: 3 }))
    hold(background(), {
      holdId: "same",
      roomType: "standard",
      checkInNight: 22_000,
      checkOutNight: 22_001,
      rooms: 1
    })
    expect(() =>
      hold(background(), {
        holdId: "same",
        roomType: "standard",
        checkInNight: 22_000,
        checkOutNight: 22_001,
        rooms: 2
      })
    ).toThrow("hold identity conflict")
  })

  test("serves hold and release through one standard Fetch handler", async () => {
    const handler = newHandler({ standard: 1 })
    const holdResponse = await handler(
      new Request("https://example.test/v1/room-holds", {
        method: "POST",
        body: JSON.stringify({
          holdId: "web-1",
          roomType: "standard",
          checkInNight: 23_000,
          checkOutNight: 23_002,
          rooms: 1
        })
      })
    )
    expect(holdResponse.status).toBe(201)
    const releaseResponse = await handler(
      new Request("https://example.test/v1/room-holds/web-1/release", {
        method: "POST"
      })
    )
    expect(releaseResponse.status).toBe(200)
    expect(await releaseResponse.json()).toMatchObject({ holdId: "web-1", status: "released" })
  })

  test("fails go-like readiness when no room inventory catalog is loaded", async () => {
    const missing = newRuntime({})
    expect((await missing.probes.check(background(), "ready")).ok).toBe(false)
    const ready = newRuntime({ standard: 1 })
    expect((await ready.probes.check(background(), "ready")).ok).toBe(true)
  })
})
