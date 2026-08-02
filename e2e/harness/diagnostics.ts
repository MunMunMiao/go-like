const Redacted = "<redacted>"
const SensitiveNames = Object.freeze([
  "credential",
  "password",
  "passwd",
  "secret",
  "api-key",
  "api_key",
  "apikey",
  "token"
])
const SensitiveNameSearch = /credential|password|passwd|secret|api[-_]?key|token/iu
const SensitiveFlagName = /(?:token|password|passwd|secret|credential|api[-_]?key)/iu
const EnvironmentName = /^[A-Za-z_][A-Za-z0-9_]*$/u
const MaximumKnownSecrets = 256
const MaximumKnownSecretCharacters = 4_096
const MaximumKnownSecretTotalCharacters = 65_536

export interface DiagnosticsSanitizerOptions {
  readonly knownSecrets?: readonly string[] | undefined
}

export interface EnvironmentMetadata {
  readonly key: string
  readonly present: boolean
}

export interface StreamingRedactor {
  readonly write: (chunk: string | Uint8Array) => string
  readonly end: () => string
}

interface LocatedSecret {
  readonly index: number
  readonly value: string
}

interface LocatedSensitiveName {
  readonly index: number
  readonly value: string
  readonly awaitingNextCharacter: boolean
}

type RedactorState =
  | "plain"
  | "after-sensitive-name"
  | "after-separator"
  | "unquoted-sensitive-value"
  | "quoted-sensitive-value"

function normalizedSecrets(options?: DiagnosticsSanitizerOptions): readonly string[] {
  const supplied = options?.knownSecrets ?? []
  if (supplied.length > MaximumKnownSecrets) {
    throw new RangeError(`knownSecrets must contain at most ${MaximumKnownSecrets} values`)
  }
  let totalCharacters = 0
  const unique = new Set<string>()
  for (const secret of supplied) {
    if (secret.length === 0) continue
    if (secret.length > MaximumKnownSecretCharacters) {
      throw new RangeError(
        `known secret values must contain at most ${MaximumKnownSecretCharacters} characters`
      )
    }
    totalCharacters += secret.length
    if (totalCharacters > MaximumKnownSecretTotalCharacters) {
      throw new RangeError(
        `known secret values must contain at most ${MaximumKnownSecretTotalCharacters} total characters`
      )
    }
    unique.add(secret)
  }
  return Object.freeze(Array.from(unique).sort((left, right) => right.length - left.length))
}

function replaceAll(value: string, search: string, replacement: string): string {
  return value.split(search).join(replacement)
}

function redactKnownSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value
  for (const secret of secrets) redacted = replaceAll(redacted, secret, Redacted)
  return redacted
}

function earliestKnownSecret(value: string, secrets: readonly string[]): LocatedSecret | null {
  let selected: LocatedSecret | null = null
  for (const secret of secrets) {
    const index = value.indexOf(secret)
    if (
      index >= 0 &&
      (selected === null ||
        index < selected.index ||
        (index === selected.index && secret.length > selected.value.length))
    ) {
      selected = { index, value: secret }
    }
  }
  return selected
}

function sensitiveNameCandidate(value: string, final: boolean): LocatedSensitiveName | null {
  let offset = 0
  while (offset < value.length) {
    const match = SensitiveNameSearch.exec(value.slice(offset))
    if (match === null) return null
    const matched = match[0]
    const index = offset + (match.index ?? 0)
    const next = value[index + matched.length]
    if (next === undefined) {
      if (!final) return { index, value: matched, awaitingNextCharacter: true }
      return null
    }
    if (next === ":" || next === "=" || next === " " || next === "\t") {
      return { index, value: matched, awaitingNextCharacter: false }
    }
    offset = index + 1
  }
  return null
}

function isValueDelimiter(value: string): boolean {
  return /[\s,;]/u.test(value)
}

function partialMatchLength(value: string, secrets: readonly string[]): number {
  const maximum = Math.min(
    value.length,
    [...SensitiveNames, ...secrets].reduce(
      (largest, candidate) => Math.max(largest, candidate.length - 1),
      0
    )
  )
  for (let length = maximum; length > 0; length -= 1) {
    const suffix = value.slice(-length)
    if (SensitiveNames.some((name) => name.startsWith(suffix.toLocaleLowerCase("en-US")))) {
      return length
    }
    if (secrets.some((secret) => secret.startsWith(suffix))) return length
  }
  return 0
}

