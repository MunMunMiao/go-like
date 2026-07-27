import { newClient, withAddress, withTransport } from "@likego/client"
import type { Context } from "@likego/context"
import {
  address,
  handler,
  newServer,
  transport as serverTransport,
  type Server
} from "@likego/server"
import { newMemoryTransport } from "@likego/transport-memory"

import { transferQuoteEndpoint } from "./contract"
import {
  newMemoryTransferNetworkDirectory,
  newQuoteTransfer,
  type TransferQuote,
  type TransferQuoteCommand
} from "./service"

const transferAddress = "memory://bank-transfer-gateway"

export interface BankTransferClient {
  quote(ctx: Context, command: TransferQuoteCommand): Promise<TransferQuote>
}

export interface BankTransferMicroservice {
  readonly address: string
  readonly server: Server
  readonly client: BankTransferClient
}

/** Composes a real Client→Server unary exchange over the process-local Memory Transport. */
export function newBankTransferMicroservice(
  sepaCountries: readonly string[]
): BankTransferMicroservice {
  const directory = newMemoryTransferNetworkDirectory(sepaCountries)
  const transport = newMemoryTransport()
  const quote = newQuoteTransfer(directory)
  const transportClient = newClient(withTransport(transport))
  return Object.freeze({
    address: transferAddress,
    server: newServer(
      serverTransport(transport),
      address(transferAddress),
      handler(transferQuoteEndpoint, quote)
    ),
    client: Object.freeze({
      async quote(ctx: Context, command: TransferQuoteCommand): Promise<TransferQuote> {
        return await transportClient.call(
          ctx,
          transferQuoteEndpoint,
          command,
          withAddress(transferAddress)
        )
      }
    })
  })
}
