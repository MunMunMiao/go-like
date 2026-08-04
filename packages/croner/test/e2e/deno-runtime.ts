import { background, type Context } from "@go-like/context"
import { newCronerServer } from "@go-like/croner"
import { Cron } from "croner"

Deno.test("built cron package runs native Croner through package names", async () => {
  let ticks = 0
  let resolveTicks: () => void = unavailableResolver
  /** Captures the timer-evidence completion callback. */
  function captureTicks(resolve: () => void): void {
    resolveTicks = resolve
  }
  const twoTicks = new Promise<void>(captureTicks)
  const native: { value: Cron<Context> | null } = { value: null }
  /** Returns the native job after startup transfers it to the Server. */
  function currentNative(): Cron<Context> {
    const value = native.value
    if (value === null) throw new Error("native Cron is unavailable")
    return value
  }
  const server = newCronerServer<Context>(function create(ctx) {
    native.value = new Cron<Context>(
      "* * * * * *",
      {
        paused: true,
        maxRuns: 2,
        catch: true,
        context: ctx
      },
      function tick(_job, callbackCtx): void {
        if (callbackCtx !== ctx) throw new Error("Croner callback Context identity drifted")
        ticks += 1
        if (ticks === 2) resolveTicks()
      }
    )
    return native.value
  })
  const running = server.start(background())
  let deadline: ReturnType<typeof setTimeout> | null = null
  const timed = new Promise<never>(function startDeadline(_resolve, reject) {
    deadline = setTimeout(function timerFailed(): void {
      reject(new Error("Deno Croner timer did not fire twice"))
    }, 4_000)
  })
  try {
    await Promise.race([twoTicks, timed])
  } finally {
    if (deadline !== null) clearTimeout(deadline)
  }
  if (ticks !== 2) throw new Error("unexpected Deno Croner timer delivery count")
  if (currentNative().isRunning() !== false || currentNative().nextRun() !== null) {
    throw new Error("native maxRuns exhaustion did not remain native")
  }
  await server.stop(background())
  await running
  if (currentNative().isStopped() !== true) throw new Error("native Cron did not stop")
})

/** Guards impossible Promise use before its constructor captures the resolver. */
function unavailableResolver(): void {
  throw new Error("timer resolver unavailable")
}
