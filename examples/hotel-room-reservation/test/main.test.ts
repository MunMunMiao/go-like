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

  test("rejects malformed Fetch commands and unsupported room-hold routes", async () => {
    const handler = newHandler({ standard: 1 })

    const malformed = await handler(
      new Request("https://example.test/v1/room-holds", {
        method: "POST",
        body: JSON.stringify({ holdId: "missing-fields" })
      })
    )
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({
      code: "room_hold_rejected",
      message: "invalid room hold command"
    })

    const notFound = await handler(
      new Request("https://example.test/v1/room-holds/hold-1", { method: "GET" })
    )
    expect(notFound.status).toBe(404)

    const invalidRelease = await handler(
      new Request("https://example.test/v1/room-holds/unknown/release", { method: "POST" })
    )
    expect(invalidRelease.status).toBe(409)
    expect(await invalidRelease.json()).toMatchObject({
      code: "room_hold_rejected",
      message: "room hold not found"
    })
  })

  test("validates intervals, capacities, room types and releases", () => {
    expect(() => newMemoryRoomHoldRepository({ standard: 0 })).toThrow("invalid room capacity")
    expect(() => newMemoryRoomHoldRepository({ "bad room": 1 })).toThrow("invalid roomType")

    const repository = newMemoryRoomHoldRepository({ standard: 1 })
    const hold = newHoldRoom(repository)
    expect(() =>
      hold(background(), {
        holdId: "bad interval",
        roomType: "standard",
        checkInNight: 1,
        checkOutNight: 2,
        rooms: 1
      })
    ).toThrow("invalid holdId")
    expect(() =>
      hold(background(), {
        holdId: "too-long",
        roomType: "standard",
        checkInNight: 1,
        checkOutNight: 33,
        rooms: 1
      })
    ).toThrow("invalid stay interval")
    expect(() =>
      hold(background(), {
        holdId: "bad-rooms",
        roomType: "standard",
        checkInNight: 1,
        checkOutNight: 2,
        rooms: 0
      })
    ).toThrow("rooms is outside the supported range")
    expect(() =>
      hold(background(), {
        holdId: "unknown-type",
        roomType: "suite",
        checkInNight: 1,
        checkOutNight: 2,
        rooms: 1
      })
    ).toThrow("room type not found")
    expect(() => repository.available(background(), "suite", 1)).toThrow("room type not found")
    expect(() => newReleaseRoomHold(repository)(background(), "missing")).toThrow(
      "room hold not found"
    )
    const same = Object.freeze({
      holdId: "same-hold",
      roomType: "standard",
      checkInNight: 10,
      checkOutNight: 11,
      rooms: 1
    })
    expect(hold(background(), same)).toBe(hold(background(), same))
    expect(newReleaseRoomHold(repository)(background(), "same-hold").status).toBe("released")
    expect(hold(background(), same).status).toBe("released")
  })
})
