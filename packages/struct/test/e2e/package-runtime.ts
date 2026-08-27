import * as Codec from "@go-like/struct/codec"
import * as Runtime from "@go-like/struct/runtime"
import * as Struct from "@go-like/struct"
import type { Struct as StructType } from "@go-like/struct"

const expectedRootExports = ["StructError", "setErrorMap", "struct"].sort()
const expectedCodecExports = ["decodeJson", "encodeJson"].sort()
const expectedRuntimeExports = [
  "PORTABLE_VALUE_GRAPH_DEPTH_LIMIT",
  "encodeStructValue",
  "getStructFields",
  "isObjectStruct",
  "isStruct",
  "parseStructTuple",
  "parseStructValue"
].sort()

if (JSON.stringify(Object.keys(Struct).sort()) !== JSON.stringify(expectedRootExports)) {
  throw new Error(`unexpected @go-like/struct exports: ${Object.keys(Struct).join(",")}`)
}
if (JSON.stringify(Object.keys(Codec).sort()) !== JSON.stringify(expectedCodecExports)) {
  throw new Error(`unexpected @go-like/struct/codec exports: ${Object.keys(Codec).join(",")}`)
}
if (JSON.stringify(Object.keys(Runtime).sort()) !== JSON.stringify(expectedRuntimeExports)) {
  throw new Error(`unexpected @go-like/struct/runtime exports: ${Object.keys(Runtime).join(",")}`)
}

const Quote = Struct.struct.object({
  id: Struct.struct.bigint().alias("quote_id"),
  requestedAt: Struct.struct.date().alias("requested_at")
})
const requestedAt = new Date("2026-08-03T05:05:06.000Z")
const wire = Codec.encodeJson(Quote, {
  id: 9007199254740993n,
  requestedAt
}) as {
  quote_id: string
  requested_at: string
}
if (wire.quote_id !== "9007199254740993" || wire.requested_at !== "2026-08-03T05:05:06.000Z") {
  throw new Error("built @go-like/struct JSON encode failed")
}

const decoded = Codec.decodeJson(Quote, wire)
if (decoded.id !== 9007199254740993n || decoded.requestedAt.getTime() !== requestedAt.getTime()) {
  throw new Error("built @go-like/struct JSON decode failed")
}

const [error] = Runtime.parseStructTuple(Quote, {
  id: 1,
  requestedAt: "invalid"
})
if (!(error instanceof Struct.StructError)) {
  throw new Error("built @go-like/struct runtime validation failed")
}

const [numberError, numberValue] = Runtime.parseStructTuple(
  Struct.struct.number(),
  Number.POSITIVE_INFINITY
)
if (numberError || numberValue !== Number.POSITIVE_INFINITY) {
  throw new Error("built @go-like/struct JavaScript number validation failed")
}

const Node = Struct.struct.object({
  get next(): StructType<unknown, unknown, boolean> {
    return Node.null()
  }
})
function nestedValue(depth: number): unknown {
  let value: unknown = null
  for (let index = 0; index < depth; index += 1) {
    value = { next: value }
  }
  return value
}
const [withinDepth] = Runtime.parseStructTuple(Node, nestedValue(1000))
const [overDepth] = Runtime.parseStructTuple(Node, nestedValue(1001))
if (withinDepth || !overDepth || overDepth instanceof RangeError) {
  throw new Error("built @go-like/struct portable depth limit failed")
}
Runtime.encodeStructValue(Node, nestedValue(1000))
let encodeDepthError: unknown
try {
  Runtime.encodeStructValue(Node, nestedValue(1001))
} catch (error) {
  encodeDepthError = error
}
if (!(encodeDepthError instanceof Error) || encodeDepthError instanceof RangeError) {
  throw new Error("built @go-like/struct portable encode depth limit failed")
}

console.log("go-like-struct-runtime ok")
