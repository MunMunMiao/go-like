import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises"
import { join } from "node:path"

import {
  closeDurableJsonDirectory,
  isDurableJsonTemporaryComponent,
  openDurableJsonDirectory,
  readDurableJson,
  writeDurableJson,
  type DurableJsonDirectory
} from "../e2e/harness/durable-json"
import {
  canonicalTempRoot,
  createTempDirectory,
  removeTempDirectory,
  type TempDirectory
} from "../e2e/harness/temp"

const CurrentUid = typeof process.getuid === "function" ? process.getuid() : null
const CurrentGid = typeof process.getgid === "function" ? process.getgid() : null
const Posix = process.platform !== "win32" && CurrentUid !== null

async function removeOwnedEntry(path: string): Promise<void> {
  try {
    const metadata = await lstat(path)
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      await rm(path, { recursive: true, force: true })
    } else {
      await unlink(path)
    }
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error
    }
  }
}

async function closeAndRemove(
  handle: DurableJsonDirectory | null,
  directory: TempDirectory
): Promise<void> {
  if (handle !== null) await closeDurableJsonDirectory(handle).catch(() => {})
  await removeTempDirectory(directory)
}

test("durable JSON recognizes only its canonical private publication components", () => {
  expect(isDurableJsonTemporaryComponent(".durable-123e4567-e89b-42d3-a456-426614174000.tmp")).toBe(
    true
  )
  for (const component of [
    ".durable-123e4567-e89b-12d3-a456-426614174000.tmp",
    ".durable-123E4567-E89B-42D3-A456-426614174000.tmp",
    ".durable-123e4567-e89b-42d3-7456-426614174000.tmp",
    ".durable-not-a-uuid.tmp",
    ".durable-123e4567-e89b-42d3-a456-426614174000.json",
    "durable-123e4567-e89b-42d3-a456-426614174000.tmp"
  ]) {
    expect(isDurableJsonTemporaryComponent(component)).toBe(false)
  }
})

test("durable JSON writes stable bytes, reads them, syncs a private file, and closes", async () => {
  if (!Posix) return
  const directory = await createTempDirectory("go-like-durable-success-")
  let handle: DurableJsonDirectory | null = null
  try {
    handle = await openDurableJsonDirectory(directory.path, {
      containedRoot: await canonicalTempRoot()
    })
    expect(Reflect.ownKeys(handle)).toEqual([])

    await writeDurableJson(handle, "participant.json", {
      zeta: [true, null, 3],
      alpha: { second: "value", first: 1 }
    })
    expect(await Bun.file(join(directory.path, "participant.json")).text()).toBe(
      '{"alpha":{"first":1,"second":"value"},"zeta":[true,null,3]}\n'
    )
    expect(await readDurableJson(handle, "participant.json")).toEqual({
      alpha: { first: 1, second: "value" },
      zeta: [true, null, 3]
    })
    const metadata = await lstat(join(directory.path, "participant.json"))
    expect(metadata.isFile()).toBe(true)
    expect(metadata.isSymbolicLink()).toBe(false)
    expect(metadata.uid).toBe(CurrentUid)
    expect(metadata.mode & 0o777).toBe(0o600)
    expect((await readdir(directory.path)).filter((entry) => entry.includes(".tmp"))).toEqual([])

    await closeDurableJsonDirectory(handle)
    await expect(readDurableJson(handle, "participant.json")).rejects.toThrow(
      "unknown durable JSON directory handle"
    )
    await expect(closeDurableJsonDirectory(handle)).rejects.toThrow(
      "unknown durable JSON directory handle"
    )
    handle = null
  } finally {
    await closeAndRemove(handle, directory)
  }
})

