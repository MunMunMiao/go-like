import { newRegistryProtocolError } from "@likego/registry/provider"

import {
  decodeManagedSlice,
  decodeSliceList,
  managedByLabel,
  managedByValue,
  type ManagedSlice,
  type SliceSnapshot
} from "./codec"
import { json, notFound, response } from "./http"
import type { OperationOptions } from "./options"

/** Returns the target namespace's EndpointSlice collection path. */
function collection(options: OperationOptions): string {
  return `/apis/discovery.k8s.io/v1/namespaces/${options.namespace}/endpointslices`
}

/** Returns one exact EndpointSlice path beneath the configured namespace. */
function exact(options: OperationOptions, name: string): string {
  return `${collection(options)}/${encodeURIComponent(name)}`
}

/** Creates the canonical LikeGo-managed label selector. */
function selector(): string {
  return `${managedByLabel}=${managedByValue}`
}

/** Reads all LikeGo-managed slices in one consistent namespace snapshot. */
export async function listSlices(
  options: OperationOptions,
  signal: AbortSignal
): Promise<SliceSnapshot> {
  const query = new URLSearchParams({ labelSelector: selector() })
  const value = await json(options, "list", `${collection(options)}?${query}`, "GET", null, signal)
  return await decodeSliceList(value, options.namespace)
}

/** Reads one exact slice, preserving foreign objects for collision protection. */
export async function getSlice(
  options: OperationOptions,
  name: string,
  signal: AbortSignal
): Promise<ManagedSlice | "foreign" | null> {
  let value: unknown
  try {
    value = await json(options, "get", exact(options, name), "GET", null, signal)
  } catch (error) {
    if (notFound(error)) return null
    throw error
  }
  const decoded = await decodeManagedSlice(value, options.namespace)
  return decoded ?? "foreign"
}

/** Creates one canonical EndpointSlice and verifies the returned managed object. */
export async function createSlice(
  options: OperationOptions,
  body: string,
  signal: AbortSignal
): Promise<ManagedSlice> {
  const value = await json(options, "create", collection(options), "POST", body, signal)
  const decoded = await decodeManagedSlice(value, options.namespace)
  if (decoded === null) {
    throw newRegistryProtocolError("Kubernetes create returned a foreign EndpointSlice")
  }
  return decoded
}

/** Replaces one exact EndpointSlice under metadata.resourceVersion CAS. */
export async function updateSlice(
  options: OperationOptions,
  name: string,
  body: string,
  signal: AbortSignal
): Promise<ManagedSlice> {
  const value = await json(options, "update", exact(options, name), "PUT", body, signal)
  const decoded = await decodeManagedSlice(value, options.namespace)
  if (decoded === null) {
    throw newRegistryProtocolError("Kubernetes update returned a foreign EndpointSlice")
  }
  return decoded
}

/** Deletes one exact EndpointSlice under a resourceVersion precondition. */
export async function deleteSlice(
  options: OperationOptions,
  name: string,
  resourceVersion: string,
  signal: AbortSignal
): Promise<void> {
  const body = JSON.stringify({
    apiVersion: "v1",
    kind: "DeleteOptions",
    preconditions: { resourceVersion }
  })
  await json(options, "delete", exact(options, name), "DELETE", body, signal)
}

/** Opens one namespace-scoped managed EndpointSlice watch from an exact list revision. */
export function watchSlices(
  options: OperationOptions,
  resourceVersion: string,
  signal: AbortSignal
): Promise<Response> {
  const query = new URLSearchParams({
    watch: "true",
    allowWatchBookmarks: "true",
    timeoutSeconds: String(options.watchTimeoutSeconds),
    resourceVersion,
    labelSelector: selector()
  })
  return response(options, "watch", `${collection(options)}?${query}`, "GET", null, signal)
}
