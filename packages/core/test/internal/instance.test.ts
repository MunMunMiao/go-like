import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "bun:test"

import { coreVersion } from "../../src/internal/version"

const slot = Symbol.for("go-like.core.instances")
const fix = "Plugs must declare @go-like/core as a peer dependency of the same version."

interface InstanceModule {
  readonly coreInstance: {
    readonly version: string
    readonly url: string
  }
}

interface SlotSnapshot {
  readonly present: boolean
  readonly value: unknown
}

interface DuplicateFailure {
  readonly name: string
  readonly code: string
  readonly message: string
  readonly constructorName: string
}

const brandModules = [
  "src/context/internal.ts",
  "src/struct/symbols.ts",
  "src/metadata/index.ts",
  "src/app/identity.ts",
  "src/app/options.ts",
  "src/telemetry/internal/state.ts",
  "src/transport/transport-info.ts",
  "src/transport/errors.ts",
  "src/broker/provider.ts"
] as const

let generation = 0

function captureSlot(): SlotSnapshot {
  return { present: Reflect.has(globalThis, slot), value: Reflect.get(globalThis, slot) }
}

function restoreSlot(saved: SlotSnapshot): void {
  if (!saved.present) {
    Reflect.deleteProperty(globalThis, slot)
    return
  }
  Object.defineProperty(globalThis, slot, {
    configurable: true,
    enumerable: false,
    value: saved.value,
    writable: true
  })
}

function clearSlot(): void {
  Reflect.deleteProperty(globalThis, slot)
}

function plantSlot(records: readonly { readonly version: string; readonly url: string }[]): void {
  Object.defineProperty(globalThis, slot, {
    configurable: true,
    enumerable: false,
    value: Object.freeze(records.map((record) => Object.freeze({ ...record }))),
    writable: false
  })
}

async function loadInstance(): Promise<InstanceModule> {
  generation += 1
  const specifier = `../../src/internal/instance.ts?generation=${generation}`
  return (await import(specifier)) as InstanceModule
}

async function loadFailure(): Promise<DuplicateFailure> {
  try {
    await loadInstance()
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    const thrown = error as Error
    const code = Reflect.get(thrown, "code")
    return {
      name: thrown.name,
      code: typeof code === "string" ? code : "",
      message: thrown.message,
      constructorName: thrown.constructor.name
    }
  }
  throw new Error("expected duplicate core instance")
}

function sourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path))
    else if (entry.endsWith(".ts")) found.push(path)
  }
  return found
}

test("first registration succeeds", async () => {
  const saved = captureSlot()
  clearSlot()
  try {
    const loaded = await loadInstance()
    expect(loaded.coreInstance.version).toBe(coreVersion)
    expect(loaded.coreInstance.url.includes("?")).toBe(false)
    expect(loaded.coreInstance.url.includes("#")).toBe(false)
    expect(loaded.coreInstance.url.includes("internal/instance.ts")).toBe(true)
    expect(Object.isFrozen(loaded.coreInstance)).toBe(true)
    const recorded: unknown = Reflect.get(globalThis, slot)
    expect(Object.isFrozen(recorded)).toBe(true)
    expect(recorded).toEqual([loaded.coreInstance])
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, slot)
    expect(descriptor?.configurable).toBe(true)
    expect(descriptor?.enumerable).toBe(false)
    expect(descriptor?.writable).toBe(false)
    expect(Object.keys(loaded).sort()).toEqual(["coreInstance"])
  } finally {
    restoreSlot(saved)
  }
})

test("a record with a different url throws", async () => {
  const saved = captureSlot()
  clearSlot()
  plantSlot([{ version: coreVersion, url: "file:///other/instance.ts" }])
  const planted = Reflect.get(globalThis, slot)
  try {
    const error = await loadFailure()
    expect(error).toEqual({
      name: "CoreInstanceError",
      code: "GO_LIKE_CORE_DUPLICATE_INSTANCE",
      constructorName: "Error",
      message: error.message
    })
    expect(error.message).toContain("file:///other/instance.ts")
    expect(error.message).toContain("internal/instance.ts")
    expect(error.message).toContain(coreVersion)
    expect(error.message).toContain(fix)
    expect(Reflect.get(globalThis, slot)).toBe(planted)
  } finally {
    restoreSlot(saved)
  }
})

test("a record with a different version throws", async () => {
  const saved = captureSlot()
  clearSlot()
  try {
    const first = await loadInstance()
    plantSlot([{ version: "9.9.9", url: first.coreInstance.url }])
    const planted = Reflect.get(globalThis, slot)
    const error = await loadFailure()
    expect(error.name).toBe("CoreInstanceError")
    expect(error.code).toBe("GO_LIKE_CORE_DUPLICATE_INSTANCE")
    expect(error.constructorName).toBe("Error")
    expect(error.message).toContain("9.9.9")
    expect(error.message).toContain(coreVersion)
    expect(error.message).toContain(first.coreInstance.url)
    expect(error.message).toContain(fix)
    expect(Reflect.get(globalThis, slot)).toBe(planted)
  } finally {
    restoreSlot(saved)
  }
})

test("the same url and version does not throw", async () => {
  const saved = captureSlot()
  clearSlot()
  try {
    const first = await loadInstance()
    const recorded = Reflect.get(globalThis, slot)
    const second = await loadInstance()
    expect(second.coreInstance).toEqual(first.coreInstance)
    expect(second.coreInstance.url).toBe(first.coreInstance.url)
    expect(Reflect.get(globalThis, slot)).toBe(recorded)
    expect(recorded).toEqual([first.coreInstance])

    plantSlot([{ version: first.coreInstance.version, url: first.coreInstance.url }])
    const planted = Reflect.get(globalThis, slot)
    const third = await loadInstance()
    expect(third.coreInstance).toEqual(first.coreInstance)
    expect(Reflect.get(globalThis, slot)).toBe(planted)
  } finally {
    restoreSlot(saved)
  }
})

test("brand-owning modules use the coreInstance binding", () => {
  const root = join(import.meta.dir, "../..")
  for (const relative of brandModules) {
    const source = readFileSync(join(root, relative), "utf8")
    const uses = source.match(/\bcoreInstance\b/g) ?? []
    expect(uses.length).toBeGreaterThan(1)
    expect(
      source.includes('from "../internal/instance"') ||
        source.includes('from "../../internal/instance"')
    ).toBe(true)
  }
})

test("production code does not read the instance slot to decide identity", () => {
  const root = join(import.meta.dir, "../../src")
  const offenders = sourceFiles(root).filter((path) => {
    if (path.endsWith(`${join("internal", "instance.ts")}`)) return false
    return readFileSync(path, "utf8").includes("go-like.core.instances")
  })
  expect(offenders).toEqual([])
})
