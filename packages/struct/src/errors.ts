import type { FlattenedStructError, FormattedStructError, Path, StructIssue } from "./types"
import { formatPath } from "./utils"

const OMITTABLE_FIELD_HINT = "Use optional() or nullish() if the field may be omitted"

/** Rewrites one issue message, or returns undefined to keep the default. */
export type ErrorMap = (issue: StructIssue) => string | undefined

/** Aggregate of the first `StructIssue` from a failed parse. */
export class StructError extends Error {
  /** Issues collected for this failure, in encounter order. */
  readonly issues: StructIssue[]

  /** @param issues - Parse issues. An empty list still produces a generic message. */
  constructor(issues: StructIssue[]) {
    const first = issues[0]?.message
    super(
      issues.length <= 1
        ? (first ?? "Struct parse failed")
        : `${issues.length} struct issues: ${first}`
    )
    this.name = "StructError"
    this.issues = issues
  }

  /** Builds a nested error tree keyed by path segments. */
  format(): FormattedStructError {
    const root = createFormattedError()
    for (const item of this.issues) {
      let cursor: FormattedStructError = root
      for (const segment of item.path) {
        const key = formatErrorTreeKey(segment)
        const existing = cursor[key]
        if (Object.hasOwn(cursor, key) && existing && !Array.isArray(existing)) {
          cursor = existing
        } else {
          const next = createFormattedError()
          cursor[key] = next
          cursor = next
        }
      }
      cursor._errors.push(item.message)
    }
    return root
  }

  /** Splits issues into root `formErrors` and first-segment `fieldErrors`. */
  flatten(): FlattenedStructError {
    const formErrors: string[] = []
    const fieldErrors: { [key: string]: string[] } = Object.create(null)
    for (const item of this.issues) {
      if (item.path.length === 0) {
        formErrors.push(item.message)
        continue
      }
      const key = String(item.path[0])
      ;(fieldErrors[key] ??= []).push(item.message)
    }
    return { fieldErrors, formErrors }
  }

  /** Renders one `× path: message` line per issue. */
  prettify(): string {
    if (this.issues.length === 0) {
      return "Struct parse failed"
    }
    return this.issues
      .map((item) => {
        const where = item.path.length === 0 ? "<root>" : formatPath(item.path)
        return `× ${where}: ${item.message}`
      })
      .join("\n")
  }
}

function createFormattedError(): FormattedStructError {
  return Object.assign(Object.create(null), { _errors: [] as string[] })
}

function formatErrorTreeKey(segment: number | string): string {
  const key = String(segment)
  return key === "_errors" ? "\\_errors" : key
}

const STACK_DEPTH_MESSAGE = "struct recursion exceeded the supported call stack depth"
const V8_STACK_EXHAUSTED = "Maximum call stack size exceeded"
const JSC_STACK_EXHAUSTED = "Maximum call stack size exceeded."
const SPIDERMONKEY_STACK_EXHAUSTED = "too much recursion"

/** Reports a call-stack overflow. Other RangeError values must keep their identity. */
export function isCallStackOverflow(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if (Object.prototype.toString.call(error) !== "[object Error]") return false
  const name = (error as { name?: unknown }).name
  const message = (error as { message?: unknown }).message
  if (typeof name !== "string" || typeof message !== "string") return false
  if (name === "InternalError") return message === SPIDERMONKEY_STACK_EXHAUSTED
  return (
    name === "RangeError" &&
    (message === V8_STACK_EXHAUSTED ||
      message === JSC_STACK_EXHAUSTED ||
      message === SPIDERMONKEY_STACK_EXHAUSTED)
  )
}

/** Builds the public error for a call stack that cannot finish a legal struct walk. */
export function callStackStructError(value: unknown): StructError {
  return new StructError([
    issue([], "custom", "safe struct value graph", value, STACK_DEPTH_MESSAGE)
  ])
}

let activeErrorMap: ErrorMap | undefined

export function hasErrorMap(): boolean {
  return activeErrorMap !== undefined
}

export function runWithErrorMap<T>(map: ErrorMap | undefined, run: () => T): T {
  const previous = activeErrorMap
  activeErrorMap = map
  try {
    return run()
  } finally {
    activeErrorMap = previous
  }
}

/** Builds one issue, redacting string and object payloads from the public message. */
export function issue(
  path: Path,
  code: StructIssue["code"],
  expected: string,
  received: unknown,
  message?: string
): StructIssue {
  const publicReceived = describeIssueValue(received)
  const where = formatPath(path)
  const fallback = `Expected ${expected} at ${where}, received ${publicReceived}`
  const candidate: StructIssue = {
    code,
    expected,
    message:
      message ?? (code === "missing_key" ? `${fallback}. ${OMITTABLE_FIELD_HINT}` : fallback),
    path,
    received: retainSafeIssueValue(received, publicReceived)
  }
  if (activeErrorMap) {
    const override = activeErrorMap(candidate)
    if (override) {
      candidate.message = override
    }
  }
  return candidate
}

function retainSafeIssueValue(value: unknown, description: string): unknown {
  return value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
    ? value
    : description
}

function describeIssueValue(value: unknown): string {
  if (value === null) {
    return "null"
  }
  if (value === undefined) {
    return "undefined"
  }

  switch (typeof value) {
    case "boolean":
    case "number":
      return String(value)
    case "bigint":
    case "function":
    case "string":
    case "symbol":
      return typeof value
  }

  if (typeof File !== "undefined" && value instanceof File) {
    return "File"
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return "Blob"
  }
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
    return "ArrayBuffer"
  }
  if (value instanceof Date) {
    return "Date"
  }
  if (Array.isArray(value)) {
    return "array"
  }
  return "object"
}
