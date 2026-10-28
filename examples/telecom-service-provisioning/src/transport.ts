import { newClient, withEndpoint, withTransport } from "@go-like/client"
import { address, newServer, transport as serverTransport, type Server } from "@go-like/server"
import type { ServiceClient } from "@go-like/transport"
import { newMemoryTransport } from "@go-like/transport-memory"

import { telecomProvisioning } from "./contract"
import type { ProvisionTelecomService } from "./service"

const serviceAddress = "memory://telecom-service-provisioning"

/** Owns the in-process provisioning Server and its generated caller. */
export interface TelecomProvisioningMicroservice {
  readonly server: Server
  readonly client: ServiceClient<typeof telecomProvisioning>
}

/** Composes an internal unary telecom service over the real Memory Transport provider. */
export function newTelecomProvisioningMicroservice(
  provision: ProvisionTelecomService
): TelecomProvisioningMicroservice {
  const transport = newMemoryTransport()
  const connection = newClient(withTransport(transport), withEndpoint(serviceAddress))
  const server = newServer(serverTransport(transport), address(serviceAddress))
  telecomProvisioning.registerHandler(server, { activate: provision })
  return Object.freeze({
    server,
    client: telecomProvisioning.newClient(connection)
  })
}
