/** Creates the immutable shared error returned while a circuit is open or already probing. */
function newCircuitOpenError(): Error {
  const error = new Error("circuit breaker is open")
  error.name = "CircuitOpenError"
  return Object.freeze(error)
}

export const circuitOpen = newCircuitOpenError()
