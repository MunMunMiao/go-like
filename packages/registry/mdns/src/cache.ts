import { type ServiceInstance } from "@likego/registry"
import {
  newRegistryProtocolError,
  snapshotServiceInstance,
  snapshotServiceInstances
} from "@likego/registry/provider"

import { canonicalPayload, identityPreimage } from "./canonical"

interface PublisherRecord {
  readonly instance: ServiceInstance
  expiresAt: number
}

type IdentityPublishers = Map<string, PublisherRecord>

/** Validates one finite monotonic cache timestamp. */
function timestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("mDNS cache time must be finite and non-negative")
  }
  return value
}

/** Resolves one logical identity or fails closed on conflicting publishers. */
function logical(records: IdentityPublishers | undefined): ServiceInstance | null {
  if (records === undefined || records.size === 0) return null
  let instance: ServiceInstance | null = null
  let content: string | null = null
  for (const record of records.values()) {
    const candidate = canonicalPayload(record.instance)
    if (content !== null && candidate !== content) {
      throw newRegistryProtocolError("mDNS identity-content collision")
    }
    instance = record.instance
    content = candidate
  }
  return instance
}

/** Reports whether one logical identity changed. */
function changed(before: ServiceInstance | null, after: ServiceInstance | null): boolean {
  if (before === null || after === null) return before !== after
  return canonicalPayload(before) !== canonicalPayload(after)
}

/** Owns decoded publisher records and derives complete logical snapshots. */
export interface MDNSCache {
  /** Observes one publisher's positive or zero-TTL record and returns changed service names. */
  observe(
    publisher: string,
    instance: ServiceInstance,
    ttlSeconds: number,
    nowMs: number
  ): readonly string[]
  /** Expires every publisher record due by a monotonic timestamp. */
  expire(nowMs: number): readonly string[]
  /** Returns complete immutable instances for one name. */
  instances(name: string): readonly ServiceInstance[]
  /** Clears all retained publisher records. */
  close(): void
}

/** Creates one isolated portable mDNS TTL cache. */
export function newMDNSCache(): MDNSCache {
  const identities = new Map<string, IdentityPublishers>()

  return Object.freeze({
    /** Observes one publisher snapshot and returns its changed service name. */
    observe(
      publisher: string,
      value: ServiceInstance,
      ttlSeconds: number,
      nowMs: number
    ): readonly string[] {
      if (typeof publisher !== "string" || publisher.length === 0) {
        throw new TypeError("mDNS cache publisher must be non-empty")
      }
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > 4_294_967) {
        throw new RangeError("mDNS cache TTL is out of range")
      }
      const now = timestamp(nowMs)
      const instance = snapshotServiceInstance(value)
      const identity = identityPreimage(instance)
      let records = identities.get(identity)
      const before = logical(records)
      const previous = records?.get(publisher)
      if (ttlSeconds === 0) {
        if (
          previous === undefined ||
          canonicalPayload(previous.instance) !== canonicalPayload(instance)
        ) {
          return Object.freeze([])
        }
        previous.expiresAt = Math.min(previous.expiresAt, now + 1_000)
        return Object.freeze([])
      }
      const created = records === undefined
      if (records === undefined) {
        records = new Map()
        identities.set(identity, records)
      }
      records.set(publisher, {
        instance,
        expiresAt: now + ttlSeconds * 1_000
      })
      try {
        const after = logical(records)
        return changed(before, after) ? Object.freeze([instance.name]) : Object.freeze([])
      } catch (error) {
        if (previous === undefined) records.delete(publisher)
        else records.set(publisher, previous)
        if (created || records.size === 0) identities.delete(identity)
        throw error
      }
    },
    /** Expires all publisher snapshots due at one monotonic time. */
    expire(nowMs: number): readonly string[] {
      const now = timestamp(nowMs)
      const names = new Set<string>()
      for (const [identity, records] of identities) {
        const before = logical(records)
        for (const [publisher, record] of records) {
          if (record.expiresAt <= now) records.delete(publisher)
        }
        if (records.size === 0) identities.delete(identity)
        const after = logical(records)
        if (changed(before, after) && before !== null) names.add(before.name)
      }
      return Object.freeze(Array.from(names).sort())
    },
    /** Returns logical ServiceInstances for one exact service name. */
    instances(name: string): readonly ServiceInstance[] {
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("mDNS cache service name must be non-empty")
      }
      const instances: ServiceInstance[] = []
      for (const records of identities.values()) {
        const instance = logical(records)
        if (instance !== null && instance.name === name) instances.push(instance)
      }
      return snapshotServiceInstances(instances)
    },
    /** Clears all retained publisher and identity state. */
    close(): void {
      identities.clear()
    }
  })
}
