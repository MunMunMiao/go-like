import { background } from "@go-like/context"
import type { ConfigSource } from "@go-like/config"

import * as ConsulConfig from "../src/index"
import { consulSource, type ConsulFetch, type ConsulSourceOptions } from "../src/index"

const fetch: ConsulFetch = async function fetchConsul(request: Request): Promise<Response> {
  return new Response(request.url, { headers: { "X-Consul-Index": "1" } })
}
const options: ConsulSourceOptions = {
  fetch,
  address: "https://consul.example",
  key: "app/config",
  retryInitialMs: 250,
  retryMaximumMs: 30_000
}
const source: ConfigSource = consulSource(options)
const loaded = source.load(background())
void loaded

// @ts-expect-error Standard Fetch capability is explicit and required.
consulSource({ address: "https://consul.example", key: "app/config" })
// @ts-expect-error Fetch accepts exactly one standard Request at the application boundary.
fetch("https://consul.example")
// @ts-expect-error The package has no PascalCase factory alias.
ConsulConfig.ConsulSource
