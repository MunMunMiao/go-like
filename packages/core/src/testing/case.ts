/**
 * One runner-agnostic conformance case.
 * Suites return these and the caller executes `run` with bun:test, node:test, or any other runner.
 */
export interface ConformanceCase {
  readonly name: string
  run(): Promise<void>
}
