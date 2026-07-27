/** Reads one own evidence field without invoking accessors. */
function own(evidence: Readonly<Record<string, unknown>>, name: string): unknown {
  return Object.getOwnPropertyDescriptor(evidence, name)?.value
}

/** Reports whether one real-Docker scenario satisfies its exact evidence contract. */
export function validateConsulScenarioEvidence(
  name: string,
  evidence: Readonly<Record<string, unknown>>
): boolean {
  if (name === "service-instance-roundtrip") {
    return (
      own(evidence, "registerReturnedVoid") === true &&
      own(evidence, "discoveredExact") === true &&
      own(evidence, "deterministicRemoteId") === true &&
      own(evidence, "deregisterReturnedVoid") === true
    )
  }
  if (name === "replacement-snapshot-watch") {
    return (
      own(evidence, "initialSnapshot") === 1 &&
      own(evidence, "updatedSnapshot") === 1 &&
      own(evidence, "emptySnapshot") === 0 &&
      own(evidence, "watcherSurfaceExact") === true
    )
  }
  if (name === "private-ttl-heartbeat") {
    const observed = own(evidence, "heartbeatPasses")
    return (
      typeof observed === "number" &&
      Number.isInteger(observed) &&
      observed >= 2 &&
      own(evidence, "publicHandleExposed") === false
    )
  }
  return false
}

/** Freezes one scenario marker with validity derived from its complete field contract. */
export function sealConsulScenarioEvidence(
  name: string,
  evidence: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.assign({}, evidence, {
      valid: validateConsulScenarioEvidence(name, evidence)
    })
  )
}
