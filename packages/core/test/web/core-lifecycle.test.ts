import { expect, test } from "bun:test"

import { name, newApp, registrar, server } from "../../src"
import { newNodeServer } from "../../src/web/node"

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
