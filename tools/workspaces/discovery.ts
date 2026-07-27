import { lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path"

export interface Workspace {
  readonly root: string
  readonly manifestPath: string
  readonly name: string
  readonly private: boolean
}

interface WorkspacePattern {
  readonly declaration: string
  readonly scanPatterns: readonly string[]
  readonly hasMagic: boolean
}

function IsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function IsMissing(error: unknown): boolean {
  return IsRecord(error) && error.code === "ENOENT"
}

function IsInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function NormalizeWorkspacePattern(valuePattern: string, sourcePattern: string): string {
  if (
    posix.isAbsolute(valuePattern) ||
    win32.isAbsolute(valuePattern) ||
    win32.parse(valuePattern).root !== "" ||
    valuePattern.includes("\\") ||
    valuePattern.includes("\0")
  ) {
    throw new TypeError(`workspace glob must be repository-relative: ${sourcePattern}`)
  }
  const pattern = posix.normalize(valuePattern.replace(/^\.\//, "").replace(/\/+$/, ""))
  if (pattern === "." || pattern === ".." || pattern.startsWith("../")) {
    throw new TypeError(`workspace glob escapes repository root: ${sourcePattern}`)
  }
  return pattern
}

function WorkspaceBracketClosing(pattern: string, opening: number, sourcePattern: string): number {
  let memberStart = opening + 1
  if (pattern[memberStart] === "!" || pattern[memberStart] === "^") memberStart += 1
  if (pattern[memberStart] === "]") memberStart += 1
  const closing = pattern.indexOf("]", memberStart)
  if (closing < 0) {
    throw new TypeError(`workspace glob syntax is invalid: ${sourcePattern}`)
  }
  return closing
}

function WorkspaceBraceClosing(pattern: string, opening: number, sourcePattern: string): number {
  for (let index = opening + 1; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === "[") {
      index = WorkspaceBracketClosing(pattern, index, sourcePattern)
      continue
    }
    if (character === "{" || character === "}") {
      if (character === "}") return index
      throw new TypeError(`workspace glob syntax is invalid: ${sourcePattern}`)
    }
  }
  throw new TypeError(`workspace glob syntax is invalid: ${sourcePattern}`)
}

function WorkspaceBraceAlternatives(body: string, sourcePattern: string): readonly string[] {
  const alternatives: string[] = []
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (character === "[") {
      index = WorkspaceBracketClosing(body, index, sourcePattern)
      continue
    }
    if (character === ",") {
      alternatives.push(body.slice(start, index))
      start = index + 1
    }
  }
  alternatives.push(body.slice(start))
  return alternatives
}

function WorkspaceBraceRangeMembers(
  body: string,
  sourcePattern: string
): readonly string[] | undefined {
  const members: string[] = []
  let start = 0
  for (let index = 0; index < body.length - 1; index += 1) {
    const character = body[index]
    if (character === "[") {
      index = WorkspaceBracketClosing(body, index, sourcePattern)
      continue
    }
    if (
      character === "." &&
      body[index + 1] === "." &&
      index > 0 &&
      index + 2 < body.length &&
      body[index - 1] !== "/" &&
      body[index + 2] !== "/"
    ) {
      members.push(body.slice(start, index))
      start = index + 2
      index += 1
    }
  }
  if (members.length === 0) return undefined
  members.push(body.slice(start))
  return members
}

function ValidateWorkspaceBraceMember(member: string, sourcePattern: string): void {
  if (member.length === 0) {
    throw new TypeError(`workspace glob syntax is invalid: ${sourcePattern}`)
  }
  NormalizeWorkspacePattern(member, sourcePattern)
  const rangeMembers = WorkspaceBraceRangeMembers(member, sourcePattern)
  if (rangeMembers === undefined) return
  if (
    (rangeMembers.length !== 2 && rangeMembers.length !== 3) ||
    rangeMembers.some((rangeMember) => rangeMember.length === 0)
  ) {
    throw new TypeError(`workspace glob syntax is invalid: ${sourcePattern}`)
  }
  for (const rangeMember of rangeMembers) {
    NormalizeWorkspacePattern(rangeMember, sourcePattern)
  }
  throw new TypeError(`workspace glob syntax is invalid: ${sourcePattern}`)
}

function WorkspaceGlobHasMagic(pattern: string, sourcePattern: string): boolean {
  let hasMagic = false
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === "*" || character === "?") {
      hasMagic = true
      continue
    }
    if (character === "]" || character === "}") {
      throw new TypeError(`workspace glob syntax is invalid: ${pattern}`)
    }
    if (character === "[") {
      const closing = WorkspaceBracketClosing(pattern, index, sourcePattern)
      hasMagic = true
      index = closing
      continue
    }
    if (character === "{") {
      const closing = WorkspaceBraceClosing(pattern, index, sourcePattern)
      const body = pattern.slice(index + 1, closing)
      WorkspaceGlobHasMagic(body, sourcePattern)
      const alternatives = WorkspaceBraceAlternatives(body, sourcePattern)
      for (const alternative of alternatives) {
        ValidateWorkspaceBraceMember(alternative, sourcePattern)
      }
      if (alternatives.length < 2) {
        throw new TypeError(`workspace glob syntax is invalid: ${sourcePattern}`)
      }
      hasMagic = true
      index = closing
    }
  }
  return hasMagic
}

