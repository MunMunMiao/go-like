import { describe, expect, test } from "bun:test"

import { background } from "@go-like/context"
import * as ConfigPackage from "../src/index"

describe("config public API", () => {
  test("exports only the reviewed lower-camel runtime surface", () => {
    expect(Object.keys(ConfigPackage).sort()).toEqual([
      "newConfig",
      "objectSource",
      "onReloadError",
      "onTerminalError",
      "placeholderResolver",
      "resolver",
      "schema",
      "source"
    ])
    expect(typeof ConfigPackage.newConfig).toBe("function")
    expect(typeof ConfigPackage.objectSource).toBe("function")
    expect(() => ConfigPackage.onTerminalError(null as never)).toThrow(TypeError)
  })

  test("loads and reads one immutable value through only the public package surface", async () => {
    const config = ConfigPackage.newConfig(
      ConfigPackage.source(ConfigPackage.objectSource("defaults", { enabled: true }))
    )
    expect(Object.keys(config).sort()).toEqual(["close", "load", "scan", "value", "watch"])
    const enabled = config.value("enabled")
    expect(enabled.load()).toBeNull()
    await expect(config.load(background())).resolves.toBeUndefined()
    expect(enabled.load()).toBe(true)
    expect(config.value("enabled")).toBe(enabled)
    await config.close(background())
  })
})
