import { describe, expect, test } from "bun:test"

import { background, withCancelCause, type Context } from "@go-like/context"
import {
  fileSource,
  jsonFileDecoder,
  type FileCapability,
  type FileChangeListener,
  type FileWatcher
} from "../src/file"
import { deferred } from "./file-helpers"

describe("file configuration source", () => {
  test("loads a complete JSON object with the capability revision and receiver", async () => {
    const capability = {
      root: "/srv/app",
      /** Reads one deployment document through the capability receiver. */
      read(_ctx: Context, path: string) {
        return Promise.resolve({
          text: `{"path":"${this.root}${path}","enabled":true}`,
          revision: "mtime:42"
        })
      }
    }
    const source = fileSource(capability, "/config.json", { name: "application-file" })

    expect(await source.load(background())).toEqual({
      value: { path: "/srv/app/config.json", enabled: true },
      revision: "mtime:42"
    })
    expect(source.name).toBe("application-file")
    expect(source.watch).toBeUndefined()
  })

  test("supports a custom format decoder while isolating the decoded document", async () => {
    const supplied = { database: { port: 5432 } }
    const source = fileSource(
      {
        /** Returns a format-neutral file result. */
        async read() {
          return { text: "port=5432", revision: null }
        }
      },
      "settings.toml",
      {
        /** Decodes the controlled TOML fixture. */
        decode(text, path) {
          expect([text, path]).toEqual(["port=5432", "settings.toml"])
          return supplied
        }
      }
    )
    const snapshot = await source.load(background())
    supplied.database.port = 9000
    expect(snapshot).toEqual({ value: { database: { port: 5432 } }, revision: null })
    expect(Object.isFrozen(snapshot.value)).toBe(true)
  })

  test("retains a startup-gap event and coalesces bursts around one pending next", async () => {
    const done = deferred<void>()
    const stops: string[] = []
    let notify: FileChangeListener = missingNotify
    const subscription: FileWatcher = {
      /** Records ownership transfer shutdown. */
      async stop() {
        stops.push("stopped")
        done.resolve(undefined)
      },
      /** Returns the stable native subscription terminal barrier. */
      done() {
        return done.promise
      }
    }
    const capability: FileCapability = {
      /** Returns the current controlled file. */
      async read() {
        return { text: "{}", revision: "r1" }
      },
      /** Captures change delivery and emits one event before watch acceptance. */
      async watch(_ctx, _path, listener) {
        notify = listener
        listener()
        listener()
        return subscription
      }
    }
    const source = fileSource(capability, "config.json")
    const watcher = await source.watch?.(background(), "r1")
    if (watcher === undefined) throw new Error("watcher missing")

    await expect(watcher.next(background())).resolves.toBeUndefined()
    const pending = watcher.next(background())
    notify()
    notify()
    await expect(pending).resolves.toBeUndefined()
    await expect(watcher.next(background())).resolves.toBeUndefined()
    await watcher.stop(background())
    expect(stops).toEqual(["stopped"])
  })

  test("reconciles the candidate revision after native watch admission", async () => {
    const done = deferred<void>()
    const source = fileSource(
      {
        /** Returns the revision observed after the native watcher is active. */
        async read() {
          return { text: "{}", revision: "r2" }
        },
        /** Opens a quiet watcher so revision reconciliation supplies the notification. */
        async watch() {
          return {
            /** Releases the native terminal barrier. */
            async stop() {
              done.resolve(undefined)
            },
            /** Returns the native terminal barrier. */
            done() {
              return done.promise
            }
          }
        }
      },
      "config.json"
    )
    const watcher = await source.watch?.(background(), "r1")
    if (watcher === undefined) throw new Error("watcher missing")

    await expect(watcher.next(background())).resolves.toBeUndefined()
    await watcher.stop(background())
  })

  test("rolls back a native watcher when revision reconciliation fails", async () => {
    const failure = new Error("reconciliation read failed")
    let stops = 0
    const source = fileSource(
      {
        /** Rejects the post-watch reconciliation read. */
        async read() {
          throw failure
        },
        /** Transfers one watcher that must be rolled back. */
        async watch() {
          return {
            /** Records watcher rollback. */
            async stop() {
              stops += 1
            },
            /** Reports an already-complete native terminal. */
            done() {
              return Promise.resolve()
            }
          }
        }
      },
      "config.json"
    )

    await expect(source.watch?.(background(), "r1")).rejects.toBe(failure)
    expect(stops).toBe(1)
  })

  test("keeps Context inspection failure primary during revision reconciliation", async () => {
    const inspectionFailure = new Error("reconciliation Context inspection failed")
    let inspections = 0
    let stops = 0
    const ctx: Context = {
      deadline() {
        return [new Date(0), false]
      },
      done() {
        return null
      },
      err(): null {
        inspections += 1
        if (inspections > 2) throw inspectionFailure
        return null
      },
      value() {
        return undefined
      }
    }
    const source = fileSource(
      {
        async read() {
          throw new Error("reconciliation read failed")
        },
        async watch() {
          return {
            async stop() {
              stops += 1
            },
            done() {
              return Promise.resolve()
            }
          }
        }
      },
      "config.json"
    )

    await expect(source.watch?.(ctx, "r1")).rejects.toBe(inspectionFailure)
    expect(stops).toBe(1)
  })

  test("surfaces a passive native watcher rejection through next and stop", async () => {
    const terminal = deferred<void>()
    const failure = new Error("native watcher failed")
    const source = fileSource(
      {
        async read() {
          return { text: "{}", revision: null }
        },
        async watch() {
          return {
            async stop() {},
            done() {
              return terminal.promise
            }
          }
        }
      },
      "config.json"
    )
    const watcher = await source.watch?.(background(), null)
    if (watcher === undefined) throw new Error("watcher missing")
    const pending = watcher.next(background())
    terminal.reject(failure)
    await expect(pending).rejects.toBe(failure)
    await expect(watcher.stop(background())).rejects.toBe(failure)
  })

  test("lets a pre-canceled Context win without consuming one retained dirty event", async () => {
    const done = deferred<void>()
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "r1" }
        },
        /** Emits one retained change before transferring the native handle. */
        async watch(_ctx, _path, changed) {
          changed()
          return {
            /** Releases the native terminal barrier. */
            async stop() {
              done.resolve(undefined)
            },
            /** Returns the stable native terminal barrier. */
            done() {
              return done.promise
            }
          }
        }
      },
      "config.json"
    )
    const watcher = await source.watch?.(background(), "r1")
    if (watcher === undefined) throw new Error("watcher missing")
    const reason = new Error("pre-canceled dirty wait")
    const [ctx, cancel] = withCancelCause(background())
    cancel(reason)

    await expect(watcher.next(ctx)).rejects.toBe(reason)
    await expect(watcher.next(background())).resolves.toBeUndefined()
    await watcher.stop(background())
  })

  test("cancels a pending next with the exact Context cause and rejects concurrent waits", async () => {
    const done = deferred<void>()
    const source = fileSource(
      {
        /** Returns the current controlled file. */
        async read() {
          return { text: "{}", revision: "r1" }
        },
        /** Opens a quiet subscription for cancellation behavior. */
        async watch() {
          return {
            /** Resolves the subscription on stop. */
            async stop() {
              done.resolve(undefined)
            },
            /** Returns the controlled subscription barrier. */
            done() {
              return done.promise
            }
          }
        }
      },
      "config.json"
    )
    const watcher = await source.watch?.(background(), "r1")
    if (watcher === undefined) throw new Error("watcher missing")
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("request abandoned")
    const pending = watcher.next(ctx)
    await expect(watcher.next(background())).rejects.toThrow("already waiting")
    cancel(reason)
    await expect(pending).rejects.toBe(reason)
    await watcher.stop(background())
  })

  test("returns malformed Context inspection as a rejected next promise", async () => {
    const done = deferred<void>()
    const failure = new Error("Context inspection failed")
    const malformed: Context = {
      /** Returns an absent deadline. */
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      /** Returns an uncancelable signal boundary. */
      done() {
        return null
      },
      /** Fails the required pre-consumption Context inspection. */
      err(): null {
        throw failure
      },
      /** Returns no Context value. */
      value() {
        return undefined
      }
    }
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "1" }
        },
        /** Opens a quiet native watcher. */
        async watch() {
          return {
            /** Releases the native terminal barrier. */
            async stop() {
              done.resolve(undefined)
            },
            /** Returns the native terminal barrier. */
            done() {
              return done.promise
            }
          }
        }
      },
      "config.json"
    )
    const watcher = await source.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")

    await expect(watcher.next(malformed)).rejects.toBe(failure)
    await watcher.stop(background())
  })

  test("rejects pre-canceled load and watch without invoking runtime capabilities", async () => {
    let reads = 0
    let watches = 0
    const source = fileSource(
      {
        /** Records an unexpected pre-canceled read invocation. */
        async read() {
          reads += 1
          return { text: "{}", revision: "1" }
        },
        /** Records an unexpected pre-canceled watch invocation. */
        async watch() {
          watches += 1
          return {
            async stop() {},
            done() {
              return Promise.resolve()
            }
          }
        }
      },
      "config.json"
    )
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("operation canceled")
    cancel(reason)

    await expect(source.load(ctx)).rejects.toBe(reason)
    await expect(source.watch?.(ctx, "1")).rejects.toBe(reason)
    expect({ reads, watches }).toEqual({ reads: 0, watches: 0 })
  })

  test("rolls back a handle when Context cancels during watch acceptance", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("watch acceptance canceled")
    let stops = 0
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "1" }
        },
        /** Cancels acceptance immediately before transferring the native handle. */
        async watch() {
          cancel(reason)
          return {
            /** Rolls back the transferred subscription. */
            async stop() {
              stops += 1
            },
            /** Returns the native terminal barrier. */
            done() {
              return Promise.resolve()
            }
          }
        }
      },
      "config.json"
    )

    await expect(source.watch?.(ctx, "1")).rejects.toBe(reason)
    expect(stops).toBe(1)
  })

  test("captures and awaits delayed rejected done during acceptance rollback", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const primary = new Error("watch acceptance canceled")
    const doneFailure = new Error("native done failed")
    const terminal = deferred<void>()
    let stops = 0
    let doneCalls = 0
    let settled = false
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "1" }
        },
        /** Cancels after transferring a handle with a delayed failing terminal barrier. */
        async watch() {
          cancel(primary)
          return {
            /** Starts native rollback without settling its terminal barrier. */
            async stop() {
              stops += 1
            },
            /** Returns the delayed terminal barrier rollback must observe. */
            done() {
              doneCalls += 1
              return terminal.promise
            }
          }
        }
      },
      "config.json"
    )

    const watching = source.watch?.(ctx, "1").catch(function capture(error: unknown) {
      return error
    })
    if (watching === undefined) throw new Error("watch promise missing")
    void watching.then(function observeSettlement() {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect({ stops, doneCalls, settled }).toEqual({ stops: 1, doneCalls: 1, settled: false })
    terminal.reject(doneFailure)
    const failure = await watching
    if (!(failure instanceof AggregateError)) throw new Error("expected rollback aggregate")
    expect(failure.errors).toEqual([primary, doneFailure])
  })

  test("keeps stop failure before an already-observed done failure", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const primary = new Error("watch acceptance canceled")
    const stopFailure = new Error("native stop failed")
    const doneFailure = new Error("native done failed")
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "1" }
        },
        /** Cancels after transferring a handle whose independent cleanup phases reject. */
        async watch() {
          cancel(primary)
          return {
            /** Rejects the first cleanup phase. */
            async stop() {
              throw stopFailure
            },
            /** Returns an already-rejected second cleanup phase. */
            done() {
              return Promise.reject(doneFailure)
            }
          }
        }
      },
      "config.json"
    )

    const failure = await source.watch?.(ctx, "1").catch(function capture(error: unknown) {
      return error
    })
    if (!(failure instanceof AggregateError)) throw new Error("expected ordered rollback aggregate")
    expect(failure.errors).toEqual([primary, stopFailure, doneFailure])
  })

  test("aggregates both rollback getter failures after the acceptance cause", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const primary = new Error("acceptance canceled")
    const doneFailure = new Error("done getter failed")
    const stopFailure = new Error("stop getter failed")
    const handle = Object.defineProperties(
      {},
      {
        done: {
          /** Rejects terminal capability capture during rollback. */
          get() {
            throw doneFailure
          }
        },
        stop: {
          /** Rejects stop capability capture during rollback. */
          get() {
            throw stopFailure
          }
        }
      }
    )
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "1" }
        },
        /** Cancels after transferring the getter-failing native handle. */
        async watch() {
          cancel(primary)
          return handle as FileWatcher
        }
      },
      "config.json"
    )

    const failure = await source.watch?.(ctx, "1").catch(function capture(error: unknown) {
      return error
    })
    if (!(failure instanceof AggregateError)) throw new Error("expected getter rollback aggregate")
    expect(failure.errors).toEqual([primary, stopFailure, doneFailure])
  })

  test("prefers exact Context cause when an ignored-cancel capability returns malformed data", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("read canceled")
    const source = fileSource(
      {
        /** Cancels the read and returns a malformed value that must not replace the cause. */
        async read() {
          cancel(reason)
          return JSON.parse('{"text":1,"revision":null}')
        }
      },
      "config.json"
    )

    await expect(source.load(ctx)).rejects.toBe(reason)
  })

  test("prefers exact Context cause when watch capability rejects after cancellation", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("watch canceled")
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "1" }
        },
        /** Cancels and rejects with a transport detail that must not replace Context cause. */
        async watch() {
          cancel(reason)
          throw new Error("native watch failed")
        }
      },
      "config.json"
    )

    await expect(source.watch?.(ctx, "1")).rejects.toBe(reason)
  })

  test("rolls back an accepted handle when post-acceptance Context inspection fails", async () => {
    const failure = new Error("Context inspection failed")
    let inspections = 0
    let stops = 0
    const ctx: Context = {
      /** Returns an absent deadline. */
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      /** Returns an uncancelable signal boundary. */
      done() {
        return null
      },
      /** Succeeds before capability invocation and fails after handle transfer. */
      err(): null {
        inspections += 1
        if (inspections > 1) throw failure
        return null
      },
      /** Returns no Context value. */
      value() {
        return undefined
      }
    }
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "1" }
        },
        /** Transfers one controlled native handle. */
        async watch() {
          return {
            /** Records acceptance rollback. */
            async stop() {
              stops += 1
            },
            /** Returns the native terminal barrier. */
            done() {
              return Promise.resolve()
            }
          }
        }
      },
      "config.json"
    )

    await expect(source.watch?.(ctx, "1")).rejects.toBe(failure)
    expect(stops).toBe(1)
  })

  test("validates file results, JSON roots, options, and watch handles", async () => {
    expect(() => jsonFileDecoder("[]", "config.json")).toThrow("JSON object")
    expect(() => jsonFileDecoder("{", "config.json")).toThrow()
    expect(() =>
      fileSource(
        {
          read: async function read() {
            return { text: "{}", revision: null }
          }
        },
        ""
      )
    ).toThrow("file path")
    expect(() =>
      fileSource(
        {
          read: async function read() {
            return { text: "{}", revision: null }
          }
        },
        "x",
        { name: "" }
      )
    ).toThrow("source name")

    const malformed = fileSource(
      {
        /** Returns a malformed revision across the runtime capability boundary. */
        async read() {
          return JSON.parse('{"text":"{}","revision":1}')
        }
      },
      "config.json"
    )
    await expect(malformed.load(background())).rejects.toThrow("file read result")

    const malformedWatch = fileSource(
      {
        /** Returns a valid empty document. */
        async read() {
          return { text: "{}", revision: null }
        },
        /** Returns a structurally malformed subscription. */
        async watch() {
          return JSON.parse("{}")
        }
      },
      "config.json"
    )
    await expect(malformedWatch.watch?.(background(), null)).rejects.toThrow("file watcher")
  })

  test("decodes the complete JSON value domain and rejects unsafe JSON keys", () => {
    expect(jsonFileDecoder('{"values":[null,true,7,"text",{"nested":[]}]}', "config.json")).toEqual(
      { values: [null, true, 7, "text", { nested: [] }] }
    )
    expect(() => jsonFileDecoder('{"__proto__":"bad"}', "config.json")).toThrow("JSON object")
    expect(() => jsonFileDecoder("null", "config.json")).toThrow("JSON object")
    expect(() => jsonFileDecoder("7", "config.json")).toThrow("JSON object")
  })

  test("makes stop idempotent and ignores notifications after ownership shutdown", async () => {
    const done = deferred<void>()
    let notify: FileChangeListener = missingNotify
    let stops = 0
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "1" }
        },
        /** Captures a notification and an idempotent subscription stop. */
        async watch(_ctx, _path, changed) {
          notify = changed
          return {
            /** Stops the native subscription once. */
            async stop() {
              stops += 1
              done.resolve(undefined)
            },
            /** Returns the native terminal barrier. */
            done() {
              return done.promise
            }
          }
        }
      },
      "config.json"
    )
    const watcher = await source.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")
    await watcher.stop(background())
    notify()
    await watcher.stop(background())
    await expect(watcher.next(background())).rejects.toThrow("stopped")
    expect(stops).toBe(1)
  })

  test("starts one owner shutdown even when the first stop caller is already canceled", async () => {
    const shutdown = deferred<void>()
    const terminal = deferred<void>()
    const stopContexts: Context[] = []
    let stops = 0
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "1" }
        },
        /** Opens a controlled subscription with a delayed owner shutdown. */
        async watch() {
          return {
            /** Records and blocks the single owner-scoped shutdown. */
            async stop(ctx) {
              stops += 1
              stopContexts.push(ctx)
              await shutdown.promise
              terminal.resolve(undefined)
            },
            /** Returns the native terminal barrier. */
            done() {
              return terminal.promise
            }
          }
        }
      },
      "config.json"
    )
    const watcher = await source.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")
    const [caller, cancel] = withCancelCause(background())
    const reason = new Error("stop caller canceled")
    cancel(reason)

    await expect(watcher.stop(caller)).rejects.toBe(reason)
    expect(stops).toBe(1)
    expect(stopContexts[0]?.err()).toBeNull()
    let joined = false
    const second = watcher.stop(background()).then(function observeJoin() {
      joined = true
    })
    await Promise.resolve()
    expect(joined).toBe(false)
    shutdown.resolve(undefined)
    await second
    expect(stops).toBe(1)
  })

  test("retains one stable owner failure when native stop throws synchronously", async () => {
    const failure = new Error("native stop failed")
    let stops = 0
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "1" }
        },
        /** Opens a subscription with a synchronously failing owner stop primitive. */
        async watch() {
          return {
            /** Reports the same native shutdown failure to the accepted owner. */
            stop(): Promise<void> {
              stops += 1
              throw failure
            },
            /** Reports that the native resource already reached its terminal barrier. */
            done() {
              return Promise.resolve()
            }
          }
        }
      },
      "config.json"
    )
    const watcher = await source.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")

    await expect(watcher.stop(background())).rejects.toBe(failure)
    await expect(watcher.stop(background())).rejects.toBe(failure)
    expect(stops).toBe(1)
  })

  test("retains a reentrant change emitted while accepting the native done barrier", async () => {
    const done = deferred<void>()
    let notify: FileChangeListener = missingNotify
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "1" }
        },
        /** Returns a handle whose done capture reentrantly emits a change. */
        async watch(_ctx, _path, changed) {
          notify = changed
          return {
            /** Stops the native subscription. */
            async stop() {
              done.resolve(undefined)
            },
            /** Emits during acceptance before returning the stable barrier. */
            done() {
              notify()
              return done.promise
            }
          }
        }
      },
      "config.json"
    )
    const watcher = await source.watch?.(background(), "1")
    if (watcher === undefined) throw new Error("watcher missing")
    await expect(watcher.next(background())).resolves.toBeUndefined()
    await watcher.stop(background())
  })

  test("rejects acceptance and rolls back when native done capture throws synchronously", async () => {
    const failure = new Error("native done failed")
    let stops = 0
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "1" }
        },
        /** Transfers a subscription whose terminal observer fails during capture. */
        async watch() {
          return {
            /** Releases the already-transferred native subscription. */
            async stop() {
              stops += 1
            },
            /** Reports the synchronous native terminal observation failure. */
            done(): Promise<void> {
              throw failure
            }
          }
        }
      },
      "config.json"
    )

    await expect(source.watch?.(background(), "1")).rejects.toBe(failure)
    expect(stops).toBe(1)
  })

  test("aggregates acceptance and rollback failures without losing either cause", async () => {
    const acceptanceFailure = new Error("native done failed")
    const rollbackFailure = new Error("native rollback failed")
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "1" }
        },
        /** Transfers a handle that fails both acceptance and cleanup. */
        async watch() {
          return {
            /** Fails rollback after ownership already transferred. */
            async stop() {
              throw rollbackFailure
            },
            /** Fails synchronous terminal capture before publication. */
            done(): Promise<void> {
              throw acceptanceFailure
            }
          }
        }
      },
      "config.json"
    )

    const failure = await source.watch?.(background(), "1").catch(function capture(error: unknown) {
      return error
    })
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure).toMatchObject({ errors: [acceptanceFailure, rollbackFailure] })
  })

  test("best-effort stops an accepted handle when its stop property first throws", async () => {
    const failure = new Error("stop capture failed")
    let reads = 0
    let stops = 0
    const handle = Object.defineProperties(
      {},
      {
        stop: {
          enumerable: true,
          /** Fails the acceptance read and exposes cleanup on the rollback read. */
          get() {
            reads += 1
            if (reads === 1) throw failure
            return async function stopAccepted(): Promise<void> {
              stops += 1
            }
          }
        },
        done: {
          enumerable: true,
          value() {
            return Promise.resolve()
          }
        }
      }
    )
    const source = fileSource(
      {
        /** Returns one empty document. */
        async read() {
          return { text: "{}", revision: "1" }
        },
        /** Transfers the controlled malformed handle. */
        async watch() {
          return handle as FileWatcher
        }
      },
      "config.json"
    )

    await expect(source.watch?.(background(), "1")).rejects.toBe(failure)
    expect(stops).toBe(1)
  })

  test("rejects malformed capability and decoder boundaries at construction", () => {
    expect(() => fileSource(JSON.parse("null"), "config.json")).toThrow("capability")
    expect(() => fileSource(JSON.parse("{}"), "config.json")).toThrow("capability")
    expect(() =>
      fileSource(
        {
          /** Provides the required read operation for option validation. */
          async read() {
            return { text: "{}", revision: null }
          }
        },
        "config.json",
        { decode: JSON.parse('"no"') }
      )
    ).toThrow("decoder")
  })
})

/** Throws if a change listener is called before the watch capability captures it. */
function missingNotify(): void {
  throw new Error("notify unavailable")
}
