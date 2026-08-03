import { background, canceled, type Context } from "@likego/context"
import type { Client, DialOption, Option } from "@likego/transport"
import { newUnsupportedTransportCapabilityError } from "@likego/transport/provider"
import { normalizeHTTPDialTarget, normalizeHTTPListenAddress } from "./address"
import { newHTTPClient } from "./client"
import { contextError, normalizeHTTPError } from "./errors"
import { newHTTPListener } from "./listener"
import {
  applyHTTPDialOptions,
  applyHTTPListenOptions,
  applyHTTPCommonOptions,
  applyHTTPTransportOptions,
  defaultHTTPCommonOptions,
  snapshotHTTPCommonOptions
} from "./options"
import type {
  HTTPExecutor,
  HTTPHost,
  HTTPHostCapabilities,
  HTTPHostHandle,
  HTTPHostListenOptions,
  HTTPListenOption,
  HTTPListener,
  HTTPTransport,
  HTTPTransportOption
} from "./types"

/** Owns one dial-scoped executor and its runtime resources. */
export interface HTTPDialExecutorHandle {
  readonly executor: HTTPExecutor
  /** Releases every runtime resource owned by this dial. */
  close(): Promise<void>
}

/** Selects one immutable executor owner for a validated HTTP dial. */
export type HTTPDialExecutorFactory = (
  target: ReturnType<typeof normalizeHTTPDialTarget>,
  common: ReturnType<typeof snapshotHTTPCommonOptions>,
  dial: ReturnType<typeof applyHTTPDialOptions>,
  fallback: HTTPExecutor
) => HTTPDialExecutorHandle

/** Contains the minimum borrowed methods required to join admission rollback. */
interface HTTPHostCleanupHandle {
  /** Starts graceful host cleanup. */
  close(ctx: Context): Promise<void>
  /** Returns the stable host terminal Promise when its getter was admitted. */
  readonly done: (() => Promise<void>) | null
}

/** Snapshots and validates one borrowed host capability declaration. */
function hostCapabilities(value: HTTPHost): HTTPHostCapabilities {
  let capabilities: HTTPHostCapabilities
  try {
    capabilities = value.capabilities.call(value)
  } catch (error) {
    throw normalizeHTTPError(error, "HTTP host capabilities threw")
  }
  if (typeof capabilities !== "object" || capabilities === null) {
    throw new TypeError("HTTP host capabilities must be an object")
  }
  let tls: unknown
  let forceClose: unknown
  let connectionMetadata: unknown
  try {
    tls = capabilities.tls
    forceClose = capabilities.forceClose
    connectionMetadata = capabilities.connectionMetadata
  } catch (error) {
    throw normalizeHTTPError(error, "HTTP host capability snapshot failed")
  }
  if (
    typeof tls !== "boolean" ||
    typeof forceClose !== "boolean" ||
    typeof connectionMetadata !== "boolean"
  ) {
    throw new TypeError("HTTP host capabilities must be booleans")
  }
  return Object.freeze({
    tls,
    forceClose,
    connectionMetadata
  })
}

/** Waits for bind while ctx remains active and rolls back a late handle. */
function bindWithContext(ctx: Context, work: Promise<HTTPHostHandle>): Promise<HTTPHostHandle> {
  const signal = ctx.done()
  if (signal === null) {
    return work.catch(function normalizeBindRejection(error: unknown): never {
      throw normalizeHTTPError(error, "HTTP host bind rejected")
    })
  }
  const activeSignal = signal
  return new Promise<HTTPHostHandle>(function wait(resolve, reject): void {
    let settled = false
    /** Removes the bind Context observer. */
    function cleanup(): void {
      activeSignal.removeEventListener("abort", onAbort)
    }
    /** Rejects bind promptly with the exact Context error. */
    function onAbort(): void {
      settled = true
      cleanup()
      reject(contextError(ctx) ?? canceled)
    }
    activeSignal.addEventListener("abort", onAbort, { once: true })
    work.then(
      function bound(handle): void {
        if (settled) {
          try {
            void Promise.resolve(handle.close.call(handle, background())).catch(
              function ignore(): void {}
            )
          } catch {
            // Late rollback cannot replace the already returned Context error.
          }
          return
        }
        settled = true
        cleanup()
        resolve(handle)
      },
      function bindRejected(error: unknown): void {
        if (settled) return
        settled = true
        cleanup()
        reject(normalizeHTTPError(error, "HTTP host bind rejected"))
      }
    )
    if (contextError(ctx) !== null) onAbort()
  })
}

/** Observes one rollback side and appends its Error at settlement time. */
async function observeRollback(
  work: Promise<void>,
  message: string,
  failures: Error[]
): Promise<void> {
  try {
    await work
  } catch (error) {
    failures.push(normalizeHTTPError(error, message))
  }
}

