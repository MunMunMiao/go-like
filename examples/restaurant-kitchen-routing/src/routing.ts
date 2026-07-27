import type { Context } from "@likego/context"
import { newProbeRegistry, type ProbeRegistry } from "@likego/health"
import { newRoundRobinSelector, type ServiceInstance } from "@likego/registry"

import type { KitchenAssignment, KitchenStation, RouteKitchenTicketCommand } from "./service"

export interface KitchenReadiness {
  readonly fryer: boolean
  readonly grill: boolean
  readonly pastry: boolean
}

export interface KitchenRoutingStore {
  route(ctx: Context, command: RouteKitchenTicketCommand): Promise<KitchenAssignment>
  setReady(ctx: Context, station: KitchenStation, ready: boolean): void
}

const defaultReadiness: KitchenReadiness = Object.freeze({
  fryer: true,
  grill: true,
  pastry: true
})

const fryerInstances: readonly ServiceInstance[] = Object.freeze([
  Object.freeze({
    id: "fryer-a",
    name: "kitchen-fryer",
    version: "v1",
    endpoints: Object.freeze(["https://fryer-a.example.test/"]),
    metadata: Object.freeze({})
  }),
  Object.freeze({
    id: "fryer-b",
    name: "kitchen-fryer",
    version: "v1",
    endpoints: Object.freeze(["https://fryer-b.example.test/"]),
    metadata: Object.freeze({})
  })
])

const grillInstances: readonly ServiceInstance[] = Object.freeze([
  Object.freeze({
    id: "grill-a",
    name: "kitchen-grill",
    version: "v1",
    endpoints: Object.freeze(["https://grill-a.example.test/"]),
    metadata: Object.freeze({})
  }),
  Object.freeze({
    id: "grill-b",
    name: "kitchen-grill",
    version: "v1",
    endpoints: Object.freeze(["https://grill-b.example.test/"]),
    metadata: Object.freeze({})
  })
])

const pastryInstances: readonly ServiceInstance[] = Object.freeze([
  Object.freeze({
    id: "pastry-a",
    name: "kitchen-pastry",
    version: "v1",
    endpoints: Object.freeze(["https://pastry-a.example.test/"]),
    metadata: Object.freeze({})
  })
])

/** Selects the readiness registry owned by one kitchen station. */
function registryFor(
  station: KitchenStation,
  fryer: ProbeRegistry,
  grill: ProbeRegistry,
  pastry: ProbeRegistry
): ProbeRegistry {
  if (station === "fryer") return fryer
  if (station === "grill") return grill
  return pastry
}

/** Selects the immutable service instances owned by one kitchen station. */
function instancesFor(station: KitchenStation): readonly ServiceInstance[] {
  if (station === "fryer") return fryerInstances
  if (station === "grill") return grillInstances
  return pastryInstances
}

/** Creates an in-memory router backed by LikeGo readiness probes and endpoint selection. */
export function newMemoryKitchenRoutingStore(
  initialReadiness: KitchenReadiness = defaultReadiness
): KitchenRoutingStore {
  const assignments = new Map<string, KitchenAssignment>()
  const readiness = {
    fryer: initialReadiness.fryer,
    grill: initialReadiness.grill,
    pastry: initialReadiness.pastry
  }
  const fryer = newProbeRegistry()
  const grill = newProbeRegistry()
  const pastry = newProbeRegistry()
  fryer.register("ready", "station.fryer", () => {
    if (!readiness.fryer) throw new Error("fryer station is unavailable")
  })
  grill.register("ready", "station.grill", () => {
    if (!readiness.grill) throw new Error("grill station is unavailable")
  })
  pastry.register("ready", "station.pastry", () => {
    if (!readiness.pastry) throw new Error("pastry station is unavailable")
  })
  const selector = newRoundRobinSelector()

  return Object.freeze({
    async route(ctx: Context, command: RouteKitchenTicketCommand): Promise<KitchenAssignment> {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const current = assignments.get(command.ticketId)
      if (current !== undefined) {
        if (current.station !== command.station) {
          throw new Error("ticket already assigned to another station")
        }
        return current
      }
      const report = await registryFor(command.station, fryer, grill, pastry).check(ctx, "ready")
      if (!report.ok) throw new Error(`${command.station} station is unavailable`)
      const concurrentlyAssigned = assignments.get(command.ticketId)
      if (concurrentlyAssigned !== undefined) {
        if (concurrentlyAssigned.station !== command.station) {
          throw new Error("ticket already assigned to another station")
        }
        return concurrentlyAssigned
      }
      const selection = selector.select(ctx, instancesFor(command.station))
      const assignment: KitchenAssignment = Object.freeze({
        ticketId: command.ticketId,
        station: command.station,
        kitchenEndpoint: selection[0].url
      })
      selection[1](ctx, { error: null })
      assignments.set(command.ticketId, assignment)
      return assignment
    },
    setReady(ctx: Context, station: KitchenStation, ready: boolean): void {
      const failure = ctx.err()
      if (failure !== null) throw failure
      readiness[station] = ready
    }
  })
}
