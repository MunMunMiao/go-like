import type { BunRuntime } from "../../../src/web/bun-server"

/** Fails type checking when the structural BunRuntime drifts from the installed Bun types. */
export const runtime: BunRuntime = Bun
