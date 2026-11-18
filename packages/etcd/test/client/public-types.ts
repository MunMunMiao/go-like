import {
  newEtcdClient,
  type EtcdClient,
  type EtcdClientOptions,
  type EtcdHttpError,
  type EtcdOperation,
  type EtcdProtocolError,
  type EtcdTransportError
} from "../../src/index"

const fetchCapability: EtcdClientOptions["fetch"] = async function fetchCapability(
  _request: Request
): Promise<Response> {
  return new Response(null)
}

const client: EtcdClient = newEtcdClient({
  fetch: fetchCapability,
  address: "https://etcd.example",
  token: "token"
})

declare const operation: EtcdOperation
declare const http: EtcdHttpError
declare const protocol: EtcdProtocolError
declare const transport: EtcdTransportError

// @ts-expect-error Fetch must return a Promise
const syncFetch: EtcdClientOptions["fetch"] = () => new Response()

void [client, operation, http, protocol, transport, syncFetch]
