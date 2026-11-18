import { newVaultClient, type VaultClient, type VaultClientOptions } from "../../src/index"
import * as root from "../../src/index"

const fetch = async function fetchVault(request: Request): Promise<Response> {
  return new Response(request.url)
}
const options: VaultClientOptions = {
  fetch,
  address: "https://vault.example",
  token: "token",
  namespace: "platform"
}
const client: VaultClient = newVaultClient(options)
void client

// @ts-expect-error Standard Fetch injection is required.
newVaultClient({ address: "https://vault.example" })
// @ts-expect-error Fetch accepts one standard Request rather than a URL string.
fetch("https://vault.example")
// @ts-expect-error The root has no PascalCase client alias.
void root.VaultClient
