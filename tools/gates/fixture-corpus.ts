import { readdir } from "node:fs/promises"
import { basename, join, relative, resolve, sep } from "node:path"
import type { GateCheck, InputSnapshot, SnapshotFile } from "./result.ts"

export interface FixtureIssue {
  readonly Code: string
}

export interface FixtureCase {
  readonly id: string
  readonly path: string
  readonly expectedCodes: readonly string[]
}

export interface CorpusEvaluation {
  readonly SubjectsExpected: number
  readonly SubjectsChecked: number
  readonly Checks: readonly GateCheck[]
}

interface CasesDocument {
  readonly schemaVersion: 1
  readonly cases: readonly FixtureCase[]
}

interface ValidationCodes {
  readonly Codes: readonly string[]
  readonly Fatal: boolean
}

interface PreparedCase {
  readonly Kind: "prepared-case"
  readonly FixtureCase: FixtureCase
  readonly Files: readonly SnapshotFile[]
  readonly ExpectedCodes: readonly string[]
}

interface CaseLocalFailure {
  readonly Kind: "case-local-failure"
  readonly Check: GateCheck
}

interface PreparedCorpus {
  readonly Kind: "prepared-corpus"
  readonly SubjectsExpected: number
  readonly Cases: readonly (PreparedCase | CaseLocalFailure)[]
}

interface CorpusPreparationFailure {
  readonly Kind: "preparation-failure"
  readonly Evaluation: CorpusEvaluation
}

type CorpusPreparation = PreparedCorpus | CorpusPreparationFailure

const Decoder = new TextDecoder("utf-8", { fatal: true })
const DiscoverySubstrings = [".test.", "_test_", ".spec.", "_spec_"] as const

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function IsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function HasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function IsSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    return false
  }
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
}

function ParseCases(file: SnapshotFile): CasesDocument | null {
  try {
    const value: unknown = JSON.parse(Decoder.decode(file.Bytes))
    if (
      !IsRecord(value)
      || !HasExactKeys(value, ["schemaVersion", "cases"])
      || value.schemaVersion !== 1
      || !Array.isArray(value.cases)
    ) {
      return null
    }
    const cases: FixtureCase[] = []
    for (const item of value.cases) {
      if (
        !IsRecord(item)
        || !HasExactKeys(item, ["id", "path", "expectedCodes"])
        || typeof item.id !== "string"
        || !/^[a-z][a-z0-9-]*$/.test(item.id)
        || typeof item.path !== "string"
        || !IsSafeRelativePath(item.path)
        || !Array.isArray(item.expectedCodes)
        || !item.expectedCodes.every((code) => typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code))
      ) {
        return null
      }
      cases.push({ id: item.id, path: item.path, expectedCodes: [...item.expectedCodes] as string[] })
    }
    return { schemaVersion: 1, cases }
  } catch {
    return null
  }
}

function InventoryFailure(expected: number, actual: number, detail: string): CorpusEvaluation {
  return {
    SubjectsExpected: expected,
    SubjectsChecked: 0,
    Checks: [{
      id: "FIXTURE_INVENTORY_MISMATCH",
      status: "fail",
      expected,
      actual,
      detail
    }]
  }
}

function RebasedFile(file: SnapshotFile, familyPrefix: string, fixtureCase: FixtureCase): SnapshotFile {
  const casePrefix = `${familyPrefix}${fixtureCase.path}`
  const Path = file.Path === casePrefix
    ? basename(fixtureCase.path)
    : file.Path.slice(casePrefix.length + 1)
  return { Path, RealPath: file.RealPath, Sha256: file.Sha256, Bytes: file.Bytes }
}

function ExactCodes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((code, index) => code === right[index])
}

function ValidationCodesFor(issues: unknown): ValidationCodes {
  if (!Array.isArray(issues)) return { Codes: ["FIXTURE_VALIDATOR_INVALID"], Fatal: true }
  const codes: string[] = []
  for (const issue of issues) {
    if (!IsRecord(issue) || typeof issue.Code !== "string" || issue.Code.length === 0) {
      return { Codes: ["FIXTURE_VALIDATOR_INVALID"], Fatal: true }
    }
    codes.push(issue.Code)
  }
  return { Codes: codes.sort(CompareCodeUnits), Fatal: false }
}

