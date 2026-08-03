export {
  newRegistryProtocolError,
  newRegistryStateError,
  newUnsupportedRegistryCapabilityError,
  newWatcherOverflowError,
  newWatcherStoppedError
} from "./errors"
export { notifyRegistrationError, providerOptions } from "./options"
export { snapshotServiceInstance, snapshotServiceInstances } from "./snapshot"
export type {
  ProviderLogger,
  ProviderLogLevel,
  ProviderOptionInput,
  ProviderOptions,
  RegistrationErrorHandler
} from "./types"
