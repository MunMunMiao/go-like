import { newConsulHttpError } from "./errors"
import {
  consulRequest,
  discardBody,
  executeRegistry,
  registryOperation,
  type RegistryWire
} from "./http"

/** Observes one intentionally detached best-effort body cancellation. */
function ignoreFailure(_value: unknown): void {}

/** Executes one agent mutation and optionally accepts an already-missing record. */
export async function mutate(
  options: RegistryWire,
  operation: "register" | "heartbeat" | "deregister",
  url: URL,
  body: string | null,
  signal: AbortSignal,
  missingIsSuccess: boolean
): Promise<"accepted" | "missing"> {
  const response = await executeRegistry(
    options,
    operation,
    consulRequest(options, url, "PUT", body, signal, "application/json")
  )
  if (response.ok) {
    discardBody(response, ignoreFailure)
    return "accepted"
  }
  if (missingIsSuccess && response.status === 404) {
    discardBody(response, ignoreFailure)
    return "missing"
  }
  discardBody(response, ignoreFailure)
  throw newConsulHttpError(registryOperation(operation), response.status)
}
