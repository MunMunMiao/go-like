import { coreVersion } from "./version"

const coreInstances = Symbol.for("go-like.core.instances")

/** One loaded copy of core in this realm. */
export interface CoreInstance {
  readonly version: string
  /** import.meta.url of internal/instance.ts without query and hash; "" when unavailable. */
  readonly url: string
}

interface InstanceRecord {
  readonly version: string
  readonly url: string
}

/** Strips the query and hash from this module's URL. An empty string means the URL is unavailable. */
function instanceUrl(raw: string): string {
  const url = new URL(raw)
  url.search = ""
  url.hash = ""
  return url.href
}

/** Builds the evaluation-time duplicate error. The type is not exported: nothing can branch on it. */
function duplicateInstance(self: CoreInstance, current: InstanceRecord): Error {
  const error = new Error(
    `a second copy of @go-like/core was loaded: ${self.url} (${self.version}); first copy: ${current.url} (${current.version}). ` +
      "Plugs must declare @go-like/core as a peer dependency of the same version."
  )
  error.name = "CoreInstanceError"
  return Object.assign(error, { code: "GO_LIKE_CORE_DUPLICATE_INSTANCE" })
}

/** Reads the realm slot and records this copy, or throws when another copy is already there. */
function register(self: CoreInstance): void {
  const existing: unknown = Reflect.get(globalThis, coreInstances)
  const list = Array.isArray(existing) ? (existing as readonly InstanceRecord[]) : []
  const conflict = list.find((entry) => entry.url !== self.url || entry.version !== self.version)
  if (conflict !== undefined) throw duplicateInstance(self, conflict)
  if (list.some((entry) => entry.url === self.url && entry.version === self.version)) return
  Object.defineProperty(globalThis, coreInstances, {
    configurable: true,
    enumerable: false,
    value: Object.freeze([...list, self]),
    writable: false
  })
}

const rawUrl = import.meta.url
/**
 * The ONE duplicate-core detector (D6), evaluated at module load; every brand-owning core module imports this used binding.
 * Registering { version, url } in globalThis[Symbol.for("go-like.core.instances")] throws Error { name: "CoreInstanceError",
 * code: "GO_LIKE_CORE_DUPLICATE_INSTANCE" } when a record with a different url or version already exists. The slot is a
 * rendezvous only, never read to decide identity. No opt-out; no exported error type.
 */
export const coreInstance: CoreInstance = Object.freeze({
  version: coreVersion,
  url: typeof rawUrl === "string" && rawUrl.length > 0 ? instanceUrl(rawUrl) : ""
})

register(coreInstance)
