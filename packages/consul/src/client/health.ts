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

/** Executes one JSON query and fully consumes its response before settling. */
export async function queryText(
  options: RegistryWire,
  operation: "readback" | "get" | "watch",
  url: URL,
  signal: AbortSignal,
  missingIsEmpty: boolean
): Promise<readonly [string, string | null, number]> {
  const response = await executeRegistry(
    options,
    operation,
    consulRequest(options, url, "GET", null, signal, "application/json")
  )
  if (missingIsEmpty && response.status === 404) {
    discardBody(response, ignoreFailure)
    const result: readonly [string, string | null, number] = [
      "",
      response.headers.get("X-Consul-Index"),
      response.status
    ]
    return Object.freeze(result)
  }
  if (!response.ok) {
    discardBody(response, ignoreFailure)
    throw newConsulHttpError(registryOperation(operation), response.status)
  }
  const text = await response.text()
  const result: readonly [string, string | null, number] = [
    text,
    response.headers.get("X-Consul-Index"),
    response.status
  ]
  return Object.freeze(result)
}
