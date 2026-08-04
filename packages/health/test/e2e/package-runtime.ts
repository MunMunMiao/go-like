import { background } from "@go-like/context"
import { newProbeRegistry } from "@go-like/health"

const lateRejections: unknown[] = []
const runtime = "Bun" in globalThis ? "bun" : "Deno" in globalThis ? "deno" : "node"

if (runtime === "node" || runtime === "bun") {
  process.on("unhandledRejection", (reason) => {
    lateRejections.push(reason)
  })
} else {
  globalThis.addEventListener("unhandledrejection", (event) => {
    lateRejections.push("reason" in event ? event.reason : event)
  })
}

const registry = newProbeRegistry()
let rejectLate: (error: Error) => void = (error) => {
  throw error
}
registry.register(
  "live",
  "late",
  () => {
    return new Promise<void>((_resolve, reject) => {
      rejectLate = reject
    })
  },
  { timeoutMs: 0 }
)

const report = await registry.check(background(), "live")
rejectLate(new Error("late rejection should be observed"))
await new Promise<void>((resolve) => setTimeout(resolve, 10))
if (report.ok !== false || lateRejections.length !== 0) {
  throw new Error(`${runtime} late rejection probe failed`)
}

console.log(
  JSON.stringify({
    runtime,
    lateRejections: lateRejections.length
  })
)
