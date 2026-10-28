import {
  decodePathSegment,
  decodeRecord,
  servicePath,
  servicesPath,
  type DecodedRecord,
  type EncodedRecord
} from "./codec"
import { isNoNode, isNotEmpty } from "./errors"
import type { OperationOptions } from "./options"
import type { ZookeeperChildren, ZookeeperClient } from "./types"

/** Reads children through either a plain or one-shot-watch boundary. */
export interface ChildReader {
  (path: string): Promise<ZookeeperChildren>
}

/** Ensures all persistent parents required for one record exist. */
export async function ensureParents(
  client: ZookeeperClient,
  options: OperationOptions,
  record: EncodedRecord,
  signal: AbortSignal
): Promise<void> {
  await client.mkdirp(servicesPath(options.root), signal)
  await client.mkdirp(record.servicePath, signal)
}

/** Reads one child list while tolerating concurrent parent removal. */
async function optionalChildren(
  reader: ChildReader,
  path: string
): Promise<ZookeeperChildren | null> {
  try {
    return await reader(path)
  } catch (value) {
    if (isNoNode(value)) return null
    throw value
  }
}

/** Reads one instance while tolerating concurrent ephemeral deletion. */
async function optionalRecord(
  client: ZookeeperClient,
  options: OperationOptions,
  path: string,
  signal: AbortSignal
): Promise<DecodedRecord | null> {
  try {
    return decodeRecord(options.root, path, await client.data(path, signal))
  } catch (value) {
    if (isNoNode(value)) return null
    throw value
  }
}

/** Reads every instance below one exact service directory. */
export async function readServiceRecords(
  client: ZookeeperClient,
  options: OperationOptions,
  name: string,
  signal: AbortSignal,
  childReader?: ChildReader
): Promise<readonly DecodedRecord[]> {
  const parent = servicePath(options.root, name)
  const reader =
    childReader ??
    function children(path: string): Promise<ZookeeperChildren> {
      return client.children(path, signal)
    }
  const children = await optionalChildren(reader, parent)
  if (children === null) return Object.freeze([])
  const records: DecodedRecord[] = []
  for (const segment of children.names) {
    decodePathSegment(segment)
    const path = `${parent}/${segment}`
    const record = await optionalRecord(client, options, path, signal)
    if (record !== null) records.push(record)
  }
  records.sort((left, right) => Number(left.path > right.path) - Number(left.path < right.path))
  return Object.freeze(records)
}

/** Removes an empty service parent without touching non-empty or absent paths. */
export async function pruneServiceParent(
  client: ZookeeperClient,
  record: EncodedRecord,
  signal: AbortSignal
): Promise<void> {
  try {
    await client.remove(record.servicePath, signal)
  } catch (value) {
    if (!isNotEmpty(value) && !isNoNode(value)) throw value
  }
}
