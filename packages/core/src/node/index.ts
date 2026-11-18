import process from "node:process"
import { constants } from "node:os"

import type { AppOption } from "../app/options"
import { runtimeInstaller } from "../app/runtime"

/**
 * Signal names owned by core.
 * The 37 names match `@types/node`'s `NodeJS.Signals` and stay aligned through a drift test, so this public declaration does not reference `@types/node`.
 */
export type ProcessSignal =
  | "SIGABRT"
  | "SIGALRM"
  | "SIGBUS"
  | "SIGCHLD"
  | "SIGCONT"
  | "SIGFPE"
  | "SIGHUP"
  | "SIGILL"
  | "SIGINT"
  | "SIGIO"
  | "SIGIOT"
  | "SIGKILL"
  | "SIGPIPE"
  | "SIGPOLL"
  | "SIGPROF"
  | "SIGPWR"
  | "SIGQUIT"
  | "SIGSEGV"
  | "SIGSTKFLT"
  | "SIGSTOP"
  | "SIGSYS"
  | "SIGTERM"
  | "SIGTRAP"
  | "SIGTSTP"
  | "SIGTTIN"
  | "SIGTTOU"
  | "SIGUNUSED"
  | "SIGURG"
  | "SIGUSR1"
  | "SIGUSR2"
  | "SIGVTALRM"
  | "SIGWINCH"
  | "SIGXCPU"
  | "SIGXFSZ"
  | "SIGBREAK"
  | "SIGLOST"
  | "SIGINFO"

interface SignalRegistration {
  readonly signal: ProcessSignal
  readonly listener: () => void
}

/** Returns the conventional Unix exit code for one signal. */
function signalExitCode(value: ProcessSignal): number {
  const number = constants.signals[value]
  return number === undefined ? 1 : 128 + number
}

/**
 * Stops the owning App on the first of the listed signals.
 * The default set is SIGTERM, SIGQUIT, and SIGINT. The listener sets `process.exitCode` to `128 + signo`.
 */
export function signal(
  ...signals: readonly ProcessSignal[] /* go-like-typed-rest: preserves the Go-style functional-option ABI. */
): AppOption {
  const selected: ProcessSignal[] = []
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
