import { background, canceled, withCancel } from "@go-like/context"
import { logger, type Client, type Message, type TransportLogLevel } from "@go-like/transport"
import { executor, newHTTPTransport, type HTTPExecutor } from "@go-like/transport-http"

/** Reports the portable HTTP client cleanup ownership matrix. */
export interface HTTPClientCleanupMatrixResult {
  readonly valid: boolean
  readonly activeReaderOwnerCycle: boolean
  readonly activeReaderIndependentResolve: boolean
  readonly activeReaderIndependentReject: boolean
  readonly statusOwnerCycle: boolean
  readonly multipleSlotAdmission: boolean
  readonly nonReentrantPendingJoin: boolean
  readonly callerCancellationJoin: boolean
  readonly duplicateOwnerIdentity: boolean
  readonly unhandled: number
}

/** Creates one externally settled runtime-neutral Promise. */
function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} {
  let resolvePromise: ((value: T) => void) | null = null
  let rejectPromise: ((error: unknown) => void) | null = null
  const promise = new Promise<T>(function capture(resolve, reject): void {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return Object.freeze({
    promise,
    /** Resolves the captured Promise once. */
    resolve(value: T): void {
      resolvePromise?.(value)
    },
    /** Rejects the captured Promise once. */
    reject(error: unknown): void {
      rejectPromise?.(error)
    }
  })
}

/** Completes a standard callable executor with optional Fetch statics. */
function httpExecutor(
  run: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): HTTPExecutor {
  return Object.assign(run, {
    /** Exposes optional connection warming without changing transport behavior. */
    preconnect(): void {}
  })
}

/** Creates one immutable transport message fixture. */
function message(value: string): Message {
  return Object.freeze({
    header: Object.freeze({ "Go-Like-Cleanup-Matrix": value }),
    body: new TextEncoder().encode(value)
  })
}

/** Waits one task so Promise settlement and rejection tracking become observable. */
function nextTask(): Promise<void> {
  return new Promise<void>(function wait(resolve): void {
    setTimeout(resolve, 0)
  })
}

/** Waits for work with a bounded result and no retained timer. */
async function settlesWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const result = await Promise.race([
    work.then(
      function settled(): boolean {
        return true
      },
      function rejected(): boolean {
        return true
      }
    ),
    new Promise<boolean>(function bounded(resolve): void {
      timer = setTimeout(function expired(): void {
        resolve(false)
      }, timeoutMs)
    })
  ])
  if (timer !== null) clearTimeout(timer)
  return result
}

/** Installs one runtime-neutral unhandled-rejection observer. */
function observeUnhandled(reasons: unknown[]): () => void {
  const processValue: unknown = Reflect.get(globalThis, "process")
  if (typeof processValue === "object" && processValue !== null) {
    const on: unknown = Reflect.get(processValue, "on")
    const off: unknown = Reflect.get(processValue, "off")
    if (typeof on === "function" && typeof off === "function") {
      /** Records one Node-compatible unhandled rejection. */
      function record(reason: unknown): void {
        reasons.push(reason)
      }
      Reflect.apply(on, processValue, ["unhandledRejection", record])
      return function removeProcessObserver(): void {
        Reflect.apply(off, processValue, ["unhandledRejection", record])
      }
    }
  }
  /** Records and handles one Web-compatible unhandled rejection event. */
  function recordEvent(event: Event): void {
    reasons.push(Reflect.get(event, "reason"))
    event.preventDefault()
  }
  globalThis.addEventListener("unhandledrejection", recordEvent)
  return function removeEventObserver(): void {
    globalThis.removeEventListener("unhandledrejection", recordEvent)
  }
}

/** Reads the first recorded Promise without asserting callback timing. */
function firstPromise(values: readonly Promise<void>[]): Promise<void> | null {
  return values[0] ?? null
}

/** Proves a reader cancel that returns its reentrant admission cannot wait on the terminal owner. */
async function activeReaderOwnerCycle(): Promise<boolean> {
  const pullStarted = deferred<void>()
  const admissions: Promise<void>[] = []
  let client: Client | null = null
  let cancelCalls = 0
  const response = new Response(
    new ReadableStream<Uint8Array>({
      /** Publishes that recv owns one active standard reader. */
      pull(): void {
        pullStarted.resolve(undefined)
      },
      /** Returns the stable synchronous reentry admission rather than independent work. */
      cancel(): Promise<void> {
        cancelCalls += 1
        const activeClient = client
        if (activeClient === null) throw new Error("active reader client is missing")
        const first = activeClient.close(background())
        const second = activeClient.close(background())
        admissions.push(first, second)
        return first
      }
    })
  )
  client = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(response)
      })
    )
  ).dial(background(), "cleanup.test:8101")
  await client.send(background(), message("active-owner-cycle"))
  const receiving = client.recv(background())
  void receiving.catch(function observeClosedRecv(): void {})
  await pullStarted.promise
  const owner = client.close(background())
  const bounded = await settlesWithin(Promise.allSettled([owner, receiving]), 100)
  const admission = firstPromise(admissions)
  return (
    bounded &&
    admission !== null &&
    admissions.length === 2 &&
    admissions[1] === admission &&
    admission !== owner &&
    client.close(background()) === owner &&
    cancelCalls === 1
  )
}

