import { newClient, withEndpoint, withTransport, type Client } from "@go-like/client"
import type { Client as TransportClient, Listener, Options, Transport } from "@go-like/transport"

/** Holds one loopback Client and the Requests it fetched. */
export interface LoopbackClient {
  readonly client: Client
  readonly sent: readonly Request[]
}

/** Creates one real go-like Client over an in-memory structural Transport. */
export function newLoopbackClient(
  reply: (request: Request) => Response | Promise<Response>
): LoopbackClient {
  const sent: Request[] = []
  const transport: Transport = {
    init(): void {},
    options(): Options {
      return Object.freeze({
        logger: null,
        timeoutMs: 0,
        secure: false,
        tlsConfig: null
      })
    },
    async dial(): Promise<TransportClient> {
      return {
        async fetch(_ctx, request): Promise<Response> {
          sent.push(request)
          return await reply(request)
        },
        async close(): Promise<void> {}
      }
    },
    async listen(): Promise<Listener> {
      throw new Error("loopback transport does not listen")
    },
    string(): string {
      return "loopback"
    }
  }
  return Object.freeze({
    client: newClient(withTransport(transport), withEndpoint("memory://loopback")),
    sent
  })
}
