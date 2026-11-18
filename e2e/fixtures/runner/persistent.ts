const readyPath = process.argv[2]
const output = process.argv[3]

if (readyPath === undefined) throw new Error("ready path is required")

process.on("SIGTERM", function ignore() {})
// Lifetime cap: the driving tests finish within 15 s, so 60 s changes no assertion but bounds a leak
// when the test process vanishes. No parent-loss exit here: the supervision tests must prove the
// supervisor kills orphaned descendants itself.
setTimeout(() => process.exit(124), 60_000)
await Bun.write(readyPath, "ready")
if (output === "stdout") process.stdout.write("DESCENDANT_READY\n")
await new Promise(function never() {})

export {}
