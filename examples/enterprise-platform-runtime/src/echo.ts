import type { Config } from "@go-like/config"
import type { Context } from "@go-like/context"
import { serviceError, type ServiceHandler } from "@go-like/transport"

import type { RuntimeConfig } from "./config"
import { echoService } from "./contract"

export { echoService } from "./contract"

/** Discovery and route name of the internal echo service. */
export const echoServiceName = echoService.name

/** Route token of the internal echo operation. */
export const echoEndpointName = echoService.endpoints.ping.endpoint

/** Creates the business handler without taking transport or lifecycle ownership. */
export function newEchoHandler(
  config: Config<RuntimeConfig>,
  onCall: () => void = () => {}
): ServiceHandler<typeof echoService> {
  if (typeof onCall !== "function") throw new TypeError("onCall must be a function")

  return Object.freeze({
    ping(_ctx: Context): string {
      const release = config.value("release").load()
      if (typeof release !== "number") {
        throw serviceError("unavailable", "runtime configuration is not ready", 503)
      }
      onCall()
      return `pong:${release}`
    }
  })
}
