import { background, type Context } from "@go-like/context"
import { type Metadata } from "@go-like/metadata"

import * as RegistryPackage from "../src/index"
import {
  filterLabel,
  filterVersion,
  newEWMASelector,
  newP2CSelector,
  newRandomSelector,
  newRoundRobinSelector,
  newWeightedRoundRobinSelector,
  type Discovery,
  type EWMASelectorOptions,
  type Filter,
  type P2CSelectorOptions,
  type Registrar,
  type Registry,
  type SelectionDone,
  type SelectionOutcome,
  type Selector,
  type ServiceEndpoint,
  type ServiceInstance,
  type Watcher
} from "../src/index"
import { snapshotServiceInstance } from "../src/provider"
import type {
  ProviderOptionInput,
  ProviderOptions,
  RegistrationErrorHandler
} from "../src/provider"

const instance: ServiceInstance = snapshotServiceInstance({
  id: "catalog-1",
  name: "catalog",
  version: "v1",
  metadata: { zone: "a" },
  endpoints: ["http://127.0.0.1:8000"]
})
const registrationErrorHandler: RegistrationErrorHandler = (_error, _service) => Promise.resolve()
const providerOptionInput: ProviderOptionInput = { onRegistrationError: registrationErrorHandler }
declare const providerOptions: ProviderOptions
const normalizedRegistrationErrorHandler: RegistrationErrorHandler | null =
  providerOptions.onRegistrationError

const watcher: Watcher = {
  next(_ctx: Context): Promise<readonly ServiceInstance[]> {
    return Promise.resolve([instance])
  },
  stop(_ctx: Context): Promise<void> {
    return Promise.resolve()
  }
}

const registrar: Registrar = {
  register(_ctx, _service): Promise<void> {
    return Promise.resolve()
  },
  deregister(_ctx, _service): Promise<void> {
    return Promise.resolve()
  }
}

const discovery: Discovery = {
  getService(_ctx, _name): Promise<readonly ServiceInstance[]> {
    return Promise.resolve([instance])
  },
  watch(_ctx, _name): Promise<Watcher> {
    return Promise.resolve(watcher)
  }
}

declare const registry: Registry
const registered: Promise<void> = registry.register(background(), instance)
const deregistered: Promise<void> = registry.deregister(background(), instance)
const discovered: Promise<readonly ServiceInstance[]> = discovery.getService(
  background(),
  "catalog"
)
const watched: Promise<Watcher> = discovery.watch(background(), "catalog")

const random: Selector = newRandomSelector(() => 0)
const roundRobin: Selector = newRoundRobinSelector()
const weighted: Selector = newWeightedRoundRobinSelector(() => 1)
const p2cOptions: P2CSelectorOptions = { random: () => 0, now: () => 0 }
const p2c: Selector = newP2CSelector(p2cOptions)
const ewmaOptions: EWMASelectorOptions = { random: () => 0, now: () => 0 }
const ewma: Selector = newEWMASelector(ewmaOptions)
const selection: readonly [ServiceEndpoint, SelectionDone] = random.select(background(), [instance])
const filters: readonly Filter[] = [filterVersion("v1"), filterLabel("zone", "a")]
declare const replyMetadata: Metadata
const compatibleOutcome: SelectionOutcome = { error: null }
const detailedOutcome: SelectionOutcome = {
  error: null,
  replyMetadata,
  bytesSent: true,
  bytesReceived: true
}

void [
  registrar,
  registered,
  deregistered,
  discovered,
  watched,
  roundRobin,
  weighted,
  p2c,
  ewma,
  selection,
  filters,
  compatibleOutcome,
  detailedOutcome,
  providerOptionInput,
  normalizedRegistrationErrorHandler
]

// @ts-expect-error Context is always the independent first argument.
registry.register(instance)
// @ts-expect-error Watch requires the service name directly.
registry.watch(background())
// @ts-expect-error TypeScript runtime exports use lower camel case.
RegistryPackage.NewRandomSelector()
