import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join, normalize, resolve } from "node:path"
import { tmpdir } from "node:os"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  isAsExpression,
  isCallSignatureDeclaration,
  isCallExpression,
  isNewExpression,
  isClassDeclaration,
  isClassExpression,
  isDecorator,
  isElementAccessExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isFunctionDeclaration,
  isArrowFunction,
  isFunctionExpression,
  isFunctionTypeNode,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isPropertySignatureDeclaration,
  isSatisfiesExpression,
  isStringLiteral,
  isNoSubstitutionTemplateLiteral,
  isTemplateExpression,
  isTypeAssertion,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  type VariableDeclaration
} from "typescript/unstable/ast"

const FunctionalOptionRestJustification =
  "// Go-style functional options require this single variadic construction boundary."

const ForbiddenGlobals = new Set([
  "AsyncLocalStorage",
  "Bun",
  "Deno",
  "Reflect",
  "WeakMap",
  "module",
  "require",
  "process",
  "eval",
  "Function",
  "global",
  "globalThis"
])

function allowedBareModule(specifier: string): boolean {
  return (
    specifier === "@hono/node-server" ||
    specifier === "node:http" ||
    specifier === "node:net" ||
    specifier === "node:stream" ||
    specifier === "node:stream/web" ||
    specifier === "@likego/context" ||
    specifier === "@likego/core" ||
    specifier === "@likego/core/lifecycle" ||
    specifier === "@likego/web"
  )
}

function relativeModule(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../")
}

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

function staticProperty(
  node: Node
): { readonly receiver: Node; readonly name: string | null } | null {
  const target = peelTransparentWrappers(node)
  if (isPropertyAccessExpression(target))
    return { receiver: peelTransparentWrappers(target.expression), name: target.name.text }
  if (!isElementAccessExpression(target)) return null
  return {
    receiver: peelTransparentWrappers(target.expression),
    name: target.argumentExpression === undefined ? null : constantString(target.argumentExpression)
  }
}

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

function codeGenerationName(expression: Node): "eval" | "Function" | null {
  const name = constantGlobalName(expression)
  return name === "eval" || name === "Function" ? name : null
}

function peelTransparentWrappers(node: Node): Node {
  let current = node
  while (
    isParenthesizedExpression(current) ||
    isAsExpression(current) ||
    isNonNullExpression(current) ||
    isSatisfiesExpression(current) ||
    isTypeAssertion(current)
  ) {
    current = current.expression
  }
  return current
}

function hasJSDoc(node: Node, sourceFile: SourceFile): boolean {
  const leading = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile))
  return /\/\*\*[\s\S]*\*\/\s*$/.test(leading)
}

function namedFunctionDeclaration(node: Node): VariableDeclaration | null {
  if (!isArrowFunction(node) && !isFunctionExpression(node)) return null
  const parent = node.parent
  if (!isVariableDeclaration(parent) || parent.name.kind !== SyntaxKind.Identifier) return null
  return parent
}

function namedFunctionProperty(node: Node): Node | null {
  if (!isArrowFunction(node) && !isFunctionExpression(node)) return null
  return isPropertyAssignment(node.parent) ? node.parent : null
}

function namedFunctionName(node: Node, sourceFile: SourceFile): string | null {
  const declaration = namedFunctionDeclaration(node)
  if (declaration !== null) return declaration.name.getText(sourceFile)
  const property = namedFunctionProperty(node)
  if (property !== null && isPropertyAssignment(property)) return property.name.getText(sourceFile)
  if (isFunctionExpression(node) && node.name !== undefined) return node.name.text
  return null
}

function hasFunctionJSDoc(node: Node, sourceFile: SourceFile): boolean {
  if (hasJSDoc(node, sourceFile)) return true
  const declaration = namedFunctionDeclaration(node)
  if (declaration !== null) {
    const statement = declaration.parent.parent
    return hasJSDoc(declaration, sourceFile) || hasJSDoc(statement, sourceFile)
  }
  const property = namedFunctionProperty(node)
  return property !== null && hasJSDoc(property, sourceFile)
}

function allowedRestParameter(node: Node, sourceFile: SourceFile): boolean {
  if (node.kind !== SyntaxKind.Parameter) return false
  if (node.getText(sourceFile) !== "...options: readonly NodeServerOption[]") return false
  const parent = node.parent.getText(sourceFile)
  if (
    !parent.startsWith("export function newNodeServer(") &&
    !parent.startsWith("export function newNodeServerWithFactory(")
  )
    return false
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const lineStarts = sourceFile.getLineStarts()
  const start = lineStarts[location.line]
  const end = lineStarts[location.line + 1] ?? sourceFile.end
  if (start === undefined) return false
  return sourceFile.text.slice(start, end).trimEnd().endsWith(FunctionalOptionRestJustification)
}

