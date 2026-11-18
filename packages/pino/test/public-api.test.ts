import { expect, test } from "bun:test"
import { symbols } from "pino"

import * as publicApi from "@go-like/pino/log"

function destinationDouble() {
  return {
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
}

function loggerDouble(destination: object) {
  return {
    [symbols.streamSym]: destination,
    flush(): void {},
    isLevelEnabled(): boolean {
      return true
    },
    child(): object {
      return this
    }
  }
}

test("exports the Pino log handler", () => {
  expect(Object.keys(publicApi).sort()).toEqual(["newPinoHandler", "pinoDrainTimeout"])
})

test("rejects invalid native resources and lifecycle options synchronously", () => {
  const destination = destinationDouble()
  const logger = loggerDouble(destination)
  expect(() => publicApi.newPinoHandler(logger as never, destination as never)).not.toThrow()
  expect(() => publicApi.newPinoHandler(undefined as never, destination as never)).toThrow(
    TypeError
  )
  expect(() => publicApi.newPinoHandler(logger as never, undefined as never)).toThrow(TypeError)
  expect(() =>
    publicApi.newPinoHandler({ flush(): void {} } as never, destination as never)
  ).toThrow(TypeError)
  expect(() =>
    publicApi.newPinoHandler(logger as never, { ...destination, destroy: 1 } as never)
  ).toThrow(TypeError)
  const changedEnding = { ...destination, _ending: "false" }
  const changedEndingLogger = loggerDouble(changedEnding)
  expect(() =>
    publicApi.newPinoHandler(changedEndingLogger as never, changedEnding as never)
  ).toThrow("Pino server requires an official destination state and lifecycle")
  expect(() =>
    publicApi.newPinoHandler(logger as never, destination as never, null as never)
  ).toThrow(TypeError)
  expect(() => publicApi.pinoDrainTimeout(-1)).toThrow(RangeError)
  expect(() => publicApi.pinoDrainTimeout(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  expect(() => publicApi.pinoDrainTimeout(2_147_483_648)).toThrow(RangeError)
})

test("rejects lifecycle operation drift while taking the construction snapshot", () => {
  const destination = destinationDouble()
  const firstFlush = function firstFlush(): void {}
  const changedFlush = function changedFlush(): void {}
  let reads = 0
  const logger = {
    [symbols.streamSym]: destination,
    isLevelEnabled(): boolean {
      return true
    },
    child(): object {
      return this
    },
    get flush(): typeof firstFlush {
      reads += 1
      return reads >= 4 ? changedFlush : firstFlush
    }
  }

  expect(() => publicApi.newPinoHandler(logger as never, destination as never)).toThrow(
    "Pino lifecycle methods changed during server construction"
  )
  expect(reads).toBe(4)
})
