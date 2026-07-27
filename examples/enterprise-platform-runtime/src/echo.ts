import type { Config } from "@likego/config"
import type { Handler } from "@likego/server"
import { serviceError } from "@likego/transport"

import type { RuntimeConfig } from "./config"

export const echoServiceName = "platform.echo"
export const echoEndpointName = "Ping"

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
