import { test } from "bun:test"

test("runs the canonical payments Docker scenario", async () => {
  const { main } = await import("../../e2e/docker")
  await main()
}, 300_000)
