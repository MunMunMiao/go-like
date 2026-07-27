import { extname } from "node:path"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  createScanner,
  isAsExpression,
  isClassDeclaration,
  isClassExpression,
  isExportDeclaration,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNonNullExpression,
  isPropertyDeclaration,
  isStringLiteral,
  isTypeAssertion,
  isVariableDeclaration,
  type Node,
  type SourceFile
} from "typescript/unstable/ast"

import { checkSemanticGlobals } from "../../../../tools/boundaries/semantic-global"

const AllowedModules = new Set([
  "@likego/context",
  "@likego/core/lifecycle",
  "@likego/store",
  "@likego/store/provider"
])
const AllowedProductionGlobals = Object.freeze([
  "AbortController",
  "AggregateError",
  "Array",
  "BigInt",
  "Date",
  "Error",
  "Headers",
  "JSON",
  "Math",
  "Number",
  "Object",
  "Promise",
  "RangeError",
  "Request",
  "Response",
  "String",
  "TextDecoder",
  "TextEncoder",
  "TypeError",
  "Uint8Array",
  "URL",
  "crypto",
  "undefined"
])
const FunctionKinds = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor
])
const CallableKinds = new Set([SyntaxKind.CallSignature, SyntaxKind.MethodSignature])

/** Reports whether a declaration owns a forbidden rest token. */
function hasRestToken(node: Node): boolean {
  if (node.kind !== SyntaxKind.Parameter && node.kind !== SyntaxKind.BindingElement) return false
  return "dotDotDotToken" in node && node.dotDotDotToken !== undefined
}

/** Reports whether one Go-style rest parameter carries explicit ABI evidence. */
function allowedRestToken(node: Node, sourceFile: SourceFile): boolean {
  if (!hasRestToken(node)) return true
  if (CallableKinds.has(node.parent.kind)) return true
  return node.parent.getFullText(sourceFile).includes("likego-typed-rest")
}

/** Reports whether one typed spread carries explicit forwarding evidence. */
function allowedSpread(node: Node, sourceFile: SourceFile): boolean {
  return node.parent.getFullText(sourceFile).includes("likego-typed-spread")
}

/** Reports whether one callable declaration owns non-empty JSDoc. */
function hasJSDoc(node: Node): boolean {
  return (
    node.jsDoc?.some(function nonEmpty(doc) {
      return (
        doc
          .getText(node.getSourceFile())
          .replace(/^\/\*\*|\*\/$/g, "")
          .replace(/\*/g, "")
          .trim() !== ""
      )
    }) === true
  )
}

/** Scans actual trivia for TypeScript suppression directives. */
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
    if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(scanner.getTokenText())) {
      violations.push("ts-suppression")
    }
  }
  return violations
}

/** Finds prohibited syntax, imports, and undocumented callables in one production file. */
function sourceViolations(sourceFile: SourceFile): string[] {
  const violations = suppressionViolations(sourceFile)
  /** Recursively checks one compiler node. */
  function visit(node: Node): void {
    if (isClassDeclaration(node) || isClassExpression(node)) violations.push("class")
    if (isAsExpression(node) || isTypeAssertion(node) || isNonNullExpression(node)) {
      violations.push("assertion")
    }
    if (
      (isVariableDeclaration(node) || isPropertyDeclaration(node)) &&
      node.getText(sourceFile).includes("!:")
    ) {
      violations.push("definite-assignment")
    }
    if (node.kind === SyntaxKind.AnyKeyword) violations.push("explicit-any")
    if (node.kind === SyntaxKind.SpreadElement && !allowedSpread(node, sourceFile)) {
      violations.push("spread-element")
    }
    if (node.kind === SyntaxKind.SpreadAssignment) violations.push("spread-assignment")
    if (!allowedRestToken(node, sourceFile)) violations.push("rest-element")
    if (FunctionKinds.has(node.kind) && !hasJSDoc(node)) {
      violations.push(`jsdoc:${node.kind}:${node.getText(sourceFile).split("\n", 1)[0]}`)
    }
    if (CallableKinds.has(node.kind) && !hasJSDoc(node)) {
      violations.push(`jsdoc:${node.kind}:${node.getText(sourceFile).split("\n", 1)[0]}`)
    }
    if (
      node.kind === SyntaxKind.FunctionType &&
      (node.parent.kind === SyntaxKind.TypeAliasDeclaration ||
        node.parent.kind === SyntaxKind.PropertySignature) &&
      !hasJSDoc(node.parent)
    ) {
      violations.push("jsdoc:function-type")
    }
    if (isImportEqualsDeclaration(node)) violations.push("import-equals")
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && isStringLiteral(specifier)) {
        if (specifier.text.startsWith(".")) {
          if (extname(specifier.text) !== "") {
            violations.push(`relative-extension:${specifier.text}`)
          }
        } else if (!AllowedModules.has(specifier.text)) {
          violations.push(`module:${specifier.text}`)
        }
      }
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return violations
}

/** Opens one compiler project and always disposes its semantic session. */
async function withProject<T>(root: string, use: (project: Project) => Promise<T>): Promise<T> {
  const api = new API({ cwd: root })
  let snapshot: Snapshot | null = null
  try {
    snapshot = await api.updateSnapshot({ openProjects: [`${root}/tsconfig.json`] })
    const projects = snapshot.getProjects()
    if (projects.length !== 1) throw new Error("source policy requires exactly one project")
    const project = projects[0]
    if (project === undefined) throw new Error("source policy project missing")
    return await use(project)
  } finally {
    if (snapshot !== null) await snapshot.dispose()
    await api.close()
  }
}

test("production source is classless, assertion-free, documented, and Web-platform portable", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const violations = await withProject(packageRoot, async function inspect(project) {
    const results: string[] = []
    const sourceFiles: SourceFile[] = []
    for await (const file of new Bun.Glob("src/**/*.ts").scan({
      cwd: packageRoot,
      onlyFiles: true
    })) {
      const sourceFile = await project.program.getSourceFile(`${packageRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source missing: ${file}`)
      sourceFiles.push(sourceFile)
      for (const violation of sourceViolations(sourceFile)) results.push(`${file}:${violation}`)
    }
    const globalIssues = await checkSemanticGlobals(project, sourceFiles, {
      AllowedFreeGlobals: AllowedProductionGlobals
    })
    for (const issue of globalIssues) results.push(`${issue.Path}:${issue.Code}:${issue.Message}`)
    return results
  })
  expect(violations).toEqual([])
})

test("development trees contain no handwritten JavaScript or extensionful relative imports", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const violations: string[] = []
  for (const tree of ["src", "test"]) {
    for await (const file of new Bun.Glob("**/*").scan({
      cwd: `${packageRoot}/${tree}`,
      onlyFiles: true
    })) {
      if (!file.endsWith(".ts") && !file.endsWith(".md")) {
        violations.push(`handwritten-javascript:${tree}/${file}`)
      }
      if (!file.endsWith(".ts")) continue
      const source = await Bun.file(`${packageRoot}/${tree}/${file}`).text()
      for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])(\.\.?\/[^"']+)\1/g)) {
        const specifier = match[2]
        if (specifier !== undefined && extname(specifier) !== "") {
          violations.push(`relative-extension:${tree}/${file}:${specifier}`)
        }
      }
    }
  }
  expect(violations).toEqual([])
})
