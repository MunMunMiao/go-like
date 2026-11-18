export { newNoAvailableEndpointError } from "./errors"
export {
  filterLabel,
  filterVersion,
  newEWMASelector,
  newP2CSelector,
  newRandomSelector,
  newRoundRobinSelector,
  newWeightedRoundRobinSelector
} from "./selector"
export type {
  Discovery,
  EWMASelectorOptions,
  Filter,
  NoAvailableEndpointError,
  P2CSelectorOptions,
  Registrar,
  Registry,
  RegistryProtocolError,
  RegistryStateError,
  SelectionDone,
  SelectionOutcome,
  Selector,
  ServiceEndpoint,
  ServiceInstance,
  UnsupportedRegistryCapabilityError,
  Watcher,
  WatcherOverflowError,
  WatcherStoppedError
} from "./types"
export { snapshotServiceInstance, snapshotServiceInstances } from "./snapshot"
export { selectEndpoint } from "./selection"
export type { EndpointSelection } from "./selection"
export type { RegistrationErrorHandler } from "./types"
export { newDiscoveryResolver } from "./resolver"
export type { DiscoveryResolver } from "./resolver"