function ExpandWorkspaceBraces(pattern: string, sourcePattern: string): readonly string[] {
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === "[") {
      index = WorkspaceBracketClosing(pattern, index, sourcePattern)
      continue
    }
    if (character !== "{") continue
    const closing = WorkspaceBraceClosing(pattern, index, sourcePattern)
    const alternatives = WorkspaceBraceAlternatives(
      pattern.slice(index + 1, closing),
      sourcePattern
    )
    const prefix = pattern.slice(0, index)
    const suffix = pattern.slice(closing + 1)
    const expanded: string[] = []
    for (const alternative of alternatives) {
      const candidate = NormalizeWorkspacePattern(`${prefix}${alternative}${suffix}`, sourcePattern)
      for (const expandedCandidate of ExpandWorkspaceBraces(candidate, sourcePattern)) {
        expanded.push(expandedCandidate)
      }
    }
    return expanded
  }
  return [pattern]
}

function WorkspacePatterns(value: unknown): readonly WorkspacePattern[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((pattern) => typeof pattern !== "string" || pattern.length === 0)
  ) {
    throw new TypeError("root workspaces must be a non-empty string array")
  }
  const patterns: WorkspacePattern[] = []
  for (const valuePattern of value as readonly string[]) {
    if (valuePattern.includes("**")) {
      throw new TypeError(`recursive workspace globs are not allowed: ${valuePattern}`)
    }
    const declaration = NormalizeWorkspacePattern(valuePattern, valuePattern)
    const hasMagic = WorkspaceGlobHasMagic(declaration, declaration)
    const scanPatterns = Object.freeze(ExpandWorkspaceBraces(declaration, declaration))
    patterns.push(Object.freeze({ declaration, scanPatterns, hasMagic }))
  }
  return Object.freeze(patterns)
}

async function RequireWorkspaceDirectory(
  repositoryRoot: string,
  realRepositoryRoot: string,
  workspaceRoot: string
): Promise<string> {
  const segments = workspaceRoot.split("/")
  let current = repositoryRoot
  for (const segment of segments) {
    current = resolve(current, segment)
    const status = await lstat(current)
    if (status.isSymbolicLink()) {
      throw new TypeError(`workspace root must not be symbolic link: ${workspaceRoot}`)
    }
  }
  const status = await lstat(current)
  if (!status.isDirectory()) {
    throw new TypeError(`workspace root must be a directory: ${workspaceRoot}`)
  }
  const resolved = await realpath(current)
  if (!IsInside(realRepositoryRoot, resolved) || resolved === realRepositoryRoot) {
    throw new TypeError(`workspace root escapes repository root: ${workspaceRoot}`)
  }
  return resolved
}

