import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path"
import type { Project, Symbol as TypeScriptSymbol } from "typescript/unstable/async"
import {
  CharacterCodes,
  ModifierFlags,
  NodeFlags,
  SyntaxKind,
  createScanner,
  isAsExpression,
  isClassLikeDeclaration,
  isElementAccessExpression,
  isExportDeclaration,
  isExpressionWithTypeArguments,
  isHeritageClause,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isJSDocNodeKind,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeAssertion,
  isTypeNode,
  type Identifier,
  type Node,
  type ShorthandPropertyAssignment,
  type SourceFile
} from "typescript/unstable/ast"
import type { BoundaryIssue } from "./module-syntax"

export interface GlobalPolicy {
  readonly AllowedFreeGlobals: readonly string[]
}

interface AdmittedSource {
  readonly SourceFile: SourceFile
  readonly Path: string
}

interface CandidateIdentifier {
  readonly Identifier: Identifier
  readonly Path: string
  readonly Shorthand: ShorthandPropertyAssignment | null
}

interface PendingProperty {
  readonly Selector: Node
  readonly Receiver: Node
  readonly Name: string
  readonly Path: string
}

interface NodeFields {
  readonly name?: Node
  readonly propertyName?: Node
  readonly label?: Node
  readonly tagName?: Node
  readonly modifierFlags?: number
}

type SymbolClassification =
  | "local"
  | "default-library"
  | "arguments"
  | "standard-intrinsic"
  | "global-this"
  | "ambient"
  | "external"
  | "mixed"
  | "unresolved"

interface ClassificationContext {
  readonly Project: Project
  readonly AdmittedFiles: ReadonlySet<string>
  readonly DefaultLibraryByPath: Map<string, Promise<boolean>>
  readonly ExternalLibraryByPath: Map<string, Promise<boolean>>
}

const NoCheckSingleLine = /^\/\/[ \t]*@ts-nocheck(?=$|[ \t\r\n])/
const NoCheckMultiLine = /^\/\*+[ \t\r\n*]*@ts-nocheck(?=$|[ \t\r\n*/])/
function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function Issue(Code: string, Path: string, Message: string): BoundaryIssue {
  return { Code, Path, Message }
}

function IsCanonicalAbsolutePath(path: string): boolean {
  return isAbsolute(path) && normalize(path) === path && resolve(path) === path
}

function AdmitSources(
  project: Project,
  sourceFiles: readonly SourceFile[]
): {
  readonly PackageRoot: string
  readonly Sources: readonly AdmittedSource[]
} {
  const configFileName = project.configFileName
  if (!IsCanonicalAbsolutePath(configFileName)) {
    throw new Error("semantic global project config must be an absolute canonical path")
  }
  const packageRoot = dirname(configFileName)
  const sources: AdmittedSource[] = []
  for (const sourceFile of sourceFiles) {
    if (!IsCanonicalAbsolutePath(sourceFile.fileName)) {
      throw new Error("semantic global source must be an absolute canonical path")
    }
    const pathFromPackage = relative(packageRoot, sourceFile.fileName)
    const parts = pathFromPackage.split(sep)
    if (
      pathFromPackage.length === 0 ||
      isAbsolute(pathFromPackage) ||
      parts[0] !== "src" ||
      parts.some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      throw new Error("semantic global source must be a package-relative src child")
    }
    const path = parts.join("/")
    sources.push({ SourceFile: sourceFile, Path: path })
  }
  sources.sort((left, right) => CompareCodeUnits(left.Path, right.Path))
  return { PackageRoot: packageRoot, Sources: sources }
}

function HasAmbientMarker(node: Node): boolean {
  const fields = node as Node & NodeFields
  return (
    (node.flags & NodeFlags.Ambient) !== 0 ||
    (typeof fields.modifierFlags === "number" &&
      (fields.modifierFlags & ModifierFlags.Ambient) !== 0)
  )
}

function IsWithinAmbientDeclaration(node: Node, sourceFile: SourceFile): boolean {
  if (sourceFile.isDeclarationFile) return true
  let current: Node = node
  while (current !== sourceFile) {
    if (HasAmbientMarker(current)) return true
    current = current.parent
  }
  return false
}

function IsRuntimeClassExtends(node: Node): boolean {
  if (!isExpressionWithTypeArguments(node)) return false
  const heritage = node.parent
  return (
    isHeritageClause(heritage) &&
    heritage.token === SyntaxKind.ExtendsKeyword &&
    isClassLikeDeclaration(heritage.parent)
  )
}

