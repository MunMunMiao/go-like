import {
  newClient,
  withAddress,
  withTransport,
  type CallOption,
  type Client
} from "@go-like/client"
import type { Context } from "@go-like/context"
import {
  address,
  newServer,
  transport as serverTransport,
  type HandlerRegistrar,
  type Server
} from "@go-like/server"
import { newMemoryTransport } from "@go-like/transport-memory"

import { transferQuoteEndpoint, type TransferQuote, type TransferQuoteCommand } from "./contract"
import { newMemoryTransferNetworkDirectory, newQuoteTransfer, type QuoteTransfer } from "./service"

const transferAddress = "memory://bank-transfer-gateway"

export interface BankTransferClient {
  quote(
    ctx: Context,
    command: TransferQuoteCommand,
    ...options: readonly CallOption[]
  ): Promise<TransferQuote>
}

export interface BankTransferMicroservice {
  readonly address: string
  readonly server: Server
  readonly client: BankTransferClient
}

/** Registers the bank-transfer quote implementation on one Server owner. */
export function registerTransferQuoteHandler(
  server: HandlerRegistrar,
  handler: QuoteTransfer
): void {
  server.registerHandler(transferQuoteEndpoint, handler)
}

/** Creates the typed bank-transfer caller while borrowing one common Client owner. */
export function newBankTransferClient(client: Client): BankTransferClient {
  return Object.freeze({
    async quote(
      ctx: Context,
      command: TransferQuoteCommand,
      ...options: readonly CallOption[]
    ): Promise<TransferQuote> {
      return await client.call(ctx, transferQuoteEndpoint, command, ...options)
    }
  })
}

/** Composes a real Client→Server unary exchange over the process-local Memory Transport. */
export function newBankTransferMicroservice(
  sepaCountries: readonly string[]
): BankTransferMicroservice {
  const directory = newMemoryTransferNetworkDirectory(sepaCountries)
  const transport = newMemoryTransport()
  const quote = newQuoteTransfer(directory)
  const client = newClient(withTransport(transport), withAddress(transferAddress))
  const server = newServer(serverTransport(transport), address(transferAddress))
  registerTransferQuoteHandler(server, quote)
  return Object.freeze({
    address: transferAddress,
    server,
    client: newBankTransferClient(client)
  })
}
