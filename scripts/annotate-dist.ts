import { basename, extname, join, relative, resolve, sep } from "node:path"

const GeneratedModuleSpecifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])(\.[^"']+)\1/g

function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep))
}

function declarationPath(javaScriptPath: string): string {
  return `${javaScriptPath.slice(0, -extname(javaScriptPath).length)}.d.ts`
}

function executableParts(source: string): {
  readonly body: string
  readonly prefix: string
} {
  if (!source.startsWith("#!")) return Object.freeze({ body: source, prefix: "" })
  const lineEnd = source.indexOf("\n")
  if (lineEnd === -1) return Object.freeze({ body: "", prefix: `${source}\n` })
  return Object.freeze({
    body: source.slice(lineEnd + 1),
    prefix: source.slice(0, lineEnd + 1)
  })
}

/** Returns the exact runtime bridge used only to make a declaration chunk resolvable by Deno. */
export function declarationCompanionSource(javaScriptPath: string): string {
  const declarationName = `${basename(javaScriptPath, ".js")}.d.ts`
  return `// @ts-self-types="./${declarationName}"\nexport {}\n`
}

async function writeDeclarationCompanions(
  distRoot: string,
  publicEntries: readonly string[]
): Promise<void> {
  const declarations = new Set<string>()
  for await (const path of new Bun.Glob("**/*.d.ts").scan({ cwd: distRoot, onlyFiles: true })) {
    declarations.add(path)
  }
  const pending = publicEntries.map(declarationPath)
  const reachable = new Set<string>()
  while (pending.length > 0) {
    const path = pending.shift()
    if (path === undefined || reachable.has(path) || !declarations.has(path)) continue
    reachable.add(path)
    const absolute = join(distRoot, path)
    const source = await Bun.file(absolute).text()
    for (const match of source.matchAll(GeneratedModuleSpecifier)) {
      const specifier = match[2] ?? ""
      if (extname(specifier) !== ".js") continue
      const javaScriptTarget = resolve(absolute, "..", specifier)
      if (!isInside(distRoot, javaScriptTarget)) continue
      const target = relative(distRoot, declarationPath(javaScriptTarget)).replaceAll("\\", "/")
      if (declarations.has(target) && !reachable.has(target)) pending.push(target)
    }
  }
  for (const path of Array.from(reachable).sort()) {
    const javaScriptPath = `${path.slice(0, -".d.ts".length)}.js`
    const absolute = join(distRoot, javaScriptPath)
    if (!(await Bun.file(absolute).exists())) {
      await Bun.write(absolute, declarationCompanionSource(javaScriptPath))
    }
  }
}

/**
 * Annotates emitted JavaScript with the adjacent declaration file required by Deno type checking.
 */
export async function annotateDist(
  workspaceRoot: string,
  publicEntries?: readonly string[]
): Promise<void> {
  const distRoot = join(workspaceRoot, "dist")
  const required = publicEntries === undefined ? null : new Set(publicEntries)
  if (publicEntries !== undefined) await writeDeclarationCompanions(distRoot, publicEntries)
  for await (const path of new Bun.Glob("**/*.js").scan({
    cwd: distRoot,
    absolute: true,
    onlyFiles: true
  })) {
    const declarationName = `${basename(path, ".js")}.d.ts`
    const declarationPath = join(path, "..", declarationName)
    if (!(await Bun.file(declarationPath).exists())) {
      const output = relative(distRoot, path).replaceAll("\\", "/")
      if (required !== null && !required.has(output)) continue
      throw new Error(`generated JavaScript declaration is missing: ${declarationPath}`)
    }
    const header = `// @ts-self-types="./${declarationName}"`
    const source = await Bun.file(path).text()
    const executable = executableParts(source)
    if (executable.body.startsWith(`${header}\n`)) continue
    const body = executable.body.startsWith("// @ts-self-types=")
      ? executable.body.slice(Math.max(0, executable.body.indexOf("\n") + 1))
      : executable.body
    await Bun.write(path, `${executable.prefix}${header}\n${body}`)
  }
}