function ShorthandFor(identifier: Identifier): ShorthandPropertyAssignment | null {
  const parent = identifier.parent
  if (
    isShorthandPropertyAssignment(parent) &&
    (parent as unknown as NodeFields).name === identifier
  )
    return parent
  return null
}

function IsJsxIntrinsic(identifier: Identifier): boolean {
  const parent = identifier.parent as Node & NodeFields
  const first = identifier.text.charCodeAt(0)
  return (
    parent.tagName === identifier &&
    ((first >= CharacterCodes.a && first <= CharacterCodes.z) || identifier.text.includes("-"))
  )
}

function IsExcludedIdentifier(identifier: Identifier): boolean {
  const parent = identifier.parent as Node & NodeFields
  if (ShorthandFor(identifier) !== null) return false
  if (
    parent.name === identifier ||
    parent.propertyName === identifier ||
    parent.label === identifier
  )
    return true
  return IsJsxIntrinsic(identifier)
}

function ScanTypeScriptDirectives(sourceFile: SourceFile, Path: string): BoundaryIssue[] {
  const issues: BoundaryIssue[] = []
  const scanner = createScanner(false, sourceFile.languageVariant, sourceFile.text)
  let token = scanner.scan()
  while (token !== SyntaxKind.EndOfFile) {
    if (
      token === SyntaxKind.SingleLineCommentTrivia ||
      token === SyntaxKind.MultiLineCommentTrivia
    ) {
      const text = scanner.getTokenText()
      if (NoCheckSingleLine.test(text) || NoCheckMultiLine.test(text)) {
        issues.push(
          Issue(
            "GLOBAL_TYPESCRIPT_DIRECTIVE_FORBIDDEN",
            Path,
            "TypeScript @ts-nocheck directive is forbidden"
          )
        )
      }
    }
    token = scanner.scan()
  }
  for (const directive of scanner.getCommentDirectives() ?? []) {
    void directive
    issues.push(
      Issue(
        "GLOBAL_TYPESCRIPT_DIRECTIVE_FORBIDDEN",
        Path,
        "TypeScript suppression directive is forbidden"
      )
    )
  }
  return issues
}

function CollectSource(
  admitted: AdmittedSource,
  candidates: CandidateIdentifier[],
  issues: BoundaryIssue[]
): void {
  const sourceFile = admitted.SourceFile
  const Path = admitted.Path
  if (sourceFile.isDeclarationFile) {
    issues.push(
      Issue(
        "GLOBAL_AMBIENT_DECLARATION_FORBIDDEN",
        Path,
        "declaration-file ambient authority is forbidden"
      )
    )
    return
  }

  for (const reference of sourceFile.typeReferenceDirectives) {
    issues.push(
      Issue(
        "GLOBAL_TYPE_REFERENCE_DIRECTIVE_FORBIDDEN",
        Path,
        "triple-slash types reference is forbidden: " + reference.fileName
      )
    )
  }
  issues.push(...ScanTypeScriptDirectives(sourceFile, Path))

  function Visit(node: Node): void {
    if (HasAmbientMarker(node)) {
      issues.push(
        Issue("GLOBAL_AMBIENT_DECLARATION_FORBIDDEN", Path, "ambient declaration is forbidden")
      )
      return
    }
    if (isJSDocNodeKind(node.kind) || (node.flags & NodeFlags.JSDoc) !== 0) return
    if (isImportDeclaration(node) || isImportEqualsDeclaration(node) || isExportDeclaration(node))
      return
    if (isExpressionWithTypeArguments(node)) {
      if (IsRuntimeClassExtends(node)) Visit(node.expression)
      return
    }
    if (isTypeNode(node)) return
    if (isIdentifier(node)) {
      if (!IsExcludedIdentifier(node)) {
        candidates.push({
          Identifier: node,
          Path,
          Shorthand: ShorthandFor(node)
        })
      }
      return
    }
    node.forEachChild(Visit)
  }

  sourceFile.forEachChild(Visit)
}

function SourceDefaultLibrary(
  sourceFile: SourceFile,
  context: ClassificationContext
): Promise<boolean> {
  let value = context.DefaultLibraryByPath.get(sourceFile.fileName)
  if (value === undefined) {
    value = context.Project.program.isSourceFileDefaultLibrary(sourceFile)
    context.DefaultLibraryByPath.set(sourceFile.fileName, value)
  }
  return value
}

