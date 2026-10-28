interface UserRouteContext {
  readonly params: {
    readonly id: string
  }
}

/**
 * Returns the selected user identifier from Elysia's inferred route parameters.
 *
 * @param context - Elysia route context containing the path parameter.
 * @returns A framework-identifying response value for Elysia to serialize.
 */
export function userRoute(context: UserRouteContext): Readonly<{ framework: string; id: string }> {
  return Object.freeze({ framework: "elysia", id: context.params.id })
}
