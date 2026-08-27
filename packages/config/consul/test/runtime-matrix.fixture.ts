import { envSource } from "@go-like/config/env"
import { fileSource } from "@go-like/config/file"
import { consulSource } from "@go-like/config-consul"
import { background } from "@go-like/context"

const ctx = background()
const env = await envSource({ APP_HTTP__PORT: "8080" }, { prefix: "APP_" }).load(ctx)
const file = await fileSource(
  {
    async read() {
      return { text: '{"enabled":true}', revision: "1" }
    }
  },
  "config.json"
).load(ctx)
const consul = await consulSource({
  async fetch(request) {
    if (request.redirect !== "error") throw new Error("Consul redirect policy is missing")
    return new Response('{"release":2}', { headers: { "X-Consul-Index": "2" } })
  },
  address: "http://consul",
  key: "app/config"
}).load(ctx)

console.log(JSON.stringify({ env: env.value, file: file.value, consul: consul.value }))
