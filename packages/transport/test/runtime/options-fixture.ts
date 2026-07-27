import type {
  DialOption,
  DialOptions,
  ListenOption,
  ListenOptions,
  Option,
  Options
} from "../../src/types"

/** Returns the approved common defaults for test-owned structural providers. */
export function defaultTestOptions(): Options {
  return Object.freeze({
    codec: null,
    logger: null,
    timeoutMs: 0,
    secure: false,
    tlsConfig: null
  })
}

/** Applies public common reducers without adding production behavior in the fixture. */
export function reduceTestOptions(...options: readonly Option[]): Options {
  let current = defaultTestOptions()
  for (const option of options) current = option(current)
  return current
}

/** Returns the approved dial defaults for test-owned structural providers. */
export function defaultTestDialOptions(): DialOptions {
  return Object.freeze({
    timeoutMs: 5_000,
    connectionClose: false
  })
}

/** Applies public dial reducers without adding production behavior in the fixture. */
export function reduceTestDialOptions(...options: readonly DialOption[]): DialOptions {
  let current = defaultTestDialOptions()
  for (const option of options) current = option(current)
  return current
}

/** Applies public listen reducers to the empty structural default. */
export function reduceTestListenOptions(...options: readonly ListenOption[]): ListenOptions {
  let current: ListenOptions = Object.freeze({})
  for (const option of options) current = option(current)
  return current
}