test("readonly publication is complete before a second handle can observe the final name", async () => {
  if (!Posix) return
  const directory = await createTempDirectory("go-like-durable-readonly-atomic-")
  let writer: DurableJsonDirectory | null = null
  let reader: DurableJsonDirectory | null = null
  try {
    writer = await openDurableJsonDirectory(directory.path)
    reader = await openDurableJsonDirectory(directory.path)
    for (let generation = 0; generation < 64; generation += 1) {
      const component = `generation-${generation}.json`
      const writing = writeDurableJson(writer, component, { generation }, { readOnly: true })
      let observed: unknown = null
      while (!(await Bun.file(join(directory.path, component)).exists())) await Bun.sleep(0)
      observed = await readDurableJson(reader, component)
      await writing
      expect(observed).toEqual({ generation })
      expect((await lstat(join(directory.path, component))).mode & 0o777).toBe(0o400)
    }
  } finally {
    if (reader !== null) await closeDurableJsonDirectory(reader).catch(() => {})
    await closeAndRemove(writer, directory)
  }
})

test("durable JSON waits for a concurrent publication link to stabilize within its bound", async () => {
  if (!Posix) return
  const directory = await createTempDirectory("go-like-durable-link-stabilize-")
  let handle: DurableJsonDirectory | null = null
  const temporary = join(directory.path, ".durable-concurrent.tmp")
  const published = join(directory.path, "result.json")
  try {
    await writeFile(temporary, '{"complete":true}\n', { mode: 0o400 })
    await link(temporary, published)
    handle = await openDurableJsonDirectory(directory.path, {
      publicationStabilizationTimeoutMs: 500
    })
    const reading = readDurableJson(handle, "result.json")
    await Bun.sleep(25)
    await unlink(temporary)
    await expect(reading).resolves.toEqual({ complete: true })
  } finally {
    await closeAndRemove(handle, directory)
  }
})

test("durable JSON rejects a crash-left publication link without waiting forever", async () => {
  if (!Posix) return
  const directory = await createTempDirectory("go-like-durable-link-crash-")
  let handle: DurableJsonDirectory | null = null
  const temporary = join(directory.path, ".durable-crashed.tmp")
  const published = join(directory.path, "result.json")
  try {
    await writeFile(temporary, '{"complete":true}\n', { mode: 0o400 })
    await link(temporary, published)
    handle = await openDurableJsonDirectory(directory.path, {
      publicationStabilizationTimeoutMs: 50
    })
    const startedAt = performance.now()
    await expect(readDurableJson(handle, "result.json")).rejects.toThrow(
      "publication did not stabilize before its bounded deadline"
    )
    expect(performance.now() - startedAt).toBeLessThan(500)
  } finally {
    await closeAndRemove(handle, directory)
  }
})

test("durable JSON publication never replaces an existing final component", async () => {
  if (!Posix) return
  const directory = await createTempDirectory("go-like-durable-duplicate-")
  let handle: DurableJsonDirectory | null = null
  try {
    handle = await openDurableJsonDirectory(directory.path)
    await writeDurableJson(handle, "result.json", { generation: 1 }, { readOnly: true })
    await expect(
      writeDurableJson(handle, "result.json", { generation: 2, secret: "must-not-leak" })
    ).rejects.toThrow("final component already exists")
    expect(await readDurableJson(handle, "result.json")).toEqual({ generation: 1 })
    expect(await Bun.file(join(directory.path, "result.json")).text()).not.toContain(
      "must-not-leak"
    )
    expect((await lstat(join(directory.path, "result.json"))).mode & 0o777).toBe(0o400)
    expect(await readdir(directory.path)).toEqual(["result.json"])
  } finally {
    await closeAndRemove(handle, directory)
  }
})