/** Proves reentry alone cannot detach independent successful reader cleanup from the owner. */
async function activeReaderIndependentResolve(): Promise<boolean> {
  const pullStarted = deferred<void>()
  const resourceCleanup = deferred<void>()
  const admissions: Promise<void>[] = []
  let client: Client | null = null
  let cancelCalls = 0
  const response = new Response(
    new ReadableStream<Uint8Array>({
      /** Publishes active reader ownership. */
      pull(): void {
        pullStarted.resolve(undefined)
      },
      /** Reenters close synchronously but returns separate pending resource work. */
      cancel(): Promise<void> {
        cancelCalls += 1
        const activeClient = client
        if (activeClient === null) throw new Error("independent resolve client is missing")
        admissions.push(activeClient.close(background()), activeClient.close(background()))
        return resourceCleanup.promise
      }
    })
  )
  client = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(response)
      })
    )
  ).dial(background(), "cleanup.test:8102")
  await client.send(background(), message("independent-resolve"))
  const receiving = client.recv(background())
  void receiving.catch(function observeClosedRecv(): void {})
  await pullStarted.promise
  const owner = client.close(background())
  let ownerSettled = false
  let admissionSettled = false
  void owner.then(function markOwner(): void {
    ownerSettled = true
  })
  const admission = firstPromise(admissions)
  if (admission !== null) {
    void admission.then(function markAdmission(): void {
      admissionSettled = true
    })
  }
  await nextTask()
  const pendingBeforeRelease = !ownerSettled && admissionSettled
  resourceCleanup.resolve(undefined)
  const bounded = await settlesWithin(Promise.allSettled([owner, receiving]), 100)
  return (
    pendingBeforeRelease &&
    bounded &&
    admission !== null &&
    admissions[1] === admission &&
    admission !== owner &&
    client.close(background()) === owner &&
    cancelCalls === 1
  )
}