/** Rolls back one invalid bound handle through true close and done settlement. */
async function rollbackInvalidHandle(handle: HTTPHostCleanupHandle): Promise<readonly Error[]> {
  let close: Promise<void>
  let done: Promise<void> | null = null
  try {
    close = Promise.resolve(handle.close.call(handle, background()))
  } catch (error) {
    close = Promise.reject(normalizeHTTPError(error, "HTTP host rollback close threw"))
  }
  if (handle.done !== null) {
    try {
      done = Promise.resolve(handle.done())
    } catch (error) {
      done = Promise.reject(normalizeHTTPError(error, "HTTP host rollback done threw"))
    }
  }
  const failures: Error[] = []
  const observations: Promise<void>[] = [
    observeRollback(close, "HTTP host rollback close rejected", failures)
  ]
  if (done !== null) {
    observations.push(observeRollback(done, "HTTP host rollback done rejected", failures))
  }
  await Promise.all(observations)
  return Object.freeze(Array.from(failures))
}

/** Creates one immutable admission AggregateError with fixed ordered failures. */
function admissionAggregate(errors: readonly Error[]): AggregateError {
  const frozen = Object.freeze(Array.from(errors))
  const aggregate = new AggregateError(frozen, "HTTP host admission rollback failed")
  Object.defineProperty(aggregate, "errors", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: frozen
  })
  return Object.freeze(aggregate)
}

/** Rolls back one bound handle and always rejects with stable admission ordering. */
async function rejectAfterRollback(
  handle: HTTPHostCleanupHandle,
  admission: Error
): Promise<never> {
  const cleanupFailures = await rollbackInvalidHandle(handle)
  if (cleanupFailures.length > 0) {
    const failures: Error[] = [admission]
    for (const failure of cleanupFailures) failures.push(failure)
    throw admissionAggregate(failures)
  }
  throw admission
}

