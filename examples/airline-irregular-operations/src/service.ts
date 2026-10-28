import type { Context } from "@go-like/context"
import { newRoundRobinSelector, type ServiceInstance } from "@go-like/registry"

export type DisruptionOutcome = "rebooked" | "refunded"

export interface ResolveDisruptionCommand {
  readonly caseId: string
  readonly outcome: DisruptionOutcome
}

export interface DisruptionResolution {
  readonly caseId: string
  readonly outcome: DisruptionOutcome
  readonly status: "resolved"
  readonly providerEndpoint: string | null
}

export interface DisruptionRepository {
  resolve(ctx: Context, command: ResolveDisruptionCommand): DisruptionResolution
  get(ctx: Context, caseId: string): DisruptionResolution | undefined
}

export type ResolveDisruption = (
  ctx: Context,
  command: ResolveDisruptionCommand
) => DisruptionResolution

const defaultRebookingProviders: readonly ServiceInstance[] = Object.freeze([
  Object.freeze({
    id: "rebooking-a",
    name: "airline-rebooking",
    version: "v1",
    endpoints: Object.freeze(["https://rebooking-a.example.test/"]),
    metadata: Object.freeze({})
  }),
  Object.freeze({
    id: "rebooking-b",
    name: "airline-rebooking",
    version: "v1",
    endpoints: Object.freeze(["https://rebooking-b.example.test/"]),
    metadata: Object.freeze({})
  })
])

/** Validates one irreversible disruption decision. */
export function validateDisruptionResolution(command: ResolveDisruptionCommand): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(command.caseId)) {
    throw new TypeError("invalid caseId")
  }
}

/** Creates an in-memory terminal-state disruption repository. */
export function newMemoryDisruptionRepository(
  rebookingProviders: readonly ServiceInstance[] = defaultRebookingProviders
): DisruptionRepository {
  const resolutions = new Map<string, DisruptionResolution>()
  const selector = newRoundRobinSelector()

  return Object.freeze({
    resolve(ctx: Context, command: ResolveDisruptionCommand): DisruptionResolution {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const current = resolutions.get(command.caseId)
      if (current !== undefined) {
        if (current.outcome !== command.outcome) {
          throw new Error("disruption already resolved")
        }
        return current
      }
      let providerEndpoint: string | null = null
      if (command.outcome === "rebooked") {
        const selection = selector.select(ctx, rebookingProviders)
        providerEndpoint = selection[0].url
        selection[1](ctx, { error: null })
      }
      const resolution: DisruptionResolution = Object.freeze({
        caseId: command.caseId,
        outcome: command.outcome,
        status: "resolved",
        providerEndpoint
      })
      resolutions.set(command.caseId, resolution)
      return resolution
    },
    get(ctx: Context, caseId: string): DisruptionResolution | undefined {
      const failure = ctx.err()
      if (failure !== null) throw failure
      return resolutions.get(caseId)
    }
  })
}

/** Creates the single-terminal-outcome disruption use case. */
export function newResolveDisruption(repository: DisruptionRepository): ResolveDisruption {
  return function resolveDisruption(
    ctx: Context,
    command: ResolveDisruptionCommand
  ): DisruptionResolution {
    validateDisruptionResolution(command)
    return repository.resolve(ctx, command)
  }
}
