/** A runner-neutral executable conformance case. */
export interface ConformanceCase {
  readonly name: string

  /** Executes the case and rejects when the public contract is violated. */
  run(): Promise<void>
}

/** A minimal runner bridge capable of registering runner-neutral cases. */
export interface ConformanceHarness {
  /** Registers one case with the host test runner. */
  register(testCase: ConformanceCase): void
}
