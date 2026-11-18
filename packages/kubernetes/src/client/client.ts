import { captureConnection, type Connection } from "./options"

declare const kubernetesClientBrand: unique symbol

/**
 * Opaque Kubernetes client handle. The runtime brand is the module-private WeakMap in this file;
 * sockets reject any object that newKubernetesClient did not create.
 */
export interface KubernetesClient {
  readonly [kubernetesClientBrand]: true
}

/** Connection options previously spread across registry and config. */
export interface KubernetesClientOptions {
  readonly fetch: Connection["fetch"]
  /** HTTP(S) origin of the API server, for example "https://kubernetes.default.svc". */
  readonly address: string
  /** ServiceAccount token, sent as Authorization: Bearer <token>. */
  readonly token?: string
}

const clients = new WeakMap<KubernetesClient, Connection>()

/** Creates the shared Kubernetes client. Invalid address or token throws before any I/O. */
export function newKubernetesClient(options: KubernetesClientOptions): KubernetesClient {
  const connection = captureConnection(options)
  const client = Object.freeze(Object.create(null)) as KubernetesClient
  clients.set(client, connection)
  return client
}

/** Returns the connection for a client created by this package. */
export function openKubernetesClient(client: KubernetesClient): Connection {
  if (typeof client !== "object" || client === null) {
    throw new TypeError("Kubernetes client must be created by newKubernetesClient")
  }
  const connection = clients.get(client)
  if (connection === undefined) {
    throw new TypeError("Kubernetes client must be created by newKubernetesClient")
  }
  return connection
}