/** Creates one configurable unary HTTP Transport with an optional runtime dial seam. */
function createHTTPTransport(
  dialExecutorFactory: HTTPDialExecutorFactory | null,
  constructionOptions: readonly HTTPTransportOption[]
): HTTPTransport {
  const httpOptions = applyHTTPTransportOptions(constructionOptions)
  let common = defaultHTTPCommonOptions()
  return Object.freeze({
    /** Returns the stable provider-neutral transport kind. */
    kind(): "http" {
      return "http"
    },
    /** Applies common options for future resources without I/O. */
    init(...options: readonly Option[]): void {
      common = applyHTTPCommonOptions(common, options)
    },
    /** Returns a deep immutable common option snapshot. */
    options() {
      return snapshotHTTPCommonOptions(common)
    },
    /** Creates one unary client after client behavior is admitted. */
    dial(ctx: Context, address: string, ...options: readonly DialOption[]): Promise<Client> {
      const failure = contextError(ctx)
      if (failure !== null) return Promise.reject(failure)
      const dialOptions = applyHTTPDialOptions(options)
      if (dialExecutorFactory === null && dialOptions.connectionClose) {
        return Promise.reject(
          newUnsupportedTransportCapabilityError("standard Fetch cannot force connection close")
        )
      }
      if (dialExecutorFactory === null && common.tlsConfig !== null) {
        return Promise.reject(
          newUnsupportedTransportCapabilityError("standard Fetch cannot use custom TLS material")
        )
      }
      let target
      try {
        target = normalizeHTTPDialTarget(address, common.secure || common.tlsConfig !== null)
      } catch (error) {
        return Promise.reject(error)
      }
      let selectedExecutor = httpOptions.executor
      /** Releases the portable executor, which owns no per-client native resources. */
      let closeExecutor = function closePortableExecutor(): Promise<void> {
        return Promise.resolve()
      }
      if (dialExecutorFactory !== null) {
        try {
          const owner = dialExecutorFactory(
            target,
            snapshotHTTPCommonOptions(common),
            dialOptions,
            httpOptions.executor
          )
          if (
            typeof owner !== "object" ||
            owner === null ||
            typeof owner.executor !== "function" ||
            typeof owner.close !== "function"
          ) {
            throw new TypeError("HTTP dial executor factory must return an executor owner")
          }
          selectedExecutor = owner.executor
          closeExecutor = owner.close.bind(owner)
        } catch (error) {
          return Promise.reject(error)
        }
      }
      return Promise.resolve(
        newHTTPClient(
          target,
          selectedExecutor,
          closeExecutor,
          common,
          dialOptions,
          httpOptions.maxMessageBytes
        )
      )
    },
    /** Binds one runtime-host-backed listener after listener behavior is admitted. */
    async listen(
      ctx: Context,
      address: string,
      ...options: readonly HTTPListenOption[]
    ): Promise<HTTPListener> {
      const resourceCommon = common
      const failure = contextError(ctx)
      if (failure !== null) throw failure
      const listenOptions = applyHTTPListenOptions(options)
      const selectedHost = listenOptions.host
      if (selectedHost === null) {
        throw newUnsupportedTransportCapabilityError("HTTP listen requires a runtime host")
      }
      const normalizedAddress = normalizeHTTPListenAddress(address)
      const capabilities = hostCapabilities(selectedHost)
      const requiresTLS = resourceCommon.secure || resourceCommon.tlsConfig !== null
      if (requiresTLS && !capabilities.tls) {
        throw newUnsupportedTransportCapabilityError("HTTP host cannot provide requested TLS")
      }
      const hostOptions: HTTPHostListenOptions = Object.freeze({
        secure: resourceCommon.secure,
        tlsConfig: resourceCommon.tlsConfig
      })
      let bind: Promise<HTTPHostHandle>
      try {
        bind = Promise.resolve(
          selectedHost.bind.call(selectedHost, ctx, normalizedAddress, hostOptions)
        )
      } catch (error) {
        throw normalizeHTTPError(error, "HTTP host bind threw")
      }
      const handle = await bindWithContext(ctx, bind)
      if (typeof handle !== "object" || handle === null) {
        throw new TypeError("HTTP host handle is invalid")
      }
      let closeMethod: HTTPHostHandle["close"] | null = null
      try {
        closeMethod = handle.close
      } catch (error) {
        throw normalizeHTTPError(error, "HTTP host cleanup method snapshot failed")
      }
      if (typeof closeMethod !== "function") {
        throw new TypeError("HTTP host handle must provide close and done")
      }
      const partialCleanupHandle: HTTPHostCleanupHandle = Object.freeze({
        close: closeMethod.bind(handle),
        done: null
      })
      let doneMethod: HTTPHostHandle["done"] | null = null
      try {
        doneMethod = handle.done
      } catch (error) {
        return await rejectAfterRollback(
          partialCleanupHandle,
          normalizeHTTPError(error, "HTTP host cleanup method snapshot failed")
        )
      }
      if (typeof doneMethod !== "function") {
        return await rejectAfterRollback(
          partialCleanupHandle,
          new TypeError("HTTP host handle must provide close and done")
        )
      }
      const admittedDone = doneMethod.bind(handle)
      const cleanupHandle: HTTPHostCleanupHandle = Object.freeze({
        close: partialCleanupHandle.close,
        done: admittedDone
      })
      let addressMethod: HTTPHostHandle["address"] | null = null
      let serveMethod: HTTPHostHandle["serve"] | null = null
      try {
        addressMethod = handle.address
        serveMethod = handle.serve
      } catch (error) {
        return await rejectAfterRollback(
          cleanupHandle,
          normalizeHTTPError(error, "HTTP host method snapshot failed")
        )
      }
      if (typeof addressMethod !== "function" || typeof serveMethod !== "function") {
        return await rejectAfterRollback(
          cleanupHandle,
          new TypeError("HTTP host handle must provide address and serve")
        )
      }
      let forceCloseMethod: ((reason: Error) => Promise<void>) | null = null
      if (capabilities.forceClose) {
        try {
          const provided = handle.forceClose
          if (typeof provided === "function") forceCloseMethod = provided
        } catch (error) {
          return await rejectAfterRollback(
            cleanupHandle,
            normalizeHTTPError(error, "HTTP host forceClose snapshot failed")
          )
        }
        if (forceCloseMethod === null) {
          return await rejectAfterRollback(
            cleanupHandle,
            newUnsupportedTransportCapabilityError(
              "HTTP host advertised forceClose without implementing it"
            )
          )
        }
      }
      const admittedHandle: HTTPHostHandle =
        forceCloseMethod === null
          ? Object.freeze({
              address: addressMethod.bind(handle),
              serve: serveMethod.bind(handle),
              close: cleanupHandle.close,
              done: admittedDone
            })
          : Object.freeze({
              address: addressMethod.bind(handle),
              serve: serveMethod.bind(handle),
              close: cleanupHandle.close,
              done: admittedDone,
              forceClose: forceCloseMethod.bind(handle)
            })
      let actualAddress: string
      try {
        actualAddress = admittedHandle.address.call(admittedHandle)
      } catch (error) {
        return await rejectAfterRollback(
          cleanupHandle,
          normalizeHTTPError(error, "HTTP host address threw")
        )
      }
      if (typeof actualAddress !== "string" || actualAddress === "") {
        return await rejectAfterRollback(
          cleanupHandle,
          new TypeError("HTTP host actual address must be a non-empty string")
        )
      }
      return newHTTPListener(
        actualAddress,
        admittedHandle,
        capabilities,
        resourceCommon.logger,
        requiresTLS,
        httpOptions.maxMessageBytes
      )
    },
    /** Returns the stable implementation name. */
    string(): string {
      return "http"
    }
  })
}

/** Creates one configurable portable unary HTTP Transport. */
export function newHTTPTransport(
  ...constructionOptions: readonly HTTPTransportOption[]
): HTTPTransport {
  return createHTTPTransport(null, constructionOptions)
}

/** Creates one runtime-backed HTTP Transport without exposing the dial seam publicly. */
export function newHTTPTransportWithDialExecutor(
  factory: HTTPDialExecutorFactory,
  ...constructionOptions: readonly HTTPTransportOption[]
): HTTPTransport {
  if (typeof factory !== "function") throw new TypeError("HTTP dial executor factory is required")
  return createHTTPTransport(factory, constructionOptions)
}
