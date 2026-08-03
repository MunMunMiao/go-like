import assert from "node:assert/strict"

import { background, type Context } from "@likego/context"
import { newCronerServer } from "@likego/croner"
import { Cron } from "croner"

const native: { value: Cron<Context> | null } = { value: null }
/** Returns the native job after startup transfers it to the Server. */
function currentNative(): Cron<Context> {
  const value = native.value
  if (value === null) throw new Error("native Cron is unavailable")
  return value
}
const server = newCronerServer<Context>(function create(ctx) {
  native.value = new Cron<Context>(
    "0 0 0 1 1 * 2099",
    {
      paused: true,
      context: ctx,
      catch: true
    },
    function noOp(_job, callbackCtx): void {
      assert.equal(callbackCtx, ctx)
    }
  )
  return native.value
})
assert.deepEqual(Object.keys(await import("@likego/croner")), ["newCronerServer"])
assert.equal(native.value, null)
const running = server.start(background())
await Promise.resolve()
assert.equal(currentNative().isRunning(), true)
await server.stop(background())
await running
assert.equal(currentNative().isStopped(), true)
