import { describe, expect, test } from "bun:test"

import { background, withCancelCause, type Context } from "@likego/context"
import type { ConfigSourceWatcher } from "../src/index"
import { newConfig, onReloadError, onTerminalError, source, objectSource } from "../src/index"
import {
  controlledWatcher,
  deferred,
  flush,
  startConfig,
  waitForConfigReady,
  waitForEvent,
  type Deferred
} from "./helpers"

describe("config lifecycle", () => {
  test("returns from load after sources, watchers, and the first value are ready", async () => {
    const order: string[] = []
    const nextCalls: Deferred<void>[] = []
    const closed = deferred<void>()
    const stops: string[] = []
    const watcher = controlledWatcher({
      nextCalls,
      done: closed,
      stops,
      name: "watched"
    })
    let loads = 0
    const config = newConfig(
      source({
        name: "watched",
        async load() {
          loads += 1
          order.push(`load:${loads}`)
          return { value: { loads }, revision: `r${loads}` }
        },
        async watch(_ctx, revision) {
          order.push(`watch:${revision}`)
          return watcher
        }
      })
    )

    const loaded = config.load(background())
    const lifecycle = await waitForConfigReady(config, loaded)
    order.push(`ready:${nextCalls.length}`)
    expect(order).toEqual(["load:1", "watch:r1", "ready:1"])
    expect(config.value("loads").load()).toBe(1)

    await expect(loaded).resolves.toBeUndefined()
    await lifecycle.close(background())
    expect(stops).toEqual(["watched"])
  })

  test("turns a change retained across the load/watch gap into one post-start reload", async () => {
    let loads = 0
    let firstNext = true
    const pendingNext = deferred<void>()
    const watcher: ConfigSourceWatcher = {
      next(ctx) {
        if (firstNext) {
          firstNext = false
          return Promise.resolve()
        }
        return waitForEvent(ctx, pendingNext.promise)
      },
      async stop() {}
    }
    const config = newConfig(
      source({
        name: "gap",
        async load() {
          loads += 1
          return { value: { loads }, revision: String(loads) }
        },
        async watch() {
          return watcher
        }
      })
    )

    const lifecycle = await startConfig(config)
    await flush(10)
    expect(config.value("loads").load()).toBe(2)
    await lifecycle.close(background())
  })

  test("wraps watch failures and malformed watcher capabilities at their exact phase", async () => {
    const watchFailure = new Error("sync watch failed")
    const syncWatch = newConfig(
      source({
        name: "sync-watch",
        async load() {
          return { value: {}, revision: null }
        },
        watch() {
          throw watchFailure
        }
      })
    )
    await expect(syncWatch.load(background())).rejects.toMatchObject({
      phase: "watch",
      cause: watchFailure
    })

    const getterFailure = new Error("watcher getter failed")
    const throwingWatcher = Object.create(null)
    Object.defineProperty(throwingWatcher, "next", {
      get() {
        throw getterFailure
      }
    })
    Object.defineProperty(throwingWatcher, "stop", {
      value: async function stop(): Promise<void> {}
    })
    const getterConfig = newConfig(
      source({
        name: "getter-watch",
        async load() {
          return { value: {}, revision: null }
        },
        async watch() {
          return throwingWatcher
        }
      })
    )
    await expect(getterConfig.load(background())).rejects.toMatchObject({
      phase: "watch",
      cause: getterFailure
    })

    const malformedConfig = newConfig(
      source({
        name: "malformed-watch",
        async load() {
          return { value: {}, revision: null }
        },
        async watch() {
          return JSON.parse("{}")
        }
      })
    )
    await expect(malformedConfig.load(background())).rejects.toMatchObject({ phase: "watch" })
  })

  test("stops a provisionally accepted malformed watcher", async () => {
    const getterFailure = new Error("next capture failed")
    let stops = 0
    const accepted = Object.defineProperties(
      {},
      {
        next: {
          get() {
            throw getterFailure
          }
        },
        stop: {
          value: async function stopAccepted(): Promise<void> {
            stops += 1
          }
        }
      }
    )
    const config = newConfig(
      source({
        name: "provisional",
        async load() {
          return { value: {}, revision: "one" }
        },
        async watch() {
          return accepted as ConfigSourceWatcher
        }
      })
    )

    await expect(config.load(background())).rejects.toMatchObject({
      phase: "watch",
      cause: getterFailure
    })
    expect(stops).toBe(1)
  })

  test("preserves provisional watcher stop getter and call failures", async () => {
    const nextFailure = new Error("invalid next")
    const getterFailure = new Error("stop getter failed")
    const getterWatcher = Object.defineProperties(
      {},
      {
        next: {
          get() {
            throw nextFailure
          }
        },
        stop: {
          get() {
            throw getterFailure
          }
        }
      }
    )
    const getterConfig = newConfig(
      source({
        name: "getter-cleanup",
        async load() {
          return { value: {}, revision: null }
        },
        async watch() {
          return getterWatcher as ConfigSourceWatcher
        }
      })
    )
    const getterResult = await getterConfig.load(background()).catch((error: unknown) => error)
    if (!(getterResult instanceof AggregateError)) throw new Error("expected getter aggregate")
    expect(getterResult.errors[0]).toMatchObject({ phase: "watch", cause: nextFailure })
    expect(getterResult.errors[1]).toMatchObject({ phase: "stop", cause: getterFailure })

    const callFailure = new Error("stop call failed")
    const callConfig = newConfig(
      source({
        name: "call-cleanup",
        async load() {
          return { value: {}, revision: null }
        },
        async watch() {
          return {
            next: 1,
            async stop() {
              throw callFailure
            }
          } as unknown as ConfigSourceWatcher
        }
      })
    )
    const callResult = await callConfig.load(background()).catch((error: unknown) => error)
    if (!(callResult instanceof AggregateError)) throw new Error("expected call aggregate")
    expect(callResult.errors[0]).toMatchObject({ phase: "watch" })
    expect(callResult.errors[1]).toMatchObject({ phase: "stop", cause: callFailure })
  })

  test("rolls opened watchers back in reverse order and keeps startup failure primary", async () => {
    const order: string[] = []
    const primary = new Error("third watch failed")
    const cleanup = new Error("second stop failed")
    function startupWatcher(name: string, stopFailure: Error | null): ConfigSourceWatcher {
      return {
        next() {
          return new Promise<void>(function neverSettles() {})
        },
        async stop() {
          order.push(name)
          if (stopFailure !== null) throw stopFailure
        }
      }
    }
    const config = newConfig(
      source(
        {
          name: "first",
          async load() {
            return { value: {}, revision: "a" }
          },
          async watch() {
            return startupWatcher("first", null)
          }
        },
        {
          name: "second",
          async load() {
            return { value: {}, revision: "b" }
          },
          async watch() {
            return startupWatcher("second", cleanup)
          }
        },
        {
          name: "third",
          async load() {
            return { value: {}, revision: "c" }
          },
          async watch() {
            throw primary
          }
        }
      )
    )

    const failure = await config.load(background()).catch((error: unknown) => error)
    expect(order).toEqual(["second", "first"])
    if (!(failure instanceof AggregateError)) throw new Error("expected aggregate startup failure")
    expect(failure.errors[0]).toMatchObject({ phase: "watch", cause: primary })
    expect(failure.errors[1]).toMatchObject({ phase: "stop", cause: cleanup })
    await expect(config.load(background())).rejects.toMatchObject({ status: "failed" })
  })

  test("detaches an accepted startup Context from private runtime ownership", async () => {
    const nextCalls: Deferred<void>[] = []
    const watcher = controlledWatcher({
      nextCalls,
      done: deferred<void>(),
      stops: [],
      name: "detached"
    })
    const [startup, cancelStartup] = withCancelCause(background())
    let loads = 0
    const config = newConfig(
      source({
        name: "detached",
        async load() {
          loads += 1
          return { value: { loads }, revision: String(loads) }
        },
        async watch() {
          return watcher
        }
      })
    )
    const loaded = config.load(startup)
    const lifecycle = await waitForConfigReady(config, loaded)
    cancelStartup(new Error("original startup owner ended"))
    nextCalls[0]?.resolve(undefined)
    await flush(8)
    expect(config.value("loads").load()).toBe(2)
    await lifecycle.close(background())
  })

  test("drains watchers in reverse order and keeps close idempotent", async () => {
    const stops: string[] = []
    const first = { nextCalls: [], done: deferred<void>(), stops, name: "first" }
    const second = { nextCalls: [], done: deferred<void>(), stops, name: "second" }
    const config = newConfig(
      source(
        {
          name: "first",
          async load() {
            return { value: {}, revision: null }
          },
          async watch() {
            return controlledWatcher(first)
          }
        },
        {
          name: "second",
          async load() {
            return { value: {}, revision: null }
          },
          async watch() {
            return controlledWatcher(second)
          }
        }
      )
    )
    const lifecycle = await startConfig(config)
    const firstStop = lifecycle.close(background())
    const secondStop = lifecycle.close(background())
    await Promise.all([firstStop, secondStop])
    expect(stops).toEqual(["second", "first"])
    await expect(config.load(background())).rejects.toMatchObject({ status: "closed" })
  })

  test("lets one close waiter cancel while owner drain remains joinable", async () => {
    const stopOperation = deferred<void>()
    const next = deferred<void>()
    const watcher: ConfigSourceWatcher = {
      next(ctx) {
        return waitForEvent(ctx, next.promise)
      },
      async stop() {
        await stopOperation.promise
      }
    }
    const config = newConfig(
      source({
        name: "slow-stop",
        async load() {
          return { value: {}, revision: null }
        },
        async watch() {
          return watcher
        }
      })
    )
    const lifecycle = await startConfig(config)
    const cancellation = new Error("stop waiter canceled")
    const [caller, cancelCaller] = withCancelCause(background())
    const first = lifecycle.close(caller)
    cancelCaller(cancellation)
    await expect(first).rejects.toBe(cancellation)
    const joined = lifecycle.close(background())
    stopOperation.resolve(undefined)
    await expect(joined).resolves.toBeUndefined()
  })

  test("makes watcher next failure terminal after reverse drain", async () => {
    const nextFailure = new Error("next failed")
    const pendingNext = deferred<void>()
    let stops = 0
    const watcher: ConfigSourceWatcher = {
      next() {
        return pendingNext.promise
      },
      async stop() {
        stops += 1
      }
    }
    const config = newConfig(
      source({
        name: "next-terminal",
        async load() {
          return { value: {}, revision: null }
        },
        async watch() {
          return watcher
        }
      })
    )
    const lifecycle = await startConfig(config)
    pendingNext.reject(nextFailure)
    await expect(lifecycle.done()).rejects.toMatchObject({ phase: "next", cause: nextFailure })
    expect(stops).toBe(1)
  })

  test("publishes one terminal error before watcher drain and preserves last-good state", async () => {
    const nextFailure = new Error("terminal next failed")
    const pendingNext = deferred<void>()
    const events: string[] = []
    const terminalErrors: Error[] = []
    const terminalReported = deferred<Error>()
    let reloadErrors = 0
    const config = newConfig(
      source({
        name: "terminal-notification",
        async load() {
          return { value: { ready: true }, revision: "one" }
        },
        async watch() {
          return {
            next() {
              return pendingNext.promise
            },
            async stop() {
              events.push("stop")
            }
          }
        }
      }),
      onReloadError(() => {
        reloadErrors += 1
      }),
      onTerminalError((error) => {
        events.push("terminal")
        terminalErrors.push(error)
        terminalReported.resolve(error)
      })
    )
    const lifecycle = await startConfig(config)
    const lastGood = config.value("ready").load()

    pendingNext.reject(nextFailure)
    const reported = await terminalReported.promise
    const failure = await lifecycle.close(background()).catch((error: unknown) => error)
    if (!(failure instanceof Error)) throw new Error("terminal close must reject with Error")

    expect(events).toEqual(["terminal", "stop"])
    expect(terminalErrors).toHaveLength(1)
    expect(reported).toBe(failure)
    expect(terminalErrors[0]).toBe(failure)
    expect(failure).toMatchObject({ phase: "next", cause: nextFailure })
    expect(config.value("ready").load()).toBe(lastGood)
    expect(reloadErrors).toBe(0)
  })

  test("keeps the reported next failure primary when watcher cleanup also fails", async () => {
    const nextFailure = new Error("terminal next failed")
    const stopFailure = new Error("terminal stop failed")
    const pendingNext = deferred<void>()
    const reported = deferred<Error>()
    let reports = 0
    const config = newConfig(
      source({
        name: "terminal-aggregate",
        async load() {
          return { value: {}, revision: null }
        },
        async watch() {
          return {
            next() {
              return pendingNext.promise
            },
            async stop() {
              throw stopFailure
            }
          }
        }
      }),
      onTerminalError((error) => {
        reports += 1
        reported.resolve(error)
      })
    )
    const lifecycle = await startConfig(config)

    pendingNext.reject(nextFailure)
    const primary = await reported.promise
    const failure = await lifecycle.close(background()).catch((error: unknown) => error)
    if (!(failure instanceof AggregateError)) throw new Error("expected terminal failure aggregate")

    expect(reports).toBe(1)
    expect(primary).toMatchObject({ phase: "next", cause: nextFailure })
    expect(failure.errors[0]).toBe(primary)
    expect(failure.errors[1]).toMatchObject({ phase: "stop", cause: stopFailure })
  })

  test("isolates terminal handler throws and rejected thenables without unhandled rejection", async () => {
    const unhandled: unknown[] = []
    const observeUnhandled = (error: unknown): void => {
      unhandled.push(error)
    }
    process.on("unhandledRejection", observeUnhandled)
    try {
      for (const mode of ["throw", "reject"] as const) {
        const nextFailure = new Error(`${mode} next failed`)
        const handlerFailure = new Error(`${mode} handler failed`)
        const pendingNext = deferred<void>()
        const stopEntered = deferred<void>()
        let handlerCalls = 0
        const config = newConfig(
          source({
            name: `${mode}-terminal-handler`,
            async load() {
              return { value: {}, revision: null }
            },
            async watch() {
              return {
                next() {
                  return pendingNext.promise
                },
                async stop() {
                  stopEntered.resolve(undefined)
                }
              }
            }
          }),
          onTerminalError(() => {
            handlerCalls += 1
            if (mode === "throw") throw handlerFailure
            return Promise.reject(handlerFailure)
          })
        )
        const lifecycle = await startConfig(config)
        pendingNext.reject(nextFailure)
        await stopEntered.promise
        await expect(lifecycle.close(background())).rejects.toMatchObject({
          phase: "next",
          cause: nextFailure
        })
        expect(handlerCalls).toBe(1)
      }
      await flush()
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", observeUnhandled)
    }
  })

  test("retains concurrent watcher failures observed before initial readiness", async () => {
    const firstFailure = new Error("first next failed")
    const secondFailure = new Error("second next failed")
    let stops = 0
    let terminalReports = 0
    const config = newConfig(
      source(
        {
          name: "first-terminal",
          async load() {
            return { value: {}, revision: null }
          },
          async watch() {
            return {
              async next() {
                throw firstFailure
              },
              async stop() {
                stops += 1
              }
            }
          }
        },
        {
          name: "second-terminal",
          async load() {
            return { value: {}, revision: null }
          },
          async watch() {
            return {
              async next() {
                throw secondFailure
              },
              async stop() {
                stops += 1
              }
            }
          }
        }
      ),
      onTerminalError(() => {
        terminalReports += 1
      })
    )

    const failure = await config.load(background()).catch((error: unknown) => error)
    if (!(failure instanceof AggregateError)) throw new Error("expected watcher failure aggregate")
    expect(failure.errors).toHaveLength(2)
    expect(failure.errors[0]).toMatchObject({ phase: "next", cause: firstFailure })
    expect(failure.errors[1]).toMatchObject({ phase: "next", cause: secondFailure })
    expect(stops).toBe(2)
    expect(terminalReports).toBe(0)
  })

  test("reports one terminal and retains concurrent watcher failures after readiness", async () => {
    const firstFailure = new Error("first loaded next failed")
    const secondFailure = new Error("second loaded next failed")
    const firstNext = deferred<void>()
    const secondNext = deferred<void>()
    const reported = deferred<Error>()
    let reports = 0
    let stops = 0
    const config = newConfig(
      source(
        {
          name: "first-loaded-terminal",
          async load() {
            return { value: {}, revision: null }
          },
          async watch() {
            return {
              next() {
                return firstNext.promise
              },
              async stop() {
                stops += 1
              }
            }
          }
        },
        {
          name: "second-loaded-terminal",
          async load() {
            return { value: {}, revision: null }
          },
          async watch() {
            return {
              next() {
                return secondNext.promise
              },
              async stop() {
                stops += 1
              }
            }
          }
        }
      ),
      onTerminalError((error) => {
        reports += 1
        reported.resolve(error)
      })
    )
    const lifecycle = await startConfig(config)

    firstNext.reject(firstFailure)
    secondNext.reject(secondFailure)
    const primary = await reported.promise
    const failure = await lifecycle.close(background()).catch((error: unknown) => error)
    if (!(failure instanceof AggregateError)) throw new Error("expected watcher failure aggregate")

    expect(reports).toBe(1)
    expect(stops).toBe(2)
    expect(primary).toMatchObject({ phase: "next", cause: firstFailure })
    expect(failure.errors).toHaveLength(2)
    expect(failure.errors[0]).toBe(primary)
    expect(failure.errors[1]).toMatchObject({ phase: "next", cause: secondFailure })
  })

  test("reports watcher stop failure through close", async () => {
    const stopFailure = new Error("stop cleanup failed")
    const pending = deferred<void>()
    const watcher: ConfigSourceWatcher = {
      next(ctx) {
        return waitForEvent(ctx, pending.promise)
      },
      async stop() {
        throw stopFailure
      }
    }
    const config = newConfig(
      source({
        name: "loaded-cleanup",
        async load() {
          return { value: {}, revision: null }
        },
        async watch() {
          return watcher
        }
      })
    )
    const lifecycle = await startConfig(config)
    await expect(lifecycle.close(background())).rejects.toMatchObject({
      phase: "stop",
      cause: stopFailure
    })
    await expect(lifecycle.done()).rejects.toMatchObject({
      phase: "stop",
      cause: stopFailure
    })
  })

  test("enforces one-shot load through loading, loaded, closing, and failure", async () => {
    const opening = deferred<ConfigSourceWatcher>()
    const next = deferred<void>()
    const closing = deferred<void>()
    const watcher: ConfigSourceWatcher = {
      next(ctx) {
        return waitForEvent(ctx, next.promise)
      },
      async stop() {
        await closing.promise
      }
    }
    const config = newConfig(
      source({
        name: "one-shot",
        async load() {
          return { value: {}, revision: null }
        },
        watch() {
          return opening.promise
        }
      })
    )
    const loaded = config.load(background())
    await flush()
    await expect(config.load(background())).rejects.toMatchObject({ status: "loading" })
    opening.resolve(watcher)
    const lifecycle = await waitForConfigReady(config, loaded)
    await expect(config.load(background())).rejects.toMatchObject({ status: "loaded" })
    const stop = lifecycle.close(background())
    await expect(config.load(background())).rejects.toMatchObject({ status: "closing" })
    closing.resolve(undefined)
    await stop

    const failed = newConfig(
      source({
        name: "failed",
        async load() {
          throw new Error("startup failed")
        }
      })
    )
    await expect(failed.load(background())).rejects.toMatchObject({ phase: "load" })
    await expect(failed.load(background())).rejects.toMatchObject({ status: "failed" })
  })

  test("closes an initial load that is still opening its watcher", async () => {
    const opening = deferred<void>()
    const config = newConfig(
      source({
        name: "opening",
        async load() {
          return { value: {}, revision: null }
        },
        watch(ctx) {
          return waitForEvent(ctx, opening.promise).then(
            function unreachable(): ConfigSourceWatcher {
              throw new Error("watch should have been canceled")
            }
          )
        }
      })
    )
    const loaded = config.load(background())
    await flush()
    await expect(config.close(background())).resolves.toBeUndefined()
    await expect(loaded).resolves.toBeUndefined()
  })

  test("honors close requested by a watcher as private runtime ownership begins", async () => {
    let closing: Promise<void> | null = null
    let config: ReturnType<typeof newConfig>
    config = newConfig(
      source({
        name: "watcher-stop",
        async load() {
          return { value: { ready: true }, revision: null }
        },
        async watch() {
          return {
            next(ctx) {
              const waiting = waitForEvent(ctx, new Promise<void>(function neverSettles() {}))
              closing = config.close(background())
              return waiting
            },
            async stop() {}
          }
        }
      })
    )

    const loaded = config.load(background())
    while (closing === null) await Bun.sleep(1)
    await expect(closing).resolves.toBeUndefined()
    await expect(loaded).resolves.toBeUndefined()
  })

  test("supports sources without watcher capabilities", async () => {
    const config = newConfig(source(objectSource("plain", { ready: true })))
    const lifecycle = await startConfig(config)
    expect(config.value("ready").load()).toBe(true)
    await lifecycle.close(background())
    await expect(lifecycle.done()).resolves.toBeUndefined()
  })

  test("a pre-canceled first load claims one-shot status without touching sources", async () => {
    let calls = 0
    const config = newConfig(
      source({
        name: "pre-canceled",
        async load() {
          calls += 1
          return { value: {}, revision: null }
        }
      })
    )
    const cancellation = new Error("pre-canceled startup")
    const [ctx, cancel] = withCancelCause(background())
    cancel(cancellation)
    await expect(config.load(ctx)).rejects.toBe(cancellation)
    expect(calls).toBe(0)
    await expect(config.load(background())).rejects.toMatchObject({ status: "failed" })
  })

  test("returns a rejected Promise when initial Context inspection throws", async () => {
    const failure = new Error("Context inspection failed")
    const hostile: Context = {
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done() {
        return null
      },
      err(): null {
        throw failure
      },
      value() {
        return undefined
      }
    }
    let calls = 0
    const config = newConfig(
      source({
        name: "hostile-context",
        async load() {
          calls += 1
          return { value: {}, revision: null }
        }
      })
    )

    const loaded = config.load(hostile)
    expect(loaded).toBeInstanceOf(Promise)
    await expect(loaded).rejects.toBe(failure)
    expect(calls).toBe(0)
    await expect(config.load(background())).rejects.toMatchObject({ status: "failed" })
  })
})
