import { type ServiceInstance } from "@go-like/registry"
import { newRegistryProtocolError, snapshotServiceInstances } from "@go-like/registry/provider"

import type { DecodedRecord } from "./codec"

/** Converts verified records to one deterministic immutable instance snapshot. */
export function instances(
  records: readonly DecodedRecord[],
  name: string | null = null
): readonly ServiceInstance[] {
  const values: ServiceInstance[] = []
  const identities = new Set<string>()
  for (const record of records) {
    if (name !== null && record.instance.name !== name) continue
    if (identities.has(record.identity)) {
      throw newRegistryProtocolError("ZooKeeper snapshot contains a duplicate service identity")
    }
    identities.add(record.identity)
    values.push(record.instance)
  }
  return snapshotServiceInstances(values)
}
