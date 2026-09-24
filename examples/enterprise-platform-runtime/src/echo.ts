import type { CallOption, Client } from "@go-like/client"
import type { Config } from "@go-like/config"
import type { Context } from "@go-like/context"
import type { Handler, HandlerRegistrar } from "@go-like/server"
import { serviceError } from "@go-like/transport"

import type { RuntimeConfig } from "./config"

export const echoServiceName = "platform.echo"
export const echoEndpointName = "Ping"

export interface EchoClient {
  ping(ctx: Context, ...options: readonly CallOption[]): Promise<string>
}

/** Registers the Echo implementation on one Server owner. */
export function registerEchoHandler(server: HandlerRegistrar, handler: Handler): void {
  server.registerHandler(echoServiceName, echoEndpointName, handler)
}

/** Creates the typed Echo caller while borrowing one common Client owner. */
export function newEchoClient(client: Client): EchoClient {
  return Object.freeze({
    async ping(ctx: Context, ...options: readonly CallOption[]): Promise<string> {
      const response = await client.call(
        ctx,
        {
          service: echoServiceName,
          endpoint: echoEndpointName,
          message: Object.freeze({ header: Object.freeze({}), body: new Uint8Array() })
        },
        ...options
      )
      return new TextDecoder().decode(response.body)
    }
  })
}

/** Creates the business handler without taking transport or lifecycle ownership. */
export function newEchoHandler(
  config: Config<RuntimeConfig>,
  onCall: () => void = () => {}
): Handler {
  if (typeof onCall !== "function") throw new TypeError("onCall must be a function")

  return function ping(_ctx, _request) {
    const release = config.value("release").load()
    if (typeof release !== "number") {
      throw serviceError("unavailable", "runtime configuration is not ready", 503)
    }
    onCall()
    return Object.freeze({
      header: Object.freeze({}),
      body: new TextEncoder().encode(`pong:${release}`)
    })
  }
}
