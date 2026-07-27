import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, extname, join, normalize, resolve } from "node:path"
import { tmpdir } from "node:os"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  createScanner,
  isArrowFunction,
  isAsExpression,
  isCallExpression,
  isCallSignatureDeclaration,
  isClassDeclaration,
  isClassExpression,
  isDecorator,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionTypeNode,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNonNullExpression,
  isPropertyAssignment,
  isPropertySignatureDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type SourceFile
} from "typescript/unstable/ast"

const ForbiddenGlobals = new Set([
  "AsyncLocalStorage",
  "Bun",
  "Deno",
  "Function",
  "Reflect",
  "WeakMap",
  "eval",
  "global",
  "globalThis",
  "module",
  "process",
  "require"
])

/** Reports whether a compiler declaration owns a directly adjacent non-empty JSDoc block. */
function hasJSDoc(node: Node, sourceFile: SourceFile): boolean {
  const leading = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile))
  const match = /\/\*\*([\s\S]*)\*\/\s*$/.exec(leading)
  return match !== null && (match[1] ?? "").replace(/\*/g, "").trim() !== ""
}

/** Finds the declaration that gives one business callable its source-level identity. */
function callableOwner(node: Node): Node | null {
  if (
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isMethodSignatureDeclaration(node) ||
    isCallSignatureDeclaration(node)
  )
    return node
  if (isFunctionTypeNode(node)) {
    let parent = node.parent
    while (parent.kind !== SyntaxKind.SourceFile) {
      if (isTypeAliasDeclaration(parent) || isPropertySignatureDeclaration(parent)) return parent
      if (
        isFunctionDeclaration(parent) ||
        isFunctionExpression(parent) ||
        isArrowFunction(parent) ||
        isMethodDeclaration(parent) ||
        isMethodSignatureDeclaration(parent)
      )
        return null
      parent = parent.parent
    }
    return null
  }
  if (!isArrowFunction(node) && !isFunctionExpression(node)) return null
  if (isVariableDeclaration(node.parent)) {
    const statement = node.parent.parent.parent
    return isVariableStatement(statement) ? statement : node.parent
  }
  if (isPropertyAssignment(node.parent)) return node.parent
  if (isFunctionExpression(node) && node.name !== undefined) return node
  return null
}

/** Returns a stable diagnostic label for one callable declaration. */
function callableName(node: Node, sourceFile: SourceFile): string {
  if (isFunctionDeclaration(node)) return node.name?.text ?? "<anonymous>"
  if (isMethodDeclaration(node) || isMethodSignatureDeclaration(node)) {
    return node.name.getText(sourceFile)
  }
  if (isCallSignatureDeclaration(node)) return "<call-signature>"
  if (isFunctionTypeNode(node)) {
    const owner = callableOwner(node)
    if (owner !== null && isTypeAliasDeclaration(owner)) return owner.name.text
    if (owner !== null && isPropertySignatureDeclaration(owner))
      return owner.name.getText(sourceFile)
  }
  if (isArrowFunction(node) || isFunctionExpression(node)) {
    if (isVariableDeclaration(node.parent) && isIdentifier(node.parent.name))
      return node.parent.name.text
    if (isPropertyAssignment(node.parent)) return node.parent.name.getText(sourceFile)
    if (isFunctionExpression(node)) return node.name?.text ?? "<anonymous>"
  }
  return "<unknown>"
}

/** Detects TypeScript suppression pragmas only inside actual comment trivia. */
function suppressionViolations(sourceFile: SourceFile): string[] {
  const scanner = createScanner(false, sourceFile.languageVariant, sourceFile.text)
  const violations: string[] = []
  while (scanner.scan() !== SyntaxKind.EndOfFile) {
    const token = scanner.getToken()
    if (token !== SyntaxKind.SingleLineCommentTrivia && token !== SyntaxKind.MultiLineCommentTrivia)
      continue
    const match = /@ts-(ignore|expect-error|nocheck)\b/.exec(scanner.getTokenText())
    if (match !== null) violations.push(`suppression:@ts-${match[1]}`)
  }
  return violations
}

/** Reports whether a compiler node owns a spread/rest token forbidden in production. */
function hasRestToken(node: Node): boolean {
  if (node.kind !== SyntaxKind.Parameter && node.kind !== SyntaxKind.BindingElement) return false
  return "dotDotDotToken" in node && node.dotDotDotToken !== undefined
}

