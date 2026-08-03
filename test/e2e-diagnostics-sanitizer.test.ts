import { expect, test } from "bun:test"

import {
  boundedTail,
  createStreamingRedactor,
  errorSummary,
  redactText,
  sanitizeArgv,
  sanitizeEnvironment
} from "../e2e/harness/diagnostics"

const Canary = "canary-super-secret"

test("argv sanitizer redacts structured environment and credential values", () => {
  expect(
    sanitizeArgv([
      "docker",
      "run",
      "--env",
      `TOKEN=${Canary}`,
      "-e=PASSWORD=value",
      `-eATTACHED_TOKEN=${Canary}`,
      "API_KEY=value",
      "--password",
      Canary,
      `--api-key=${Canary}`,
      "--token",
      "--safe-flag",
      "safe"
    ])
  ).toEqual([
    "docker",
    "run",
    "--env",
    "TOKEN=<redacted>",
    "-e=PASSWORD=<redacted>",
    "-eATTACHED_TOKEN=<redacted>",
    "API_KEY=<redacted>",
    "--password",
    "<redacted>",
    "--api-key=<redacted>",
    "--token",
    "--safe-flag",
    "safe"
  ])
})

test("environment metadata exposes keys and presence only", () => {
  const metadata = sanitizeEnvironment({ Z_VALUE: Canary, A_VALUE: undefined })
  expect(metadata).toEqual([
    { key: "A_VALUE", present: false },
    { key: "Z_VALUE", present: true }
  ])
  expect(JSON.stringify(metadata)).not.toContain(Canary)
})

test("registered secrets are replaced longest first and empty secrets are ignored", () => {
  const value = `before ${Canary}-suffix and ${Canary} after`
  const redacted = redactText(value, {
    knownSecrets: ["", Canary, `${Canary}-suffix`, Canary]
  })
  expect(redacted).toBe("before <redacted> and <redacted> after")
  expect(redacted).not.toContain(Canary)
})

test("credential assignments redact escaped quotes and complete values", () => {
  const doubleQuoted = redactText(`token=\"abc\\\"${Canary}\" rest`)
  const singleQuoted = redactText(`password='abc\\'${Canary}' rest`)
  expect(doubleQuoted).toBe("token=<redacted> rest")
  expect(singleQuoted).toBe("password=<redacted> rest")
  expect(`${doubleQuoted}${singleQuoted}`).not.toContain(Canary)
})

test("streaming redactor removes secrets split across chunks and flush boundaries", () => {
  const redactor = createStreamingRedactor({ knownSecrets: [Canary] })
  const output = [
    redactor.write(`${"x".repeat(140)}${Canary.slice(0, 8)}`),
    redactor.write(Canary.slice(8)),
    redactor.write(" after"),
    redactor.end()
  ].join("")
  expect(output).toBe(`${"x".repeat(140)}<redacted> after`)
  expect(output).not.toContain(Canary)

  const insensitive = createStreamingRedactor()
  expect(`${insensitive.write("TO")}${insensitive.write("KEN=value")}${insensitive.end()}`).toBe(
    "TOKEN=<redacted>"
  )
})

test("streaming credential redaction stays bounded for values without delimiters", () => {
  const redactor = createStreamingRedactor()
  const output: string[] = [redactor.write("token=")]
  for (let index = 0; index < 1_024; index += 1) {
    const safe = redactor.write("x".repeat(4_096))
    expect(safe.length).toBeLessThanOrEqual("<redacted>".length)
    output.push(safe)
  }
  output.push(redactor.end())
  expect(output.join("")).toBe("token=<redacted>")
})

test("bounded tail and error summary retain safe bounded diagnostics", () => {
  expect(boundedTail("abcdefgh", 4)).toBe("efgh")
  expect(() => boundedTail("value", -1)).toThrow(
    "maximumCharacters must be a non-negative safe integer"
  )
  const failure = new Error(`request token=${Canary}`, {
    cause: new Error(`nested ${Canary}`)
  })
  const summary = errorSummary(failure, { knownSecrets: [Canary] }, 80)
  expect(summary).not.toContain(Canary)
  expect(summary.length).toBeLessThanOrEqual(80)
})
