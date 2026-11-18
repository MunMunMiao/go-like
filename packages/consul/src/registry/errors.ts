/** Preserves a primary failure and appends ordered rollback failures. */
export function rollbackFailure(primary: Error, failures: readonly Error[]): Error {
  if (failures.length === 0) return primary
  const errors: Error[] = [primary]
  for (const failure of failures) errors.push(failure)
  return new AggregateError(errors, "Consul mutation failed and rollback was incomplete")
}