function createRedactor(secrets: readonly string[]): StreamingRedactor {
  const decoder = new TextDecoder()
  let pending = ""
  let state: RedactorState = "plain"
  let quote = ""
  let escaped = false
  let ended = false

  function consume(input: string, final: boolean): string {
    pending += input
    const output: string[] = []
    while (true) {
      if (state === "after-sensitive-name") {
        const next = pending[0]
        if (next === undefined) break
        if (next === " " || next === "\t") {
          output.push(next)
          pending = pending.slice(1)
          continue
        }
        if (next === ":" || next === "=") {
          output.push(next)
          pending = pending.slice(1)
          state = "after-separator"
          continue
        }
        state = "plain"
        continue
      }

      if (state === "after-separator") {
        const next = pending[0]
        if (next === undefined) {
          if (final) {
            output.push(Redacted)
            state = "plain"
          }
          break
        }
        if (next === " " || next === "\t") {
          output.push(next)
          pending = pending.slice(1)
          continue
        }
        output.push(Redacted)
        if (next === '"' || next === "'") {
          quote = next
          escaped = false
          pending = pending.slice(1)
          state = "quoted-sensitive-value"
          continue
        }
        if (isValueDelimiter(next)) {
          state = "plain"
          continue
        }
        pending = pending.slice(1)
        state = "unquoted-sensitive-value"
        continue
      }

      if (state === "unquoted-sensitive-value") {
        let delimiter = -1
        for (let index = 0; index < pending.length; index += 1) {
          const value = pending[index]
          if (value !== undefined && isValueDelimiter(value)) {
            delimiter = index
            break
          }
        }
        if (delimiter < 0) {
          pending = ""
          break
        }
        pending = pending.slice(delimiter)
        state = "plain"
        continue
      }

      if (state === "quoted-sensitive-value") {
        let closed = false
        for (let index = 0; index < pending.length; index += 1) {
          const value = pending[index]
          if (value === undefined) continue
          if (escaped) {
            escaped = false
            continue
          }
          if (value === "\\") {
            escaped = true
            continue
          }
          if (value === quote) {
            pending = pending.slice(index + 1)
            quote = ""
            state = "plain"
            closed = true
            break
          }
        }
        if (!closed) {
          pending = ""
          break
        }
        continue
      }

      const secret = earliestKnownSecret(pending, secrets)
      const sensitive = sensitiveNameCandidate(pending, final)
      if (
        secret !== null &&
        (sensitive === null ||
          secret.index < sensitive.index ||
          (secret.index === sensitive.index && sensitive.awaitingNextCharacter))
      ) {
        output.push(pending.slice(0, secret.index), Redacted)
        pending = pending.slice(secret.index + secret.value.length)
        continue
      }
      if (sensitive !== null) {
        output.push(
          redactKnownSecrets(pending.slice(0, sensitive.index), secrets),
          redactKnownSecrets(sensitive.value, secrets)
        )
        pending = pending.slice(sensitive.index + sensitive.value.length)
        state = "after-sensitive-name"
        if (sensitive.awaitingNextCharacter) break
        continue
      }
      if (final) {
        output.push(redactKnownSecrets(pending, secrets))
        pending = ""
        break
      }
      const retained = partialMatchLength(pending, secrets)
      const boundary = pending.length - retained
      if (boundary > 0) {
        output.push(redactKnownSecrets(pending.slice(0, boundary), secrets))
        pending = pending.slice(boundary)
      }
      break
    }
    return output.join("")
  }

  return Object.freeze({
    write(chunk: string | Uint8Array): string {
      if (ended) throw new Error("streaming redactor already ended")
      return consume(
        typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
        false
      )
    },
    end(): string {
      if (ended) return ""
      ended = true
      return consume(decoder.decode(), true)
    }
  })
}

/** Redacts registered secret values and credential assignments in free-form text. */
export function redactText(value: string, options?: DiagnosticsSanitizerOptions): string {
  const redactor = createRedactor(normalizedSecrets(options))
  return `${redactor.write(value)}${redactor.end()}`
}

function redactEnvironmentArgument(value: string, options?: DiagnosticsSanitizerOptions): string {
  const separator = value.indexOf("=")
  if (separator < 0) return EnvironmentName.test(value) ? redactText(value, options) : Redacted
  const key = value.slice(0, separator)
  if (!EnvironmentName.test(key)) return Redacted
  return `${redactText(key, options)}=${Redacted}`
}

function sensitiveFlag(value: string): boolean {
  const separator = value.indexOf("=")
  const name = separator < 0 ? value : value.slice(0, separator)
  return value.startsWith("-") && SensitiveFlagName.test(name)
}

