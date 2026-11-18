/**
 * Winston log plug.
 * Adapts an application-owned Winston logger to core `LogHandler`. Winston is a type-only import.
 */
export { newWinstonHandler } from "./handler"
export type {
  WinstonAlreadyStartedError,
  WinstonHandler,
  WinstonLoggerClosedError,
  WinstonLoggerFinishedError
} from "./types"