function ObserveThenableRejection(value: unknown): void {
  try {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return
    const then: unknown = (value as Readonly<{ then?: unknown }>).then
    if (typeof then !== "function") return
    void Promise.resolve(value).catch(() => {})
  } catch {}
}

function SafelyValidate(
  files: readonly SnapshotFile[],
  validate: (caseFiles: readonly SnapshotFile[]) => readonly FixtureIssue[]
): ValidationCodes {
  try {
    const result: unknown = validate(files)
    if (!Array.isArray(result)) ObserveThenableRejection(result)
    return ValidationCodesFor(result)
  } catch {
    return { Codes: ["FIXTURE_VALIDATOR_THROW"], Fatal: true }
  }
}

async function SafelyValidateAsync(
  files: readonly SnapshotFile[],
  validate: (caseFiles: readonly SnapshotFile[]) => Promise<readonly FixtureIssue[]>
): Promise<ValidationCodes> {
  let issues: unknown
  try {
    issues = await validate(files)
  } catch {
    return { Codes: ["FIXTURE_VALIDATOR_THROW"], Fatal: true }
  }
  try {
    return ValidationCodesFor(issues)
  } catch {
    return { Codes: ["FIXTURE_VALIDATOR_INVALID"], Fatal: true }
  }
}

function PreparationFailure(expected: number, actual: number, detail: string): CorpusPreparationFailure {
  return { Kind: "preparation-failure", Evaluation: InventoryFailure(expected, actual, detail) }
}

function PrepareFixtureCorpus(snapshot: InputSnapshot, familyRoot: string): CorpusPreparation {
  if (!IsSafeRelativePath(familyRoot)) {
    return PreparationFailure(0, 0, "fixture family root must be a safe non-empty relative path")
  }
  const familyPrefix = `${familyRoot}/`
  const casesPath = `${familyRoot}/cases.json`
  const files = new Map<string, SnapshotFile>()
  for (const file of snapshot.Files) {
    if (files.has(file.Path)) {
      return PreparationFailure(0, snapshot.Files.length, `duplicate snapshot path: ${file.Path}`)
    }
    files.set(file.Path, file)
  }

  const casesFile = files.get(casesPath)
  if (casesFile === undefined) {
    return PreparationFailure(0, 0, `missing fixture case inventory: ${casesPath}`)
  }
  const document = ParseCases(casesFile)
  if (document === null) {
    return PreparationFailure(0, 0, "fixture case inventory must use the fixed common shape")
  }
  const expected = document.cases.length
  if (expected === 0) {
    return PreparationFailure(0, 0, "fixture case inventory must not be empty")
  }

  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const fixtureCase of document.cases) {
    if (ids.has(fixtureCase.id) || paths.has(fixtureCase.path)) {
      return PreparationFailure(expected, 0, "fixture case ids and paths must be unique")
    }
    ids.add(fixtureCase.id)
    paths.add(fixtureCase.path)
  }

  const payloadsByCase = new Map<string, SnapshotFile[]>()
  for (const fixtureCase of document.cases) payloadsByCase.set(fixtureCase.id, [])
  for (const file of snapshot.Files) {
    if (file.Path === casesPath || !file.Path.startsWith(familyPrefix)) continue
    const pathWithinFamily = file.Path.slice(familyPrefix.length)
    const matches = document.cases.filter((fixtureCase) => (
      pathWithinFamily === fixtureCase.path || pathWithinFamily.startsWith(`${fixtureCase.path}/`)
    ))
    if (matches.length !== 1) {
      return PreparationFailure(expected, 0, `fixture payload must belong to exactly one listed case: ${file.Path}`)
    }
    payloadsByCase.get(matches[0]!.id)?.push(file)
  }
  for (const fixtureCase of document.cases) {
    if ((payloadsByCase.get(fixtureCase.id)?.length ?? 0) === 0) {
      return PreparationFailure(expected, 0, `listed fixture path has no snapshotted payload: ${fixtureCase.path}`)
    }
  }

  const sharedFiles = snapshot.Files.filter((file) => !file.Path.startsWith(familyPrefix))
  const preparedCases: (PreparedCase | CaseLocalFailure)[] = []
  for (const fixtureCase of document.cases) {
    const caseFiles = (payloadsByCase.get(fixtureCase.id) ?? [])
      .map((file) => RebasedFile(file, familyPrefix, fixtureCase))
    const validationFiles = [...sharedFiles, ...caseFiles]
      .sort((left, right) => CompareCodeUnits(left.Path, right.Path))
    if (new Set(validationFiles.map((file) => file.Path)).size !== validationFiles.length) {
      preparedCases.push({
        Kind: "case-local-failure",
        Check: {
          id: "FIXTURE_INVENTORY_MISMATCH",
          status: "fail",
          path: fixtureCase.path,
          detail: "shared and case-local payload paths collide after case rebasing"
        }
      })
      continue
    }
    preparedCases.push({
      Kind: "prepared-case",
      FixtureCase: fixtureCase,
      Files: validationFiles,
      ExpectedCodes: [...fixtureCase.expectedCodes].sort(CompareCodeUnits)
    })
  }

  return { Kind: "prepared-corpus", SubjectsExpected: expected, Cases: preparedCases }
}

