import type { ConfigSource } from "@go-like/config"
import { background } from "@go-like/context"

import * as VaultConfig from "../src/index"
import {
  vaultSource,
  type VaultFetch,
  type VaultHttpError,
  type VaultProtocolError,
  type VaultSourceOptions,
  type VaultTransportError
} from "../src/index"

const fetch: VaultFetch = async function fetchVault(request: Request): Promise<Response> {
  return new Response(request.url)
}
const options: VaultSourceOptions = {
  fetch,
  address: "https://vault.example",
  mount: "secret",
  path: "applications/orders/config",
  pollIntervalMs: 5_000,
  retryInitialMs: 250,
  retryMaximumMs: 30_000
}
const source: ConfigSource = vaultSource(options)
const loaded = source.load(background())
const httpError: VaultHttpError | null = null
const protocolError: VaultProtocolError | null = null
const transportError: VaultTransportError | null = null
void [loaded, httpError, protocolError, transportError]

// @ts-expect-error Standard Fetch injection is required.
vaultSource({ address: "https://vault.example", mount: "secret", path: "app/config" })
// @ts-expect-error Fetch accepts one standard Request rather than a URL string.
fetch("https://vault.example")
// @ts-expect-error The package has no PascalCase factory alias.
void VaultConfig.VaultSource
