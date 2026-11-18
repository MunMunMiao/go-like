/**
 * Broker conformance suites.
 * Callers run the returned cases. Cases may be added in a minor release.
 */
import { background, withCancelCause, withValue, type Context } from "../context/index"
import { newTelemetry, withTelemetry } from "../telemetry/index"
import { withRemoteSpanContext } from "../telemetry/provider"
import { AttributeKey, LogEvent, MetricName, SemconvValue } from "../telemetry/semconv"
import { spanFromContext } from "../trace/index"
import type { ConformanceCase } from "../testing/case"
import { newTelemetryRecorder } from "../testing/recorder"

import { newBrokerServer, type Broker, type BrokerEvent, type Subscriber } from "./index"

/** Supplies a fresh broker and one routed topic to both broker suites. */
export interface BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native> {
  /** A fresh broker connected to a backend the cases may publish to. */
  newBroker(ctx: Context): Promise<Broker<PublishOptions, PublishResult, SubscribeOptions, Native>>
  /** A topic the backend routes back to a subscription on the same topic. */
  readonly topic: string
  readonly publishOptions?: PublishOptions
  readonly subscribeOptions?: SubscribeOptions
  /** Native settlement after a successful handler. Omit when the backend needs none. */
  settle?(event: BrokerEvent<Native>): void | Promise<void>
  /** Bounds every wait. Default 5,000 ms. */
  readonly timeoutMs?: number
  /** Releases the broker and backend resources the subject created. */
  close(ctx: Context): Promise<void>
}

const inherited = Symbol("broker-conformance")

/** Throws when a conformance assertion fails. */
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * Reports whether a terminal still carries the handler Error.
 * One ordinary failure must be that Error. An AggregateError matches only when
 * the handler Error is first and an independent cleanup failure is attached.
 */
function retainsFailure(actual: unknown, failure: Error): boolean {
  if (actual === failure) return true
  if (!(actual instanceof AggregateError)) return false
  const [primary, ...attached] = actual.errors
  if (primary !== failure || attached.length === 0) return false
  return attached.some((item) => item !== primary)
}

/** Rejects a subject that cannot host the suites. */
function capture<PublishOptions, PublishResult, SubscribeOptions, Native>(
  subject: BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native>
): Required<
  Pick<
    BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native>,
    "timeoutMs"
  >
> &
  BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native> {
  if (
    typeof subject !== "object" ||
    subject === null ||
    typeof subject.newBroker !== "function" ||
    typeof subject.close !== "function" ||
    typeof subject.topic !== "string" ||
    subject.topic.length === 0 ||
    !subject.topic.isWellFormed()
  ) {
    throw new TypeError("broker conformance subject is invalid")
  }
  const timeoutMs = subject.timeoutMs ?? 5_000
  return {
    timeoutMs,
    topic: subject.topic,
    ...(subject.publishOptions !== undefined ? { publishOptions: subject.publishOptions } : {}),
    ...(subject.subscribeOptions !== undefined
      ? { subscribeOptions: subject.subscribeOptions }
      : {}),
    ...(subject.settle !== undefined
      ? {
          settle: (event: BrokerEvent<Native>): void | Promise<void> => subject.settle?.(event)
        }
      : {}),
    newBroker: (ctx) => subject.newBroker(ctx),
    close: (ctx) => subject.close(ctx)
  }
}

/** Waits for a short wall-clock gap without failing the case. */
async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Waits until `predicate` holds or the bound expires. */
async function until(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10)
    })
  }
}

/** Keeps a fulfilled result and a rejection in one function so both paths stay observable. */
async function observe(
  operation: Promise<unknown>
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await operation }
  } catch (error) {
    return { ok: false, error }
  }
}

