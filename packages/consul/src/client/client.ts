import { captureConnection, type Connection } from "./options"

declare const consulClientBrand: unique symbol

/**
 * Opaque Consul client handle. The runtime brand is the module-private WeakMap in this file;
 * sockets reject any object that newConsulClient did not create.
 */
export interface ConsulClient {
  readonly [consulClientBrand]: true
}

/** Connection options previously spread across registry, config, and store. */
export interface ConsulClientOptions {
  readonly fetch: Connection["fetch"]
  /** HTTP(S) origin of the Consul agent, for example "http://127.0.0.1:8500". */
  readonly address: string
  /** ACL token, sent as X-Consul-Token. */
  readonly token?: string
  /** dc query parameter on catalog, health, and KV endpoints (never on agent endpoints). */
  readonly datacenter?: string
  /** ns query parameter (Consul Enterprise). */
  readonly namespace?: string
}

const clients = new WeakMap<ConsulClient, Connection>()

/** Creates the shared Consul client. Invalid address, token, or scope throws before any I/O. */
export function newConsulClient(options: ConsulClientOptions): ConsulClient {
  const connection = captureConnection(options)
  const client = Object.freeze(Object.create(null)) as ConsulClient
  clients.set(client, connection)
  return client
}

/** Returns the connection for a client created by this package. */
export function openConsulClient(client: ConsulClient): Connection {
  if (typeof client !== "object" || client === null) {
    throw new TypeError("Consul client must be created by newConsulClient")
  }
  const connection = clients.get(client)
  if (connection === undefined) {
    throw new TypeError("Consul client must be created by newConsulClient")
  }
  return connection
}
