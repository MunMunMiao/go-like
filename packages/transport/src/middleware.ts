import type { Context } from "@likego/context"

/** Performs one Context-first operation with an explicitly typed result and argument tail. */
export type Handler<Input, Result, Arguments extends readonly unknown[] = readonly []> = (
  ctx: Context,
  input: Input,
  ...arguments_: Arguments
) => Result

/** Wraps one Context-first Handler without changing its input, result, or argument contract. */
export type Middleware<Input, Result, Arguments extends readonly unknown[] = readonly []> = (
  next: Handler<Input, Result, Arguments>
) => Handler<Input, Result, Arguments>

/** Composes middleware so the first declaration is the outermost operation layer. */
export function chain<Input, Result, Arguments extends readonly unknown[]>(
  handler: Handler<Input, Result, Arguments>,
  ...middleware: readonly Middleware<
    Input,
    Result,
    Arguments
  >[] /* likego-typed-rest: preserves ordered middleware declarations. */
): Handler<Input, Result, Arguments> {
  if (typeof handler !== "function") throw new TypeError("handler must be a function")
  let composed = handler
  for (let index = middleware.length - 1; index >= 0; index -= 1) {
    const wrapper = middleware[index]
    if (typeof wrapper !== "function") throw new TypeError("middleware must be a function")
    const candidate = wrapper(composed)
    if (typeof candidate !== "function") {
      throw new TypeError("middleware must return a handler function")
    }
    composed = candidate
  }
  return composed
}
