import { test } from "bun:test"

import { runManagedFaultTests } from "./e2e/native-faults.js"

test("native RPC cancellation, drain, large slow streams, peer reset and close", async () => {
  await runManagedFaultTests()
}, 20_000)
