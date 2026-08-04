export {}

const secret = process.env.GO_LIKE_E2E_CANARY ?? "missing-secret"
const mode = process.argv[2] ?? "success"

process.stdout.write(`prefix token=\"${secret.slice(0, 5)}`)
await Bun.sleep(5)
process.stdout.write(`\\\"quoted-${secret.slice(5)}\" suffix ${secret}\n`)
process.stderr.write(`stderr -eGO_LIKE_TOKEN=${secret}\n`)

if (mode === "failure") process.exitCode = 17
