import { snapshotServiceInstance } from "./snapshot"
import type {
  ProviderLogger,
  ProviderOptionInput,
  ProviderOptions,
  RegistrationErrorHandler,
  ServiceInstance
} from "./types"

const MaximumTimerMs = 2_147_483_647

/** Reports whether a value can structurally carry public option fields. */
function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

/** Validates one finite integer against inclusive portable bounds. */
function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

/** Validates one structural Registry logger without taking ownership of it. */
function loggerSnapshot(value: ProviderLogger | null): ProviderLogger | null {
  if (value === null) return null
  if (!isObjectLike(value) || typeof value.log !== "function") {
    throw new TypeError("Registry logger must implement log or be null")
  }
  return value
}

/** Validates one borrowed terminal registration observer. */
function registrationErrorHandlerSnapshot(
  value: RegistrationErrorHandler | null
): RegistrationErrorHandler | null {
  if (value === null) return null
  if (typeof value !== "function") {
    throw new TypeError("Registry onRegistrationError must be callable or null")
  }
  return value
}

/** Validates and freezes one shared provider option snapshot. */
export function providerOptions(value: ProviderOptionInput): ProviderOptions {
  if (!isObjectLike(value)) throw new TypeError("Registry provider options must be an object")
  return Object.freeze({
    logger: loggerSnapshot(value.logger ?? null),
    onRegistrationError: registrationErrorHandlerSnapshot(value.onRegistrationError ?? null),
    timeoutMs: boundedInteger(
      value.timeoutMs ?? 5_000,
      1,
      MaximumTimerMs,
      "Registry provider timeoutMs"
    )
  })
}

/** Notifies one borrowed terminal observer without transferring lifecycle ownership. */
export function notifyRegistrationError(
  handler: RegistrationErrorHandler | null,
  error: Error,
  service: ServiceInstance
): void {
  if (handler === null) return
  const snapshot = snapshotServiceInstance(service)
  try {
    const result = handler(error, snapshot)
    void Promise.resolve(result).catch(function ignoreObserverFailure(): void {})
  } catch {
    return
  }
}
