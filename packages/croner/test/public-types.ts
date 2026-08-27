import { background, type Context } from "@go-like/context"
import type { Server } from "@go-like/core"
import { Cron } from "croner"

import * as CronerPackage from "../src/index"
import { newCronerServer, type CronerFactory, type CronerServer } from "../src/index"

const factory: CronerFactory<Context> = function create(ctx) {
  return new Cron<Context>(
    "* * * * * *",
    {
      paused: true,
      context: ctx,
      catch: true
    },
    async function run(native, callbackCtx): Promise<void> {
      const first: Context = callbackCtx
      const job: Cron<Context> = native
      void [first, job]
    }
  )
}
const cron: CronerServer = newCronerServer(factory)
const structural: Server = cron
const running: Promise<void> = cron.start(background())

async function stopServer(server: Server): Promise<void> {
  await server.stop(background())
}

void [structural, running, stopServer]

// @ts-expect-error Croner Server is a structural value, not a constructable class.
new cron()
// @ts-expect-error Context is the independent first argument for start.
cron.start()
// @ts-expect-error Factory must synchronously return one or more native Cron instances.
newCronerServer(() => null)
// @ts-expect-error Async factories cross the native startup acceptance boundary.
newCronerServer(async function asyncFactory(ctx: Context) {
  return factory(ctx)
})
// @ts-expect-error Removed managed job facade is not exported.
void CronerPackage.CronerJob
// @ts-expect-error Removed managed handle facade is not exported.
void CronerPackage.CronerHandle
