import { expect, test } from "bun:test"

const runtimePath = `${import.meta.dir}/portable-runtime.ts`
const marker = "LIKEGO_REGISTRY_MDNS_PORTABLE_RUNTIME="

/** Executes the source authority and returns its published result payload. */
async function runtimeResult(): Promise<Readonly<Record<string, unknown>>> {
  const process = Bun.spawn(["bun", runtimePath], {
    cwd: `${import.meta.dir}/../..`,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ])
  expect(exitCode, stderr).toBe(0)
  const line = stdout.split("\n").find(function isMarker(value): boolean {
    return value.startsWith(marker)
  })
  if (line === undefined) throw new Error("portable mDNS runtime marker is missing")
  return JSON.parse(line.slice(marker.length))
}

test("portable authority uses public runtime exports and internal testing helpers", async () => {
  const source = await Bun.file(runtimePath).text()
  expect(source).not.toContain("/dist/")
  expect(source).not.toContain("coverage-ignore")
  expect(source).toContain('from "../../../src/testing"')
  expect(source).toContain('from "../../src/testing"')
})

test("portable authority replays common and mDNS-specific behavior", async () => {
  const result = await runtimeResult()
  expect(result).toMatchObject({
    valid: true,
    conformanceCases: 3,
    scenarios: [
      "conformance",
      "registry-lifecycle",
      "domain-isolation",
      "context-cancellation",
      "testing-host"
    ],
    sockets: 0
  })
  expect(result.assertions).toBe(15)
}, 20_000)
