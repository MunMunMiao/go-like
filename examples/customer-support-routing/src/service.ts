import type { Context } from "@likego/context"
import type { SupportRoutingStore } from "./routing"

const publicId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export type SupportLanguage = "en" | "zh"
export type SupportPriority = "standard" | "urgent"

export interface RouteSupportCaseCommand {
  readonly caseId: string
  readonly language: SupportLanguage
  readonly priority: SupportPriority
}

export interface SupportAssignment {
  readonly caseId: string
  readonly language: SupportLanguage
  readonly priority: SupportPriority
  readonly agentEndpoint: string
  readonly agentLevel: "senior" | "standard"
}

/** Validates one customer-support routing command. */
export function validateSupportCase(command: RouteSupportCaseCommand): void {
  if (!publicId.test(command.caseId)) throw new TypeError("invalid caseId")
  if (command.language !== "en" && command.language !== "zh") {
    throw new TypeError("unsupported support language")
  }
  if (command.priority !== "standard" && command.priority !== "urgent") {
    throw new TypeError("unsupported support priority")
  }
}

export type RouteSupportCase = (ctx: Context, command: RouteSupportCaseCommand) => SupportAssignment

/** Creates the Context-first customer-support routing use case. */
export function newRouteSupportCase(store: SupportRoutingStore): RouteSupportCase {
  return function routeSupportCase(
    ctx: Context,
    command: RouteSupportCaseCommand
  ): SupportAssignment {
    validateSupportCase(command)
    return store.assign(ctx, command)
  }
}
