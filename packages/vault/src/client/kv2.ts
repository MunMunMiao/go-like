import type { VaultOperation } from "./errors"

/** Store wire operations before the shared error prefix is applied. */
export type VaultStoreWireOperation = "read" | "write" | "delete" | "list"

/** Config reads, including watch polls, share one operation at the error boundary. */
export const configReadOperation: VaultOperation = "config.read"

/** Prefixes a store wire operation at the shared error boundary. */
export function storeOperation(operation: VaultStoreWireOperation): VaultOperation {
  if (operation === "read") return "store.read"
  if (operation === "write") return "store.write"
  if (operation === "delete") return "store.delete"
  return "store.list"
}

/** Joins an already-encoded KV v2 mount, role, and suffix. */
export function vaultKvPath(
  mount: string,
  role: "data" | "delete" | "metadata",
  suffix: string
): string {
  return `/v1/${mount}/${role}/${suffix}`
}
