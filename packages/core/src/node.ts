import process from "node:process"
import { constants } from "node:os"

import { runtimeInstaller, type AppOption } from "./app"

interface SignalRegistration {
  readonly signal: NodeJS.Signals
  readonly listener: () => void
}

/** Returns the conventional Unix exit code for one signal. */
function signalExitCode(value: NodeJS.Signals): number {
  const number = constants.signals[value]
  return number === undefined ? 1 : 128 + number
}

/** Adds Node-compatible process signals to the owning App lifecycle. */
export function signal(
  ...signals: readonly NodeJS.Signals[] /* likego-typed-rest: preserves the Go-style functional-option ABI. */
): AppOption {
  const selected: NodeJS.Signals[] = []
  if (signals.length === 0) {
    selected.push("SIGTERM", "SIGQUIT", "SIGINT")
  } else {
    for (const value of signals) {
      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError("signal must be a non-empty process signal name")
      }
      if (!selected.includes(value)) selected.push(value)
    }
  }

  return runtimeInstaller((stop) => {
    const registrations: SignalRegistration[] = []
    let admitted = false
    /** Removes every signal listener owned by this App option. */
    const removeListeners = (): void => {
      for (const registration of registrations) {
        process.off(registration.signal, registration.listener)
      }
    }
    try {
      for (const value of selected) {
        /** Admits the first signal and delegates shutdown to the same App.stop operation. */
        const listener = (): void => {
          if (admitted) return
          admitted = true
          process.exitCode = signalExitCode(value)
          removeListeners()
          void stop().catch(() => {
            process.exitCode = 1
          })
        }
        process.on(value, listener)
        registrations.push({ signal: value, listener })
      }
    } catch (error) {
      removeListeners()
      throw error
    }

    return removeListeners
  })
}
