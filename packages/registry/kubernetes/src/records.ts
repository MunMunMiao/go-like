import { type ServiceInstance } from "@likego/registry"
import { newRegistryProtocolError, snapshotServiceInstances } from "@likego/registry/provider"

import type { ManagedSlice } from "./codec"

/** Deduplicates managed identities and fails closed on disagreeing content. */
export function logicalRecords(
  records: readonly ManagedSlice[]
): ReadonlyMap<string, ManagedSlice> {
  const logical = new Map<string, ManagedSlice>()
  for (const record of records) {
    const prior = logical.get(record.identity)
    if (prior === undefined) logical.set(record.identity, record)
    else if (prior.content !== record.content) {
      throw newRegistryProtocolError("Kubernetes duplicate managed identity disagrees")
    }
  }
  return logical
}

/** Converts verified records into one deterministic replacement snapshot. */
export function instances(
  records: readonly ManagedSlice[],
  name: string | null
): readonly ServiceInstance[] {
  const values: ServiceInstance[] = []
  for (const record of logicalRecords(records).values()) {
    if (name === null || record.instance.name === name) values.push(record.instance)
  }
  return snapshotServiceInstances(values)
}

/** Reports whether two complete replacement snapshots have identical canonical bytes. */
export function sameSnapshot(
  left: readonly ServiceInstance[],
  right: readonly ServiceInstance[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
