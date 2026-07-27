import { expect, test } from "bun:test"
import { symbols } from "pino"

import * as publicApi from "../src/index"

test("exports the native Pino lifecycle and request logging adapters", () => {
  expect(Object.keys(publicApi).sort()).toEqual([
    "logBroker",
    "logClient",
    "logUnaryMiddleware",
    "logWebHandler",
    "newPinoServer",
    "pinoDrainTimeout"
  ])
})

test("rejects invalid native resources and lifecycle options synchronously", () => {
  const destination = {
    _ending: false,
    destroyed: false,
    writable: true,
    end(): void {},
    destroy(): void {},
    once(): unknown {
      return this
    },
    on(): unknown {
      return this
    },
    removeListener(): unknown {
      return this
    }
  }
  const logger = { [symbols.streamSym]: destination, flush(): void {} }
  expect(() => publicApi.newPinoServer(logger as never, destination as never)).not.toThrow()
  expect(() => publicApi.newPinoServer(undefined as never, destination as never)).toThrow(TypeError)
  expect(() => publicApi.newPinoServer(logger as never, undefined as never)).toThrow(TypeError)
  expect(() =>
    publicApi.newPinoServer({ flush(): void {} } as never, destination as never)
  ).toThrow(TypeError)
  expect(() =>
    publicApi.newPinoServer(logger as never, { ...destination, destroy: 1 } as never)
  ).toThrow(TypeError)
  const changedEnding = { ...destination, _ending: "false" }
  const changedEndingLogger = { [symbols.streamSym]: changedEnding, flush(): void {} }
  expect(() =>
    publicApi.newPinoServer(changedEndingLogger as never, changedEnding as never)
  ).toThrow("Pino server requires an official destination state and lifecycle")
  expect(() =>
    publicApi.newPinoServer(logger as never, destination as never, null as never)
  ).toThrow(TypeError)
  expect(() => publicApi.pinoDrainTimeout(-1)).toThrow(RangeError)
  expect(() => publicApi.pinoDrainTimeout(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  expect(() => publicApi.pinoDrainTimeout(2_147_483_648)).toThrow(RangeError)
})

test("rejects lifecycle operation drift while taking the construction snapshot", () => {
  const destination = {
    _ending: false,
    destroyed: false,
    writable: true,
    end(): void {},
    destroy(): void {},
    once(): unknown {
      return this
    },
    on(): unknown {
      return this
    },
    removeListener(): unknown {
      return this
    }
  }
  const firstFlush = function firstFlush(): void {}
  const changedFlush = function changedFlush(): void {}
  let reads = 0
  const logger = {
    [symbols.streamSym]: destination,
    get flush(): typeof firstFlush {
      reads += 1
      return reads >= 4 ? changedFlush : firstFlush
    }
  }

  expect(() => publicApi.newPinoServer(logger as never, destination as never)).toThrow(
    "Pino lifecycle methods changed during server construction"
  )
  expect(reads).toBe(4)
})
