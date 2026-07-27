import { type ServiceInstance } from "@likego/registry"
import { newRegistryProtocolError, snapshotServiceInstances } from "@likego/registry/provider"

import { decodeRecord, type DecodedRecord } from "./codec"
import type { OperationOptions } from "./options"
import type { RangeSnapshot } from "./protocol"

/** Binds one verified wire record to its exact etcd ownership carrier. */
export interface ManagedDecodedRecord extends DecodedRecord {
  readonly key: string
  readonly value: string
  readonly lease: string
}

/** Fully decodes one consistent etcd range snapshot in key order. */
export async function decodeSnapshot(
  options: OperationOptions,
  snapshot: RangeSnapshot
): Promise<readonly ManagedDecodedRecord[]> {
  const records: ManagedDecodedRecord[] = []
  for (const carrier of snapshot.records) {
    const decoded = await decodeRecord(options.prefix, carrier.key, carrier.value)
    records.push(
      Object.freeze({
        key: carrier.key,
        value: carrier.value,
        lease: carrier.lease,
        identity: decoded.identity,
        content: decoded.content,
        instance: decoded.instance
      })
    )
  }
  return Object.freeze(records)
}

/** Converts verified records to one deterministic public replacement snapshot. */
export function instances(
  records: readonly ManagedDecodedRecord[],
  serviceName: string | null = null
): readonly ServiceInstance[] {
  const logical = new Map<string, ManagedDecodedRecord>()
  for (const record of records) {
    if (serviceName !== null && record.instance.name !== serviceName) continue
    const previous = logical.get(record.identity)
    if (previous === undefined) {
      logical.set(record.identity, record)
    } else if (previous.content !== record.content) {
      throw newRegistryProtocolError("etcd ServiceInstance identity collision")
    }
  }
  const values: ServiceInstance[] = []
  for (const record of logical.values()) values.push(record.instance)
  return snapshotServiceInstances(values)
}
