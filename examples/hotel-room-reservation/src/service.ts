import type { Context } from "@likego/context"
import { newProbeRegistry } from "@likego/health"
import type { Handler } from "@likego/web"

import { newRoomHoldHandler } from "./http"

/** Describes one contiguous room-night reservation request. */
export interface HoldRoomCommand {
  readonly holdId: string
  readonly roomType: string
  readonly checkInNight: number
  readonly checkOutNight: number
  readonly rooms: number
}

export type RoomHoldStatus = "held" | "released"

export interface RoomHold {
  readonly holdId: string
  readonly roomType: string
  readonly checkInNight: number
  readonly checkOutNight: number
  readonly rooms: number
  readonly status: RoomHoldStatus
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
}

/** Validates one room type key. */
export function validateRoomType(roomType: string): void {
  if (!validId(roomType)) throw new TypeError("invalid roomType")
}

/** Validates one hold identity. */
export function validateHoldId(holdId: string): void {
  if (!validId(holdId)) throw new TypeError("invalid holdId")
}

/** Validates one contiguous room-night hold. */
export function validateRoomHold(command: HoldRoomCommand): void {
  validateHoldId(command.holdId)
  validateRoomType(command.roomType)
  if (
    !Number.isSafeInteger(command.checkInNight) ||
    !Number.isSafeInteger(command.checkOutNight) ||
    command.checkInNight < 0 ||
    command.checkOutNight <= command.checkInNight ||
    command.checkOutNight - command.checkInNight > 31
  ) {
    throw new RangeError("invalid stay interval")
  }
  if (!Number.isSafeInteger(command.rooms) || command.rooms <= 0 || command.rooms > 10_000) {
    throw new RangeError("rooms is outside the supported range")
  }
}

/** Produces the stable identity of an idempotent room hold. */
export function roomHoldFingerprint(command: HoldRoomCommand): string {
  return [
    command.roomType,
    String(command.checkInNight),
    String(command.checkOutNight),
    String(command.rooms)
  ].join("\u0000")
}

export interface RoomHoldRepository {
  hold(ctx: Context, command: HoldRoomCommand): RoomHold
  release(ctx: Context, holdId: string): RoomHold
  available(ctx: Context, roomType: string, night: number): number
  checkReady(ctx: Context): void
}

interface SavedHold {
  readonly fingerprint: string
  readonly hold: RoomHold
}

function occupiedRooms(
  holds: ReadonlyMap<string, SavedHold>,
  roomType: string,
  night: number
): number {
  let occupied = 0
  for (const saved of holds.values()) {
    const hold = saved.hold
    if (
      hold.status === "held" &&
      hold.roomType === roomType &&
      hold.checkInNight <= night &&
      night < hold.checkOutNight
    ) {
      occupied += hold.rooms
    }
  }
  return occupied
}

/** Creates an in-memory repository that accounts inventory for every room night. */
export function newMemoryRoomHoldRepository(
  capacityByRoomType: Readonly<Record<string, number>>
): RoomHoldRepository {
  const capacities = new Map<string, number>()
  const holds = new Map<string, SavedHold>()
  for (const entry of Object.entries(capacityByRoomType)) {
    const roomType = entry[0]
    const capacity = entry[1]
    validateRoomType(roomType)
    if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > 100_000) {
      throw new RangeError("invalid room capacity")
    }
    capacities.set(roomType, capacity)
  }

  return Object.freeze({
    hold(ctx: Context, command: HoldRoomCommand): RoomHold {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const fingerprint = roomHoldFingerprint(command)
      const saved = holds.get(command.holdId)
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint) throw new Error("hold identity conflict")
        return saved.hold
      }
      const capacity = capacities.get(command.roomType)
      if (capacity === undefined) throw new Error("room type not found")
      for (let night = command.checkInNight; night < command.checkOutNight; night += 1) {
        if (occupiedRooms(holds, command.roomType, night) + command.rooms > capacity) {
          throw new Error("insufficient room-night inventory")
        }
      }
      const hold: RoomHold = Object.freeze({
        holdId: command.holdId,
        roomType: command.roomType,
        checkInNight: command.checkInNight,
        checkOutNight: command.checkOutNight,
        rooms: command.rooms,
        status: "held"
      })
      holds.set(command.holdId, Object.freeze({ fingerprint, hold }))
      return hold
    },
    release(ctx: Context, holdId: string): RoomHold {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const saved = holds.get(holdId)
      if (saved === undefined) throw new Error("room hold not found")
      if (saved.hold.status === "released") return saved.hold
      const hold: RoomHold = Object.freeze({
        holdId: saved.hold.holdId,
        roomType: saved.hold.roomType,
        checkInNight: saved.hold.checkInNight,
        checkOutNight: saved.hold.checkOutNight,
        rooms: saved.hold.rooms,
        status: "released"
      })
      holds.set(holdId, Object.freeze({ fingerprint: saved.fingerprint, hold }))
      return hold
    },
    available(ctx: Context, roomType: string, night: number): number {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const capacity = capacities.get(roomType)
      if (capacity === undefined) throw new Error("room type not found")
      return capacity - occupiedRooms(holds, roomType, night)
    },
    checkReady(ctx: Context): void {
      const failure = ctx.err()
      if (failure !== null) throw failure
      if (capacities.size === 0) throw new Error("room inventory catalog is empty")
    }
  })
}

export type HoldRoom = (ctx: Context, command: HoldRoomCommand) => RoomHold
export type ReleaseRoomHold = (ctx: Context, holdId: string) => RoomHold

/** Creates the all-nights room hold operation. */
export function newHoldRoom(repository: RoomHoldRepository): HoldRoom {
  return function holdRoom(ctx: Context, command: HoldRoomCommand): RoomHold {
    validateRoomHold(command)
    return repository.hold(ctx, command)
  }
}

/** Creates the idempotent room hold release operation. */
export function newReleaseRoomHold(repository: RoomHoldRepository): ReleaseRoomHold {
  return function releaseRoomHold(ctx: Context, holdId: string): RoomHold {
    validateHoldId(holdId)
    return repository.release(ctx, holdId)
  }
}

const defaultCapacity: Readonly<Record<string, number>> = Object.freeze({
  standard: 2
})

/** Composes hotel room holds as an embeddable standard Fetch handler. */
export function newHandler(
  capacityByRoomType: Readonly<Record<string, number>> = defaultCapacity
): Handler {
  return newRuntime(capacityByRoomType).handler
}

/** Composes room holds and inventory-catalog readiness. */
export function newRuntime(capacityByRoomType: Readonly<Record<string, number>> = defaultCapacity) {
  const repository = newMemoryRoomHoldRepository(capacityByRoomType)
  const probes = newProbeRegistry()
  probes.register("ready", "room_inventory", function checkRoomInventory(ctx): void {
    repository.checkReady(ctx)
  })
  return Object.freeze({
    handler: newRoomHoldHandler(newHoldRoom(repository), newReleaseRoomHold(repository)),
    probes
  })
}
