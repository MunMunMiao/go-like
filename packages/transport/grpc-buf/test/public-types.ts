import type { CallOptions, ConnectRouter, ContextValues, HandlerContext } from "@connectrpc/connect"
import type { Context } from "@go-like/context"
import type { Endpointer, Server as CoreServer } from "@go-like/core"
import type { Transport } from "@go-like/transport"
import type { Discovery, Selector } from "@go-like/registry"
import type { TLSConfig } from "@go-like/transport"
import type { fromCallContextValues } from "../src/context"
import type {
  callOptions,
  fromHandlerContext,
  newHandler,
  Routes,
  ServiceRegistrar
} from "../src/index"
import type {
  Client as NativeClient,
  ClientOption as NativeClientOption,
  Server as NativeServer,
  ServerOption as NativeServerOption,
  address as nativeAddress,
  advertise as nativeAdvertise,
  clientAuth as nativeClientAuth,
  newClient as newNativeClient,
  newServer as newNativeServer,
  tlsConfig as nativeTLSConfig,
  withBlock as withNativeBlock,
  withDiscovery as withNativeDiscovery,
  withEndpoint as withNativeEndpoint,
  withSelector as withNativeSelector,
  withTLSConfig as withNativeTLSConfig
} from "../src/native"

type Equal<Actual, Expected> =
  (<Value>() => Value extends Actual ? 1 : 2) extends <Value>() => Value extends Expected ? 1 : 2
    ? true
    : false
type Expect<Value extends true> = Value
type IsAny<Value> = 0 extends 1 & Value ? true : false
type Matches<Actual, Expected> = IsAny<Actual> extends true ? false : Equal<Actual, Expected>
type IsNotTransport<Handler> =
  IsAny<Handler> extends true ? false : Handler extends Transport ? false : true

type AnyMustNotMatchRoutes = Expect<Equal<Matches<any, (server: ServiceRegistrar) => void>, false>>
type AnyMustNotBeTransport = Expect<Equal<IsNotTransport<any>, false>>
type ServiceRegistrarSignature = Expect<Matches<ServiceRegistrar, Pick<ConnectRouter, "service">>>
type RoutesSignature = Expect<Matches<Routes, (server: ServiceRegistrar) => void>>
type NewHandlerSignature = Expect<
  Matches<typeof newHandler, (routes: Routes) => (request: Request) => Promise<Response>>
>
type FromHandlerContextSignature = Expect<
  Matches<typeof fromHandlerContext, (rpc: HandlerContext) => Context>
>
type CallOptionsSignature = Expect<
  Matches<typeof callOptions, (ctx: Context, overrides?: CallOptions) => CallOptions>
>
type FromCallContextValuesSignature = Expect<
  Matches<typeof fromCallContextValues, (values: ContextValues | undefined) => Context | null>
>
type NewHandlerIsNotTransport = Expect<Equal<IsNotTransport<typeof newHandler>, true>>
type CarrierStaysPrivate = Expect<
  Equal<"fromCallContextValues" extends keyof typeof import("../src/index") ? true : false, false>
>
type NativeClientSignature = Expect<
  Matches<typeof newNativeClient, (...options: readonly NativeClientOption[]) => NativeClient>
>
type NativeEndpointSignature = Expect<
  Matches<typeof withNativeEndpoint, (endpoint: string | readonly string[]) => NativeClientOption>
>
type NativeDiscoverySignature = Expect<
  Matches<typeof withNativeDiscovery, (discovery: Discovery) => NativeClientOption>
>
type NativeSelectorSignature = Expect<
  Matches<typeof withNativeSelector, (selector: Selector) => NativeClientOption>
>
type NativeBlockSignature = Expect<Matches<typeof withNativeBlock, () => NativeClientOption>>
type NativeTLSSignature = Expect<
  Matches<typeof withNativeTLSConfig, (config: TLSConfig | null) => NativeClientOption>
>
type NativeRootStaysPortable = Expect<
  Equal<"newClient" extends keyof typeof import("../src/index") ? true : false, false>
>
type NativeServerSignature = Expect<
  Matches<typeof newNativeServer, (...options: readonly NativeServerOption[]) => NativeServer>
>
type NativeServerAddressSignature = Expect<
  Matches<typeof nativeAddress, (value: string) => NativeServerOption>
>
type NativeServerAdvertiseSignature = Expect<
  Matches<typeof nativeAdvertise, (value: string) => NativeServerOption>
>
type NativeServerTLSSignature = Expect<
  Matches<typeof nativeTLSConfig, (value: TLSConfig | null) => NativeServerOption>
>
type NativeServerClientAuthSignature = Expect<
  Matches<typeof nativeClientAuth, (value: "none" | "require") => NativeServerOption>
>
type NativeServerIsCoreServer = Expect<Equal<NativeServer extends CoreServer ? true : false, true>>
type NativeServerIsEndpointer = Expect<Equal<NativeServer extends Endpointer ? true : false, true>>
type NativeServerIsServiceRegistrar = Expect<
  Equal<NativeServer extends ServiceRegistrar ? true : false, true>
>
type NativeClientOptionStaysDistinct = Expect<
  Equal<NativeClientOption extends NativeServerOption ? true : false, false>
>
type NativeServerOptionStaysDistinct = Expect<
  Equal<NativeServerOption extends NativeClientOption ? true : false, false>
>
type NativeServerRootStaysPortable = Expect<
  Equal<"newServer" extends keyof typeof import("../src/index") ? true : false, false>
>

export type PublicTypeAssertions = [
  AnyMustNotMatchRoutes,
  AnyMustNotBeTransport,
  ServiceRegistrarSignature,
  RoutesSignature,
  NewHandlerSignature,
  FromHandlerContextSignature,
  CallOptionsSignature,
  FromCallContextValuesSignature,
  CarrierStaysPrivate,
  NewHandlerIsNotTransport,
  NativeClientSignature,
  NativeEndpointSignature,
  NativeDiscoverySignature,
  NativeSelectorSignature,
  NativeBlockSignature,
  NativeTLSSignature,
  NativeRootStaysPortable,
  NativeServerSignature,
  NativeServerAddressSignature,
  NativeServerAdvertiseSignature,
  NativeServerTLSSignature,
  NativeServerClientAuthSignature,
  NativeServerIsCoreServer,
  NativeServerIsEndpointer,
  NativeServerIsServiceRegistrar,
  NativeClientOptionStaysDistinct,
  NativeServerOptionStaysDistinct,
  NativeServerRootStaysPortable
]
