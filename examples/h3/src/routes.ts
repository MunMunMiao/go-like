/**
 * Returns the stable canary payload serialized by H3.
 *
 * @returns A framework-identifying health payload.
 */
export function statusRoute(): Readonly<{ framework: string; ok: boolean }> {
  return Object.freeze({ framework: "h3", ok: true })
}
