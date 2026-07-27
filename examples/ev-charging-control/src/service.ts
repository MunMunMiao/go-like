import type { Context } from "@likego/context"
import { newProbeRegistry, type ProbeRegistry } from "@likego/health"
import type { Handler } from "@likego/web"

import { newChargingHandler } from "./http"

const PublicId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface ChargingStation {
  readonly stationId: string
  readonly capacityKw: number
  readonly online: boolean
}

export interface StartChargingCommand {
  readonly sessionId: string
  readonly stationId: string
  readonly connectorId: string
  readonly requestedKw: number
}

export interface ChargingSession extends StartChargingCommand {
  readonly status: "charging"
}

/** Validates a station admitted into the local control-plane snapshot. */
export function validateChargingStation(station: ChargingStation): void {
  if (!PublicId.test(station.stationId)) throw new TypeError("invalid stationId")
  if (!Number.isSafeInteger(station.capacityKw) || station.capacityKw <= 0) {
    throw new RangeError("capacityKw must be a positive safe integer")
  }
}

/** Validates one charging request before any capacity is reserved. */
export function validateStartCharging(command: StartChargingCommand): void {
  if (
    !PublicId.test(command.sessionId) ||
    !PublicId.test(command.stationId) ||
    !PublicId.test(command.connectorId)
  ) {
    throw new TypeError("invalid charging identity")
  }
  if (!Number.isSafeInteger(command.requestedKw) || command.requestedKw <= 0) {
    throw new RangeError("requestedKw must be a positive safe integer")
  }
}

/** Reports whether an existing session is the same idempotent charging command. */
export function sameChargingCommand(
  session: ChargingSession,
  command: StartChargingCommand
): boolean {
  return (
    session.sessionId === command.sessionId &&
    session.stationId === command.stationId &&
    session.connectorId === command.connectorId &&
    session.requestedKw === command.requestedKw
  )
}

export interface ChargingRepository {
  reserve(ctx: Context, command: StartChargingCommand): ChargingSession
  setOnline(ctx: Context, stationId: string, online: boolean): void
  checkReady(ctx: Context): void
  sessionCount(): number
}

interface StationState {
  readonly capacityKw: number
  online: boolean
  allocatedKw: number
  readonly connectors: Set<string>
}

/** Rejects repository work after its caller Context has ended. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

/** Creates an in-memory station controller with atomic single-process capacity admission. */
export function newMemoryChargingRepository(
  definitions: readonly ChargingStation[]
): ChargingRepository {
  const stations = new Map<string, StationState>()
  const sessions = new Map<string, ChargingSession>()
  for (const definition of definitions) {
    validateChargingStation(definition)
    if (stations.has(definition.stationId)) throw new TypeError("duplicate stationId")
    stations.set(definition.stationId, {
      capacityKw: definition.capacityKw,
      online: definition.online,
      allocatedKw: 0,
      connectors: new Set()
    })
  }

  return Object.freeze({
    /** Reserves connector and station power without oversubscription. */
    reserve(ctx: Context, command: StartChargingCommand): ChargingSession {
      checkContext(ctx)
      const existing = sessions.get(command.sessionId)
      if (existing !== undefined) {
        if (!sameChargingCommand(existing, command))
          throw new Error("charging session identity conflict")
        return existing
      }
      const station = stations.get(command.stationId)
      if (station === undefined) throw new Error("charging station not found")
      if (!station.online) throw new Error("charging station is offline")
      if (station.connectors.has(command.connectorId))
        throw new Error("connector is already occupied")
      const nextAllocation = station.allocatedKw + command.requestedKw
      if (!Number.isSafeInteger(nextAllocation) || nextAllocation > station.capacityKw) {
        throw new Error("station capacity exceeded")
      }
      const session: ChargingSession = Object.freeze({
        sessionId: command.sessionId,
        stationId: command.stationId,
        connectorId: command.connectorId,
        requestedKw: command.requestedKw,
        status: "charging"
      })
      station.allocatedKw = nextAllocation
      station.connectors.add(command.connectorId)
      sessions.set(command.sessionId, session)
      return session
    },
    /** Changes only the operational state of one known station. */
    setOnline(ctx: Context, stationId: string, online: boolean): void {
      checkContext(ctx)
      const station = stations.get(stationId)
      if (station === undefined) throw new Error("charging station not found")
      station.online = online
    },
    /** Fails readiness closed unless at least one station can accept traffic. */
    checkReady(ctx: Context): void {
      checkContext(ctx)
      for (const station of stations.values()) {
        if (station.online) return
      }
      throw new Error("no charging station is online")
    },
    /** Returns the number of uniquely admitted sessions. */
    sessionCount(): number {
      return sessions.size
    }
  })
}

export type StartCharging = (ctx: Context, command: StartChargingCommand) => ChargingSession

/** Creates the capacity-safe charging-session operation. */
export function newStartCharging(repository: ChargingRepository): StartCharging {
  return function startCharging(ctx: Context, command: StartChargingCommand): ChargingSession {
    validateStartCharging(command)
    return repository.reserve(ctx, command)
  }
}

export interface ChargingControlRuntime {
  readonly handler: Handler
  readonly probes: ProbeRegistry
  readonly repository: ChargingRepository
}

const defaultStations = Object.freeze([
  Object.freeze({ stationId: "station-1", capacityKw: 120, online: true })
])

/** Composes charging control and its readiness probe without owning a Web listener. */
export function newChargingControlRuntime(
  stations: readonly ChargingStation[] = defaultStations
): ChargingControlRuntime {
  const repository = newMemoryChargingRepository(stations)
  const probes = newProbeRegistry()
  probes.register("ready", "charging_stations", function chargingStationsReady(ctx): void {
    repository.checkReady(ctx)
  })
  return Object.freeze({
    handler: newChargingHandler(newStartCharging(repository)),
    probes,
    repository
  })
}
