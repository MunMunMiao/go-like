import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, extname, join, normalize, resolve } from "node:path"
import { tmpdir } from "node:os"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  isArrowFunction,
  isAsExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isDecorator,
  isElementAccessExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isTemplateExpression,
  isTypeAssertion,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  type VariableDeclaration
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

/** Reports whether a module specifier is an internal relative source edge. */
function relativeModule(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../")
}

/** Removes syntax wrappers that cannot make a forbidden capability safe. */
function peelTransparentWrappers(node: Node): Node {
  let current = node
  while (
    isParenthesizedExpression(current) ||
    isAsExpression(current) ||
    isNonNullExpression(current) ||
    isSatisfiesExpression(current) ||
    isTypeAssertion(current)
  )
    current = current.expression
  return current
}

/** Evaluates only statically composed string syntax used for hidden property names. */
function constantString(node: Node): string | null {
  const target = peelTransparentWrappers(node)
  if (isStringLiteral(target) || isNoSubstitutionTemplateLiteral(target)) return target.text
  if (isTemplateExpression(target)) {
    let value = target.head.text
    for (const span of target.templateSpans) {
      const expression = constantString(span.expression)
      if (expression === null) return null
      value += expression + span.literal.text
    }
    return value
  }
  if (target.kind !== SyntaxKind.BinaryExpression) return null
  const binary = target as import("typescript/unstable/ast").BinaryExpression
  if (binary.operatorToken.kind !== SyntaxKind.PlusToken) return null
  const left = constantString(binary.left)
  const right = constantString(binary.right)
  return left === null || right === null ? null : left + right
}

/** Returns a statically named property access while preserving its receiver node. */
function staticProperty(
  node: Node
): { readonly receiver: Node; readonly name: string | null } | null {
  const target = peelTransparentWrappers(node)
  if (isPropertyAccessExpression(target)) {
    return { receiver: peelTransparentWrappers(target.expression), name: target.name.text }
  }
  if (!isElementAccessExpression(target)) return null
  return {
    receiver: peelTransparentWrappers(target.expression),
    name: target.argumentExpression === undefined ? null : constantString(target.argumentExpression)
  }
}

/** Resolves direct and constant-computed references to a global capability name. */
function constantGlobalName(node: Node): string | null {
  const target = peelTransparentWrappers(node)
  if (isIdentifier(target)) return target.text
  if (target.kind === SyntaxKind.BinaryExpression) {
    const binary = target as import("typescript/unstable/ast").BinaryExpression
    if (binary.operatorToken.kind === SyntaxKind.CommaToken) return constantGlobalName(binary.right)
  }
  const property = staticProperty(target)
  if (property === null) return null
  const receiverName = constantGlobalName(property.receiver)
  if (receiverName !== "globalThis" && receiverName !== "global") return null
  return property.name
}

/** Detects direct and computed CommonJS module loader calls. */
function commonJsLoader(expression: Node): boolean {
  const target = peelTransparentWrappers(expression)
  if (constantGlobalName(target) === "require") return true
  const property = staticProperty(target)
  return (
    property !== null &&
    constantGlobalName(property.receiver) === "module" &&
    property.name === "require"
  )
}

/** Detects dynamic source-code generation entrypoints. */
function codeGenerationName(expression: Node): "eval" | "Function" | null {
  const name = constantGlobalName(expression)
  return name === "eval" || name === "Function" ? name : null
}

/** Reports a non-empty JSDoc block immediately preceding one declaration. */
function hasJSDoc(node: Node, sourceFile: SourceFile): boolean {
  const leading = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile))
  return /\/\*\*[\s\S]*\*\/\s*$/.test(leading)
}

/** Finds the declaration that owns a named arrow or function expression. */
function namedFunctionDeclaration(node: Node): VariableDeclaration | null {
  if (!isArrowFunction(node) && !isFunctionExpression(node)) return null
  const parent = node.parent
  if (!isVariableDeclaration(parent) || parent.name.kind !== SyntaxKind.Identifier) return null
  return parent
}

