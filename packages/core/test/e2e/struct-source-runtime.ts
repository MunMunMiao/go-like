import * as SourceStruct from "../../src/struct/index"
import type { Struct as StructType } from "../../src/struct/index"
import * as Runtime from "../../src/struct/introspection"

const sourceQuote = SourceStruct.struct.object({
  id: SourceStruct.struct.bigint().alias("quote_id"),
  requestedAt: SourceStruct.struct.date().alias("requested_at")
})
const [error] = Runtime.parseStructTuple(sourceQuote, { id: 1, requestedAt: "invalid" })
if (!SourceStruct.isStructError(error)) {
  throw new Error("built @go-like/core/struct runtime validation failed")
}
const [numberError, numberValue] = Runtime.parseStructTuple(
  SourceStruct.struct.number(),
  Number.POSITIVE_INFINITY
)
if (numberError || numberValue !== Number.POSITIVE_INFINITY) {
  throw new Error("built @go-like/core/struct JavaScript number validation failed")
}
const Node = SourceStruct.struct.object({
  get next(): StructType<unknown, unknown, boolean> {
    return Node.null()
  }
})

function nestedValue(depth: number): unknown {
  let nested: unknown = null
  for (let index = 0; index < depth; index += 1) nested = { next: nested }
  return nested
}

const [withinDepth] = Runtime.parseStructTuple(Node, nestedValue(1000))
const [overDepth] = Runtime.parseStructTuple(Node, nestedValue(1001))
if (withinDepth || !overDepth || overDepth instanceof RangeError) {
  throw new Error("built @go-like/core/struct portable depth limit failed")
}
Runtime.encodeStructValue(Node, nestedValue(1000))
let encodeDepthError: unknown
try {
  Runtime.encodeStructValue(Node, nestedValue(1001))
} catch (caught) {
  encodeDepthError = caught
}
if (!(encodeDepthError instanceof Error) || encodeDepthError instanceof RangeError) {
  throw new Error("built @go-like/core/struct portable encode depth limit failed")
}