function sourceViolations(sourceFile: SourceFile, sourceFiles: ReadonlySet<string>): string[] {
  const violations: string[] = []
  if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(sourceFile.text))
    violations.push("syntax:ts-suppression")
  const inspectModule = (specifier: string): void => {
    if (!relativeModule(specifier)) {
      if (!allowedBareModule(specifier)) violations.push(`module:${specifier}`)
      return
    }
    if (/\.(?:[cm]?js|[cm]?ts)$/.test(specifier)) {
      violations.push(`module:${specifier}`)
      return
    }
    const exactSource = normalize(resolve(dirname(sourceFile.fileName), `${specifier}.ts`))
    if (!sourceFiles.has(exactSource)) violations.push(`module:unresolved-relative:${specifier}`)
  }
  const visit = (node: Node): void => {
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
    const functionName = namedFunctionName(node, sourceFile)
    if (functionName !== null && !hasFunctionJSDoc(node, sourceFile)) {
      violations.push(`jsdoc:function:${functionName}`)
    }
    if (isMethodDeclaration(node) && !hasJSDoc(node, sourceFile)) {
      violations.push(`jsdoc:method:${node.name.getText(sourceFile)}`)
    }
    if (isMethodSignatureDeclaration(node) && !hasJSDoc(node, sourceFile)) {
      violations.push(`jsdoc:method:${node.name.getText(sourceFile)}`)
    }
    if (isCallSignatureDeclaration(node) && !hasJSDoc(node, sourceFile)) {
      violations.push("jsdoc:call-signature")
    }
    if (
      isFunctionTypeNode(node) &&
      isTypeAliasDeclaration(node.parent) &&
      !hasJSDoc(node.parent, sourceFile)
    ) {
      violations.push(`jsdoc:type:${node.parent.name.text}`)
    }
    if (
      isFunctionTypeNode(node) &&
      isPropertySignatureDeclaration(node.parent) &&
      !hasJSDoc(node.parent, sourceFile)
    ) {
      violations.push(`jsdoc:property:${node.parent.name.getText(sourceFile)}`)
    }

    if (isIdentifier(node) && ForbiddenGlobals.has(node.text))
      violations.push(`global:${node.text}`)
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(specifier.text)
    }
    if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
      violations.push("syntax:import-equals-external-reference")
      const specifier = node.moduleReference.expression
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(specifier.text)
    }
    if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(specifier.text)
      else violations.push("module:<non-literal-dynamic-import>")
    } else if (isCallExpression(node) && commonJsLoader(node.expression)) {
      const [specifier] = node.arguments
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(specifier.text)
      else violations.push("module:<non-literal-commonjs-loader>")
    }
    if (isCallExpression(node) || isNewExpression(node)) {
      const generated = codeGenerationName(node.expression)
      if (generated !== null) violations.push(`code-generation:${generated}`)
    }
    const property = staticProperty(node)
    const receiverName = property === null ? null : constantGlobalName(property.receiver)
    if (property !== null && (receiverName === "globalThis" || receiverName === "global")) {
      if (property.name !== null && ForbiddenGlobals.has(property.name))
        violations.push(`global:${property.name}`)
      else violations.push("global:globalThis-computed-access")
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return violations
}

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

