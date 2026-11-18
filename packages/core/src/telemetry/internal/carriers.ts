import type { Context } from "../../context/index"
import type { CarrierReader, CarrierWriter } from "../../trace/index"

import { stateFrom } from "./state"

const detachedRecords = new WeakSet<object>()

/** Marks one record as a detached carrier built by core from validated entries. */
export function markDetachedRecord(record: Readonly<Record<string, string>>): void {
  detachedRecords.add(record)
}

/** Deletes caller-supplied propagation fields, then injects the current span with `set`. */
export function injectHeaders(ctx: Context, headers: Headers): void {
  const propagator = stateFrom(ctx)?.propagator
  if (propagator === undefined || propagator === null) return
  let fields: readonly string[] = []
  try {
    fields = propagator.fields()
  } catch {
    return
  }
  for (const field of fields) headers.delete(field)
  try {
    propagator.inject(ctx, headerWriter(headers))
  } catch {
    // A propagator failure does not change the call that asked for injection.
  }
}

/** Defines an own data field, including the name `__proto__`. */
function writeField(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value
  })
}

/**
 * Returns a frozen copy of `headers` with caller propagation fields replaced by ctx's.
 * A record core already detached (a broker snapshot or an earlier result here) is returned
 * unchanged when no propagator is installed, because recopying it is pure disabled-path cost.
 * Every other record, including a user-frozen object, is copied: each accepted own enumerable
 * field is read once through ordinary property access. A throwing accessor fails the copy;
 * skipping it would publish a carrier that silently dropped a legal field. Non-string results
 * are omitted.
 */
export function injectRecord(
  ctx: Context,
  headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const propagator = stateFrom(ctx)?.propagator ?? null
  if (propagator === null && detachedRecords.has(headers)) return headers
  let fields: readonly string[] = []
  if (propagator !== null) {
    try {
      fields = propagator.fields()
    } catch {
      fields = []
    }
  }
  const owned = new Set(fields.map((field) => field.toLowerCase()))
  const copy = Object.create(null) as Record<string, string>
  for (const key of Object.keys(headers)) {
    if (owned.has(key.toLowerCase())) continue
    const value = headers[key]
    if (typeof value !== "string") continue
    writeField(copy, key, value)
  }
  if (propagator !== null) {
    try {
      propagator.inject(ctx, {
        /** Replaces one field on the copied record. */
        set(key: string, value: string): void {
          writeField(copy, key, value)
        }
      })
    } catch {
      // Keep the stripped copy when injection fails.
    }
  }
  const frozen = Object.freeze(copy)
  markDetachedRecord(frozen)
  return frozen
}

/** Adapts a Fetch `Headers` object or a string record to a case-insensitive reader. */
export function carrierReader(carrier: Headers | Readonly<Record<string, string>>): CarrierReader {
  if (carrier instanceof Headers) {
    return {
      /** Reads one header. `Headers.get` is already case-insensitive. */
      get(key: string): string | null {
        return carrier.get(key)
      },
      /** Lists the header names currently stored. */
      keys(): readonly string[] {
        return [...carrier.keys()]
      }
    }
  }
  return {
    /** Reads one field, matching the name without case sensitivity. */
    get(key: string): string | null {
      const wanted = key.toLowerCase()
      for (const name of Object.keys(carrier)) {
        if (name.toLowerCase() !== wanted) continue
        const value = carrier[name]
        return typeof value === "string" ? value : null
      }
      return null
    },
    /** Lists the record's own keys. */
    keys(): readonly string[] {
      return Object.keys(carrier)
    }
  }
}

/** Writes propagation fields with `Headers.set`, which replaces rather than appends. */
function headerWriter(headers: Headers): CarrierWriter {
  return {
    /** Replaces one header value. */
    set(key: string, value: string): void {
      headers.set(key, value)
    }
  }
}
