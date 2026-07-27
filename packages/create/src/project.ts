import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { projectFiles, type ProjectDependencies } from "./templates"

const ProjectName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const ExactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const NodeFilesystem = Object.freeze({ mkdir, writeFile })

export interface CreatedProject {
  readonly name: string
  readonly directory: string
}

interface ProjectFilesystem {
  readonly mkdir: (path: string) => Promise<void>
  readonly writeFile: (
    path: string,
    content: string,
    options: Readonly<{ flag: "wx" }>
  ) => Promise<void>
}

/** Finds this package manifest from either the source or built distribution layout. */
async function packageManifest(moduleURL: string): Promise<Readonly<Record<string, unknown>>> {
  let directory = dirname(fileURLToPath(moduleURL))
  for (let depth = 0; depth < 2; depth += 1) {
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Reflect.get(value, "name") === "@likego/create"
      ) {
        return value as Readonly<Record<string, unknown>>
      }
    } catch (error) {
      if (typeof error !== "object" || error === null || Reflect.get(error, "code") !== "ENOENT") {
        throw error
      }
    }
    directory = dirname(directory)
  }
  throw new Error("@likego/create package manifest is unavailable")
}

/** Reads this package's version through the shared source/dist manifest lookup. */
export async function packageVersion(moduleURL: string): Promise<string> {
  const version = Reflect.get(await packageManifest(moduleURL), "version")
  if (typeof version !== "string")
    throw new TypeError("@likego/create package version is unavailable")
  return version
}

/** Reads the exact LikeGo dependency versions that Changesets maintains on this package. */
async function packageDependencies(moduleURL: string): Promise<ProjectDependencies> {
  const dependencies = Reflect.get(await packageManifest(moduleURL), "dependencies")
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    throw new TypeError("@likego/create package dependencies are unavailable")
  }
  const version = (name: keyof ProjectDependencies): string => {
    const value = Reflect.get(dependencies, name)
    if (typeof value !== "string" || !ExactSemver.test(value)) {
      throw new TypeError(`@likego/create package dependency must use an exact semver: ${name}`)
    }
    return value
  }
  return Object.freeze({
    "@likego/core": version("@likego/core"),
    "@likego/server": version("@likego/server"),
    "@likego/transport": version("@likego/transport"),
    "@likego/transport-http": version("@likego/transport-http")
  })
}

/** Resolves one target and derives its strict lower-kebab project name. */
function targetIdentity(value: string): CreatedProject {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("target directory must be a non-empty string")
  }
  const directory = resolve(value)
  const name = basename(directory)
  if (!ProjectName.test(name)) {
    throw new TypeError("project name must use strict lower-kebab case")
  }
  return Object.freeze({ name, directory })
}

/** Requires the caller-owned target parent to be one existing directory. */
async function requireParent(path: string): Promise<void> {
  const parent = await stat(dirname(path))
  if (!parent.isDirectory()) throw new TypeError("target parent must be a directory")
}

/** Implements creation against an explicit filesystem boundary for fail-closed verification. */
export async function createProjectWithFilesystem(
  target: string,
  filesystem: ProjectFilesystem,
  moduleURL = import.meta.url
): Promise<CreatedProject> {
  const identity = targetIdentity(target)
  await requireParent(identity.directory)
  const dependencies = await packageDependencies(moduleURL)

  try {
    await filesystem.mkdir(identity.directory)
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "EEXIST") {
      throw new TypeError(`target directory already exists: ${identity.directory}`)
    }
    throw error
  }

  await filesystem.mkdir(join(identity.directory, "src"))
  await filesystem.mkdir(join(identity.directory, "test"))
  for (const file of projectFiles(identity.name, dependencies)) {
    await filesystem.writeFile(join(identity.directory, file.path), file.content, { flag: "wx" })
  }
  return identity
}

/** Claims one missing target atomically, then writes the complete project into it. */
export async function createProject(target: string): Promise<CreatedProject> {
  return await createProjectWithFilesystem(target, NodeFilesystem, import.meta.url)
}
