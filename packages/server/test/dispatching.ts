import { background, type Context } from "@go-like/context"
import type { Client, Listener, Options, Transport, TransportHandler } from "@go-like/transport"

import { newServer, transport, type Server, type ServerOption } from "../src/index"

/** Creates one structural transport around listener. */
function fixtureTransport(listener: Listener): Transport {
  return {
    kind(): string {
      return "http"
    },
    init(): void {},
    options(): Options {
      return Object.freeze({
        logger: null,
        timeoutMs: 0,
        secure: false,
        tlsConfig: null
      })
    },
    dial(): Promise<Client> {
      return Promise.reject(new Error("unused"))
    },
    listen(): Promise<Listener> {
      return Promise.resolve(listener)
    },
    string(): string {
      return "fixture"
    }
  }
}

export interface Dispatching {
  readonly dispatch: TransportHandler
  stop(): Promise<void>
}

/** Starts a Server whose Listener only publishes its dispatcher, so each call picks its own Context. */
export async function dispatching(
  register: (server: Server) => void,
  ...options: readonly ServerOption[]
): Promise<Dispatching> {
  const published = Promise.withResolvers<TransportHandler>()
  const closed = Promise.withResolvers<void>()
  const listener: Listener = {
    addr(): string {
      return "127.0.0.1:43210"
    },
    async close(): Promise<void> {
      closed.resolve()
    },
    async serve(_ctx: Context, handler: TransportHandler): Promise<void> {
      published.resolve(handler)
      await closed.promise
    }
  }
  const server = newServer(transport(fixtureTransport(listener)), ...options)
  register(server)
  const running = server.start(background())
  const dispatch = await published.promise
  return {
    dispatch,
    async stop(): Promise<void> {
      await server.stop(background())
      await running
    }
  }
}
