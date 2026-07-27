import { newConfig, source, objectSource } from "@likego/config"
import { background } from "@likego/context"

Deno.test("built package imports through its package name", async () => {
  const config = newConfig(source(objectSource("one", { value: 1 })))
  await config.load(background())
  if (config.value("value").load() !== 1) throw new Error("unexpected config value")
  await config.close(background())
})