function SourceExternalLibrary(
  sourceFile: SourceFile,
  context: ClassificationContext
): Promise<boolean> {
  let value = context.ExternalLibraryByPath.get(sourceFile.fileName)
  if (value === undefined) {
    value = context.Project.program.isSourceFileFromExternalLibrary(sourceFile)
    context.ExternalLibraryByPath.set(sourceFile.fileName, value)
  }
  return value
}

async function ClassifySymbol(
  symbol: TypeScriptSymbol | undefined,
  context: ClassificationContext
): Promise<SymbolClassification> {
  if (symbol === undefined) return "unresolved"
  const checker = context.Project.checker
  if (await checker.isUnknownSymbol(symbol)) return "unresolved"
  if (await checker.isArgumentsSymbol(symbol)) return "arguments"
  if (await checker.isUndefinedSymbol(symbol)) return "standard-intrinsic"
  if (symbol.declarations.length === 0) {
    return symbol.name === "globalThis" ? "global-this" : "unresolved"
  }

  const kinds = new Set<SymbolClassification>()
  for (const handle of symbol.declarations) {
    const declaration = await handle.resolve(context.Project)
    if (declaration === undefined) {
      kinds.add("unresolved")
      continue
    }
    const sourceFile = declaration.getSourceFile()
    if (await SourceDefaultLibrary(sourceFile, context)) {
      kinds.add("default-library")
      continue
    }
    const kind: SymbolClassification = IsWithinAmbientDeclaration(declaration, sourceFile)
      ? "ambient"
      : (await SourceExternalLibrary(sourceFile, context))
        ? "external"
        : context.AdmittedFiles.has(sourceFile.fileName)
          ? "local"
          : "unresolved"
    kinds.add(kind)
  }
  if (kinds.size !== 1) return "mixed"
  return [...kinds][0] as SymbolClassification
}

function IsWrapper(parent: Node, child: Node): boolean {
  return (
    (isParenthesizedExpression(parent) ||
      isAsExpression(parent) ||
      isSatisfiesExpression(parent) ||
      isNonNullExpression(parent) ||
      isTypeAssertion(parent)) &&
    parent.expression === child
  )
}

function PeelParentWrappers(node: Node): Node {
  let current = node
  while (IsWrapper(current.parent, current)) current = current.parent
  return current
}

function PeelExpressionWrappers(node: Node): Node {
  let current = node
  while (
    isParenthesizedExpression(current) ||
    isAsExpression(current) ||
    isSatisfiesExpression(current) ||
    isNonNullExpression(current) ||
    isTypeAssertion(current)
  )
    current = current.expression
  return current
}

function EscapeIssue(Path: string): BoundaryIssue {
  return Issue("GLOBAL_THIS_ESCAPE_FORBIDDEN", Path, "globalThis may not be aliased or escaped")
}

function QueueGlobalThisProperty(
  candidate: CandidateIdentifier,
  pending: PendingProperty[],
  issues: BoundaryIssue[]
): void {
  const origin = PeelParentWrappers(candidate.Identifier)
  const parent = origin.parent
  const access =
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === origin
      ? parent
      : null
  if (access === null) {
    issues.push(EscapeIssue(candidate.Path))
    return
  }
  if (isPropertyAccessExpression(access)) {
    const Name = access.name.text
    if (Name === "eval" || Name === "Function") {
      issues.push(
        Issue(
          "GLOBAL_DYNAMIC_CODE_FORBIDDEN",
          candidate.Path,
          "dynamic code globalThis property is forbidden: " + Name
        )
      )
      return
    }
    pending.push({
      Selector: access.name,
      Receiver: access.expression,
      Name,
      Path: candidate.Path
    })
    return
  }
  const selector = PeelExpressionWrappers(access.argumentExpression)
  if (!isStringLiteral(selector)) {
    issues.push(
      Issue(
        "GLOBAL_THIS_COMPUTED_ACCESS_FORBIDDEN",
        candidate.Path,
        "globalThis computed access must use one string literal"
      )
    )
    return
  }
  const Name = selector.text
  if (Name === "eval" || Name === "Function") {
    issues.push(
      Issue(
        "GLOBAL_DYNAMIC_CODE_FORBIDDEN",
        candidate.Path,
        "dynamic code globalThis property is forbidden: " + Name
      )
    )
    return
  }
  pending.push({
    Selector: selector,
    Receiver: access.expression,
    Name,
    Path: candidate.Path
  })
}

