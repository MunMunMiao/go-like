import type { ConfigSource, ConfigValue } from "@go-like/config"

import * as EnvironmentConfig from "../src/env"
import { envSource, type EnvSourceOptions, type EnvironmentRecord } from "../src/env"

const environment: EnvironmentRecord = { APP_PORT: "8080" }
const options: EnvSourceOptions = {
  prefix: "APP_",
  /** Proves callback input and output types remain connected. */
  decode(value, name, path): ConfigValue {
    const inputs: readonly [string, string, readonly string[]] = [value, name, path]
    void inputs
    return Number(value)
  }
}
const source: ConfigSource = envSource(environment, options)
void source

// @ts-expect-error The factory is context-independent but requires an explicit environment record.
envSource()
// @ts-expect-error Environment values must be strings or undefined.
envSource({ PORT: 8080 })
// @ts-expect-error The package has no Go-style PascalCase factory alias.
EnvironmentConfig.EnvSource
