import type { ConfigSource } from "@go-like/core/config"
import { background } from "@go-like/core/context"

import * as VaultConfig from "../../src/config/index"
import { vaultSource, type VaultSourceOptions } from "../../src/config/index"
import { newVaultClient } from "../../src/index"

const fetch = async function fetchVault(request: Request): Promise<Response> {
  return new Response(request.url)
}
const client = newVaultClient({
  fetch,
  address: "https://vault.example"
})
const options: VaultSourceOptions = {
  mount: "secret",
  path: "applications/orders/config",
  pollIntervalMs: 5_000,
  retryInitialMs: 250,
  retryMaximumMs: 30_000
}
const source: ConfigSource = vaultSource(client, options)
const loaded = source.load(background())
void loaded

// @ts-expect-error A Vault client created by newVaultClient is required.
vaultSource({}, options)
// @ts-expect-error Fetch accepts one standard Request rather than a URL string.
fetch("https://vault.example")
// @ts-expect-error The package has no PascalCase factory alias.
void VaultConfig.VaultSource
