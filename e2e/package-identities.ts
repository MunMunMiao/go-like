import { readFileSync } from "node:fs"
import { resolve } from "node:path"

interface PackageIdentity {
  readonly name?: string
  readonly version?: string
}

const exactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function packageVersion(path: string, expectedName: string): string {
  const value = JSON.parse(
    readFileSync(resolve(import.meta.dir, "..", path), "utf8")
  ) as PackageIdentity
  if (
    value.name !== expectedName ||
    typeof value.version !== "string" ||
    !exactSemver.test(value.version)
  ) {
    throw new TypeError(`${expectedName} must expose an exact package version`)
  }
  return value.version
}

export const transportHTTPVersion = packageVersion(
  "packages/transport/http/package.json",
  "@likego/transport-http"
)
export const transportHTTPService = `LikeGo Transport ${transportHTTPVersion}`
