import { newClient, withTransport, type Client } from "@go-like/client"
import type {
  Client as TransportClient,
  Listener,
  Message,
  Options,
  Transport
} from "@go-like/transport"

export interface LoopbackClient {
  readonly client: Client
  readonly sent: readonly Message[]
}

/** Creates one real go-like Client over an in-memory structural Transport. */
export function newLoopbackClient(
  reply: (request: Message) => Message | PromiseLike<Message>
): LoopbackClient {
  const sent: Message[] = []
  const transport: Transport = {
    init(): void {},
    options(): Options {
      return Object.freeze({
        codec: null,
        logger: null,
        timeoutMs: 0,
        secure: false,
        tlsConfig: null
      })
    },
    async dial(): Promise<TransportClient> {
      let request: Message | null = null
      return {
        async send(_ctx, message): Promise<void> {
          request = message
          sent.push(message)
        },
        async recv(): Promise<Message> {
          if (request === null) throw new Error("loopback receive requires a request")
          return await reply(request)
        },
        async close(): Promise<void> {},
        local(): string {
          return "loopback-client"
        },
        remote(): string {
          return "loopback-server"
        }
      }
    },
    async listen(): Promise<Listener> {
      throw new Error("loopback transport does not listen")
    },
    string(): string {
      return "loopback"
    }
  }
  return Object.freeze({ client: newClient(withTransport(transport)), sent })
}