/** Returns an argv-safe diagnostic representation without credential values. */
export function sanitizeArgv(
  argv: readonly string[],
  options?: DiagnosticsSanitizerOptions
): readonly string[] {
  const sanitized: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === undefined) continue
    if (value === "--env" || value === "-e") {
      sanitized.push(value)
      const assigned = argv[index + 1]
      if (assigned !== undefined && !assigned.startsWith("-")) {
        sanitized.push(redactEnvironmentArgument(assigned, options))
        index += 1
      }
      continue
    }
    if (value.startsWith("--env=")) {
      sanitized.push(`--env=${redactEnvironmentArgument(value.slice("--env=".length), options)}`)
      continue
    }
    if (value.startsWith("-e=")) {
      sanitized.push(`-e=${redactEnvironmentArgument(value.slice("-e=".length), options)}`)
      continue
    }
    if (value.startsWith("-e") && value.length > 2) {
      sanitized.push(`-e${redactEnvironmentArgument(value.slice(2), options)}`)
      continue
    }
    if (sensitiveFlag(value)) {
      const separator = value.indexOf("=")
      if (separator >= 0) sanitized.push(`${value.slice(0, separator + 1)}${Redacted}`)
      else {
        sanitized.push(value)
        const assigned = argv[index + 1]
        if (assigned !== undefined && !assigned.startsWith("-")) {
          sanitized.push(Redacted)
          index += 1
        }
      }
      continue
    }
    if (!value.startsWith("-") && /^[^=\s]+=.*$/su.test(value)) {
      sanitized.push(redactEnvironmentArgument(value, options))
      continue
    }
    sanitized.push(redactText(value, options))
  }
  return Object.freeze(sanitized)
}

/** Describes child environment keys without exposing values. */
export function sanitizeEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): readonly EnvironmentMetadata[] {
  return Object.freeze(
    Object.keys(environment)
      .sort()
      .map((key) => Object.freeze({ key, present: environment[key] !== undefined }))
  )
}

function sensitiveEnvironmentName(value: string): boolean {
  return EnvironmentName.test(value) && SensitiveFlagName.test(value)
}

function assignmentSecret(value: string): string | null {
  const separator = value.indexOf("=")
  if (separator <= 0) return null
  const key = value.slice(0, separator)
  const assigned = value.slice(separator + 1)
  return sensitiveEnvironmentName(key) && assigned.length > 0 ? assigned : null
}

/** Extracts only values carried by structurally sensitive argv and environment fields. */
export function extractSensitiveValues(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = Object.freeze({})
): readonly string[] {
  const secrets = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === undefined) continue
    if (value === "--env" || value === "-e") {
      const secret = assignmentSecret(argv[index + 1] ?? "")
      if (secret !== null) secrets.add(secret)
      index += 1
      continue
    }
    const environmentAssignment = value.startsWith("--env=")
      ? value.slice("--env=".length)
      : value.startsWith("-e=")
        ? value.slice(3)
        : value.startsWith("-e") && value.length > 2
          ? value.slice(2)
          : null
    if (environmentAssignment !== null) {
      const secret = assignmentSecret(environmentAssignment)
      if (secret !== null) secrets.add(secret)
      continue
    }
    if (!sensitiveFlag(value)) continue
    const separator = value.indexOf("=")
    if (separator >= 0) {
      const secret = value.slice(separator + 1)
      if (secret.length > 0) secrets.add(secret)
      continue
    }
    const assigned = argv[index + 1]
    if (assigned !== undefined && !assigned.startsWith("-")) {
      if (assigned.length > 0) secrets.add(assigned)
      index += 1
    }
  }
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && value.length > 0 && sensitiveEnvironmentName(key)) {
      secrets.add(value)
    }
  }
  return Object.freeze(Array.from(secrets))
}

/** Returns an exact bounded tail after validating the requested diagnostic limit. */
export function boundedTail(value: string, maximumCharacters: number): string {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 0) {
    throw new RangeError("maximumCharacters must be a non-negative safe integer")
  }
  return value.length <= maximumCharacters ? value : value.slice(-maximumCharacters)
}

/** Produces a bounded, sanitized summary without serializing raw stacks. */
export function errorSummary(
  value: unknown,
  options?: DiagnosticsSanitizerOptions,
  maximumCharacters = 4_000
): string {
  const summaries: string[] = []
  const seen = new Set<unknown>()
  function visit(current: unknown, depth: number): void {
    if (depth >= 4 || current === undefined || seen.has(current) || summaries.length >= 12) return
    seen.add(current)
    if (current instanceof AggregateError) {
      summaries.push(`${current.name}: ${current.message}`)
      for (const nested of current.errors) visit(nested, depth + 1)
      visit(current.cause, depth + 1)
      return
    }
    if (current instanceof Error) {
      summaries.push(`${current.name}: ${current.message}`)
      visit(current.cause, depth + 1)
      return
    }
    summaries.push(String(current))
  }
  visit(value, 0)
  return boundedTail(redactText(summaries.join(" <- "), options), maximumCharacters)
}

/** Redacts registered secrets and credential assignments across arbitrary stream boundaries. */
export function createStreamingRedactor(options?: DiagnosticsSanitizerOptions): StreamingRedactor {
  return createRedactor(normalizedSecrets(options))
}