async function syntheticViolations(
  source: string,
  dependencies: Readonly<Record<string, string>> = {}
): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "likego-fetch-node-policy-"))
  const configPath = join(root, "tsconfig.json")
  const sourcePath = join(root, "synthetic.ts")
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023" },
        include: ["synthetic.ts"]
      })
    )
    await writeFile(sourcePath, source)
    const sourceFiles = new Set([normalize(sourcePath)])
    for (const [file, contents] of Object.entries(dependencies)) {
      const dependencyPath = join(root, file)
      await writeFile(dependencyPath, contents)
      sourceFiles.add(normalize(dependencyPath))
    }
    return await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return sourceViolations(sourceFile, sourceFiles)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test.each([
  [
    "an import-equals external reference",
    'import Legacy = require("node:path")',
    "syntax:import-equals-external-reference"
  ],
  ["a direct require call", 'void require("node:util")', "module:node:util"],
  ["a parenthesized require call", 'void (require)("node:buffer")', "module:node:buffer"],
  ["a module.require call", 'void module.require("node:events")', "module:node:events"],
  [
    "a type-asserted require call",
    'void (require as unknown as Function)("node:fs")',
    "module:node:fs"
  ],
  ["computed globalThis process", 'void globalThis["process"]', "global:process"],
  ["template globalThis process", "void globalThis[`process`]", "global:process"],
  ["interpolated constant globalThis process", 'void globalThis[`${"pro"}cess`]', "global:process"],
  ["constant-computed globalThis process", 'void globalThis["pro" + "cess"]', "global:process"],
  ["computed Node global process", 'void global["process"]', "global:process"],
  ["parenthesized globalThis process", 'void (globalThis)[("pro" + "cess")]', "global:process"],
  [
    "a type-asserted globalThis process",
    'void (globalThis as unknown as Record<string, unknown>)["process"]',
    "global:process"
  ],
  ["an aliased globalThis", 'const root = globalThis; void root["process"]', "global:globalThis"],
  [
    "an unapproved globalThis computed access",
    'void globalThis["set" + "Timeout"]',
    "global:globalThis-computed-access"
  ],
  ["a direct eval", 'void eval("1")', "code-generation:eval"],
  ["an indirect eval", 'void (0, eval)("1")', "code-generation:eval"],
  ["a Node global eval", 'void global["eval"]("1")', "code-generation:eval"],
  ["an aliased eval", 'const execute = eval; void execute("1")', "global:eval"],
  ["a Function call", 'void Function("return 1")', "code-generation:Function"],
  ["a Function constructor", 'void new Function("return 1")', "code-generation:Function"],
  [
    "a globalThis Function constructor",
    'void new globalThis["Fun" + "ction"]("return 1")',
    "code-generation:Function"
  ],
  [
    "a Node global Function constructor",
    'void new global["Function"]("return 1")',
    "code-generation:Function"
  ],
  ["a computed CommonJS loader", 'void module["re" + "quire"]("node:fs")', "module:node:fs"],
  ["a non-literal CommonJS loader", "void require(name)", "module:<non-literal-commonjs-loader>"],
  ["a class declaration", "class Bad {}", "class-declaration:Bad"],
  [
    "a non-literal dynamic import",
    "void import(Math.random() > 0.5 ? './a.js' : './b.js')",
    "module:<non-literal-dynamic-import>"
  ]
] as const)("rejects %s", async (_name, source, expectedViolation) => {
  expect(await syntheticViolations(source)).toContain(expectedViolation)
})

test("accepts comments and strings mentioning forbidden globals", async () => {
  expect(await syntheticViolations('// eval("1")\nvoid "Function process"')).toEqual([])
})

const RelativeSpecifierCases: ReadonlyArray<readonly [string, string, string]> = [
  ["compiled JavaScript", 'import "./dependency.js"', "module:./dependency.js"],
  ["explicit TypeScript", 'import "./dependency.ts"', "module:./dependency.ts"],
  ["explicit ESM JavaScript", 'import "./dependency.mjs"', "module:./dependency.mjs"]
]

test.each(RelativeSpecifierCases)(
  "rejects %s relative source specifiers",
  async (_name, source, expectedViolation) => {
    expect(await syntheticViolations(source)).toContain(expectedViolation)
  }
)

test("accepts an extensionless relative source specifier", async () => {
  expect(
    await syntheticViolations('import "./dependency"', { "dependency.ts": "export {}" })
  ).toEqual([])
})

test("rejects an extensionless relative specifier without an exact TypeScript source", async () => {
  expect(await syntheticViolations('import "./dependency"')).toContain(
    "module:unresolved-relative:./dependency"
  )
})

