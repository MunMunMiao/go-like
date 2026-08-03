export {}

const secret = process.env.LIKEGO_E2E_CANARY ?? "missing-secret"
const mode = process.argv[2] ?? "success"

process.stdout.write(`prefix token=\"${secret.slice(0, 5)}`)
await Bun.sleep(5)
process.stdout.write(`\\\"quoted-${secret.slice(5)}\" suffix ${secret}\n`)
process.stderr.write(`stderr -eLIKEGO_TOKEN=${secret}\n`)

if (mode === "failure") process.exitCode = 17
