import type { Context } from "@likego/context"

import type {
  AcceptHandler,
  DialOption,
  DialOptions,
  Listener,
  ListenOption,
  ListenOptions,
  Message,
  Options,
  Socket,
  Transport
} from "../src/index"
import type { TransportConformanceFaultHarness } from "../src/testing"

type Assert<T extends true> = T
type Not<T extends boolean> = T extends true ? false : true
type HasContextOption<T> = "context" extends keyof T ? true : false
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false

type OptionsHaveNoHiddenContext = Assert<Not<HasContextOption<Options>>>
type DialOptionsHaveNoHiddenContext = Assert<Not<HasContextOption<DialOptions>>>
type ListenOptionsHaveNoHiddenContext = Assert<Not<HasContextOption<ListenOptions>>>
type TransportDialParameters = Assert<
  Equal<
    Parameters<Transport["dial"]>,
    [ctx: Context, address: string, ...options: readonly DialOption[]]
  >
>
type TransportListenParameters = Assert<
  Equal<
    Parameters<Transport["listen"]>,
    [ctx: Context, address: string, ...options: readonly ListenOption[]]
  >
>
type SocketRecvParameters = Assert<Equal<Parameters<Socket["recv"]>, [ctx: Context]>>
type SocketSendParameters = Assert<
  Equal<Parameters<Socket["send"]>, [ctx: Context, message: Message]>
>
type SocketCloseParameters = Assert<Equal<Parameters<Socket["close"]>, [ctx: Context]>>
type ListenerCloseParameters = Assert<Equal<Parameters<Listener["close"]>, [ctx: Context]>>
type ListenerAcceptParameters = Assert<
  Equal<Parameters<Listener["accept"]>, [ctx: Context, handler: AcceptHandler]>
>
type AcceptHandlerParameters = Assert<
  Equal<Parameters<AcceptHandler>, [ctx: Context, socket: Socket]>
>
type FaultHarnessParameters = Assert<
  Equal<
    Parameters<TransportConformanceFaultHarness["failListener"]>,
    [ctx: Context, listener: Listener, cause: Error]
  >
>

export type ContextBoundaryProof = readonly [
  OptionsHaveNoHiddenContext,
  DialOptionsHaveNoHiddenContext,
  ListenOptionsHaveNoHiddenContext,
  TransportDialParameters,
  TransportListenParameters,
  SocketRecvParameters,
  SocketSendParameters,
  SocketCloseParameters,
  ListenerCloseParameters,
  ListenerAcceptParameters,
  AcceptHandlerParameters,
  FaultHarnessParameters
]
