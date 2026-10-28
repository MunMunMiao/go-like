import type { DenoRuntime } from "../../src/deno-server"

/** Fails `deno check` when the structural DenoRuntime drifts from the installed Deno types. */
export const runtime: DenoRuntime = Deno
