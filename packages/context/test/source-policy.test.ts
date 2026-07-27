import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  createScanner,
  isArrowFunction,
  isAsExpression,
  isClassDeclaration,
  isClassExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionTypeNode,
  isMethodDeclaration,
  isNonNullExpression,
  isPropertySignatureDeclaration,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  type VariableDeclaration
} from "typescript/unstable/ast"

function hasJSDoc(node: Node): boolean {
  return (
    node.jsDoc?.some((doc) => {
      const text = doc.getText(node.getSourceFile())
      return (
        text
          .replace(/^\/\*\*|\*\/$/g, "")
          .replace(/\*/g, "")
          .trim() !== ""
      )
    }) === true
  )
}

/** Returns the variable declaration that gives an arrow or function expression its business name. */
function namedFunctionDeclaration(node: Node): VariableDeclaration | null {
  if (!isArrowFunction(node) && !isFunctionExpression(node)) return null
  const parent = node.parent
  if (!isVariableDeclaration(parent) || parent.name.kind !== SyntaxKind.Identifier) return null
  return parent
}

/** Reports whether a named arrow or function expression is documented at any valid declaration site. */
function hasNamedFunctionJSDoc(node: Node, declaration: VariableDeclaration): boolean {
  return hasJSDoc(node) || hasJSDoc(declaration) || hasJSDoc(declaration.parent.parent)
}

/** Finds the callable type alias or property that owns a FunctionType node. */
function callableTypeOwner(node: Node): Node | null {
  if (!isFunctionTypeNode(node)) return null
  let current = node.parent
  while (current.kind !== SyntaxKind.SourceFile) {
    if (isPropertySignatureDeclaration(current) || isTypeAliasDeclaration(current)) return current
    if (
      isFunctionDeclaration(current) ||
      isFunctionExpression(current) ||
      isArrowFunction(current) ||
      isMethodDeclaration(current) ||
      current.kind === SyntaxKind.MethodSignature
    ) {
      return null
    }
    current = current.parent
  }
  return null
}

/** Returns a stable source-policy label for a callable type alias or property. */
function callableTypeName(owner: Node, sourceFile: SourceFile): string {
  if (isTypeAliasDeclaration(owner)) return owner.name.text
  if (isPropertySignatureDeclaration(owner)) return owner.name.getText(sourceFile)
  return "<anonymous>"
}

function suppressionViolations(sourceFile: SourceFile): string[] {
  const scanner = createScanner(false, sourceFile.languageVariant, sourceFile.text)
  const violations: string[] = []
  while (scanner.scan() !== SyntaxKind.EndOfFile) {
    const token = scanner.getToken()
    if (
      token !== SyntaxKind.SingleLineCommentTrivia &&
      token !== SyntaxKind.MultiLineCommentTrivia
    ) {
      continue
    }
    const match = /@ts-(ignore|expect-error|nocheck)\b/.exec(scanner.getTokenText())
    if (match !== null) violations.push(`suppression:@ts-${match[1]}`)
  }
  return violations
}

/** Reports whether a parameter or binding element owns an actual rest token. */
function hasRestToken(node: Node): boolean {
  if (node.kind !== SyntaxKind.Parameter && node.kind !== SyntaxKind.BindingElement) return false
  return "dotDotDotToken" in node && node.dotDotDotToken !== undefined
}

