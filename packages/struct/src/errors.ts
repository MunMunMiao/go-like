import type { FlattenedStructError, FormattedStructError, Path, StructIssue } from "./types"
import { formatPath } from "./utils"

export type ErrorMap = (issue: StructIssue) => string | undefined

let globalErrorMap: ErrorMap | undefined

export function setErrorMap(map: ErrorMap | undefined): void {
  globalErrorMap = map
}

export class StructError extends Error {
  readonly issues: StructIssue[]

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

  format(): FormattedStructError {
    const root = formattedErrorNode()
    for (const item of this.issues) {
      let cursor: FormattedStructError = root
      for (const segment of item.path) {
        const key = formatErrorTreeKey(segment)
        const existing = cursor[key]
        if (existing && !Array.isArray(existing)) {
          cursor = existing
        } else {
          const next = formattedErrorNode()
          cursor[key] = next
          cursor = next
        }
      }
      cursor._errors.push(item.message)
    }
    return root
  }

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

function formattedErrorNode(): FormattedStructError {
  const node = Object.create(null) as FormattedStructError
  node._errors = []
  return node
}

function formatErrorTreeKey(segment: number | string): string {
  const key = String(segment)
  return key === "_errors" ? "\\_errors" : key
}

export function issue(
  path: Path,
  code: StructIssue["code"],
  expected: string,
  received: unknown,
  message?: string
): StructIssue {
  const publicReceived = describeIssueValue(received)
  const candidate: StructIssue = {
    code,
    expected,
    message: message ?? `Expected ${expected} at ${formatPath(path)}, received ${publicReceived}`,
    path,
    received: retainSafeIssueValue(received, publicReceived)
  }
  if (globalErrorMap) {
    const override = globalErrorMap(candidate)
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
