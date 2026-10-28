import * as webDeno from "@go-like/web/deno"

import { runPortable } from "./portable.ts"

runPortable()
if (typeof webDeno !== "object" || webDeno === null) {
  throw new Error("published Deno web export did not load as a module")
}
try {
  Deno.env.get("HOME")
  throw new Error("published Deno consumer unexpectedly received environment permission")
} catch (error) {
  if (!(error instanceof Deno.errors.NotCapable)) throw error
}
