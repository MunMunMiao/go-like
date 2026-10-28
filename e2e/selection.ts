import {
  type E2eScope,
  type E2eScopeSelection,
  findSuiteDefinition,
  type SuiteDefinition,
  suiteDefinitions
} from "./definitions"
import type { ProcessMode } from "./harness/process"

export type E2eRequest =
  | { readonly kind: "help" }
  | {
      readonly kind: "scope"
      readonly scope: E2eScopeSelection
      readonly processMode: ProcessMode
    }
  | {
      readonly kind: "suites"
      readonly ids: readonly string[]
      readonly processMode: ProcessMode
    }

const Scopes: readonly E2eScopeSelection[] = Object.freeze([
  "all",
  "suites",
  "providers",
  "runtimes",
  "examples",
  "published"
])

export const E2eUsage = `Usage:
  bun e2e/run.ts --scope <all|suites|providers|runtimes|examples|published> [--require-platform-containment]
  bun e2e/run.ts --suite <id> [--suite <id> ...] [--require-platform-containment]
  bun e2e/run.ts --help`

function invalidArguments(message: string): Error {
  return new Error(`${message}\n${E2eUsage}`)
}

export function parseE2eArguments(args: readonly string[]): E2eRequest {
  if (args.length === 0) throw invalidArguments("E2E requires --scope, --suite, or --help")
  if (args.includes("--help")) {
    if (args.length !== 1) throw invalidArguments("--help must be used alone")
    return Object.freeze({ kind: "help" })
  }

  let scope: E2eScopeSelection | null = null
  let processMode: ProcessMode = "managed"
  let processModeProvided = false
  const suites: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--require-platform-containment") {
      if (processModeProvided) {
        throw invalidArguments("--require-platform-containment may be provided only once")
      }
      processMode = "platform-containment"
      processModeProvided = true
      continue
    }
    if (argument === "--scope") {
      if (scope !== null) throw invalidArguments("--scope may be provided only once")
      if (suites.length > 0) throw invalidArguments("--scope and --suite are mutually exclusive")
      const value = args[index + 1]
      if (value === undefined || value.startsWith("-")) {
        throw invalidArguments("--scope requires a value")
      }
      if (!Scopes.includes(value as E2eScopeSelection)) {
        throw invalidArguments(`unknown E2E scope ${value}`)
      }
      scope = value as E2eScopeSelection
      index += 1
      continue
    }
    if (argument === "--suite") {
      if (scope !== null) throw invalidArguments("--scope and --suite are mutually exclusive")
      const value = args[index + 1]
      if (value === undefined || value.startsWith("-")) {
        throw invalidArguments("--suite requires a value")
      }
      if (findSuiteDefinition(value) === undefined)
        throw invalidArguments(`unknown E2E suite ${value}`)
      if (!suites.includes(value)) suites.push(value)
      index += 1
      continue
    }
    throw invalidArguments(`unknown E2E argument ${argument ?? "<missing>"}`)
  }

  if (scope !== null) return Object.freeze({ kind: "scope", scope, processMode })
  if (suites.length > 0) {
    return Object.freeze({ kind: "suites", ids: Object.freeze(suites), processMode })
  }
  throw invalidArguments("E2E selection is empty")
}

function scopeDefinitions(
  definitions: readonly SuiteDefinition[],
  scope: E2eScope
): readonly SuiteDefinition[] {
  if (scope === "providers") {
    return definitions.filter(
      (definition) => definition.explicitOnly !== true && definition.tags.includes("provider")
    )
  }
  return definitions.filter(
    (definition) => definition.explicitOnly !== true && definition.defaultScopes.includes(scope)
  )
}

export function selectExecutionPlan(
  definitions: readonly SuiteDefinition[],
  request: E2eRequest
): readonly SuiteDefinition[] {
  if (request.kind === "help") return Object.freeze([])
  if (request.kind === "suites") {
    return Object.freeze(
      request.ids.map((id) => {
        const selected = definitions.find((definition) => definition.id === id)
        if (selected === undefined) throw new Error(`unknown E2E suite ${id}`)
        return selected
      })
    )
  }
  if (request.scope !== "all") return Object.freeze(scopeDefinitions(definitions, request.scope))

  const selected: SuiteDefinition[] = []
  for (const scope of ["suites", "runtimes", "examples", "published"] as const) {
    for (const candidate of scopeDefinitions(definitions, scope)) {
      if (
        candidate.includeInAll &&
        candidate.explicitOnly !== true &&
        !selected.some((definition) => definition.id === candidate.id)
      ) {
        selected.push(candidate)
      }
    }
  }
  return Object.freeze(selected)
}

export function selectedSuites(args: readonly string[]): readonly string[] {
  const request = parseE2eArguments(args)
  return Object.freeze(
    selectExecutionPlan(suiteDefinitions(), request).map((definition) => definition.id)
  )
}

export { suiteDefinitions }
export type { E2eScope, E2eScopeSelection, SuiteDefinition }
