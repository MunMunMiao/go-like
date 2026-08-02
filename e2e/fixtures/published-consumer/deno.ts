import { runPortable } from "./portable.ts"

runPortable()
try {
  Deno.env.get("HOME")
  throw new Error("published Deno consumer unexpectedly received environment permission")
} catch (error) {
  if (!(error instanceof Deno.errors.NotCapable)) throw error
}