/** Finds every portability, type-safety, documentation, and module-boundary violation. */
function sourceViolations(sourceFile: SourceFile, sourceFiles: ReadonlySet<string>): string[] {
  const violations = suppressionViolations(sourceFile)
  const documentedOwners = new Set<number>()

  /** Validates one static module specifier against the package's portable boundary. */
  function inspectModule(specifier: string): void {
    if (specifier === "@likego/context") return
    if (!specifier.startsWith(".")) {
      violations.push(`module:${specifier}`)
      return
    }
    if (extname(specifier) !== "") {
      violations.push(`relative-extension:${specifier}`)
      return
    }
    const target = normalize(resolve(dirname(sourceFile.fileName), `${specifier}.ts`))
    if (!sourceFiles.has(target)) violations.push(`unresolved-relative:${specifier}`)
  }

  /** Recursively inspects one compiler node without relying on source-text guesses. */
  function visit(node: Node): void {
    if (isClassDeclaration(node)) violations.push("class-declaration")
    else if (isClassExpression(node)) violations.push("class-expression")
    else if (isDecorator(node)) violations.push("decorator")
    else if (isImportEqualsDeclaration(node)) violations.push("import-equals")
    else if (isAsExpression(node)) violations.push("type-assertion:as")
    else if (isTypeAssertion(node)) violations.push("type-assertion:angle")
    else if (isNonNullExpression(node)) violations.push("type-assertion:non-null")
    else if (isVariableDeclaration(node) && node.exclamationToken !== undefined) {
      violations.push("type-assertion:definite-assignment")
    } else if (node.kind === SyntaxKind.AnyKeyword) violations.push("explicit-any")
    else if (node.kind === SyntaxKind.SpreadElement) violations.push("spread-element")
    else if (node.kind === SyntaxKind.SpreadAssignment) violations.push("spread-assignment")
    else if (hasRestToken(node)) violations.push("rest-element")

    const owner = callableOwner(node)
    if (owner !== null && !documentedOwners.has(owner.pos)) {
      documentedOwners.add(owner.pos)
      if (!hasJSDoc(owner, sourceFile)) {
        violations.push(`jsdoc:${callableName(node, sourceFile)}`)
      }
    }

    if (isIdentifier(node) && ForbiddenGlobals.has(node.text)) {
      violations.push(`global:${node.text}`)
    }
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(specifier.text)
    }
    if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(specifier.text)
      else violations.push("module:<non-literal-dynamic-import>")
    }
    node.forEachChild(visit)
  }

  sourceFile.forEachChild(visit)
  return violations
}

/** Opens exactly one compiler project for source-policy inspection. */
async function withProject<T>(
  root: string,
  configPath: string,
  use: (project: Project) => Promise<T>
): Promise<T> {
  const api = new API({ cwd: root })
  let snapshot: Snapshot | null = null
  try {
    snapshot = await api.updateSnapshot({ openProjects: [configPath] })
    const projects = snapshot.getProjects()
    if (projects.length !== 1) throw new Error("source policy requires exactly one project")
    const project = projects[0]
    if (project === undefined) throw new Error("source policy project is missing")
    return await use(project)
  } finally {
    if (snapshot !== null) await snapshot.dispose()
    await api.close()
  }
}

