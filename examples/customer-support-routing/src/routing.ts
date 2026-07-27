import type { Context } from "@likego/context"
import { newRoundRobinSelector, type ServiceInstance } from "@likego/registry"

import type {
  RouteSupportCaseCommand,
  SupportAssignment,
  SupportLanguage,
  SupportPriority
} from "./service"

export interface SupportRoutingStore {
  assign(ctx: Context, command: RouteSupportCaseCommand): SupportAssignment
}

const defaultAgents: readonly ServiceInstance[] = Object.freeze([
  Object.freeze({
    id: "agent-zh-standard",
    name: "customer-support",
    version: "v1",
    endpoints: Object.freeze(["https://zh-standard.example.test/"]),
    metadata: Object.freeze({ language: "zh", level: "standard" })
  }),
  Object.freeze({
    id: "agent-zh-senior",
    name: "customer-support",
    version: "v1",
    endpoints: Object.freeze(["https://zh-senior.example.test/"]),
    metadata: Object.freeze({ language: "zh", level: "senior" })
  }),
  Object.freeze({
    id: "agent-en-standard",
    name: "customer-support",
    version: "v1",
    endpoints: Object.freeze(["https://en-standard.example.test/"]),
    metadata: Object.freeze({ language: "en", level: "standard" })
  }),
  Object.freeze({
    id: "agent-en-senior",
    name: "customer-support",
    version: "v1",
    endpoints: Object.freeze(["https://en-senior.example.test/"]),
    metadata: Object.freeze({ language: "en", level: "senior" })
  })
])

/** Returns whether one agent satisfies an explicit support route. */
function eligible(
  agent: ServiceInstance,
  language: SupportLanguage,
  priority: SupportPriority
): boolean {
  if (agent.metadata.language !== language) return false
  return priority === "standard" || agent.metadata.level === "senior"
}

/** Reads the validated level attached to one selected support instance. */
function agentLevel(agent: ServiceInstance): "senior" | "standard" {
  return agent.metadata.level === "senior" ? "senior" : "standard"
}

/** Creates an in-memory assignment store using a LikeGo endpoint selector. */
export function newMemorySupportRoutingStore(
  agents: readonly ServiceInstance[] = defaultAgents
): SupportRoutingStore {
  const assignments = new Map<string, SupportAssignment>()
  const selector = newRoundRobinSelector()
  return Object.freeze({
    assign(ctx: Context, command: RouteSupportCaseCommand): SupportAssignment {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const current = assignments.get(command.caseId)
      if (current !== undefined) {
        if (current.language !== command.language || current.priority !== command.priority) {
          throw new Error("support case already assigned with different routing criteria")
        }
        return current
      }
      const candidates = agents.filter((agent) => {
        return eligible(agent, command.language, command.priority)
      })
      if (candidates.length === 0) throw new Error("no eligible support agent")
      const selection = selector.select(ctx, candidates)
      const assignment: SupportAssignment = Object.freeze({
        caseId: command.caseId,
        language: command.language,
        priority: command.priority,
        agentEndpoint: selection[0].url,
        agentLevel: agentLevel(selection[0].instance)
      })
      selection[1](ctx, { error: null })
      assignments.set(command.caseId, assignment)
      return assignment
    }
  })
}