test("durable JSON rejects every non-component path without reflecting its value", async () => {
  if (!Posix) return
  const directory = await createTempDirectory("go-like-durable-component-")
  let handle: DurableJsonDirectory | null = null
  try {
    handle = await openDurableJsonDirectory(directory.path)
    for (const component of [
      "",
      ".",
      "..",
      "../escape.json",
      "nested/value.json",
      "nested\\value.json",
      "/absolute.json",
      "secret-component-秘密.json"
    ]) {
      let failure: unknown = null
      try {
        await writeDurableJson(handle, component, { secret: "GO_LIKE_JSON_SECRET" })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      const message = failure instanceof Error ? failure.message : String(failure)
      expect(message).toBe("invalid durable JSON path component")
      if (component.length > 0) expect(message).not.toContain(component)
      expect(message).not.toContain("GO_LIKE_JSON_SECRET")
    }
    expect(await readdir(directory.path)).toEqual([])
  } finally {
    await closeAndRemove(handle, directory)
  }
})

test("durable JSON rejects symlink and overly permissive directories and enforces containment", async () => {
  if (!Posix) return
  const root = await createTempDirectory("go-like-durable-directory-")
  const outside = await createTempDirectory("go-like-durable-outside-")
  const privatePath = join(root.path, "private")
  const aliasPath = join(root.path, "alias")
  let handle: DurableJsonDirectory | null = null
  try {
    await mkdir(privatePath, { mode: 0o700 })
    await symlink(privatePath, aliasPath, "dir")
    await expect(openDurableJsonDirectory(aliasPath)).rejects.toThrow("must not be a symbolic link")

    await chmod(privatePath, 0o750)
    await expect(openDurableJsonDirectory(privatePath)).rejects.toThrow(
      "permissions are wider than 0700"
    )
    await chmod(privatePath, 0o700)

    await expect(
      openDurableJsonDirectory(outside.path, { containedRoot: root.path })
    ).rejects.toThrow("escaped its required contained root")
    await expect(openDurableJsonDirectory(`${privatePath}/.`)).rejects.toThrow(
      "must be absolute and canonical"
    )
    handle = await openDurableJsonDirectory(privatePath, { containedRoot: root.path })
    await writeDurableJson(handle, "contained.json", { contained: true })
  } finally {
    if (handle !== null) await closeDurableJsonDirectory(handle).catch(() => {})
    await removeTempDirectory(root)
    await removeTempDirectory(outside)
  }
})

test("durable JSON reads reject symlink, non-regular, and overly permissive entries", async () => {
  if (!Posix) return
  const directory = await createTempDirectory("go-like-durable-entry-")
  let handle: DurableJsonDirectory | null = null
  try {
    handle = await openDurableJsonDirectory(directory.path)
    const target = join(directory.path, "target.json")
    await writeFile(target, "{}\n", { mode: 0o600 })
    await symlink(target, join(directory.path, "symlink.json"))
    await expect(readDurableJson(handle, "symlink.json")).rejects.toThrow(
      "without following symbolic links"
    )

    await mkdir(join(directory.path, "directory.json"), { mode: 0o700 })
    await expect(readDurableJson(handle, "directory.json")).rejects.toThrow(
      "must be a regular file"
    )

    const wide = join(directory.path, "wide.json")
    await writeFile(wide, "{}\n", { mode: 0o600 })
    await chmod(wide, 0o640)
    await expect(readDurableJson(handle, "wide.json")).rejects.toThrow(
      "permissions are wider than 0600"
    )

    if (CurrentUid === 0 && CurrentGid !== null) {
      const foreign = join(directory.path, "foreign.json")
      await writeFile(foreign, "{}\n", { mode: 0o600 })
      await chown(foreign, 1, 1)
      await expect(readDurableJson(handle, "foreign.json")).rejects.toThrow(
        "is not owned by the current user"
      )
      await chown(foreign, CurrentUid, CurrentGid)
    }
  } finally {
    await closeAndRemove(handle, directory)
  }
})

test("durable JSON rejects oversized writes and reads plus invalid UTF-8 without data disclosure", async () => {
  if (!Posix) return
  const directory = await createTempDirectory("go-like-durable-bounds-")
  let handle: DurableJsonDirectory | null = null
  try {
    handle = await openDurableJsonDirectory(directory.path, { maximumBytes: 64 })
    const secret = "GO_LIKE_OVERSIZE_SECRET_VALUE"
    let writeFailure: unknown = null
    try {
      await writeDurableJson(handle, "too-large.json", { secret: secret.repeat(4) })
    } catch (error) {
      writeFailure = error
    }
    expect(writeFailure).toBeInstanceOf(Error)
    expect(writeFailure instanceof Error ? writeFailure.message : "").toBe(
      "durable JSON document exceeds the configured byte bound"
    )
    expect(writeFailure instanceof Error ? writeFailure.message : "").not.toContain(secret)
    expect(await Bun.file(join(directory.path, "too-large.json")).exists()).toBe(false)

    await writeFile(join(directory.path, "oversize.json"), new Uint8Array(65), { mode: 0o600 })
    await expect(readDurableJson(handle, "oversize.json")).rejects.toThrow(
      "exceeds the configured byte bound"
    )

    await writeFile(join(directory.path, "invalid-utf8.json"), new Uint8Array([0xc3, 0x28]), {
      mode: 0o600
    })
    await expect(readDurableJson(handle, "invalid-utf8.json")).rejects.toThrow("is not valid UTF-8")

    const invalidJsonSecret = "GO_LIKE_INVALID_JSON_SECRET"
    await writeFile(join(directory.path, "invalid-json.json"), invalidJsonSecret, { mode: 0o600 })
    let invalidJsonFailure: unknown = null
    try {
      await readDurableJson(handle, "invalid-json.json")
    } catch (error) {
      invalidJsonFailure = error
    }
    expect(invalidJsonFailure).toBeInstanceOf(Error)
    expect(invalidJsonFailure instanceof Error ? invalidJsonFailure.message : "").toBe(
      "durable JSON file is not valid JSON"
    )
    expect(invalidJsonFailure instanceof Error ? invalidJsonFailure.message : "").not.toContain(
      invalidJsonSecret
    )
  } finally {
    await closeAndRemove(handle, directory)
  }
})

test("durable JSON handles fail closed after a directory identity swap", async () => {
  if (!Posix) return
  const directory = await createTempDirectory("go-like-durable-swap-")
  const moved = `${directory.path}-moved-${randomUUID()}`
  let handle: DurableJsonDirectory | null = null
  let originalMoved = false
  try {
    handle = await openDurableJsonDirectory(directory.path)
    await writeDurableJson(handle, "before.json", { stable: true })
    await rename(directory.path, moved)
    originalMoved = true
    await mkdir(directory.path, { mode: 0o700 })
    await writeFile(join(directory.path, "canary"), "preserve", { mode: 0o600 })

    await expect(readDurableJson(handle, "before.json")).rejects.toThrow(
      "directory identity changed after opening"
    )
    await expect(writeDurableJson(handle, "after.json", { stable: false })).rejects.toThrow(
      "directory identity changed after opening"
    )
    expect(await Bun.file(join(directory.path, "canary")).text()).toBe("preserve")
    expect(await Bun.file(join(directory.path, "after.json")).exists()).toBe(false)
  } finally {
    if (handle !== null) await closeDurableJsonDirectory(handle).catch(() => {})
    if (originalMoved) {
      await removeOwnedEntry(directory.path)
      await rename(moved, directory.path)
    }
    await removeTempDirectory(directory)
  }
})

test("durable JSON rejects forged opaque handles", async () => {
  if (!Posix) return
  const forged = Object.freeze({}) as DurableJsonDirectory
  await expect(readDurableJson(forged, "result.json")).rejects.toThrow(
    "unknown durable JSON directory handle"
  )
  await expect(writeDurableJson(forged, "result.json", {})).rejects.toThrow(
    "unknown durable JSON directory handle"
  )
  await expect(closeDurableJsonDirectory(forged)).rejects.toThrow(
    "unknown durable JSON directory handle"
  )
})
