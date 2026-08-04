import { expect, test } from "bun:test"

import { name, newApp, registrar, server } from "@go-like/core"
import { newNodeServer } from "@go-like/web/node"

test("Core clean stop during Node Web startup does not surface cancellation", async () => {
  const app = newApp(
    name("orders"),
    registrar({
      async register() {},
      async deregister() {}
    }),
    server(newNodeServer(() => new Response("ok")))
  )
  const running = app.run()
  await Promise.resolve()
  const stopping = app.stop()

  await expect(stopping).resolves.toBeUndefined()
  await expect(running).resolves.toBeUndefined()
})