async function ReadWorkspace(
  repositoryRoot: string,
  realRepositoryRoot: string,
  workspaceRoot: string
): Promise<Workspace> {
  const root = await RequireWorkspaceDirectory(repositoryRoot, realRepositoryRoot, workspaceRoot)
  const manifestPath = `${workspaceRoot}/package.json`
  const absoluteManifestPath = resolve(root, "package.json")
  let manifestSource: string
  try {
    const status = await lstat(absoluteManifestPath)
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new TypeError(`workspace manifest must be a regular file: ${manifestPath}`)
    }
    manifestSource = await readFile(absoluteManifestPath, "utf8")
  } catch (error) {
    if (IsMissing(error)) throw new TypeError(`workspace manifest is missing: ${manifestPath}`)
    throw error
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestSource) as unknown
  } catch {
    throw new TypeError(`workspace manifest must be valid JSON: ${manifestPath}`)
  }
  if (!IsRecord(manifest) || typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new TypeError(`workspace manifest must declare a non-empty name: ${manifestPath}`)
  }
  if (manifest.private !== undefined && typeof manifest.private !== "boolean") {
    throw new TypeError(`workspace manifest private must be boolean: ${manifestPath}`)
  }
  return Object.freeze({
    root: workspaceRoot,
    manifestPath,
    name: manifest.name,
    private: manifest.private === true
  })
}

/** Discovers the repository workspaces declared by the root package manifest. */
export async function discoverWorkspaces(repositoryRoot: string): Promise<readonly Workspace[]> {
  const root = resolve(repositoryRoot)
  const realRepositoryRoot = await realpath(root)
  let rootManifest: unknown
  try {
    rootManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as unknown
  } catch {
    throw new TypeError("root package manifest must be valid JSON")
  }
  if (!IsRecord(rootManifest)) throw new TypeError("root package manifest must be an object")

  const workspaceRoots = new Set<string>()
  for (const pattern of WorkspacePatterns(rootManifest.workspaces)) {
    let matchedDirectories = 0
    for (const scanPattern of pattern.scanPatterns) {
      const glob = new Bun.Glob(scanPattern)
      for await (const matchedPath of glob.scan({
        cwd: root,
        followSymlinks: false,
        onlyFiles: false
      })) {
        const workspaceRoot = posix.normalize(matchedPath.split(sep).join("/"))
        if (workspaceRoot === "." || workspaceRoot === ".." || workspaceRoot.startsWith("../")) {
          throw new TypeError(`workspace glob escapes repository root: ${pattern.declaration}`)
        }
        const matchedStatus = await lstat(resolve(root, workspaceRoot))
        if (matchedStatus.isFile()) continue
        matchedDirectories += 1
        workspaceRoots.add(workspaceRoot)
      }
    }
    if (matchedDirectories === 0 && !pattern.hasMagic) {
      throw new TypeError(`workspace glob did not match a directory: ${pattern.declaration}`)
    }
  }
  if (workspaceRoots.size === 0)
    throw new TypeError("root workspaces must discover at least one directory")

  const workspaces: Workspace[] = []
  const names = new Map<string, string>()
  for (const workspaceRoot of [...workspaceRoots].sort(CompareCodeUnits)) {
    const workspace = await ReadWorkspace(root, realRepositoryRoot, workspaceRoot)
    const owner = names.get(workspace.name)
    if (owner !== undefined) {
      throw new TypeError(
        `duplicate workspace package name ${workspace.name}: ${owner}, ${workspace.root}`
      )
    }
    names.set(workspace.name, workspace.root)
    workspaces.push(workspace)
  }
  return Object.freeze(workspaces)
}