/** Proves independent cleanup rejection is diagnosed before terminal owner settlement. */
async function activeReaderIndependentReject(): Promise<boolean> {
  const pullStarted = deferred<void>()
  const resourceCleanup = deferred<void>()
  const cleanupFailure = new Error("independent reader cleanup rejected")
  const events: string[] = []
  let client: Client | null = null
  let cancelCalls = 0
  let loggedCause: unknown = null
  const transport = newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              /** Publishes active reader ownership. */
              pull(): void {
                pullStarted.resolve(undefined)
              },
              /** Reenters close but returns separate rejecting resource work. */
              cancel(): Promise<void> {
                cancelCalls += 1
                const activeClient = client
                if (activeClient === null) throw new Error("independent reject client is missing")
                activeClient.close(background())
                return resourceCleanup.promise
              }
            })
          )
        )
      })
    )
  )
  transport.init(
    logger(
      Object.freeze({
        /** Records the existing response-cleanup diagnostic synchronously. */
        log(
          _level: TransportLogLevel,
          _message: string,
          fields?: Readonly<Record<string, unknown>>
        ): void {
          loggedCause = fields?.["cause"]
          events.push("diagnostic")
        }
      })
    )
  )
  client = await transport.dial(background(), "cleanup.test:8103")
  await client.send(background(), message("independent-reject"))
  const receiving = client.recv(background())
  void receiving.catch(function observeClosedRecv(): void {})
  await pullStarted.promise
  const owner = client.close(background())
  let ownerSettled = false
  void owner.then(function recordOwner(): void {
    ownerSettled = true
    events.push("owner")
  })
  await nextTask()
  const pendingBeforeReject = !ownerSettled
  resourceCleanup.reject(cleanupFailure)
  const bounded = await settlesWithin(Promise.allSettled([owner, receiving]), 100)
  await nextTask()
  return (
    pendingBeforeReject &&
    bounded &&
    loggedCause === cleanupFailure &&
    events.join(",") === "diagnostic,owner" &&
    cancelCalls === 1
  )
}

/** Proves status truncation receives the same narrow synchronous admission handshake. */
async function statusOwnerCycle(): Promise<boolean> {
  const cancelEntered = deferred<void>()
  const admissions: Promise<void>[] = []
  let client: Client | null = null
  let cancelCalls = 0
  const bytes = new Uint8Array(65_537)
  bytes.fill(7)
  const response = new Response(
    new ReadableStream<Uint8Array>({
      /** Forces bounded status-body cancellation. */
      start(controller): void {
        controller.enqueue(bytes)
      },
      /** Returns the stable synchronous close admission from status cleanup. */
      cancel(): Promise<void> {
        cancelCalls += 1
        const activeClient = client
        if (activeClient === null) throw new Error("status client is missing")
        const first = activeClient.close(background())
        const second = activeClient.close(background())
        admissions.push(first, second)
        cancelEntered.resolve(undefined)
        return first
      }
    }),
    { status: 503 }
  )
  client = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(response)
      })
    )
  ).dial(background(), "cleanup.test:8104")
  await client.send(background(), message("status-owner-cycle"))
  const receiving = client.recv(background())
  void receiving.catch(function observeClosedRecv(): void {})
  await cancelEntered.promise
  const owner = client.close(background())
  const bounded = await settlesWithin(Promise.allSettled([owner, receiving]), 100)
  const admission = firstPromise(admissions)
  return (
    bounded &&
    admission !== null &&
    admissions[1] === admission &&
    admission !== owner &&
    client.close(background()) === owner &&
    cancelCalls === 1
  )
}

/** Proves every synchronous slot cleanup receives one shared admission after registration. */
async function multipleSlotAdmission(): Promise<boolean> {
  const admissions: Promise<void>[] = []
  let client: Client | null = null
  let cancelCalls = 0
  let responseIndex = 0
  const transport = newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        responseIndex += 1
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              /** Keeps each unread response body owned by the client. */
              pull(): void {},
              /** Reenters close twice and returns the shared admission. */
              cancel(): Promise<void> {
                cancelCalls += 1
                const activeClient = client
                if (activeClient === null) throw new Error("multiple-slot client is missing")
                const first = activeClient.close(background())
                const second = activeClient.close(background())
                admissions.push(first, second)
                return first
              }
            })
          )
        )
      })
    )
  )
  client = await transport.dial(background(), "cleanup.test:8105")
  await client.send(background(), message("multiple-one"))
  await client.send(background(), message("multiple-two"))
  const owner = client.close(background())
  const bounded = await settlesWithin(owner, 100)
  const admission = firstPromise(admissions)
  return (
    bounded &&
    responseIndex === 2 &&
    cancelCalls === 2 &&
    admissions.length === 4 &&
    admission !== null &&
    admissions.every(function shared(value): boolean {
      return value === admission
    }) &&
    admission !== owner &&
    client.close(background()) === owner
  )
}

