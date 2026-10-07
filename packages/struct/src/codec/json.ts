import type { AnyStructLike, Infer } from "../types"
import { decodeObjectByAlias, encodeObjectByAlias } from "./common"

/** Encodes a struct value using exact alias wire keys. */
export function encodeJson(struct: AnyStructLike, value: unknown): unknown {
  return encodeObjectByAlias(struct, value, "json")
}

/** Decodes a JSON value by exact wire key and returns `Infer<S>`. */
export function decodeJson<S extends AnyStructLike>(struct: S, value: unknown): Infer<S> {
  return decodeObjectByAlias(struct, value) as Infer<S>
}

/** Encodes a value returned by parseStructValue() without repeating its graph check. */
export function encodeParsedJson(struct: AnyStructLike, value: unknown): unknown {
  return encodeObjectByAlias(struct, value, "json", true)
}
