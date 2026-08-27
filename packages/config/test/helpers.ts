import { background, cause, type Context } from "@go-like/context"
import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { Config, ConfigObject, ConfigSourceWatcher, ConfigValue } from "../src/index"
import { isConfigObject } from "../src/value"

export interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

/** Creates a manually settled Promise without a type assertion. */
export function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = missingResolve
  let rejectValue: (error: unknown) => void = missingReject
  /** Captures the Promise settlement callbacks synchronously. */
  function executor(resolve: (value: T) => void, reject: (error: unknown) => void): void {
    resolveValue = resolve
    rejectValue = reject
  }
  const promise = new Promise<T>(executor)
  return { promise, resolve: resolveValue, reject: rejectValue }
}

/** Throws if a Deferred resolver were somehow used before its constructor callback. */
function missingResolve(_value: unknown): void {
  throw new Error("deferred resolver is unavailable")
}

/** Throws if a Deferred rejecter were somehow used before its constructor callback. */
function missingReject(_error: unknown): void {
  throw new Error("deferred rejecter is unavailable")
}

/** Resolves after several microtasks so Promise continuation chains can settle deterministically. */
export async function flush(turns = 4): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

/** Creates a runtime ConfigObject containing a value that static types may intentionally reject. */
export function invalidDocument(value: unknown): ConfigObject {
  const document = Object.create(null)
  Object.defineProperty(document, "value", { enumerable: true, value })
  return document
}

/** Returns the private cancellation cause supplied through a Context. */
export function cancellationFrom(ctx: Context): Error {
  return cause(ctx) ?? ctx.err() ?? new Error("context was expected to be canceled")
}

/** Waits for a controlled event while rejecting with the exact supplied Context cancellation cause. */
export function waitForEvent(ctx: Context, event: Promise<void>): Promise<void> {
  const cancellation = deferred<void>()
  const signal = ctx.done()
  if (signal !== null) {
    /** Rejects the cancellation branch with the exact Context cause. */
    function canceled(): void {
      cancellation.reject(cancellationFrom(ctx))
    }
    signal.addEventListener("abort", canceled, { once: true })
  }
  return Promise.race([event, cancellation.promise])
}

/** Reads one raw current Config through the public Standard Schema scan contract. */
export function readConfig(config: Config<ConfigObject>): Promise<ConfigObject> {
  const schema = {
    "~standard": {
      version: 1,
      vendor: "go-like-test-identity",
      validate(value: unknown) {
        return isConfigObject(value)
          ? { value }
          : { issues: [{ message: "configuration object required" }] }
      }
    }
  } satisfies StandardSchemaV1<ConfigObject, ConfigObject>
  return config.scan(background(), schema)
}

export interface LoadedConfig {
  /** Closes the Config through its canonical lifecycle. */
  readonly close: (ctx: Context) => Promise<void>
  /** Starts and joins closure for terminal watcher assertions. */
  readonly done: () => Promise<void>
}

/** Loads a Config and returns a small test-only closure helper. */
export async function startConfig<T extends ConfigValue>(config: Config<T>): Promise<LoadedConfig> {
  await config.load(background())
  return loadedConfig(config)
}

/** Waits for an in-flight initial load and returns a small test-only closure helper. */
export async function waitForConfigReady<T extends ConfigValue>(
  config: Config<T>,
  loading: Promise<void>
): Promise<LoadedConfig> {
  await loading
  return loadedConfig(config)
}

/** Creates a test-only facade without changing the public Config contract. */
function loadedConfig<T extends ConfigValue>(config: Config<T>): LoadedConfig {
  return Object.freeze({
    close(ctx: Context): Promise<void> {
      return config.close(ctx)
    },
    done(): Promise<void> {
      return config.close(background())
    }
  })
}

/** Creates a watcher whose notifications and shutdown are controlled by the test. */
export function controlledWatcher(events: {
  readonly nextCalls: Deferred<void>[]
  readonly done: Deferred<void>
  readonly stops: string[]
  readonly name: string
}): ConfigSourceWatcher {
  return {
    /** Waits for the next test-controlled dirty event or the supplied Context cancellation. */
    next(ctx: Context): Promise<void> {
      const event = deferred<void>()
      events.nextCalls.push(event)
      const signal = ctx.done()
      if (signal !== null) {
        /** Rejects the pending adapter operation with the exact Context cause. */
        function canceled(): void {
          event.reject(cancellationFrom(ctx))
        }
        signal.addEventListener("abort", canceled, { once: true })
      }
      return event.promise
    },
    /** Records reverse drain and releases the test's shutdown signal. */
    stop(_ctx: Context): Promise<void> {
      events.stops.push(events.name)
      events.done.resolve(undefined)
      return Promise.resolve()
    }
  }
}
