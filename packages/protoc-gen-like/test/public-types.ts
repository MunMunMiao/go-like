import type { Plugin } from "@bufbuild/protoplugin"
import type { protocGenLike } from "../src/index"

type Equal<Actual, Expected> =
  (<Value>() => Value extends Actual ? 1 : 2) extends <Value>() => Value extends Expected ? 1 : 2
    ? true
    : false
type Expect<Value extends true> = Value
type IsAny<Value> = 0 extends 1 & Value ? true : false
type Matches<Actual, Expected> = IsAny<Actual> extends true ? false : Equal<Actual, Expected>

type AnyMustNotMatchPlugin = Expect<Equal<Matches<any, Plugin>, false>>
type ProtocGenLikeSignature = Expect<Matches<typeof protocGenLike, Plugin>>

export type PublicTypeAssertions = [AnyMustNotMatchPlugin, ProtocGenLikeSignature]
