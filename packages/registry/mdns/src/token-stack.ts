/** Describes the mutable liveness shared by one exact registration generation. */
export interface TokenGeneration {
  readonly identity: string
  active: boolean
}

/** Returns the latest live generation in one logical identity stack. */
export function currentToken<T extends TokenGeneration>(stack: readonly T[] | undefined): T | null {
  if (stack === undefined) return null
  for (const token of stack.slice().reverse()) if (token.active) return token
  return null
}

/** Returns the latest live generation after excluding one staged mutation set. */
export function currentTokenExcept<T extends TokenGeneration>(
  stack: readonly T[] | undefined,
  excluded: ReadonlySet<T>
): T | null {
  if (stack === undefined) return null
  for (const token of stack.slice().reverse())
    if (token.active && !excluded.has(token)) return token
  return null
}

/** Deactivates and removes one exact generation without disturbing live survivors. */
export function removeToken<T extends TokenGeneration>(stacks: Map<string, T[]>, token: T): void {
  token.active = false
  const stack = stacks.get(token.identity)
  if (stack === undefined) return
  const index = stack.indexOf(token)
  if (index >= 0) stack.splice(index, 1)
  if (stack.length === 0) stacks.delete(token.identity)
}
