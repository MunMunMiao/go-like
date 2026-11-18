import { decodeCompiledJsonTree } from "../compile-decode"
import { encodeCompiledJson } from "../compile-encode"
import { issue, StructError } from "../errors"
import type { AnyStructLike, Infer } from "../types"
import { decodeObjectByAlias, encodeObjectByAlias } from "./common"

/** UTF-8 JSON bytes for one struct value. */
export interface JsonCodec<T> {
  readonly mediaType: "application/json"
  /** `utf8(JSON.stringify(encodeJson(struct, value)))`. */
  encode(value: T): Uint8Array
  /** `decodeJson(struct, JSON.parse(fatalUtf8(bytes)))`. Invalid UTF-8, JSON, or values throw StructError. */
  decode(bytes: Uint8Array): T
}

/** Builds a JSON byte codec for one struct. */
export function jsonCodec<S extends AnyStructLike>(schema: S): JsonCodec<Infer<S>> {
  return {
    mediaType: "application/json",
    /** Encodes one value as UTF-8 JSON using wire aliases. */
    encode(value: Infer<S>): Uint8Array {
      return new TextEncoder().encode(JSON.stringify(encodeJson(schema, value)))
    },
    /** Decodes UTF-8 JSON bytes and validates them with the struct. */
    decode(bytes: Uint8Array): Infer<S> {
      if (!(bytes instanceof Uint8Array))
        throw new TypeError("jsonCodec decode requires a Uint8Array")
      let text: string
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        throw new StructError([issue([], "custom", "UTF-8 JSON", undefined, "invalid UTF-8")])
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new StructError([issue([], "custom", "JSON", undefined, "invalid JSON")])
      }
      return decodeJson(schema, parsed)
    }
  }
}

/** Encodes a struct value using exact alias wire keys. */
export function encodeJson(struct: AnyStructLike, value: unknown): unknown {
  return encodeObjectByAlias(struct, value, "json")
}

/** Decodes a JSON value by exact wire key and returns `Infer<S>`. */
export function decodeJson<S extends AnyStructLike>(struct: S, value: unknown): Infer<S> {
  return decodeObjectByAlias(struct, value) as Infer<S>
}

/** Decodes a JSON.parse data tree. Failures, unsupported schemas, and over-deep trees use decodeJson's interpreter. */
export function decodeJsonTree<S extends AnyStructLike>(struct: S, tree: unknown): Infer<S> {
  return decodeCompiledJsonTree(struct, tree) as Infer<S>
}

/** Encodes a value returned by parseStructValue() without repeating its graph check. */
export function encodeParsedJson(struct: AnyStructLike, value: unknown): unknown {
  return encodeObjectByAlias(struct, value, "json", true)
}

/** Equivalent to encodeParsedJson(struct, parseStructValue(struct, value)), including its errors. */
export function encodeValidatedJson(struct: AnyStructLike, value: unknown): unknown {
  return encodeCompiledJson(struct, value)
}
