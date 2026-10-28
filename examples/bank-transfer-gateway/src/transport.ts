import { newClient, withEndpoint, withTransport } from "@go-like/client"
import type { Server } from "@go-like/server"
import { address, newServer, transport as serverTransport } from "@go-like/server"
import type { ServiceClient } from "@go-like/transport"
import { newMemoryTransport } from "@go-like/transport-memory"

import { bankTransfer } from "./contract"
import { newMemoryTransferNetworkDirectory, newQuoteTransfer } from "./service"

const transferAddress = "memory://bank-transfer-gateway"

export interface BankTransferMicroservice {
  readonly address: string
  readonly server: Server
  readonly client: ServiceClient<typeof bankTransfer>
}

/** Composes a Client to Server quote exchange over the process-local Memory Transport. */
export function newBankTransferMicroservice(
  sepaCountries: readonly string[]
): BankTransferMicroservice {
  const directory = newMemoryTransferNetworkDirectory(sepaCountries)
  const transport = newMemoryTransport()
  const quote = newQuoteTransfer(directory)
  const connection = newClient(withEndpoint(transferAddress), withTransport(transport))
  const server = newServer(serverTransport(transport), address(transferAddress))
  bankTransfer.registerHandler(server, { quote })
  return Object.freeze({
    address: transferAddress,
    server,
    client: bankTransfer.newClient(connection)
  })
}
