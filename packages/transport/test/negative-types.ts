import type { Context } from "@go-like/context"

import type {
  Client,
  DialOption,
  DialOptions,
  Listener,
  ListenOption,
  ListenOptions,
  Options,
  Transport,
  TransportHandler
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
type ClientFetchParameters = Assert<
  Equal<Parameters<Client["fetch"]>, [ctx: Context, request: Request]>
>
type ClientCloseParameters = Assert<Equal<Parameters<Client["close"]>, [ctx: Context]>>
type ListenerCloseParameters = Assert<Equal<Parameters<Listener["close"]>, [ctx: Context]>>
type ListenerServeParameters = Assert<
  Equal<Parameters<Listener["serve"]>, [ctx: Context, handler: TransportHandler]>
>
type TransportHandlerParameters = Assert<
  Equal<Parameters<TransportHandler>, [ctx: Context, request: Request]>
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
  ClientFetchParameters,
  ClientCloseParameters,
  ListenerCloseParameters,
  ListenerServeParameters,
  TransportHandlerParameters,
  FaultHarnessParameters
]
