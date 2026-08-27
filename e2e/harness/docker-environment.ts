import { createHash } from "node:crypto"

import type { CommandDefinition, ProcessSupervisor } from "./process"

export type DockerEnvironmentSnapshot = Readonly<Record<string, string>>

const DockerEnvironmentName = /^DOCKER_[A-Z0-9_]+$/u
const MaximumDockerEnvironmentEntries = 64
const MaximumDockerEnvironmentValueCharacters = 4_096
const MaximumDockerEnvironmentTotalCharacters = 32 * 1024

function dockerEnvironmentName(value: string): boolean {
  return DockerEnvironmentName.test(value)
}

/** Strictly validates and freezes a bounded Docker CLI environment snapshot. */
export function parseDockerEnvironmentSnapshot(value: unknown): DockerEnvironmentSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Docker environment snapshot must be a plain object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Docker environment snapshot must be a plain object")
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length > MaximumDockerEnvironmentEntries ||
    keys.some((key) => typeof key !== "string" || !dockerEnvironmentName(key))
  ) {
    throw new RangeError("Docker environment snapshot contains invalid keys")
  }
  let totalCharacters = 0
  const snapshot: Record<string, string> = {}
  for (const name of (keys as string[]).sort((left, right) => left.localeCompare(right, "en-US"))) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    const selected = descriptor !== undefined && "value" in descriptor ? descriptor.value : null
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      typeof selected !== "string" ||
      selected.includes("\0") ||
      selected.length > MaximumDockerEnvironmentValueCharacters
    ) {
      throw new RangeError("Docker environment snapshot contains an invalid entry")
    }
    totalCharacters += name.length + selected.length
    if (totalCharacters > MaximumDockerEnvironmentTotalCharacters) {
      throw new RangeError("Docker environment snapshot exceeds its character bound")
    }
    snapshot[name] = selected
  }
  return Object.freeze(snapshot)
}

/** Captures every Docker CLI environment value before less-trusted child code can mutate it. */
export function snapshotDockerEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env
): DockerEnvironmentSnapshot {
  const snapshot: Record<string, string> = {}
  for (const [name, value] of Object.entries(environment)) {
    if (dockerEnvironmentName(name) && value !== undefined) snapshot[name] = value
  }
  return parseDockerEnvironmentSnapshot(snapshot)
}

/** Binds a selector snapshot without publishing its potentially sensitive values in capability IPC. */
export function digestDockerEnvironment(snapshot: DockerEnvironmentSnapshot): string {
  const selected = parseDockerEnvironmentSnapshot(snapshot)
  return createHash("sha256").update(JSON.stringify(selected), "utf8").digest("hex")
}

/**
 * Produces child-only overrides that restore one snapshot and remove Docker variables introduced
 * after it was captured.
 */
export function dockerEnvironmentOverrides(
  snapshot: DockerEnvironmentSnapshot,
  ambient: Readonly<Record<string, string | undefined>> = process.env
): Readonly<Record<string, string | undefined>> {
  const selected = parseDockerEnvironmentSnapshot(snapshot)
  const names = new Set(Object.keys(selected))
  for (const name of Object.keys(ambient)) {
    if (dockerEnvironmentName(name)) names.add(name)
  }
  return Object.freeze(
    Object.fromEntries(
      Array.from(names)
        .sort((left, right) => left.localeCompare(right, "en-US"))
        .map((name) => [name, selected[name]])
    )
  )
}

/** Returns a complete child environment with the exact captured Docker selector state restored. */
export function applyDockerEnvironment(
  snapshot: DockerEnvironmentSnapshot,
  ambient: Readonly<Record<string, string | undefined>> = process.env
): Readonly<Record<string, string | undefined>> {
  const environment: Record<string, string | undefined> = { ...ambient }
  for (const [name, value] of Object.entries(dockerEnvironmentOverrides(snapshot, ambient))) {
    if (value === undefined) delete environment[name]
    else environment[name] = value
  }
  return Object.freeze(environment)
}

/** Pins every command submitted through a runner to one immutable Docker environment snapshot. */
export function withDockerEnvironment(
  runner: ProcessSupervisor["run"],
  snapshot: DockerEnvironmentSnapshot
): ProcessSupervisor["run"] {
  const selected = parseDockerEnvironmentSnapshot(snapshot)
  return async (root: string, definition: CommandDefinition) =>
    await runner(root, {
      ...definition,
      environment: Object.freeze({
        ...definition.environment,
        ...dockerEnvironmentOverrides(selected)
      })
    })
}