/** Publishes until the subscription server rejects, or the suite bound expires. */
async function publishUntilTerminal<PublishOptions, PublishResult, SubscribeOptions, Native>(
  broker: Broker<PublishOptions, PublishResult, SubscribeOptions, Native>,
  topic: string,
  options: PublishOptions | undefined,
  ctx: Context,
  running: Promise<void>,
  timeoutMs: number,
  failure: Error
): Promise<unknown> {
  let rejected: unknown = null
  const deadline = Date.now() + timeoutMs
  let terminal: unknown = null
  while (terminal === null && Date.now() <= deadline) {
    const published = await observe(
      broker.publish(ctx, topic, { headers: {}, body: new Uint8Array([1]) }, options)
    )
    if (!published.ok) rejected = published.error
    const raced = await Promise.race([observe(running), sleep(15).then(() => null)])
    if (raced === null) continue
    terminal = raced.ok ? "resolved" : raced.error
  }
  ensure(retainsFailure(terminal, failure), "server start lost the handler error")
  return rejected
}

/** Returns the rejection, or throws when the operation fulfills. */
async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error("broker operation fulfilled")
}

/** Compares payload bytes. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Rejects when an operation stays pending past the suite bound. */
function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("bounded-rejection"))
    }, timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** Opens one broker and always closes it. Every wait shares the subject bound. */
async function using<PublishOptions, PublishResult, SubscribeOptions, Native>(
  subject: BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native>,
  run: (broker: Broker<PublishOptions, PublishResult, SubscribeOptions, Native>) => Promise<void>
): Promise<void> {
  const ctx = background()
  const limit = subject.timeoutMs ?? 5_000
  let failure: unknown
  let failed = false
  try {
    const broker = await bounded(subject.newBroker(ctx), limit)
    const running = run(broker)
    try {
      await bounded(running, limit)
    } catch (error) {
      failed = true
      failure = error
      const settled = await observe(bounded(running, limit))
      if (!settled.ok && failure instanceof Error && failure.message === "bounded-rejection") {
        failure = settled.error
      }
    }
  } catch (error) {
    failed = true
    failure = error
  } finally {
    try {
      await bounded(subject.close(ctx), limit)
    } catch (error) {
      if (!failed) {
        failed = true
        failure = error
      }
    }
  }
  if (failed) throw failure
}

