import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32
} from "node:path"
import {
  SyntaxKind,
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  type Expression,
  type Node,
  type SourceFile
} from "typescript/unstable/ast"

export interface BoundaryIssue {
  readonly Code: string
  readonly Path: string
  readonly Message: string
}

export interface ModulePolicy {
  readonly PackageRoot: string
  readonly AllowedWorkspaceDependencies: readonly string[]
}

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function IsInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === ""
    || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
}

function IsCanonicalAbsolutePath(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value
}

function AdmitSourceIndex(
  sourceFiles: readonly SourceFile[],
  packageRoot: string,
  sourceRoot: string
): ReadonlySet<string> {
  if (!IsCanonicalAbsolutePath(packageRoot)) {
    throw new Error("module syntax package root must be an absolute canonical lexical path")
  }
  const sourceIndex = new Set<string>()
  for (const sourceFile of sourceFiles) {
    const pathFromSourceRoot = relative(sourceRoot, sourceFile.fileName)
    if (
      !IsCanonicalAbsolutePath(sourceFile.fileName)
      || pathFromSourceRoot.length === 0
      || !IsInside(sourceRoot, sourceFile.fileName)
    ) {
      throw new Error(
        "module syntax source file must be an absolute canonical lexical child of package src"
      )
    }
    sourceIndex.add(sourceFile.fileName)
  }
  return sourceIndex
}

function StableSourcePath(packageRoot: string, sourceFile: SourceFile): string {
  return relative(packageRoot, sourceFile.fileName).split(sep).join("/")
}

function Issue(Code: string, Path: string, Message: string): BoundaryIssue {
  return { Code, Path, Message }
}

function PeelParentheses(expression: Expression): Expression {
  let current = expression
  while (isParenthesizedExpression(current)) current = current.expression
  return current
}

function IsRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./")
    || specifier.startsWith("../")
    || specifier.startsWith(".\\")
    || specifier.startsWith("..\\")
}

function CheckSpecifier(
  specifier: string,
  sourceFile: SourceFile,
  sourceRoot: string,
  sourceIndex: ReadonlySet<string>,
  allowedDependencies: ReadonlySet<string>,
  issues: BoundaryIssue[]
): void {
  const Path = StableSourcePath(dirname(sourceRoot), sourceFile)
  if (IsRelativeSpecifier(specifier)) {
    if (specifier.includes("\\") || !specifier.endsWith(".js")) {
      issues.push(Issue(
        "MODULE_RELATIVE_JS_EXTENSION_REQUIRED",
        Path,
        `relative module specifier must use a portable .js suffix: ${specifier}`
      ))
      return
    }
    const target = resolve(dirname(sourceFile.fileName), `${specifier.slice(0, -3)}.ts`)
    if (!IsInside(sourceRoot, target)) {
      issues.push(Issue(
        "MODULE_RELATIVE_PACKAGE_ESCAPE",
        Path,
        `relative module specifier escapes the package src directory: ${specifier}`
      ))
      return
    }
    if (!sourceIndex.has(target)) {
      issues.push(Issue(
        "MODULE_RELATIVE_TARGET_MISSING",
        Path,
        `relative module specifier has no exact snapshotted .ts target: ${specifier}`
      ))
    }
    return
  }
  if (posix.isAbsolute(specifier) || win32.isAbsolute(specifier)) {
    issues.push(Issue(
      "MODULE_SPECIFIER_ABSOLUTE_FORBIDDEN",
      Path,
      `absolute module specifier is forbidden: ${specifier}`
    ))
    return
  }
  if (specifier.startsWith("#")) {
    issues.push(Issue(
      "MODULE_SPECIFIER_HASH_FORBIDDEN",
      Path,
      `package hash module specifier is forbidden: ${specifier}`
    ))
    return
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) {
    issues.push(Issue(
      "MODULE_SPECIFIER_SCHEME_FORBIDDEN",
      Path,
      `URI-scheme module specifier is forbidden: ${specifier}`
    ))
    return
  }
  if (!allowedDependencies.has(specifier)) {
    issues.push(Issue(
      "MODULE_BARE_DEPENDENCY_DISALLOWED",
      Path,
      `bare dependency is not an exact allowed workspace dependency: ${specifier}`
    ))
  }
}

export function CheckModuleSyntax(
  sourceFiles: readonly SourceFile[],
  policy: ModulePolicy
): readonly BoundaryIssue[] {
  const sourceRoot = join(policy.PackageRoot, "src")
  const sourceIndex = AdmitSourceIndex(sourceFiles, policy.PackageRoot, sourceRoot)
  const allowedDependencies = new Set(policy.AllowedWorkspaceDependencies)
  const issues: BoundaryIssue[] = []

  for (const sourceFile of sourceFiles) {
    const Path = StableSourcePath(policy.PackageRoot, sourceFile)
    function Classify(specifier: string): void {
      CheckSpecifier(specifier, sourceFile, sourceRoot, sourceIndex, allowedDependencies, issues)
    }
    function Visit(node: Node): void {
      if (isImportEqualsDeclaration(node)) {
        issues.push(Issue(
          "MODULE_IMPORT_EQUALS_FORBIDDEN",
          Path,
          "import-equals declarations are forbidden"
        ))
        return
      }
      if (isImportDeclaration(node)) {
        if (isStringLiteral(node.moduleSpecifier)) Classify(node.moduleSpecifier.text)
      } else if (isExportDeclaration(node)) {
        if (node.moduleSpecifier !== undefined && isStringLiteral(node.moduleSpecifier)) {
          Classify(node.moduleSpecifier.text)
        }
      } else if (isImportTypeNode(node)) {
        if (isLiteralTypeNode(node.argument) && isStringLiteral(node.argument.literal)) {
          Classify(node.argument.literal.text)
        }
      } else if (isCallExpression(node)) {
        if (node.expression.kind === SyntaxKind.ImportKeyword) {
          if (node.arguments.length !== 1 || !isStringLiteral(node.arguments[0]!)) {
            issues.push(Issue(
              "MODULE_DYNAMIC_IMPORT_NON_LITERAL",
              Path,
              "dynamic import must have exactly one string literal argument"
            ))
          } else {
            Classify(node.arguments[0].text)
          }
        } else {
          const expression = PeelParentheses(node.expression)
          const receiver = isPropertyAccessExpression(expression)
            ? PeelParentheses(expression.expression)
            : null
          if (isIdentifier(expression) && expression.text === "require") {
            issues.push(Issue(
              "MODULE_REQUIRE_FORBIDDEN",
              Path,
              "require calls are forbidden"
            ))
          } else if (
            isPropertyAccessExpression(expression)
            && receiver !== null
            && isIdentifier(receiver)
            && receiver.text === "module"
            && isIdentifier(expression.name)
            && expression.name.text === "require"
          ) {
            issues.push(Issue(
              "MODULE_MODULE_REQUIRE_FORBIDDEN",
              Path,
              "module.require calls are forbidden"
            ))
          }
        }
      }
      node.forEachChild(Visit)
    }
    sourceFile.forEachChild(Visit)
  }

  return issues.sort((left, right) => (
    CompareCodeUnits(left.Code, right.Code)
    || CompareCodeUnits(left.Path, right.Path)
    || CompareCodeUnits(left.Message, right.Message)
  ))
}
