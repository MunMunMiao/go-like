import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"

import { decodeJson, encodeJson } from "../src/codec/json"
import { StructError, struct } from "../src/index"
import { encodeStructValue } from "../src/introspection"
import { decodeJsonBody, encodeJsonBody } from "../../transport/src/json"

const encoder = new TextEncoder()

/** Schema whose field getter throws the supplied cause, or overflows in a vm realm. */
function throwingSchema(cause: unknown) {
  return struct.object({
    get value(): ReturnType<typeof struct.string> {
      throw cause
    }
  })
}

/** Runs the public entries and returns the error each one surfaces. */
function entryErrors(schema: ReturnType<typeof throwingSchema>): unknown[] {
  const input = {}
  const runs = [
    () => {
      const [error, value] = struct.parse(schema, input)
      if (error) throw error
      return value
    },
    () => decodeJson(schema, input),
    () => encodeJson(schema, input),
    () => encodeStructValue(schema, input),
    () => decodeJsonBody(schema, encoder.encode("{}")),
    () => encodeJsonBody(schema, input as never)
  ]
  return runs.map((run) => {
    try {
      run()
      return undefined
    } catch (error) {
      return error
    }
  })
}

describe("Q7-04 call-stack overflow identification", () => {
  test("a RangeError that only contains a stack message keeps its identity", () => {
    const causes = [
      new RangeError("upstream Maximum call stack size exceeded: remote counter exceeded"),
      new RangeError("data contains too much recursion in label")
    ]
    for (const cause of causes) {
      for (const error of entryErrors(throwingSchema(cause))) {
        expect(error).toBe(cause)
      }
    }
  })

  test("a real cross-realm stack overflow becomes StructError", () => {
    const foreign = runInNewContext(
      "(()=>{try{function f(n){return f(n+1)+1};f(0)}catch(e){return e}})()"
    ) as { name: unknown; message: unknown }
    expect(Object.prototype.toString.call(foreign)).toBe("[object Error]")
    expect(foreign instanceof RangeError).toBe(false)
    expect(foreign.name).toBe("RangeError")
    expect(["Maximum call stack size exceeded", "Maximum call stack size exceeded."]).toContain(
      String(foreign.message)
    )
    for (const error of entryErrors(throwingSchema(foreign))) {
      expect(error).toBeInstanceOf(StructError)
      expect(error).not.toBe(foreign)
      expect((error as StructError).message).toContain("supported call stack depth")
    }
  })

  test("exact engine stack messages are converted, including a constructed InternalError", () => {
    const causes = [
      new RangeError("Maximum call stack size exceeded"),
      new RangeError("Maximum call stack size exceeded."),
      new RangeError("too much recursion"),
      Object.assign(new Error("too much recursion"), { name: "InternalError" })
    ]
    for (const cause of causes) {
      for (const error of entryErrors(throwingSchema(cause))) {
        expect(error).toBeInstanceOf(StructError)
      }
    }
  })

  test("ordinary errors keep their identity", () => {
    const tagged = Object.assign(Object.create(null), {
      [Symbol.toStringTag]: "Error",
      name: 1,
      message: "Maximum call stack size exceeded"
    })
    const causes = [
      new RangeError("ordinary range error"),
      new TypeError("ordinary type"),
      new Error("ordinary error"),
      "string cause",
      { name: "RangeError", message: "Maximum call stack size exceeded" },
      tagged
    ]
    for (const cause of causes) {
      for (const error of entryErrors(throwingSchema(cause))) {
        expect(error).toBe(cause)
      }
    }
  })
})