test.each([
  ["an as assertion", "const value = 1 as number", "syntax:as-assertion"],
  ["an angle assertion", "const value = <number>1", "syntax:angle-assertion"],
  [
    "a non-null assertion",
    "declare const value: string | null; void value!",
    "syntax:non-null-assertion"
  ],
  [
    "a definite-assignment assertion",
    "let value!: string; void value",
    "syntax:definite-assignment-assertion"
  ],
  ["an explicit any", "let value: any; void value", "syntax:explicit-any"],
  ["an array spread", "const values = [...input]", "syntax:spread"],
  ["an object spread", "const value = { ...input }", "syntax:spread"],
  ["an internal rest parameter", "function values(...input: unknown[]): void {}", "syntax:rest"],
  ["a ts-ignore directive", "// @ts-ignore\nvoid missing", "syntax:ts-suppression"],
  ["a ts-expect-error directive", "// @ts-expect-error\nvoid missing", "syntax:ts-suppression"],
  ["a ts-nocheck directive", "// @ts-nocheck\nvoid missing", "syntax:ts-suppression"],
  ["an undocumented function", "function undocumented(): void {}", "jsdoc:function:undocumented"],
  [
    "an undocumented named arrow",
    "const undocumented = (): void => {}",
    "jsdoc:function:undocumented"
  ],
  [
    "an undocumented named function expression",
    "const undocumented = function internal(): void {}",
    "jsdoc:function:undocumented"
  ],
  [
    "an undocumented named callback expression",
    "void Promise.resolve().then(function callback(): void {})",
    "jsdoc:function:callback"
  ],
  [
    "an undocumented property arrow",
    "const value = { callback: (): void => {} }; void value",
    "jsdoc:function:callback"
  ],
  [
    "an undocumented method",
    "const value = { method(): void {} }; void value",
    "jsdoc:method:method"
  ],
  ["an undocumented method signature", "interface Value { method(): void }", "jsdoc:method:method"],
  ["an undocumented call signature", "interface Value { (): void }", "jsdoc:call-signature"],
  [
    "an undocumented callable type alias",
    "type Handler = (value: string) => void",
    "jsdoc:type:Handler"
  ],
  [
    "an undocumented function-valued property",
    "interface Value { callback: (value: string) => void }",
    "jsdoc:property:callback"
  ]
] as const)(
  "rejects %s",
  async (_name, source, expectedViolation) => {
    expect(await syntheticViolations(source)).toContain(expectedViolation)
  },
  10_000
)

test("accepts documented callable declaration forms", async () => {
  expect(
    await syntheticViolations(`
    /** Performs one documented operation. */
    function documented(): void {}
    /** Performs one documented arrow operation. */
    const documentedArrow = (): void => {}
    /** Performs one documented function-expression operation. */
    const documentedExpression = function internal(): void {}
    const value = {
      /** Performs one documented method operation. */
      method(): void {},
      /** Performs one documented property operation. */
      callback: (): void => {}
    }
    /** Handles one aliased operation. */
    type Handler = (input: string) => void
    interface CallableValue {
      /** Performs one documented signature operation. */
      method(): void
      /** Performs one documented direct call operation. */
      (): void
      /** Performs one documented function-valued property operation. */
      callback: (input: string) => void
    }
    documented()
    documentedArrow()
    documentedExpression()
    value.method()
    value.callback()
  `)
  ).toEqual([])
})

test.each([
  [
    "the exact option rest without a justification",
    "/** Constructs a server. */\nexport function newNodeServer(handler: unknown,\n  ...options: readonly NodeServerOption[]\n): unknown { return handler }"
  ],
  [
    "the exact option rest with an imprecise justification",
    "/** Constructs a server. */\nexport function newNodeServer(handler: unknown,\n  ...options: readonly NodeServerOption[] // Variadic options.\n): unknown { return handler }"
  ],
  [
    "the justified rest on another function",
    "/** Constructs another server. */\nexport function anotherServer(handler: unknown,\n  ...options: readonly NodeServerOption[] // Go-style functional options require this single variadic construction boundary.\n): unknown { return handler }"
  ]
] as const)("rejects %s", async (_name, source) => {
  expect(await syntheticViolations(source)).toContain("syntax:rest")
})

test("accepts the exact locally justified Go-style functional-option rest", async () => {
  expect(
    await syntheticViolations(
      [
        "/** Constructs a server from Go-style functional options. */",
        "export function newNodeServer(handler: unknown,",
        "  ...options: readonly NodeServerOption[] // Go-style functional options require this single variadic construction boundary.",
        "): unknown { return handler }"
      ].join("\n")
    )
  ).toEqual([])
})

test("Node production source has complete inventory and no policy violations", async () => {
  const packageRoot = resolve(import.meta.dir, "../..")
  const sourceRoot = `${packageRoot}/src`
  const files: string[] = []
  const violations: string[] = []

  for await (const file of new Bun.Glob("node*.ts").scan({ cwd: sourceRoot, onlyFiles: true }))
    files.push(file)
  files.sort()
  const sourceFiles = new Set(files.map((file) => normalize(resolve(sourceRoot, file))))

  await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async (project) => {
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${sourceRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source file is missing: ${file}`)
      for (const violation of sourceViolations(sourceFile, sourceFiles))
        violations.push(`${file}:${violation}`)
    }
  })

  expect(files).toEqual(["node-errors.ts", "node-server.ts", "node.ts"])
  expect(violations).toEqual([])
})