/** Returns either an inline function-expression name or its owning variable name. */
function namedFunctionName(node: Node): string | null {
  if (isFunctionExpression(node) && node.name !== undefined) return node.name.text
  const declaration = namedFunctionDeclaration(node)
  return declaration === null ? null : declaration.name.getText()
}

/** Reports JSDoc attached either to a function expression or its named declaration. */
function hasFunctionJSDoc(node: Node, sourceFile: SourceFile): boolean {
  if (hasJSDoc(node, sourceFile)) return true
  const declaration = namedFunctionDeclaration(node)
  if (declaration === null) return false
  return hasJSDoc(declaration, sourceFile) || hasJSDoc(declaration.parent.parent, sourceFile)
}

/** Reports whether one rest parameter is an explicitly reviewed public ABI exception. */
function allowedRestParameter(_node: Node, _sourceFile: SourceFile): boolean {
  return false
}

/** Reports whether a bare module is an exact reviewed production dependency. */
function allowedBareModule(node: Node, sourceFile: SourceFile, specifier: string): boolean {
  if (
    specifier === "croner" ||
    specifier === "@likego/context" ||
    specifier === "@likego/core/lifecycle"
  )
    return true
  return (
    specifier === "@likego/core" &&
    isImportDeclaration(node) &&
    node.getText(sourceFile).startsWith("import type ")
  )
}

/** Finds every source-policy violation in one parsed production file. */
function sourceViolations(sourceFile: SourceFile, sourceFiles: ReadonlySet<string>): string[] {
  const violations: string[] = []
  if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(sourceFile.text))
    violations.push("syntax:ts-suppression")
  /** Validates one static module edge against exact package and source boundaries. */
  function inspectModule(node: Node, specifier: string): void {
    if (!relativeModule(specifier)) {
      if (!allowedBareModule(node, sourceFile, specifier)) violations.push(`module:${specifier}`)
      return
    }
    if (extname(specifier) !== "") {
      violations.push(`module:${specifier}`)
      return
    }
    const target = normalize(resolve(dirname(sourceFile.fileName), `${specifier}.ts`))
    if (!sourceFiles.has(target)) violations.push(`module:unresolved-relative:${specifier}`)
  }
  /** Recursively inspects one syntax node without text-only escape hatches. */
  function visit(node: Node): void {
    if (isClassDeclaration(node))
      violations.push(`class-declaration:${node.name?.text ?? "<anonymous>"}`)
    else if (isClassExpression(node))
      violations.push(`class-expression:${node.name?.text ?? "<anonymous>"}`)
    else if (isDecorator(node)) violations.push("decorator")

    if (isAsExpression(node)) violations.push("syntax:as-assertion")
    else if (isTypeAssertion(node)) violations.push("syntax:angle-assertion")
    else if (isNonNullExpression(node)) violations.push("syntax:non-null-assertion")
    if (node.kind === SyntaxKind.AnyKeyword) violations.push("syntax:explicit-any")
    if (node.kind === SyntaxKind.SpreadElement || node.kind === SyntaxKind.SpreadAssignment) {
      violations.push("syntax:spread")
    }
    if (
      node.kind === SyntaxKind.Parameter &&
      node.getText(sourceFile).startsWith("...") &&
      !allowedRestParameter(node, sourceFile)
    )
      violations.push("syntax:rest")
    if (isVariableDeclaration(node) && node.exclamationToken !== undefined) {
      violations.push("syntax:definite-assignment-assertion")
    }

    if (isFunctionDeclaration(node) && !hasJSDoc(node, sourceFile)) {
      violations.push(`jsdoc:function:${node.name?.text ?? "<anonymous>"}`)
    }
    const functionName = namedFunctionName(node)
    if (functionName !== null && !hasFunctionJSDoc(node, sourceFile)) {
      violations.push(`jsdoc:function:${functionName}`)
    }
    if (isMethodDeclaration(node) && !hasJSDoc(node, sourceFile)) {
      violations.push(`jsdoc:method:${node.name.getText(sourceFile)}`)
    }
    if (node.kind === SyntaxKind.MethodSignature && !hasJSDoc(node, sourceFile)) {
      violations.push(
        `jsdoc:method:${node.getText(sourceFile).split("(", 1)[0]?.trim() ?? "<anonymous>"}`
      )
    }
    if (
      node.kind === SyntaxKind.FunctionType &&
      (node.parent.kind === SyntaxKind.TypeAliasDeclaration ||
        node.parent.kind === SyntaxKind.PropertySignature) &&
      !hasJSDoc(node.parent, sourceFile)
    )
      violations.push(
        `jsdoc:callable-type:${node.parent.getText(sourceFile).split("=", 1)[0]?.trim() ?? "<anonymous>"}`
      )

    if (isIdentifier(node) && ForbiddenGlobals.has(node.text))
      violations.push(`global:${node.text}`)
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(node, specifier.text)
    }
    if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
      violations.push("syntax:import-equals-external-reference")
      const specifier = node.moduleReference.expression
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(node, specifier.text)
    }
    if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0]
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(node, specifier.text)
      else violations.push("module:<non-literal-dynamic-import>")
    } else if (isCallExpression(node) && commonJsLoader(node.expression)) {
      const specifier = node.arguments[0]
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(node, specifier.text)
      else violations.push("module:<non-literal-commonjs-loader>")
    }
    if (isCallExpression(node) || isNewExpression(node)) {
      const generated = codeGenerationName(node.expression)
      if (generated !== null) violations.push(`code-generation:${generated}`)
    }
    const property = staticProperty(node)
    const receiver = property === null ? null : constantGlobalName(property.receiver)
    if (property !== null && (receiver === "globalThis" || receiver === "global")) {
      if (property.name !== null && ForbiddenGlobals.has(property.name))
        violations.push(`global:${property.name}`)
      else violations.push("global:computed-access")
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return violations
}

