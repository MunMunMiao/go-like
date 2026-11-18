import { openEtcdClient, type EtcdClient } from "../client/client"
import type { Fetch } from "@go-like/core/fetch"

/** Contains one immutable construction-time etcd Store snapshot. */
export interface CapturedOptions {
  readonly fetch: Fetch
  readonly origin: string
  readonly token: string | undefined
}

/** Captures the shared client once, without starting network I/O. */
export function captureOptions(client: EtcdClient): CapturedOptions {
  const connection = openEtcdClient(client)
  return Object.freeze({
    fetch: connection.fetch,
    origin: connection.origin,
    token: connection.token
  })
}