function sourceViolations(sourceFile: SourceFile): string[] {
  const violations = suppressionViolations(sourceFile)
  const inspectedCallableTypes = new Set<number>()
  const visit = (node: Node): void => {
    if (isClassDeclaration(node)) {
      violations.push(`class-declaration:${node.name?.text ?? "<anonymous>"}`)
    } else if (isClassExpression(node)) {
      violations.push(`class-expression:${node.name?.text ?? "<anonymous>"}`)
    } else if (isAsExpression(node)) {
      violations.push("type-assertion:as")
    } else if (isTypeAssertion(node)) {
      violations.push("type-assertion:angle")
    } else if (isNonNullExpression(node)) {
      violations.push("type-assertion:non-null")
    } else if (isVariableDeclaration(node) && node.exclamationToken !== undefined) {
      violations.push("type-assertion:definite-assignment")
    } else if (node.kind === SyntaxKind.AnyKeyword) {
      violations.push("explicit-any")
    } else if (node.kind === SyntaxKind.SpreadElement) {
      violations.push("spread-element")
    } else if (node.kind === SyntaxKind.SpreadAssignment) {
      violations.push("spread-assignment")
    } else if (hasRestToken(node)) {
      violations.push("rest-element")
    }
    if (isFunctionDeclaration(node) && !hasJSDoc(node)) {
      violations.push(`jsdoc:function:${node.name?.text ?? "<anonymous>"}`)
    } else if (isMethodDeclaration(node) && !hasJSDoc(node)) {
      violations.push(`jsdoc:method:${node.name.getText(sourceFile)}`)
    }
    const named = namedFunctionDeclaration(node)
    if (named !== null && !hasNamedFunctionJSDoc(node, named)) {
      violations.push(`jsdoc:function:${named.name.getText(sourceFile)}`)
    }
    if (node.kind === SyntaxKind.MethodSignature && !hasJSDoc(node)) {
      violations.push(
        `jsdoc:method:${node.getText(sourceFile).split("(", 1)[0]?.trim() ?? "<anonymous>"}`
      )
    }
    const callableOwner = callableTypeOwner(node)
    if (
      callableOwner !== null &&
      !inspectedCallableTypes.has(callableOwner.pos) &&
      !hasJSDoc(callableOwner)
    ) {
      inspectedCallableTypes.add(callableOwner.pos)
      violations.push(`jsdoc:callable-type:${callableTypeName(callableOwner, sourceFile)}`)
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

test("detects named class declarations and anonymous or named class expressions", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-context-source-policy-"))
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
    await writeFile(
      sourcePath,
      [
        "class NamedDeclaration {}",
        "const AnonymousExpression = class {}",
        "const NamedExpression = class Inner {}"
      ].join("\n")
    )

    const forms = await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return sourceViolations(sourceFile).filter((violation) => violation.startsWith("class-"))
    })

    expect(forms).toEqual([
      "class-declaration:NamedDeclaration",
      "class-expression:<anonymous>",
      "class-expression:Inner"
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("detects missing JSDoc, all assertion forms, and TypeScript suppression pragmas", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-context-type-policy-"))
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
    await writeFile(
      sourcePath,
      [
        "function undocumented(): void {}",
        "const documented = {",
        "  /** Documents the method. */",
        "  run(): void {}",
        "}",
        "const undocumentedObject = {",
        "  missing(): void {}",
        "}",
        "const chained = value as unknown as string",
        "const angle = <string>value",
        "const nonNull = value!",
        "let deferred!: () => void",
        "const broad: any = value",
        "const spreadArray = [...items]",
        "const spreadObject = { ...documented }",
        "/** Documents the synthetic forbidden rest form. */",
        "function variadic(...items: string[]): void { void items }",
        "// @ts-ignore",
        "void chained",
        "// @ts-expect-error expected failure",
        "void angle",
        "// @ts-nocheck"
      ].join("\n")
    )

    const violations = await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return sourceViolations(sourceFile)
    })

    expect(violations).toContain("jsdoc:function:undocumented")
    expect(violations).not.toContain("jsdoc:method:run")
    expect(violations).toContain("jsdoc:method:missing")
    expect(violations.filter((violation) => violation === "type-assertion:as")).toHaveLength(2)
    expect(violations).toContain("type-assertion:angle")
    expect(violations).toContain("type-assertion:non-null")
    expect(violations).toContain("type-assertion:definite-assignment")
    expect(violations).toContain("explicit-any")
    expect(violations).toContain("spread-element")
    expect(violations).toContain("spread-assignment")
    expect(violations).toContain("rest-element")
    expect(violations).toContain("suppression:@ts-ignore")
    expect(violations).toContain("suppression:@ts-expect-error")
    expect(violations).toContain("suppression:@ts-nocheck")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("detects undocumented named expressions, method signatures, and callable type owners", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-context-callable-policy-"))
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
    await writeFile(
      sourcePath,
      [
        "const missingArrow = (): void => {}",
        "const missingExpression = function inner(): void {}",
        "/** Documents the named arrow. */",
        "const documentedArrow = (): void => {}",
        "/** Documents the named function expression. */",
        "const documentedExpression = function inner(): void {}",
        "interface CallableShape {",
        "  missingMethod(): void",
        "  /** Documents the method signature. */",
        "  documentedMethod(): void",
        "  missingProperty: null | (() => void)",
        "  /** Documents the callable property. */",
        "  documentedProperty: () => void",
        "}",
        "type MissingAlias = (callback: () => void) => void",
        "/** Documents the callable type alias. */",
        "type DocumentedAlias = () => void",
        "/** Documents the enclosing function instead of its callback parameter type. */",
        "function acceptsCallback(callback: () => void): void { callback() }"
      ].join("\n")
    )

    const violations = await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return sourceViolations(sourceFile).filter((violation) => violation.startsWith("jsdoc:"))
    })

    expect(violations).toEqual([
      "jsdoc:function:missingArrow",
      "jsdoc:function:missingExpression",
      "jsdoc:method:missingMethod",
      "jsdoc:callable-type:missingProperty",
      "jsdoc:callable-type:MissingAlias"
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("production source recursively satisfies class, JSDoc, assertion, and suppression policy", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourceRoot = `${packageRoot}/src`
  const files: string[] = []
  const violations: string[] = []

  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, onlyFiles: true })) {
    files.push(file)
  }
  files.sort()

  await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async (project) => {
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${sourceRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source file is missing: ${file}`)
      for (const violation of sourceViolations(sourceFile)) {
        violations.push(`${file}:${violation}`)
      }
    }
  })

  expect(files.length).toBeGreaterThan(0)
  expect(violations).toEqual([])
})
