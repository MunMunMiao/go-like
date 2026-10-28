import { describe, expect, test } from "bun:test"

import { background } from "@go-like/context"
import { newConfig, source, objectSource } from "../src/index"
import { readConfig } from "./helpers"

describe("config merge", () => {
  test("recursively overrides objects while replacing arrays, scalars, and null as complete values", async () => {
    const config = newConfig(
      source(
        objectSource("base", {
          nested: { left: 1, items: [1, 2], scalar: 1, nullable: { retained: false } },
          replaced: { old: true }
        }),
        objectSource("override", {
          nested: { right: 2, items: [3], scalar: { now: true }, nullable: null },
          replaced: "whole"
        })
      )
    )

    await config.load(background())
    expect(await readConfig(config)).toEqual({
      nested: {
        left: 1,
        right: 2,
        items: [3],
        scalar: { now: true },
        nullable: null
      },
      replaced: "whole"
    })
    await config.close(background())
  })

  test("a missing later key leaves the earlier source visible", async () => {
    const overridden = newConfig(
      source(
        objectSource("base", { value: { selected: "base", retained: true } }),
        objectSource("override", { value: { selected: "override" } })
      )
    )
    await overridden.load(background())
    expect(await readConfig(overridden)).toEqual({
      value: { selected: "override", retained: true }
    })
    await overridden.close(background())

    const revealed = newConfig(
      source(
        objectSource("base", { value: { selected: "base", retained: true } }),
        objectSource("override", { value: {} })
      )
    )
    await revealed.load(background())
    expect(await readConfig(revealed)).toEqual({ value: { selected: "base", retained: true } })
    await revealed.close(background())
  })

  test("preserves source order and independent frozen values", async () => {
    const leftInput = { nested: { left: 1 } }
    const rightInput = { nested: { right: 2 } }
    const config = newConfig(
      source(
        {
          name: "left",
          /** Supplies the first mutable adapter-owned document. */
          async load() {
            return { value: leftInput, revision: null }
          }
        },
        {
          name: "right",
          /** Supplies the second mutable adapter-owned document. */
          async load() {
            return { value: rightInput, revision: "r2" }
          }
        }
      )
    )
    await config.load(background())
    const value = await readConfig(config)
    leftInput.nested.left = 9
    rightInput.nested.right = 9

    expect(value).toEqual({ nested: { left: 1, right: 2 } })
    expect(Object.isFrozen(value)).toBe(true)
    expect(value).not.toBe(leftInput)
    expect(value).not.toBe(rightInput)
    await config.close(background())
  })

  test("an invalid source snapshot revision fails without publishing", async () => {
    const runtime = JSON.parse('{"revision":2}')
    const config = newConfig(
      source({
        name: "revision",
        /** Supplies a runtime-controlled revision shape. */
        async load() {
          return { value: { ready: true }, revision: runtime.revision }
        }
      })
    )
    const failure = await config.load(background()).catch((error: unknown) => error)
    expect(failure).toMatchObject({ name: "ConfigSourceError", phase: "load" })
    expect(config.value("ready").load()).toBeNull()
  })
})
