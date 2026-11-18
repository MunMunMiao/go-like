import { withValue, type Context } from "../context/index"
import { coreInstance } from "../internal/instance"

import type { AppInfo } from "./options"

void coreInstance.version

const appInfoContextKey = Symbol("go-like.core.appInfo")

/** Context key that carries one immutable application identity. */
export function appInfoKey(): symbol {
  return appInfoContextKey
}

/** Validates an application identity string. */
export function identityText(value: unknown, field: "id" | "name" | "version"): string {
  if (typeof value !== "string") throw new TypeError(`app ${field} must be a string`)
  return value
}

/** Copies metadata without retaining caller-owned mutable state. */
export function snapshotMetadata(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("app metadata must be an object")
  }
  const entries: Array<[string, string]> = []
  for (const key of Object.keys(value)) {
    const entry = Reflect.get(value, key)
    if (typeof entry !== "string") {
      throw new TypeError(`app metadata value for "${key}" must be a string`)
    }
    entries.push([key, entry])
  }
  return Object.freeze(Object.fromEntries(entries))
}

/** Copies and validates an ordered endpoint list. */
export function snapshotEndpoints(values: readonly string[]): readonly string[] {
  const snapshot: string[] = []
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError("app endpoint must be a non-empty string")
    }
    snapshot.push(value)
  }
  return Object.freeze(snapshot)
}

/** Creates immutable application identity accessors. */
export function newAppInfo(
  appId: string,
  appName: string,
  appVersion: string,
  appMetadata: Readonly<Record<string, string>>,
  appEndpoints: readonly string[]
): AppInfo {
  return Object.freeze({
    id: () => appId,
    name: () => appName,
    version: () => appVersion,
    metadata: () => appMetadata,
    endpoint: () => appEndpoints
  })
}

/** Reports whether an unknown Context value implements AppInfo. */
export function isAppInfo(value: unknown): value is AppInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "id") === "function" &&
    typeof Reflect.get(value, "name") === "function" &&
    typeof Reflect.get(value, "version") === "function" &&
    typeof Reflect.get(value, "metadata") === "function" &&
    typeof Reflect.get(value, "endpoint") === "function"
  )
}

/** Returns a child Context carrying an immutable application identity snapshot. */
export function newContext(ctx: Context, info: AppInfo): Context {
  if (!isAppInfo(info)) throw new TypeError("app info must implement AppInfo")
  const snapshot = newAppInfo(
    identityText(info.id(), "id"),
    identityText(info.name(), "name"),
    identityText(info.version(), "version"),
    snapshotMetadata(info.metadata()),
    snapshotEndpoints(info.endpoint())
  )
  return withValue(ctx, appInfoContextKey, snapshot)
}

/** Returns the application identity carried by ctx, or null when absent. */
export function fromContext(ctx: Context): AppInfo | null {
  const value = ctx.value(appInfoContextKey)
  return isAppInfo(value) ? value : null
}
