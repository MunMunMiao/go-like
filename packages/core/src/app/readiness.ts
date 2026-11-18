/** Phases a ready probe can report. `ready` itself never appears on the error. */
export type AppPhase = "created" | "starting" | "ready" | "stopping" | "stopped"

/** Failure reported by `readyProbe` outside the ready window. */
export interface AppNotReadyError extends Error {
  readonly name: "AppNotReadyError"
  readonly code: "GO_LIKE_APP_NOT_READY"
  readonly phase: Exclude<AppPhase, "ready">
}

/** Mutable phase read by the ready probe and the stop sequence. */
export interface PhaseCell {
  phase: AppPhase
}

/** Builds the stable not-ready error for the current phase. */
export function appNotReady(phase: Exclude<AppPhase, "ready">): AppNotReadyError {
  const error = new Error(`application is ${phase}`) as AppNotReadyError
  Object.defineProperty(error, "name", { value: "AppNotReadyError" })
  Object.defineProperty(error, "code", { value: "GO_LIKE_APP_NOT_READY" })
  Object.defineProperty(error, "phase", { value: phase })
  return error
}

/** Probe body. It passes only while the phase is `ready`. */
export function readyProbeBody(cell: PhaseCell): void {
  if (cell.phase === "ready") return
  throw appNotReady(cell.phase)
}
