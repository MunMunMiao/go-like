import { describe, expect, test } from "bun:test"

import { newConfig, onReloadError, source as configSource } from "@go-like/config"
import { fileSource, type FileCapability } from "@go-like/config/file"
import { decodeYaml } from "@go-like/config/yaml"
import { background } from "@go-like/context"

import * as YamlConfig from "../src/yaml"

describe("YAML configuration decoder", () => {
  test("decodes nested values, Unicode, safe integers, and timestamp text", () => {
    expect(
      decodeYaml(`
service:
  name: 配置服务
  enabled: true
  ports: [8080, 8443]
  ratio: 1.5
  releasedAt: 2026-07-21T08:30:00Z
  optional: null
`)
    ).toEqual({
      service: {
        name: "配置服务",
        enabled: true,
        ports: [8080, 8443],
        ratio: 1.5,
        releasedAt: "2026-07-21T08:30:00Z",
        optional: null
      }
    })
  })

  test.each([
    ["empty", ""],
    ["scalar root", "value\n"],
    ["array root", "- one\n- two\n"],
    ["multiple documents", "one: 1\n---\ntwo: 2\n"],
    ["duplicate key", "one: 1\none: 2\n"],
    ["custom tag", "one: !custom value\n"],
    ["alias", "one: &value { nested: true }\ntwo: *value\n"],
    ["alias cycle", "one: &value { nested: *value }\n"],
    ["unsafe key", "nested:\n  __proto__: unsafe\n"],
    ["unsafe integer", "one: 9007199254740992\n"],
    ["positive infinity", "one: .inf\n"],
    ["not a number", "one: .nan\n"]
  ])("rejects %s", (_name, input) => {
    expect(() => decodeYaml(input)).toThrow()
  })

  test("exports only the lower-camel decoder", () => {
    expect(Object.keys(YamlConfig)).toEqual(["decodeYaml"])
  })

  test("works as the existing file decoder and preserves the last-good Config value", async () => {
    let text = "service:\n  enabled: true\n"
    let changed: () => void = function missingWatcher(): void {
      throw new Error("file watcher was not installed")
    }
    const closed = Promise.withResolvers<void>()
    const reloaded = Promise.withResolvers<Error>()
    const capability: FileCapability = {
      /** Returns the currently controlled YAML document. */
      async read() {
        return { text, revision: "controlled" }
      },
      /** Captures one native change callback and exposes a stable close barrier. */
      async watch(_ctx, _path, notify) {
        changed = notify
        return {
          async stop() {
            closed.resolve()
          },
          done() {
            return closed.promise
          }
        }
      }
    }
    const source = fileSource(capability, "config.yaml", { decode: decodeYaml })
    const config = newConfig(
      configSource(source),
      onReloadError(function observe(error): void {
        reloaded.resolve(error)
      })
    )

    await config.load(background())
    const good = config.value("service").load()
    text = "service: true\nservice: false\n"
    changed()
    await reloaded.promise
    expect(config.value("service").load()).toBe(good)
    await config.close(background())
  })
})

if (false) {
  // @ts-expect-error The decoder accepts source text, not pre-parsed values.
  decodeYaml({ service: true })
  // @ts-expect-error The package has no Go-style PascalCase decoder alias.
  YamlConfig.DecodeYaml
}
