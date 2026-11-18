import { captureConnection, type Connection } from "./options"

declare const etcdClientBrand: unique symbol

/**
 * Opaque etcd client handle. The runtime brand is the module-private WeakMap in this file;
 * sockets reject any object that newEtcdClient did not create.
 */
export interface EtcdClient {
  readonly [etcdClientBrand]: true
}

/** Connection options previously spread across registry, config, and store. */
export interface EtcdClientOptions {
  readonly fetch: Connection["fetch"]
  /** HTTP(S) origin of the gateway, for example "http://127.0.0.1:2379". */
  readonly address: string
  /** Token from /v3/auth/authenticate, sent unchanged as the Authorization header value (no "Bearer"). */
  readonly token?: string
}

const clients = new WeakMap<EtcdClient, Connection>()

/** Creates the shared etcd client. Invalid address or token throws before any I/O. */
export function newEtcdClient(options: EtcdClientOptions): EtcdClient {
  const connection = captureConnection(options)
  const client = Object.freeze(Object.create(null)) as EtcdClient
  clients.set(client, connection)
  return client
}

/** Returns the connection for a client created by this package. */
export function openEtcdClient(client: EtcdClient): Connection {
  if (typeof client !== "object" || client === null) {
    throw new TypeError("Etcd client must be created by newEtcdClient")
  }
  const connection = clients.get(client)
  if (connection === undefined) {
    throw new TypeError("Etcd client must be created by newEtcdClient")
  }
  return connection
}
