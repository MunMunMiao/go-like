/**
 * Pino log plug.
 * Adapts an application-owned Pino logger to core `LogHandler` and owns the transferred destination.
 */
export { newPinoHandler, pinoDrainTimeout } from "./handler"
export type {
  PinoAlreadyStartedError,
  PinoDestinationClosedError,
  PinoDrainTimeoutError,
  PinoHandler,
  PinoHandlerOption
} from "./types"
export type {} from "../thread-stream-node26-compat"
