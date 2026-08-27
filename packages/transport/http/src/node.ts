import type { Context } from "@go-like/context"
import type {
  Client,
  DialOption,
  ListenOption,
  Listener,
  Option,
  Options,
  Transport
} from "@go-like/transport"
import { newUnsupportedTransportCapabilityError } from "@go-like/transport/provider"

import { newNodeHTTPExecutor } from "./node-client"
import {
  allowHTTP1 as allowNodeHTTP1,
  clientAuth as nodeClientAuth,
  newNodeHTTPHost,
  type NodeHTTPClientAuth,
  type NodeHTTPHostOption
} from "./node-host"
import { host } from "./options"
import { newHTTPTransportWithDialExecutor, type HTTPDialExecutorFactory } from "./transport"
import type { HTTPListenOption, HTTPListenOptions, HTTPTransportOption } from "./types"

/** Contains the public Node server policy captured by transport construction. */
export interface NodeHTTPTransportOptions {
  /** Selects whether a secure listener admits HTTP/1.1 through ALPN. */
  readonly allowHTTP1: boolean
  /** Selects whether a secure listener requires a verified client certificate. */
  readonly clientAuth: NodeHTTPClientAuth
}

/** Immutably reduces the Node server policy captured by transport construction. */
type NodeHTTPServerOption = (options: NodeHTTPTransportOptions) => NodeHTTPTransportOptions

/** Configures either portable HTTP behavior or the Node server owned by one transport. */
export type NodeHTTPTransportOption = HTTPTransportOption | NodeHTTPServerOption

export type { NodeHTTPClientAuth }

const HostOptions = new WeakMap<object, NodeHTTPHostOption>()

/** Registers one existing host reducer behind the public transport option boundary. */
function serverOption(option: NodeHTTPHostOption): NodeHTTPServerOption {
  HostOptions.set(option, option)
  return option
}

/** Reports whether one public construction option configures the owned Node server. */
function isServerOption(option: NodeHTTPTransportOption): option is NodeHTTPServerOption {
  return HostOptions.has(option)
}

/**
 * Configures whether secure listeners admit HTTP/1.1 through ALPN.
 *
 * @param enabled - True to admit HTTP/1.1 alongside HTTP/2.
 * @returns A functional Node transport construction option.
 */
export function allowHTTP1(enabled: boolean): NodeHTTPTransportOption {
  return serverOption(allowNodeHTTP1(enabled))
}

/**
 * Configures client-certificate authentication for secure listeners.
 *
 * @param value - `require` verifies a client certificate against the configured CA.
 * @returns A functional Node transport construction option.
 */
export function clientAuth(value: NodeHTTPClientAuth): NodeHTTPTransportOption {
  return serverOption(nodeClientAuth(value))
}

/**
 * Creates the Node-backed HTTP Transport used for both dial and listen.
 *
 * The runtime host stays internal so applications only learn the go-micro Transport contract.
 */
export function newNodeHTTPTransport(
  ...options: readonly NodeHTTPTransportOption[] /* go-like-typed-rest: preserves construction options. */
): Transport {
  const defaultExecutor = globalThis.fetch
  const transportOptions: HTTPTransportOption[] = []
  const hostOptions: NodeHTTPHostOption[] = []
  for (const option of options) {
    if (isServerOption(option)) hostOptions.push(option)
    else transportOptions.push(option)
  }
  /** Uses Node-native pooling unless the application explicitly replaced the Fetch executor. */
  const nodeDialExecutor: HTTPDialExecutorFactory = function select(
    target,
    common,
    dial,
    fallback
  ) {
    if (fallback !== defaultExecutor) {
      if (dial.connectionClose) {
        throw newUnsupportedTransportCapabilityError("standard Fetch cannot force connection close")
      }
      if (common.tlsConfig !== null) {
        throw newUnsupportedTransportCapabilityError(
          "standard Fetch cannot use custom TLS material"
        )
      }
      return Object.freeze({
        executor: fallback,
        /** Releases a borrowed executor, which owns no transport resources. */
        close(): Promise<void> {
          return Promise.resolve()
        }
      })
    }
    return newNodeHTTPExecutor(target, common, dial)
  }
  const arguments_: unknown[] = [nodeDialExecutor]
  for (const option of transportOptions) arguments_.push(option)
  const transport = Reflect.apply(newHTTPTransportWithDialExecutor, undefined, arguments_)
  const runtimeHostArguments: unknown[] = []
  for (const option of hostOptions) runtimeHostArguments.push(option)
  const runtimeHost: ReturnType<typeof newNodeHTTPHost> = Reflect.apply(
    newNodeHTTPHost,
    undefined,
    runtimeHostArguments
  )

  return Object.freeze({
    /** Returns the stable transport kind. */
    kind(): "http" {
      return "http"
    },
    /** Applies common Transport options. */
    init(
      ...values: readonly Option[] /* go-like-typed-rest: preserves common transport options. */
    ): void {
      Reflect.apply(transport.init, transport, values)
    },
    /** Returns the current common Transport options. */
    options(): Options {
      return transport.options()
    },
    /** Dials one HTTP transport client. */
    dial(
      ctx: Context,
      address: string,
      ...values: readonly DialOption[] /* go-like-typed-rest: preserves dial options. */
    ): Promise<Client> {
      const arguments_: unknown[] = [ctx, address]
      for (const value of values) arguments_.push(value)
      return Reflect.apply(transport.dial, transport, arguments_)
    },
    /** Binds one Node HTTP listener without exposing the runtime host SPI. */
    listen(
      ctx: Context,
      address: string,
      ...values: readonly ListenOption[] /* go-like-typed-rest: preserves listen options. */
    ): Promise<Listener> {
      const selected: HTTPListenOption[] = []
      for (const value of values) {
        /** Applies one generic option to HTTP listen options. */
        function apply(options: HTTPListenOptions): HTTPListenOptions {
          return value(options)
        }
        selected.push(apply)
      }
      selected.push(host(runtimeHost))
      const arguments_: unknown[] = [ctx, address]
      for (const value of selected) arguments_.push(value)
      return Reflect.apply(transport.listen, transport, arguments_)
    },
    /** Returns the stable provider name. */
    string(): string {
      return "http"
    }
  })
}