/** Builds the portable broker behavior suite. */
export function brokerConformance<PublishOptions, PublishResult, SubscribeOptions, Native>(
  subject: BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native>
): readonly ConformanceCase[] {
  const selected = capture(subject)
  return Object.freeze([
    Object.freeze({
      name: "string is stable",
      /** Reads the diagnostic name twice. */
      async run(): Promise<void> {
        await using(selected, async (broker) => {
          const name = broker.string()
          ensure(typeof name === "string" && name.length > 0 && name.isWellFormed(), "string()")
          ensure(broker.string() === name, "string() changed")
          let fulfilled = false
          try {
            await rejection(Promise.resolve())
          } catch (error) {
            fulfilled = error instanceof Error
          }
          ensure(fulfilled, "a completed publish is not reported as a rejection")
        })
      }
    }),
    Object.freeze({
      name: "publish copies headers and bytes",
      /** Mutates the caller payload after publish and checks the delivery. */
      async run(): Promise<void> {
        await using(selected, async (broker) => {
          const events: BrokerEvent<Native>[] = []
          await broker.subscribe(
            background(),
            selected.topic,
            async (_ctx, event) => {
              events.push(event)
              await selected.settle?.(event)
            },
            selected.subscribeOptions
          )
          const headers: Record<string, string> = { source: "api" }
          const body = new Uint8Array([1, 2])
          const publishing = broker.publish(
            background(),
            selected.topic,
            { headers, body },
            selected.publishOptions
          )
          headers.source = "changed"
          body[0] = 9
          await publishing
          await until(() => events.length === 1, selected.timeoutMs, "delivery timed out")
          const event = events[0]
          ensure(event !== undefined, "missing delivery")
          ensure(event.topic === selected.topic, "topic changed")
          ensure(Object.isFrozen(event) && Object.isFrozen(event.message), "event was mutable")
          ensure(Object.isFrozen(event.message.headers), "headers were mutable")
          ensure(event.message.headers.source === "api", "header snapshot followed the caller")
          const first = event.message.body
          first[0] = 8
          ensure(sameBytes(event.message.body, new Uint8Array([1, 2])), "body was retained")
          ensure(event.message.body !== event.message.body, "body getter returned one view")
        })
      }
    }),
    Object.freeze({
      name: "invalid publish and a canceled context do no I/O",
      /** Rejects bad topics, bodies, headers, and a pre-canceled context. */
      async run(): Promise<void> {
        await using(selected, async (broker) => {
          let calls = 0
          await broker.subscribe(
            background(),
            selected.topic,
            async (_ctx, event) => {
              calls += 1
              await selected.settle?.(event)
            },
            selected.subscribeOptions
          )
          await broker.publish(
            background(),
            selected.topic,
            { headers: {}, body: new Uint8Array([1]) },
            selected.publishOptions
          )
          await until(() => calls === 1, selected.timeoutMs, "valid publish was not delivered")
          const samples: Promise<unknown>[] = [
            broker.publish(
              background(),
              "",
              { headers: {}, body: new Uint8Array() },
              selected.publishOptions
            ),
            broker.publish(
              background(),
              selected.topic,
              { headers: {}, body: [] as never },
              selected.publishOptions
            ),
            broker.publish(
              background(),
              selected.topic,
              { headers: { "": "x" }, body: new Uint8Array() },
              selected.publishOptions
            )
          ]
          for (const sample of samples) {
            ensure(
              (await rejection(sample)) instanceof TypeError,
              "invalid publish was not a TypeError"
            )
          }
          const [canceledCtx, cancel] = withCancelCause(background())
          const reason = new Error("publish canceled")
          cancel(reason)
          ensure(
            (await rejection(
              broker.publish(
                canceledCtx,
                selected.topic,
                { headers: {}, body: new Uint8Array([1]) },
                selected.publishOptions
              )
            )) === reason,
            "canceled publish lost its cause"
          )
          await sleep(30)
          ensure(calls === 1, "invalid or canceled publish admitted a delivery")
        })
      }
    }),
    Object.freeze({
      name: "subscriber topic is the subscribed topic",
      /** Reads the handle topic. */
      async run(): Promise<void> {
        await using(selected, async (broker) => {
          const subscriber = await broker.subscribe(
            background(),
            selected.topic,
            async (_ctx, event) => {
              await selected.settle?.(event)
            },
            selected.subscribeOptions
          )
          await broker.publish(
            background(),
            selected.topic,
            { headers: {}, body: new Uint8Array([1]) },
            selected.publishOptions
          )
          ensure(subscriber.topic === selected.topic, "Subscriber.topic")
          await subscriber.unsubscribe(background())
        })
      }
    }),
    Object.freeze({
      name: "one subscriber receives messages serially",
      /** Holds the first delivery and checks the second waits. */
      async run(): Promise<void> {
        await using(selected, async (broker) => {
          const seen: number[] = []
          let release: (() => void) | undefined
          const gate = new Promise<void>((resolve) => {
            release = resolve
          })
          let subscriber: Subscriber | null = null
          let failure: unknown
          let failed = false
          try {
            subscriber = await broker.subscribe(
              background(),
              selected.topic,
              async (_ctx, event) => {
                seen.push(event.message.body[0] ?? -1)
                if (event.message.body[0] === 1) await gate
                await selected.settle?.(event)
              },
              selected.subscribeOptions
            )
            const first = broker.publish(
              background(),
              selected.topic,
              { headers: {}, body: new Uint8Array([1]) },
              selected.publishOptions
            )
            await until(() => seen.length === 1, selected.timeoutMs, "first delivery timed out")
            const second = broker.publish(
              background(),
              selected.topic,
              { headers: {}, body: new Uint8Array([2]) },
              selected.publishOptions
            )
            await sleep(40)
            ensure(seen.length === 1 && seen[0] === 1, "deliveries overlapped")
            release?.()
            await bounded(first, selected.timeoutMs)
            await bounded(second, selected.timeoutMs)
            await until(
              () => seen.length === 2 && seen[1] === 2,
              selected.timeoutMs,
              "serial order was lost"
            )
          } catch (error) {
            failed = true
            failure = error
          } finally {
            release?.()
            if (subscriber !== null) {
              try {
                await bounded(subscriber.unsubscribe(background()), selected.timeoutMs)
              } catch (error) {
                if (!failed) {
                  failed = true
                  failure = error
                }
              }
            }
          }
          if (failed) throw failure
        })
      }
    }),
    Object.freeze({
      name: "handler failure terminates the subscription and the server",
      /** Preserves the handler Error through publish and newBrokerServer. */
      async run(): Promise<void> {
        await using(selected, async (broker) => {
          const failure = new Error("handler failed")
          let calls = 0
          const server = newBrokerServer(
            broker,
            selected.topic,
            async (_ctx, event) => {
              calls += 1
              if (calls === 1) {
                await selected.settle?.(event)
                return
              }
              throw failure
            },
            selected.subscribeOptions
          )
          const running = server.start(background())
          const deadline = Date.now() + selected.timeoutMs
          while (calls < 1) {
            if (Date.now() > deadline) break
            await observe(
              broker.publish(
                background(),
                selected.topic,
                { headers: {}, body: new Uint8Array([1]) },
                selected.publishOptions
              )
            )
            if (calls < 1) await sleep(20)
          }
          ensure(calls >= 1, "subscriber did not start")
          const failedPublish = await observe(
            broker.publish(
              background(),
              selected.topic,
              { headers: {}, body: new Uint8Array([1]) },
              selected.publishOptions
            )
          )
          if (!failedPublish.ok && failedPublish.error !== failure) throw failedPublish.error
          await until(() => calls >= 2, selected.timeoutMs, "handler did not fail")
          ensure(
            retainsFailure(await rejection(running), failure),
            "server start lost the handler error"
          )
          const before = calls
          await observe(
            broker.publish(
              background(),
              selected.topic,
              { headers: {}, body: new Uint8Array([2]) },
              selected.publishOptions
            )
          )
          await sleep(30)
          ensure(calls === before, "failed subscription stayed open")
        })
      }
    }),
    Object.freeze({
      name: "unsubscribe drains admitted handlers without following the caller",
      /** Cancels one waiter and checks a second unsubscribe joins the same drain. */
      async run(): Promise<void> {
        await using(selected, async (broker) => {
          let calls = 0
          let release: (() => void) | undefined
          const gate = new Promise<void>((resolve) => {
            release = resolve
          })
          let subscriber: Subscriber | null = null
          let failure: unknown
          let failed = false
          try {
            subscriber = await broker.subscribe(
              background(),
              selected.topic,
              async (_ctx, event) => {
                calls += 1
                await gate
                await selected.settle?.(event)
              },
              selected.subscribeOptions
            )
            const publishing = broker.publish(
              background(),
              selected.topic,
              { headers: {}, body: new Uint8Array([1]) },
              selected.publishOptions
            )
            await until(() => calls === 1, selected.timeoutMs, "admitted handler did not start")
            const [stopCtx, cancel] = withCancelCause(background())
            const reason = new Error("unsubscribe waiter canceled")
            const waiting = subscriber.unsubscribe(stopCtx)
            cancel(reason)
            ensure(
              (await rejection(waiting)) === reason,
              "unsubscribe followed the owner instead of the caller"
            )
            await broker.publish(
              background(),
              selected.topic,
              { headers: {}, body: new Uint8Array([2]) },
              selected.publishOptions
            )
            ensure(calls === 1, "unsubscribe kept admitting")
            release?.()
            await bounded(publishing, selected.timeoutMs)
            await bounded(subscriber.unsubscribe(background()), selected.timeoutMs)
            await bounded(subscriber.unsubscribe(background()), selected.timeoutMs)
          } catch (error) {
            failed = true
            failure = error
          } finally {
            release?.()
            if (subscriber !== null) {
              try {
                await bounded(subscriber.unsubscribe(background()), selected.timeoutMs)
              } catch (error) {
                if (!failed) {
                  failed = true
                  failure = error
                }
              }
            }
          }
          if (failed) throw failure
        })
      }
    }),
    Object.freeze({
      name: "each delivery gets a child context that is canceled after it settles",
      /** Checks inheritance, identity, and cancellation. */
      async run(): Promise<void> {
        await using(selected, async (broker) => {
          const parent = withValue(background(), inherited, "kept")
          const seen: { ctx: Context | null } = { ctx: null }
          await broker.subscribe(
            parent,
            selected.topic,
            async (ctx, event) => {
              seen.ctx = ctx
              ensure(ctx !== parent, "delivery reused the subscribe context")
              ensure(ctx.value(inherited) === "kept", "delivery dropped a context value")
              ensure(ctx.err() === null, "delivery context started canceled")
              await selected.settle?.(event)
            },
            selected.subscribeOptions
          )
          await broker.publish(
            background(),
            selected.topic,
            { headers: {}, body: new Uint8Array([1]) },
            selected.publishOptions
          )
          await until(
            () => seen.ctx !== null && seen.ctx.err() !== null,
            selected.timeoutMs,
            "delivery context stayed open"
          )
        })
      }
    })
  ])
}

