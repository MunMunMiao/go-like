import { background } from "@go-like/core/context"
import type { ConfigSource } from "@go-like/core/config"

import * as ConsulConfig from "../../src/config/index"
import { consulSource, type ConsulSourceOptions } from "../../src/config/index"
import { newConsulClient } from "../../src/index"

const fetch = async function fetchConsul(request: Request): Promise<Response> {
  return new Response(request.url, { headers: { "X-Consul-Index": "1" } })
}
const client = newConsulClient({
  fetch,
  address: "https://consul.example"
})
const options: ConsulSourceOptions = {
  key: "app/config",
  retryInitialMs: 250,
  retryMaximumMs: 30_000
}
const source: ConfigSource = consulSource(client, options)
const loaded = source.load(background())
void loaded

// @ts-expect-error Standard Fetch capability is explicit and required.
newConsulClient({ address: "https://consul.example" })
// @ts-expect-error Fetch accepts exactly one standard Request at the application boundary.
fetch("https://consul.example")
// @ts-expect-error The package has no PascalCase factory alias.
void ConsulConfig.ConsulSource