/** Opens exactly one compiler project and releases its snapshot deterministically. */
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

/** Parses one synthetic fixture through the same policy used for production. */
async function syntheticViolations(
  source: string,
  dependencies: Readonly<Record<string, string>> = {}
): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "likego-cron-policy-"))
  const configPath = join(root, "tsconfig.json")
  const sourcePath = join(root, "synthetic.ts")
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2023" },
        include: ["synthetic.ts", "*.ts"]
      })
    )
    await writeFile(sourcePath, source)
    const sourceFiles = new Set([normalize(sourcePath)])
    for (const [file, contents] of Object.entries(dependencies)) {
      const dependencyPath = join(root, file)
      await writeFile(dependencyPath, contents)
      sourceFiles.add(normalize(dependencyPath))
    }
    return await withProject(root, configPath, async function inspect(project) {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return sourceViolations(sourceFile, sourceFiles)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test.each([
  ["class declaration", "class Bad {}", "class-declaration:Bad"],
  ["as assertion", "const value = 1 as number", "syntax:as-assertion"],
  ["angle assertion", "const value = <number>1", "syntax:angle-assertion"],
  [
    "non-null assertion",
    "declare const value: string | null; void value!",
    "syntax:non-null-assertion"
  ],
  ["definite assignment", "let value!: string", "syntax:definite-assignment-assertion"],
  ["explicit any", "let value: any", "syntax:explicit-any"],
  ["array spread", "const values = [...input]", "syntax:spread"],
  ["object spread", "const value = { ...input }", "syntax:spread"],
  ["rest parameter", "function values(...input: unknown[]): void {}", "syntax:rest"],
  ["suppression", "// @ts-ignore\nvoid missing", "syntax:ts-suppression"],
  ["undocumented function", "function missing(): void {}", "jsdoc:function:missing"],
  ["undocumented method", "const value = { missing(): void {} }", "jsdoc:method:missing"],
  ["undocumented callable type", "type Missing = () => void", "jsdoc:callable-type:type Missing"],
  ["CommonJS loader", "void require('node:fs')", "module:node:fs"],
  ["computed CommonJS loader", "void module['re' + 'quire']('node:fs')", "module:node:fs"],
  ["computed process", "void globalThis['pro' + 'cess']", "global:process"],
  ["Node global process", "void global['process']", "global:process"],
  ["indirect eval", "void (0, eval)('1')", "code-generation:eval"],
  [
    "Function constructor",
    "void new globalThis['Function']('return 1')",
    "code-generation:Function"
  ],
  ["non-literal import", "void import(name)", "module:<non-literal-dynamic-import>"]
] as const)("rejects %s", async (_name, source, expected) => {
  expect(await syntheticViolations(source)).toContain(expected)
})

test("requires adjacent JSDoc for a named inline function expression", async () => {
  const undocumented =
    "void new Promise<void>(function undocumentedExecutor(resolve) { resolve() })"
  expect(await syntheticViolations(undocumented)).toContain("jsdoc:function:undocumentedExecutor")

  const documented = `void new Promise<void>(
    /** Resolves one documented synthetic Promise. */
    function documentedExecutor(resolve) { resolve() }
  )`
  expect(await syntheticViolations(documented)).not.toContain("jsdoc:function:documentedExecutor")
})

test("accepts documented functions, callable types, methods, and exact extensionless sources", async () => {
  expect(
    await syntheticViolations(
      `
    import "./dependency"
    /** Runs documented work. */
    type Work = () => void
    /** Runs documented work. */
    function work(): void {}
    const value = {
      /** Runs a documented method. */
      method(): void {}
    }
    void [work, value]
  `,
      { "dependency.ts": "export {}" }
    )
  ).toEqual([])
})

test.each(["./dependency.js", "./dependency.ts", "./dependency.mjs"])(
  "rejects explicit relative source extension %s",
  async (specifier) => {
    expect(await syntheticViolations(`import "${specifier}"`)).toContain(`module:${specifier}`)
  }
)

test("rejects an unresolved extensionless relative source", async () => {
  expect(await syntheticViolations('import "./missing"')).toContain(
    "module:unresolved-relative:./missing"
  )
})

test("production source has exact inventory and no policy violations", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourceRoot = `${packageRoot}/src`
  const files: string[] = []
  const violations: string[] = []
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, onlyFiles: true }))
    files.push(file)
  files.sort()
  const sourceFiles = new Set(
    files.map(function sourcePath(file) {
      return normalize(resolve(sourceRoot, file))
    })
  )
  await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async function inspect(project) {
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${sourceRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source file is missing: ${file}`)
      for (const violation of sourceViolations(sourceFile, sourceFiles))
        violations.push(`${file}:${violation}`)
    }
  })
  expect(files).toEqual(["errors.ts", "index.ts", "server.ts", "types.ts"])
  expect(violations).toEqual([])
})

test("development source and tests contain no handwritten JavaScript or relative extensions", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const violations: string[] = []
  for (const tree of ["src", "test"]) {
    for await (const file of new Bun.Glob("**/*").scan({
      cwd: `${packageRoot}/${tree}`,
      onlyFiles: true
    })) {
      const relative = `${tree}/${file}`
      if (/\.(?:[cm]?js|jsx)$/.test(file)) violations.push(`handwritten-javascript:${relative}`)
      if (!file.endsWith(".ts")) continue
      const source = await Bun.file(`${packageRoot}/${relative}`).text()
      const matches = source.matchAll(/(?:from\s+|import\s*\()(["'])(\.\.?\/[^"']+)\1/g)
      for (const match of matches) {
        const specifier = match[2]
        if (specifier !== undefined && extname(specifier) !== "") {
          violations.push(`relative-extension:${relative}:${specifier}`)
        }
      }
    }
  }
  expect(violations).toEqual([])
})