/** Builds the broker telemetry suite. */
export function brokerTelemetryConformance<PublishOptions, PublishResult, SubscribeOptions, Native>(
  subject: BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native>
): readonly ConformanceCase[] {
  const selected = capture(subject)
  return Object.freeze([
    Object.freeze({
      name: "publish injects traceparent into a copy and process is its child",
      /** Records publish and process names, kinds, parent, metrics, and logs. */
      async run(): Promise<void> {
        await using(selected, async (broker) => {
          const recorder = newTelemetryRecorder()
          const ctx = withTelemetry(background(), recorder.telemetry)
          const caller = Object.freeze({
            TraceParent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
            source: "api"
          })
          let traceparent = ""
          await broker.subscribe(
            ctx,
            selected.topic,
            async (_delivery, event) => {
              traceparent = event.message.headers.traceparent ?? ""
              ensure(event.message.headers.source === "api", "source header was dropped")
              ensure(
                event.message.headers.TraceParent === undefined,
                "caller propagation field was kept"
              )
              ensure(Object.isFrozen(event.message.headers), "delivered headers were not frozen")
              await selected.settle?.(event)
            },
            selected.subscribeOptions
          )
          await broker.publish(
            ctx,
            selected.topic,
            { headers: caller, body: new Uint8Array([4]) },
            selected.publishOptions
          )
          ensure(caller.TraceParent.startsWith("00-aaaaaaaa"), "caller record was mutated")
          await until(
            () =>
              recorder.spans().some((span) => span.name === "publish" && span.ended) &&
              recorder
                .spans()
                .some((span) => span.name === `process ${selected.topic}` && span.ended),
            selected.timeoutMs,
            "publish or process span did not end"
          )
          const publish = recorder.spans().find((span) => span.name === "publish")
          const process = recorder.spans().find((span) => span.name === `process ${selected.topic}`)
          ensure(publish !== undefined && process !== undefined, "publish or process span missing")
          ensure(publish.kind === "producer" && publish.root === false, "publish kind or root")
          ensure(process.kind === "consumer" && process.root === false, "process kind or root")
          ensure(
            process.parent?.spanId === publish.context.spanId,
            "process parent was not the publish span"
          )
          ensure(
            process.links.length === 0 && publish.links.length === 0,
            "messaging spans recorded links"
          )
          ensure(
            publish.attributes[AttributeKey.messagingDestinationName] === selected.topic,
            "destination"
          )
          ensure(process.status === "unset", "success span status")
          ensure(
            traceparent.includes(publish.context.traceId),
            "traceparent did not carry the publish trace"
          )
          ensure(
            recorder
              .measurements()
              .some((item) => item.descriptor.name === MetricName.messagingClientOperationDuration),
            "publish metric missing"
          )
          ensure(
            recorder
              .measurements()
              .some((item) => item.descriptor.name === MetricName.messagingProcessDuration),
            "process metric missing"
          )
          const publishLog = recorder
            .logs()
            .find((item) => item.record.event === LogEvent.messagingPublishCompleted)
          const processLog = recorder
            .logs()
            .find((item) => item.record.event === LogEvent.messagingProcessCompleted)
          ensure(publishLog?.record.level === "debug", "publish success log")
          ensure(processLog?.record.level === "info", "process success log")
          ensure(
            publish.attributes[AttributeKey.outcome] === SemconvValue.outcomeSuccess,
            "publish outcome"
          )
          ensure(!JSON.stringify(publish.attributes).includes("secret"), "error text in attributes")
        })
      }
    }),
    Object.freeze({
      name: "propagation works with a propagator and no tracer",
      /** Reinjects an upstream traceparent without creating a span. */
      async run(): Promise<void> {
        await using(selected, async (broker) => {
          const ctx = withTelemetry(background(), newTelemetry({}))
          const remote = withRemoteSpanContext(ctx, {
            traceId: "0123456789abcdef0123456789abcdef",
            spanId: "0123456789abcdef",
            traceFlags: 1,
            traceState: "",
            isRemote: true
          })
          let seen = ""
          await broker.subscribe(
            ctx,
            selected.topic,
            async (delivery, event) => {
              seen = spanFromContext(delivery).spanContext().traceId
              ensure(
                (event.message.headers.traceparent ?? "").includes(
                  "0123456789abcdef0123456789abcdef"
                ),
                "upstream traceparent was not reinjected"
              )
              await selected.settle?.(event)
            },
            selected.subscribeOptions
          )
          await broker.publish(
            remote,
            selected.topic,
            { headers: {}, body: new Uint8Array([1]) },
            selected.publishOptions
          )
          await until(
            () => seen.length > 0,
            selected.timeoutMs,
            "delivery did not extract the upstream parent"
          )
          ensure(
            seen === "0123456789abcdef0123456789abcdef",
            "delivery did not extract the upstream parent"
          )
        })
      }
    }),
    Object.freeze({
      name: "handler failure reaches the subscription with and without telemetry",
      /** Preserves Error identity and records the failure on the process span. */
      async run(): Promise<void> {
        await using(selected, async (broker) => {
          const failure = new Error("handler-secret-text")
          failure.name = "Boom"
          const server = newBrokerServer(
            broker,
            selected.topic,
            () => {
              throw failure
            },
            selected.subscribeOptions
          )
          const running = server.start(background())
          const rejected = await publishUntilTerminal(
            broker,
            selected.topic,
            selected.publishOptions,
            background(),
            running,
            selected.timeoutMs,
            failure
          )
          if (rejected !== null) {
            ensure(rejected === failure, "failure without telemetry lost its identity")
          }
        })
        await using(selected, async (broker) => {
          const recorder = newTelemetryRecorder()
          const ctx = withTelemetry(background(), recorder.telemetry)
          const failure = new Error("handler-secret-text")
          failure.name = "Boom"
          const server = newBrokerServer(
            broker,
            selected.topic,
            () => {
              throw failure
            },
            selected.subscribeOptions
          )
          const running = server.start(ctx)
          const rejected = await publishUntilTerminal(
            broker,
            selected.topic,
            selected.publishOptions,
            ctx,
            running,
            selected.timeoutMs,
            failure
          )
          if (rejected !== null) {
            ensure(rejected === failure, "failure with telemetry lost its identity")
          }
          await until(
            () =>
              recorder
                .spans()
                .some(
                  (span) => span.name === `process ${selected.topic}` && span.status === "error"
                ),
            selected.timeoutMs,
            "process failure status"
          )
          const process = recorder.spans().find((span) => span.name === `process ${selected.topic}`)
          ensure(process?.status === "error", "process failure status")
          ensure(process?.attributes[AttributeKey.errorType] === "Boom", "process error.type")
          ensure(
            process?.attributes[AttributeKey.outcome] === SemconvValue.outcomeFailure,
            "process outcome"
          )
          const logged = recorder
            .logs()
            .find((item) => item.record.event === LogEvent.messagingProcessCompleted)
          ensure(logged?.record.level === "error", "process failure log")
          ensure(
            !logged?.record.message.includes("handler-secret-text"),
            "log message contained error text"
          )
          if (rejected !== null) {
            const publishLog = recorder
              .logs()
              .find((item) => item.record.event === LogEvent.messagingPublishCompleted)
            ensure(publishLog?.record.level === "warn", "publish failure log")
          }
        })
      }
    })
  ])
}
