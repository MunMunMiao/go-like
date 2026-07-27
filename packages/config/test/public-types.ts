import { background, type Context } from "@likego/context"
import type { StandardSchemaV1 } from "@standard-schema/spec"

import * as ConfigPackage from "../src/index"
import type {
  Config,
  ConfigAlreadyLoadedError,
  ConfigNotFoundError,
  ConfigObject,
  ConfigOption,
  ConfigReloadErrorHandler,
  ConfigResolver,
  ConfigScalar,
  ConfigSchema,
  ConfigSource,
  ConfigSourceError,
  ConfigSourceSnapshot,
  ConfigSourceWatcher,
  ConfigTerminalErrorHandler,
  ConfigValidationError,
  ConfigValue,
  Observer,
  Value
} from "../src/index"
import {
  newConfig,
  objectSource,
  onReloadError,
  onTerminalError,
  placeholderResolver,
  resolver as configResolver,
  schema as configSchema,
  source as configSource
} from "../src/index"

/** Narrows the ConfigObject input exposed to a Standard Schema validator. */
function isObject(value: unknown): value is ConfigObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

const source: ConfigSource = objectSource("typed", { enabled: true, port: 8080 })
const sourceOption: ConfigOption = configSource(source)
const raw: Config = newConfig(sourceOption)
const load: Promise<void> = raw.load(background())
const closing: Promise<void> = raw.close(background())
const context: Context = background()
const current: Value = raw.value("port")
const observer: Observer = function observer(key, value) {
  const watchedKey: string = key
  const watchedValue: ConfigValue | null = value.load()
  void [watchedKey, watchedValue]
}
const watched: void = raw.watch("port", observer)

const numberSchema = {
  "~standard": {
    version: 1,
    vendor: "types-number",
    validate(value: unknown) {
      return typeof value === "number" ? { value } : { issues: [{ message: "number required" }] }
    }
  }
} satisfies StandardSchemaV1<ConfigValue, number>
const scannedValue: Promise<number> = current.scan(background(), numberSchema)

const rootSchema = {
  "~standard": {
    version: 1,
    vendor: "types-root",
    validate(value: unknown) {
      return isObject(value)
        ? { value: { enabled: value.enabled === true } }
        : { issues: [{ message: "object required" }] }
    }
  }
} satisfies StandardSchemaV1<ConfigObject, { readonly enabled: boolean }>
const scannedRoot: Promise<{ readonly enabled: boolean }> = raw.scan(background(), rootSchema)

const transformedSchema = {
  "~standard": {
    version: 1,
    vendor: "types",
    validate(_value: unknown) {
      return { value: { transformed: "yes" } }
    }
  }
} satisfies ConfigSchema<{ readonly transformed: string }>
const schemaOption: ConfigOption<{ readonly transformed: string }> = configSchema(transformedSchema)
const transformedInline = newConfig(configSource(source), configSchema(transformedSchema))
const transformedStored = newConfig(configSource(source), schemaOption)
const transformed: Config<{ readonly transformed: string }> = transformedInline
const transformedLoad: Promise<void> = transformedStored.load(background())
const transformedScan = transformed.scan(background(), {
  "~standard": {
    version: 1,
    vendor: "transformed-scan",
    validate(_value) {
      return { value: "yes" }
    }
  }
} satisfies StandardSchemaV1<{ readonly transformed: string }, string>)

const invalidOutputSchema = {
  "~standard": {
    version: 1,
    vendor: "invalid-output",
    validate(_value: unknown) {
      return { value: new Date() }
    }
  }
} satisfies StandardSchemaV1<ConfigObject, Date>

const watcher: ConfigSourceWatcher = {
  next(_ctx: Context): Promise<void> {
    return Promise.resolve()
  },
  stop(_ctx: Context): Promise<void> {
    return Promise.resolve()
  }
}
const watcherNext: Promise<void> = watcher.next(background())
const sourceSnapshot: Promise<ConfigSourceSnapshot> = source.load(background())
const reload: ConfigReloadErrorHandler = (_error, lastGood) => {
  const retained: ConfigValue | null = lastGood
  void retained
}
const reloadOption: ConfigOption = onReloadError(reload)
const terminal: ConfigTerminalErrorHandler = async (_error) => {}
const terminalOption: ConfigOption = onTerminalError(terminal)
const placeholders: ConfigResolver = placeholderResolver()
const resolverOption: ConfigOption = configResolver(placeholders)
const scalar: ConfigScalar = "value"
const value: ConfigValue = { scalar }
declare const notFound: ConfigNotFoundError
declare const alreadyLoaded: ConfigAlreadyLoadedError
declare const sourceError: ConfigSourceError
declare const validationError: ConfigValidationError

void [
  load,
  closing,
  context,
  watched,
  scannedValue,
  scannedRoot,
  transformed,
  transformedLoad,
  transformedScan,
  watcherNext,
  sourceSnapshot,
  reload,
  reloadOption,
  terminal,
  terminalOption,
  placeholders,
  resolverOption,
  value,
  alreadyLoaded,
  notFound,
  sourceError,
  validationError
]

// @ts-expect-error Schema output Date is outside the ConfigValue contract.
configSchema(invalidOutputSchema)
// @ts-expect-error Config is a structural value, not a constructable class.
new raw()
// @ts-expect-error Explicit load requires Context as its independent first argument.
raw.load()
// @ts-expect-error Complete scan requires Context and Standard Schema.
raw.scan(rootSchema)
// @ts-expect-error Value scan requires Context and Standard Schema.
current.scan(numberSchema)
// @ts-expect-error Dotted keys are strings, matching Kratos.
raw.value(["port"])
// @ts-expect-error Watch requires an observer.
raw.watch("port")
// @ts-expect-error The superseded snapshot read model is absent.
raw.snapshot()
// @ts-expect-error The superseded subscribe read model is absent.
raw.subscribe(observer)
// @ts-expect-error Config is not a Core Server.
raw.start(context)
// @ts-expect-error Config is not a Core Server.
raw.stop(context)
// @ts-expect-error The package has no PascalCase callable alias.
ConfigPackage.NewConfig
// @ts-expect-error The package has no PascalCase resolver alias.
ConfigPackage.Resolver
// @ts-expect-error ConfigSourceSnapshot is type-only at runtime.
ConfigPackage.ConfigSourceSnapshot
