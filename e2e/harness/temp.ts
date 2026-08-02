import { isAbsolute, relative, resolve } from "node:path"

import { errorValue } from "./result"
import {
  canonicalSecureTempRoot,
  closeSecureDirectory,
  createSecurePrivateDirectory,
  createSecureTempDirectory,
  removeSecureDirectoryTree,
  secureDirectoryLeaseConsumed,
  secureDirectoryPath,
  verifySecureDirectory,
  type SecureDirectory
} from "./secure-filesystem"

export interface TempDirectory {
  readonly path: string
}

interface DirectoryState {
  readonly root: SecureDirectory
  readonly children: SecureDirectory[]
  closing: boolean
}

const TempPrefixPattern = /^[a-z0-9][a-z0-9_.-]{0,63}-$/u
const TempComponentPattern = /^(?!\.{1,2}$)[@a-zA-Z0-9][@a-zA-Z0-9_.-]{0,127}$/u
const issuedDirectories = new WeakMap<object, DirectoryState>()

/** Returns whether a candidate is a strict descendant of one canonical root. */
export function isPathContained(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate))
  return (
    child.length > 0 &&
    child !== ".." &&
    !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(child)
  )
}

/** Resolves the canonical private per-user leaf beneath the platform temp directory. */
export async function canonicalTempRoot(): Promise<string> {
  return await canonicalSecureTempRoot()
}

/** Creates one validated opaque directory handle under the canonical user temp root. */
export async function createTempDirectory(prefix: string): Promise<TempDirectory> {
  if (!TempPrefixPattern.test(prefix)) throw new Error("invalid LikeGo temp directory prefix")
  const root = await createSecureTempDirectory(prefix)
  const directory = Object.freeze({ path: secureDirectoryPath(root) })
  issuedDirectories.set(directory, { root, children: [], closing: false })
  return directory
}

function stateFor(directory: TempDirectory): DirectoryState {
  const state = issuedDirectories.get(directory)
  if (state === undefined || state.closing) {
    throw new Error("unknown LikeGo temp directory handle")
  }
  return state
}

function validateComponentPaths(componentPaths: readonly (readonly string[])[]): void {
  if (componentPaths.length === 0) throw new Error("LikeGo temp subdirectories require a path")
  for (const components of componentPaths) {
    if (components.length === 0) throw new Error("LikeGo temp subdirectory requires a component")
    for (const component of components) {
      if (!TempComponentPattern.test(component)) {
        throw new Error(`invalid LikeGo temp path component ${JSON.stringify(component)}`)
      }
    }
  }
}

/** Creates runner-owned child paths through retained directory descriptors. */
export async function createTempSubdirectories(
  directory: TempDirectory,
  componentPaths: readonly (readonly string[])[]
): Promise<readonly string[]> {
  const state = stateFor(directory)
  validateComponentPaths(componentPaths)
  await verifySecureDirectory(state.root)

  const created = new Map<string, SecureDirectory>([["", state.root]])
  const results: string[] = []
  for (const components of componentPaths) {
    let key = ""
    for (const component of components) {
      const childKey = `${key}\u0000${component}`
      let child = created.get(childKey)
      if (child === undefined) {
        const parent = created.get(key)
        if (parent === undefined) throw new Error("LikeGo temp path parent was not created")
        try {
          child = await createSecurePrivateDirectory(parent, component)
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EEXIST") {
            throw new Error(`LikeGo temp path component already exists: ${component}`, {
              cause: error
            })
          }
          throw error
        }
        created.set(childKey, child)
        state.children.push(child)
      }
      key = childKey
    }
    const result = created.get(key)
    if (result === undefined) throw new Error("LikeGo temp path was not created")
    results.push(secureDirectoryPath(result))
  }
  return Object.freeze(results)
}

/** Creates one runner-owned child path without traversing pre-existing components. */
export async function createTempSubdirectory(
  directory: TempDirectory,
  components: readonly string[]
): Promise<string> {
  const created = await createTempSubdirectories(directory, [components])
  const path = created[0]
  if (path === undefined) throw new Error("LikeGo temp subdirectory was not created")
  return path
}

/** Revalidates every retained runner-owned directory before an external spawn boundary. */
export async function verifyTempDirectory(directory: TempDirectory): Promise<void> {
  const state = stateFor(directory)
  await verifySecureDirectory(state.root)
  for (const child of state.children) await verifySecureDirectory(child)
}

/** Removes only the unchanged directory object issued by this module. */
export async function removeTempDirectory(directory: TempDirectory): Promise<void> {
  const state = stateFor(directory)
  state.closing = true
  try {
    await verifySecureDirectory(state.root)
    for (const child of state.children) await verifySecureDirectory(child)
  } catch (error) {
    state.closing = false
    throw error
  }

  const failures: Error[] = []
  while (state.children.length > 0) {
    const child = state.children.at(-1)
    if (child === undefined) throw new Error("LikeGo temp child handle inventory changed")
    try {
      await closeSecureDirectory(child)
      state.children.pop()
    } catch (error) {
      if (!secureDirectoryLeaseConsumed(error)) {
        state.closing = false
        throw error
      }
      state.children.pop()
      failures.push(errorValue(error, "LikeGo temp child cleanup failed"))
    }
  }

  try {
    await removeSecureDirectoryTree(state.root)
    issuedDirectories.delete(directory)
  } catch (error) {
    if (secureDirectoryLeaseConsumed(error)) issuedDirectories.delete(directory)
    else state.closing = false
    failures.push(errorValue(error, "LikeGo temp root cleanup failed"))
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "LikeGo temp cleanup failed")
}
