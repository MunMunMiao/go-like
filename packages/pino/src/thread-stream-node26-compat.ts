import type { Transferable } from "node:worker_threads"

/** Restores the exact alias still referenced by ThreadStream 4.2.0 declarations. */
declare module "node:worker_threads" {
  type TransferListItem = Transferable
}