/** Evaluates one synthetic source file and its exact extensionless dependencies. */
async function syntheticViolations(
  source: string,
  dependencies: Readonly<Record<string, string>> = {}
): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "likego-resilience-policy-"))
  const configPath = join(root, "tsconfig.json")
  const sourcePath = join(root, "synthetic.ts")
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023" },
        include: ["*.ts"]
      })
    )
    await writeFile(sourcePath, source)
    const files = new Set([normalize(sourcePath)])
    for (const [name, contents] of Object.entries(dependencies)) {
      const path = join(root, name)
      await writeFile(path, contents)
      files.add(normalize(path))
    }
    return await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source is missing")
      return sourceViolations(sourceFile, files)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("AST policy fails closed on unsafe syntax and undocumented callable forms", async () => {
  const violations = await syntheticViolations(
    [
      'import "node:fs"',
      'import legacy = require("node:path")',
      "class Named {}",
      "const Anonymous = class {}",
      "function undocumented(): void {}",
      "const arrow = (): void => {}",
      "const expression = function named(): void {}",
      "const object = { method(): void {}, property: (): void => {} }",
      "interface Contract { method(): void; callback: () => void; (): void }",
      "type Handler = () => void",
      "const cast = value as string",
      "const angle = <string>value",
      "const asserted = value!",
      "let deferred!: string",
      "const broad: any = value",
      "const array = [...values]",
      "const record = { ...object }",
      "function variadic(...values: string[]): void {}",
      "// @ts-ignore",
      "void [Anonymous, arrow, expression, cast, angle, asserted, deferred, broad, array, record, variadic, process]"
    ].join("\n")
  )

  expect(violations).toContain("module:node:fs")
  expect(violations).toContain("import-equals")
  expect(violations).toContain("class-declaration")
  expect(violations).toContain("class-expression")
  expect(violations).toContain("type-assertion:as")
  expect(violations).toContain("type-assertion:angle")
  expect(violations).toContain("type-assertion:non-null")
  expect(violations).toContain("type-assertion:definite-assignment")
  expect(violations).toContain("explicit-any")
  expect(violations).toContain("spread-element")
  expect(violations).toContain("spread-assignment")
  expect(violations).toContain("rest-element")
  expect(violations).toContain("suppression:@ts-ignore")
  expect(violations).toContain("global:process")
  expect(violations.filter((item) => item.startsWith("jsdoc:"))).toHaveLength(10)
})

test("AST policy accepts every directly documented business callable declaration form", async () => {
  expect(
    await syntheticViolations(
      [
        "/** Documents the function. */",
        "function documented(): void {}",
        "/** Documents the variable callable. */",
        "const arrow = (): void => {}",
        "const object = {",
        "  /** Documents the method. */",
        "  method(): void {},",
        "  /** Documents the property callable. */",
        "  property: (): void => {}",
        "}",
        "interface Contract {",
        "  /** Documents the method signature. */",
        "  method(): void",
        "  /** Documents the callable property. */",
        "  callback: () => void",
        "  /** Documents the call signature. */",
        "  (): void",
        "}",
        "/** Documents the callable alias. */",
        "type Handler = () => void",
        "void [documented, arrow, object]"
      ].join("\n")
    )
  ).toEqual([])
})

test("module policy requires an exact extensionless TypeScript target", async () => {
  expect(
    await syntheticViolations('import "./dependency"', { "dependency.ts": "export {}" })
  ).toEqual([])
  expect(await syntheticViolations('import "./dependency.js"')).toContain(
    "relative-extension:./dependency.js"
  )
  expect(await syntheticViolations('import "./dependency.ts"')).toContain(
    "relative-extension:./dependency.ts"
  )
  expect(await syntheticViolations('import "./missing"')).toContain("unresolved-relative:./missing")
  expect(await syntheticViolations("void import(name)")).toContain(
    "module:<non-literal-dynamic-import>"
  )
})

test("production source has the exact inventory and no policy violation", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourceRoot = `${packageRoot}/src`
  const files: string[] = []
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, onlyFiles: true }))
    files.push(file)
  files.sort()
  const exactSources = new Set(files.map((file) => normalize(`${sourceRoot}/${file}`)))
  const violations: string[] = []

  await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async (project) => {
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${sourceRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source is missing: ${file}`)
      for (const violation of sourceViolations(sourceFile, exactSources)) {
        violations.push(`${file}:${violation}`)
      }
    }
  })

  expect(files).toEqual([
    "circuit.ts",
    "errors.ts",
    "index.ts",
    "internal.ts",
    "limiter.ts",
    "retry.ts",
    "types.ts"
  ])
  expect(violations).toEqual([])
})

test("development source and tests contain no JavaScript or relative source extensions", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const violations: string[] = []
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  for (const tree of ["src", "test"]) {
    for await (const file of new Bun.Glob("**/*").scan({
      cwd: `${packageRoot}/${tree}`,
      onlyFiles: true
    })) {
      const relative = `${tree}/${file}`
      if (/\.(?:js|mjs|cjs)$/.test(file)) violations.push(`javascript:${relative}`)
      if (!file.endsWith(".ts")) continue
      for (const imported of transpiler.scanImports(
        await Bun.file(`${packageRoot}/${relative}`).text()
      )) {
        if (imported.path.startsWith(".") && extname(imported.path) !== "") {
          violations.push(`relative-extension:${relative}:${imported.path}`)
        }
      }
    }
  }
  expect(violations).toEqual([])
})