function CompareIssues(left: BoundaryIssue, right: BoundaryIssue): number {
  return (
    CompareCodeUnits(left.Code, right.Code) ||
    CompareCodeUnits(left.Path, right.Path) ||
    CompareCodeUnits(left.Message, right.Message)
  )
}

export async function checkSemanticGlobals(
  project: Project,
  sourceFiles: readonly SourceFile[],
  policy: GlobalPolicy
): Promise<readonly BoundaryIssue[]> {
  const admitted = AdmitSources(project, sourceFiles)
  const candidates: CandidateIdentifier[] = []
  const issues: BoundaryIssue[] = []
  for (const source of admitted.Sources) CollectSource(source, candidates, issues)

  const checker = project.checker
  const ordinarySymbols =
    candidates.length === 0
      ? []
      : await checker.getSymbolAtLocation(candidates.map((candidate) => candidate.Identifier))
  const symbols = await Promise.all(
    candidates.map(async (candidate, index) =>
      candidate.Shorthand === null
        ? ordinarySymbols[index]
        : await checker.getShorthandAssignmentValueSymbol(candidate.Shorthand)
    )
  )
  const context: ClassificationContext = {
    Project: project,
    AdmittedFiles: new Set(admitted.Sources.map((source) => source.SourceFile.fileName)),
    DefaultLibraryByPath: new Map(),
    ExternalLibraryByPath: new Map()
  }
  const classificationBySymbol = new Map<number, Promise<SymbolClassification>>()
  function Classification(symbol: TypeScriptSymbol | undefined): Promise<SymbolClassification> {
    if (symbol === undefined) return Promise.resolve("unresolved")
    let classification = classificationBySymbol.get(symbol.id)
    if (classification === undefined) {
      classification = ClassifySymbol(symbol, context)
      classificationBySymbol.set(symbol.id, classification)
    }
    return classification
  }
  const classifications = await Promise.all(symbols.map((symbol) => Classification(symbol)))
  const allowed = new Set(policy.AllowedFreeGlobals)
  const pending: PendingProperty[] = []

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!
    const classification = classifications[index]!
    const name = candidate.Identifier.text
    if (classification === "local" || classification === "arguments") continue
    if (classification === "global-this") {
      QueueGlobalThisProperty(candidate, pending, issues)
      continue
    }
    if (classification === "default-library" || classification === "standard-intrinsic") {
      if (name === "eval" || name === "Function") {
        issues.push(
          Issue(
            "GLOBAL_DYNAMIC_CODE_FORBIDDEN",
            candidate.Path,
            "dynamic code global is forbidden: " + name
          )
        )
      } else if (!allowed.has(name)) {
        issues.push(
          Issue(
            "GLOBAL_FREE_IDENTIFIER_FORBIDDEN",
            candidate.Path,
            "free global identifier is forbidden: " + name
          )
        )
      }
      continue
    }
    issues.push(
      Issue(
        "GLOBAL_FREE_IDENTIFIER_FORBIDDEN",
        candidate.Path,
        "free global identifier is forbidden: " + name
      )
    )
  }

  if (pending.length > 0) {
    const selectorSymbols = await checker.getSymbolAtLocation(
      pending.map((property) => property.Selector)
    )
    const missing = pending
      .map((property, index) => ({ index, property }))
      .filter(({ index }) => selectorSymbols[index] === undefined)
    if (missing.length > 0) {
      const receiverTypes = await checker.getTypeAtLocation(
        missing.map(({ property }) => property.Receiver)
      )
      const fallbackSymbols = await Promise.all(
        missing.map(async ({ property }, index) =>
          receiverTypes[index] === undefined
            ? undefined
            : checker.getPropertyOfType(receiverTypes[index]!, property.Name)
        )
      )
      for (let index = 0; index < missing.length; index += 1) {
        selectorSymbols[missing[index]!.index] = fallbackSymbols[index]
      }
    }
    const selectorClassifications = await Promise.all(
      selectorSymbols.map((symbol) => Classification(symbol))
    )
    for (let index = 0; index < pending.length; index += 1) {
      const property = pending[index]!
      if (
        !allowed.has(property.Name) ||
        (selectorClassifications[index] !== "default-library" &&
          selectorClassifications[index] !== "standard-intrinsic")
      ) {
        issues.push(
          Issue(
            "GLOBAL_THIS_PROPERTY_FORBIDDEN",
            property.Path,
            "globalThis property is forbidden or unproven: " + property.Name
          )
        )
      }
    }
  }

  return issues.sort(CompareIssues)
}
