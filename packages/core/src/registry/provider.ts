export {
  newRegistryProtocolError,
  newRegistryStateError,
  newUnsupportedRegistryCapabilityError,
  newWatcherOverflowError,
  newWatcherStoppedError
} from "./errors"
export { notifyRegistrationError, providerOptions } from "./options"
export type { ProviderOptionInput, ProviderOptions } from "./types"
export { sha256Base32 } from "./digest"
export { newSnapshotWatcher } from "./snapshot-watcher"
export type { SnapshotWatcher, SnapshotWatcherOptions } from "./snapshot-watcher"
export { newIdentityLocks } from "./locks"
export type { IdentityLocks } from "./locks"
export { startHeartbeat } from "./heartbeat"
export type { Heartbeat, HeartbeatOptions } from "./heartbeat"
