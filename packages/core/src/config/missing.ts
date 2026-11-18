import type { ConfigSourceMissingError } from "./config"

/** Creates the missing-document error thrown when a source is required and absent. */
export function newConfigSourceMissingError(sourceName: string): ConfigSourceMissingError {
  if (typeof sourceName !== "string" || sourceName.length === 0 || !sourceName.isWellFormed()) {
    throw new TypeError("configuration source name must be a non-empty string")
  }
  return Object.freeze(
    Object.assign(new Error(`configuration source "${sourceName}" document is missing`), {
      name: "ConfigSourceMissingError" as const,
      code: "GO_LIKE_CONFIG_SOURCE_MISSING" as const,
      sourceName
    })
  )
}
