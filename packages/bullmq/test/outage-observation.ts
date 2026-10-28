/** Counts only application Worker errors observed after the controlled outage baseline. */
export function outageErrorDelta(errors: readonly Error[], baseline: number): number {
  if (!Number.isInteger(baseline) || baseline < 0 || baseline > errors.length) {
    throw new RangeError("outage error baseline must identify an existing observation prefix")
  }
  return errors.length - baseline
}
