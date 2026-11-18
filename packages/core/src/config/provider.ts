/**
 * SDK for ConfigSource and ConfigDecoder plugs.
 * Application code should use `@go-like/core/config`.
 */
export { newSourceWatcher } from "./source-watcher"
export type { SourceWatcher, SourceWatcherOptions } from "./source-watcher"
export { newConfigSourceMissingError } from "./missing"
export { admitConfigObject } from "./value"
