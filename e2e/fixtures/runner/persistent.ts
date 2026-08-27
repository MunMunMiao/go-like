const readyPath = process.argv[2]
const output = process.argv[3]

if (readyPath === undefined) throw new Error("ready path is required")

process.on("SIGTERM", function ignore() {})
await Bun.write(readyPath, "ready")
if (output === "stdout") process.stdout.write("DESCENDANT_READY\n")
await new Promise(function never() {})

export {}