function ValidationCheck(prepared: PreparedCase, validation: ValidationCodes): GateCheck {
  const matches = !validation.Fatal && ExactCodes(prepared.ExpectedCodes, validation.Codes)
  return {
    id: matches ? "FIXTURE_CASE_MATCH" : "FIXTURE_INVENTORY_MISMATCH",
    status: matches ? "pass" : "fail",
    path: prepared.FixtureCase.path,
    expected: JSON.stringify(prepared.ExpectedCodes),
    actual: JSON.stringify(validation.Codes),
    ...(matches ? {} : { detail: "fixture validator code multiset did not exactly match cases.json" })
  }
}

function CompletedEvaluation(preparation: PreparedCorpus, checks: readonly GateCheck[]): CorpusEvaluation {
  return {
    SubjectsExpected: preparation.SubjectsExpected,
    SubjectsChecked: preparation.Cases.length,
    Checks: checks
  }
}

export function EvaluateFixtureCorpus(
  snapshot: InputSnapshot,
  familyRoot: string,
  validate: (caseFiles: readonly SnapshotFile[]) => readonly FixtureIssue[]
): CorpusEvaluation {
  const preparation = PrepareFixtureCorpus(snapshot, familyRoot)
  if (preparation.Kind === "preparation-failure") return preparation.Evaluation
  const checks: GateCheck[] = []
  for (const prepared of preparation.Cases) {
    checks.push(prepared.Kind === "case-local-failure"
      ? prepared.Check
      : ValidationCheck(prepared, SafelyValidate(prepared.Files, validate)))
  }
  return CompletedEvaluation(preparation, checks)
}

export async function EvaluateAsyncFixtureCorpus(
  snapshot: InputSnapshot,
  familyRoot: string,
  validate: (caseFiles: readonly SnapshotFile[]) => Promise<readonly FixtureIssue[]>
): Promise<CorpusEvaluation> {
  const preparation = PrepareFixtureCorpus(snapshot, familyRoot)
  if (preparation.Kind === "preparation-failure") return preparation.Evaluation
  const checks: GateCheck[] = []
  for (const prepared of preparation.Cases) {
    if (prepared.Kind === "case-local-failure") {
      checks.push(prepared.Check)
      continue
    }
    checks.push(ValidationCheck(prepared, await SafelyValidateAsync(prepared.Files, validate)))
  }
  return CompletedEvaluation(preparation, checks)
}

function IsMissingDirectory(error: unknown): boolean {
  return IsRecord(error) && error.code === "ENOENT"
}

export async function FindBunDiscoveredFixturePaths(root: string): Promise<readonly string[]> {
  const absoluteRoot = resolve(root)
  const paths: string[] = []

  async function Visit(directory: string): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (IsMissingDirectory(error)) return
      throw error
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        await Visit(absolute)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const path = relative(absoluteRoot, absolute).split(sep).join("/")
        const fixturePayload = /^tools\/(?:.*\/)?fixtures\//.test(path)
          || path.startsWith("test/runtime/probes/")
        if (fixturePayload && DiscoverySubstrings.some((substring) => path.includes(substring))) {
          paths.push(path)
        }
      }
    }
  }

  await Visit(join(absoluteRoot, "tools"))
  await Visit(join(absoluteRoot, "test", "runtime", "probes"))
  return paths.sort(CompareCodeUnits)
}