/** Proves ordinary non-reentrant pending cancellation remains owner-joined. */
async function nonReentrantPendingJoin(): Promise<boolean> {
  const pullStarted = deferred<void>()
  const resourceCleanup = deferred<void>()
  let cancelCalls = 0
  const client = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              /** Publishes active reader ownership. */
              pull(): void {
                pullStarted.resolve(undefined)
              },
              /** Returns ordinary pending cleanup without reentry. */
              cancel(): Promise<void> {
                cancelCalls += 1
                return resourceCleanup.promise
              }
            })
          )
        )
      })
    )
  ).dial(background(), "cleanup.test:8106")
  await client.send(background(), message("non-reentrant"))
  const receiving = client.recv(background())
  void receiving.catch(function observeClosedRecv(): void {})
  await pullStarted.promise
  const owner = client.close(background())
  const duplicate = client.close(background())
  let ownerSettled = false
  void owner.then(function markOwner(): void {
    ownerSettled = true
  })
  await nextTask()
  const pendingBeforeRelease = !ownerSettled
  resourceCleanup.resolve(undefined)
  const bounded = await settlesWithin(Promise.allSettled([owner, receiving]), 100)
  return pendingBeforeRelease && bounded && duplicate === owner && cancelCalls === 1
}

/** Proves caller cancellation bounds only that wait and never abandons owner cleanup. */
async function callerCancellationJoin(): Promise<boolean> {
  const resourceCleanup = deferred<void>()
  let cancelCalls = 0
  const client = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              /** Keeps the unread response body owned until close. */
              pull(): void {},
              /** Holds real resource cleanup beyond the first caller Context. */
              cancel(): Promise<void> {
                cancelCalls += 1
                return resourceCleanup.promise
              }
            })
          )
        )
      })
    )
  ).dial(background(), "cleanup.test:8107")
  await client.send(background(), message("caller-cancellation"))
  const [ctx, cancel] = withCancel(background())
  const caller = client.close(ctx)
  cancel()
  const callerOutcome = await caller.then(
    function fulfilled(): unknown {
      return null
    },
    function rejected(error: unknown): unknown {
      return error
    }
  )
  const owner = client.close(background())
  let ownerSettled = false
  void owner.then(function markOwner(): void {
    ownerSettled = true
  })
  await nextTask()
  const pendingBeforeRelease = !ownerSettled
  resourceCleanup.resolve(undefined)
  const bounded = await settlesWithin(owner, 100)
  return (
    callerOutcome === canceled &&
    pendingBeforeRelease &&
    bounded &&
    client.close(background()) === owner &&
    cancelCalls === 1
  )
}

/** Executes the real standard Streams lifecycle matrix through public package APIs. */
export async function runHTTPClientCleanupMatrix(): Promise<HTTPClientCleanupMatrixResult> {
  const unhandled: unknown[] = []
  const removeUnhandled = observeUnhandled(unhandled)
  try {
    const ownerCycle = await activeReaderOwnerCycle()
    const independentResolve = await activeReaderIndependentResolve()
    const independentReject = await activeReaderIndependentReject()
    const statusCycle = await statusOwnerCycle()
    const multipleSlots = await multipleSlotAdmission()
    const nonReentrant = await nonReentrantPendingJoin()
    const callerCancellation = await callerCancellationJoin()
    await nextTask()
    const duplicateOwner = nonReentrant && callerCancellation
    const valid =
      ownerCycle &&
      independentResolve &&
      independentReject &&
      statusCycle &&
      multipleSlots &&
      nonReentrant &&
      callerCancellation &&
      duplicateOwner &&
      unhandled.length === 0
    return Object.freeze({
      valid,
      activeReaderOwnerCycle: ownerCycle,
      activeReaderIndependentResolve: independentResolve,
      activeReaderIndependentReject: independentReject,
      statusOwnerCycle: statusCycle,
      multipleSlotAdmission: multipleSlots,
      nonReentrantPendingJoin: nonReentrant,
      callerCancellationJoin: callerCancellation,
      duplicateOwnerIdentity: duplicateOwner,
      unhandled: unhandled.length
    })
  } finally {
    removeUnhandled()
  }
}
