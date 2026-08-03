import type { Infer, Struct } from "@likego/struct"
import { decodeJson, encodeJson } from "@likego/struct/codec"
import { parseStructValue } from "@likego/struct/runtime"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
export const jsonContentType = "application/json"

/** Validates and encodes one Struct output as UTF-8 JSON. */
export function encodeJsonBody<S extends Struct>(schema: S, value: NoInfer<Infer<S>>): Uint8Array {
  const json = JSON.stringify(encodeJson(schema, parseStructValue(schema, value)))
  if (json === undefined) throw new TypeError("json body is not serializable")
  return encoder.encode(json)
}

/** Decodes one UTF-8 JSON body through the endpoint Struct. */
export function decodeJsonBody<S extends Struct>(schema: S, body: Uint8Array): Infer<S> {
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(body))
  } catch (cause) {
    throw new TypeError("json body is invalid", { cause })
  }
  return decodeJson(schema, value)
}
