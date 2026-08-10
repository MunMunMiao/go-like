import { expect, test } from "bun:test"
import {
  bufferedLengthBeforeDisconnect,
  createDrainByteCounter,
  decideBodyRecoveryAfterDisconnect,
  enqueueBufferedBody,
  isByteExactEncoding,
  isPrematureCloseError,
  isRecoverableBufferedBody,
  normalizeAbortError,
  normalizeIncomingMethod,
  pullIncomingBody,
  resolveDirectPrebufferedBody,
  resolveBufferedBody,
  settleBodyRecoveryDecision,
  validateDirectReadMethod,
  type BufferedBodySnapshot
} from "../../src/node-fetch-bridge-logic"

function snapshot(overrides: Partial<BufferedBodySnapshot> = {}): BufferedBodySnapshot {
  return {
    complete: true,
    canRead: true,
    readableEncoding: null,
    readableDidRead: false,
    readableLength: 0,
    bufferedLengthBeforeDisconnect: undefined,
    cached: undefined,
    errored: undefined,
    contentLength: undefined,
    ...overrides
  }
}

test("classifies byte encodings and recoverable request snapshots", () => {
  expect(isByteExactEncoding(null)).toBe(true)
  expect(isByteExactEncoding("latin1")).toBe(true)
  expect(isByteExactEncoding("utf8")).toBe(false)
  expect(isRecoverableBufferedBody(snapshot())).toBe(true)
  expect(isRecoverableBufferedBody(snapshot({ complete: false }))).toBe(false)
  expect(isRecoverableBufferedBody(snapshot({ canRead: false }))).toBe(false)
  expect(isRecoverableBufferedBody(snapshot({ readableEncoding: "utf8" }))).toBe(false)
  expect(bufferedLengthBeforeDisconnect(snapshot({ readableLength: 4 }), undefined)).toBe(4)
  expect(bufferedLengthBeforeDisconnect(snapshot({ readableDidRead: true }), 3)).toBe(3)
  expect(bufferedLengthBeforeDisconnect(snapshot({ complete: false }), 3)).toBe(3)
})

test("resolves buffered bodies, cache, stream errors, length mismatches, and chunks", () => {
  expect(
    resolveBufferedBody(snapshot({ cached: Buffer.from("cached") }), undefined, () => null)
  ).toEqual(Buffer.from("cached"))
  const error = Object.assign(new Error("bad stream"), { code: "EPIPE" })
  expect(resolveBufferedBody(snapshot({ errored: error }), [], () => null)).toBe(error)
  expect(
    resolveBufferedBody(
      snapshot({ bufferedLengthBeforeDisconnect: 1, readableLength: 2 }),
      [],
      () => null
    )
  ).toBeInstanceOf(TypeError)
  expect(resolveBufferedBody(snapshot({ contentLength: "4" }), [], () => "abc")).toBeInstanceOf(
    TypeError
  )
  expect(resolveBufferedBody(snapshot({ contentLength: "3" }), [], () => "abc")).toEqual(
    Buffer.from("abc")
  )
  expect(
    resolveBufferedBody(snapshot({ readableDidRead: true }), undefined, () => null)
  ).toBeUndefined()
  expect(resolveBufferedBody(snapshot({ complete: false }), [], () => null)).toBeUndefined()
  expect(resolveBufferedBody(snapshot({}), [Buffer.from("a")], () => Buffer.from("b"))).toEqual(
    Buffer.from("ab")
  )
})

test("enqueues buffered bytes and errors into web streams", async () => {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      enqueueBufferedBody(controller, Buffer.from("body"))
    }
  })
  expect(await new Response(readable).text()).toBe("body")
  const failure = new Error("failure")
  const errored = new ReadableStream<Uint8Array>({
    start(controller) {
      enqueueBufferedBody(controller, failure)
    }
  })
  await expect(new Response(errored).text()).rejects.toThrow("failure")
})

test("counts drained body bytes and enforces the configured ceiling", () => {
  let forceCalls = 0
  const count = createDrainByteCounter(4, () => {
    forceCalls += 1
  })
  count({ length: 2 })
  count({ length: 2 })
  expect(forceCalls).toBe(0)
  count({ length: 1 })
  expect(forceCalls).toBe(1)
})

test("pulls incoming bodies from recovery or an ordinary Web reader", async () => {
  let readCalls = 0
  const recovered = new ReadableStream<Uint8Array>({
    pull(controller) {
      return pullIncomingBody(controller, Buffer.from("recovered"), async () => {
        readCalls += 1
        return { done: true, value: undefined }
      })
    }
  })
  expect(await new Response(recovered).text()).toBe("recovered")
  expect(readCalls).toBe(0)

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("ordinary"))
      controller.close()
    }
  })
  const reader = source.getReader()
  const ordinary = new ReadableStream<Uint8Array>({
    pull(controller) {
      return pullIncomingBody(controller, undefined, () => reader.read())
    }
  })
  expect(await new Response(ordinary).text()).toBe("ordinary")

  const recoveredError = new ReadableStream<Uint8Array>({
    pull(controller) {
      return pullIncomingBody(controller, new Error("recovery failed"), async () => ({
        done: true,
        value: undefined
      }))
    }
  })
  await expect(new Response(recoveredError).text()).rejects.toThrow("recovery failed")

  const rejectedReader = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("read failed"))
    }
  }).getReader()
  const rejected = new ReadableStream<Uint8Array>({
    pull(controller) {
      return pullIncomingBody(controller, undefined, () => rejectedReader.read())
    }
  })
  await expect(new Response(rejected).text()).rejects.toThrow("read failed")
})

