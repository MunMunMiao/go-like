import { envSource } from "@go-like/core/config"
import { fileSource } from "@go-like/core/config"
import { consulSource } from "@go-like/consul/config"
import { background } from "@go-like/core/context"
import { newConsulClient } from "@go-like/consul"

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
const consul = await consulSource(
  newConsulClient({
    async fetch(request) {
      if (request.redirect !== "error") throw new Error("Consul redirect policy is missing")
      return new Response('{"release":2}', { headers: { "X-Consul-Index": "2" } })
    },
    address: "http://consul"
  }),
  {
    key: "app/config"
  }
).load(ctx)

console.log(JSON.stringify({ env: env.value, file: file.value, consul: consul.value }))