test("resolves direct prebuffered bodies without Node stream objects", async () => {
  expect(resolveDirectPrebufferedBody(undefined)).toBeUndefined()
  expect(await resolveDirectPrebufferedBody(Buffer.from("body"))).toEqual(Buffer.from("body"))
  await expect(resolveDirectPrebufferedBody(new Error("unusable"))).rejects.toThrow("unusable")
})

test("normalizes and validates methods", () => {
  expect(normalizeIncomingMethod(undefined)).toBe("GET")
  expect(normalizeIncomingMethod("")).toBe("GET")
  expect(normalizeIncomingMethod("DELETE")).toBe("DELETE")
  expect(normalizeIncomingMethod("GET")).toBe("GET")
  expect(normalizeIncomingMethod("HEAD")).toBe("HEAD")
  expect(normalizeIncomingMethod("OPTIONS")).toBe("OPTIONS")
  expect(normalizeIncomingMethod("PATCH")).toBe("PATCH")
  expect(normalizeIncomingMethod("POST")).toBe("POST")
  expect(normalizeIncomingMethod("PUT")).toBe("PUT")
  expect(normalizeIncomingMethod("QUERY")).toBe("QUERY")
  expect(normalizeIncomingMethod("post")).toBe("POST")
  expect(normalizeIncomingMethod("delete")).toBe("DELETE")
  expect(normalizeIncomingMethod("get")).toBe("GET")
  expect(normalizeIncomingMethod("head")).toBe("HEAD")
  expect(normalizeIncomingMethod("options")).toBe("OPTIONS")
  expect(normalizeIncomingMethod("patch")).toBe("patch")
  expect(normalizeIncomingMethod("put")).toBe("PUT")
  expect(normalizeIncomingMethod("query")).toBe("query")
  expect(normalizeIncomingMethod("PURGE")).toBe("PURGE")
  expect(validateDirectReadMethod("bad method")?.message).toContain("not a valid")
  expect(validateDirectReadMethod("CONNECT")?.message).toContain("unsupported")
  expect(validateDirectReadMethod("trace")?.message).toContain("unsupported")
  expect(validateDirectReadMethod("TRACK")?.message).toContain("unsupported")
  expect(validateDirectReadMethod("POST")).toBeUndefined()
  expect(validateDirectReadMethod("TRACE")).toBeUndefined()
})

test("normalizes abort errors and response close errors", () => {
  const incoming = new Error("incoming")
  expect(normalizeAbortError(incoming, "reason")).toBe(incoming)
  expect(normalizeAbortError(undefined, new Error("reason"))).toEqual(new Error("reason"))
  expect(normalizeAbortError(undefined, "reason")).toEqual(new Error("reason"))
  expect(normalizeAbortError(undefined, undefined).message).toBe(
    "Client connection prematurely closed."
  )
  expect(isPrematureCloseError({ code: "ERR_STREAM_PREMATURE_CLOSE" })).toBe(true)
  expect(isPrematureCloseError({ code: "OTHER" })).toBe(false)
  expect(isPrematureCloseError(null)).toBe(false)
})

test("decides disconnected body recovery outcomes", () => {
  const body = Buffer.from("body")
  expect(decideBodyRecoveryAfterDisconnect(snapshot(), undefined, () => body, undefined)).toEqual({
    kind: "resolve",
    body
  })
  expect(
    decideBodyRecoveryAfterDisconnect(
      snapshot({ readableEncoding: "utf8" }),
      undefined,
      () => body,
      undefined
    )
  ).toEqual({ kind: "not-recoverable" })
  const nonReset = Object.assign(new Error("bad"), { code: "EPIPE" })
  expect(decideBodyRecoveryAfterDisconnect(snapshot(), nonReset, () => body, undefined)).toEqual({
    kind: "not-recoverable"
  })
  const recoveredError = new Error("failed")
  expect(
    decideBodyRecoveryAfterDisconnect(snapshot(), undefined, () => recoveredError, "abort")
  ).toEqual({ kind: "reject", error: recoveredError })
  expect(
    decideBodyRecoveryAfterDisconnect(snapshot(), undefined, () => undefined, "abort")
  ).toEqual({ kind: "reject", error: new Error("abort") })
  expect(
    decideBodyRecoveryAfterDisconnect(snapshot(), undefined, () => undefined, new Error("abort"))
  ).toEqual({ kind: "reject", error: new Error("abort") })
  expect(
    decideBodyRecoveryAfterDisconnect(snapshot(), undefined, () => undefined, undefined)
  ).toEqual({ kind: "reject", error: new Error("Client connection prematurely closed.") })
})

test("settles body recovery decisions through ordinary callbacks", () => {
  const settled: Array<Buffer | unknown> = []
  let finishCalls = 0
  const finish = (): boolean => {
    finishCalls += 1
    return true
  }
  const resolve = (body: Buffer): void => {
    settled.push(body)
  }
  const reject = (error: unknown): void => {
    settled.push(error)
  }
  expect(settleBodyRecoveryDecision({ kind: "not-recoverable" }, finish, resolve, reject)).toBe(
    false
  )
  expect(
    settleBodyRecoveryDecision(
      { kind: "resolve", body: Buffer.from("body") },
      finish,
      resolve,
      reject
    )
  ).toBe(true)
  const failure = new Error("failed")
  expect(
    settleBodyRecoveryDecision({ kind: "reject", error: failure }, finish, resolve, reject)
  ).toBe(true)
  expect(
    settleBodyRecoveryDecision(
      { kind: "resolve", body: Buffer.from("late") },
      () => false,
      resolve,
      reject
    )
  ).toBe(true)
  expect(finishCalls).toBe(2)
  expect(settled).toEqual([Buffer.from("body"), failure])
})
