import type {
  PublishedCoverage,
  PublishedCoverageCounter,
  PublishedCoverageCounters,
  PublishedCoverageFile
} from "./contracts"
import { fileURLToPath } from "node:url"
import { isAbsolute, relative, resolve, sep } from "node:path"

export interface PublishedCoverageReport {
  readonly files: readonly PublishedCoverageFile[]
  readonly aggregate: PublishedCoverage
  readonly counters: PublishedCoverageCounters
}

function metric(value: string, label: string): number {
  const metric = Number(value)
  if (!Number.isFinite(metric) || metric < 0 || metric > 100) {
    throw new Error(`invalid ${label} coverage metric: ${value}`)
  }
  return metric
}

/** Parses the target-only aggregate row from Node's native test coverage table. */
export function parseNodeCoverage(output: string): PublishedCoverage {
  const matches = Array.from(
    output.matchAll(
      /all files\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)/gi
    )
  )
  if (matches.length === 0) throw new Error("zero published-JS coverage subjects in Node report")
  if (matches.length !== 1)
    throw new Error("duplicate target aggregate rows in Node coverage report")
  const match = matches[0]
  if (
    match === undefined ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    throw new Error("Node coverage aggregate row is incomplete")
  }
  return Object.freeze({
    lines: metric(match[1], "line"),
    branches: metric(match[2], "branch"),
    functions: metric(match[3], "function")
  })
}

/** Parses the target-only aggregate row from Deno's native coverage table. */
export function parseDenoCoverage(output: string): PublishedCoverage {
  const matches = Array.from(
    output.matchAll(
      /\|\s*All files\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/g
    )
  )
  if (matches.length === 0) throw new Error("zero published-JS coverage subjects in Deno report")
  if (matches.length !== 1)
    throw new Error("duplicate target aggregate rows in Deno coverage report")
  const match = matches[0]
  if (
    match === undefined ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    throw new Error("Deno coverage aggregate row is incomplete")
  }
  return Object.freeze({
    branches: metric(match[1], "branch"),
    functions: metric(match[2], "function"),
    lines: metric(match[3], "line")
  })
}

function lcovCounter(lines: readonly string[], prefix: string): number {
  const values = lines.filter((line) => line.startsWith(prefix))
  if (values.length !== 1)
    throw new Error(`published LCOV record must contain exactly one ${prefix} counter`)
  const encoded = values[0]
  if (encoded === undefined) throw new Error(`published LCOV record is missing ${prefix}`)
  const value = Number(encoded.slice(prefix.length))
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`published LCOV contains invalid ${prefix}`)
  return value
}

function percent(hit: number, found: number): number {
  return found === 0 ? 100 : Number(((hit / found) * 100).toFixed(2))
}

function coverageCounter(found: number, hit: number, label: string): PublishedCoverageCounter {
  if (hit > found) throw new Error(`published LCOV ${label} hit count exceeds found count`)
  return Object.freeze({ found, hit })
}

function coverageCounters(
  label: string,
  linesFound: number,
  linesHit: number,
  functionsFound: number,
  functionsHit: number,
  branchesFound: number,
  branchesHit: number
): PublishedCoverageCounters {
  return Object.freeze({
    lines: coverageCounter(linesFound, linesHit, `${label} line`),
    functions: coverageCounter(functionsFound, functionsHit, `${label} function`),
    branches: coverageCounter(branchesFound, branchesHit, `${label} branch`)
  })
}

function sourcePath(targetDistRoot: string, encoded: string): string {
  const raw = encoded.startsWith("file:") ? fileURLToPath(encoded) : encoded
  let absolute = raw
  if (!isAbsolute(raw)) {
    absolute = resolve(targetDistRoot, raw)
    for (const directory of ["node_modules", "deno_modules"]) {
      const marker = `${sep}${directory}${sep}`
      const index = targetDistRoot.lastIndexOf(marker)
      if (raw.startsWith(`${directory}/`) && index >= 0) {
        absolute = resolve(targetDistRoot.slice(0, index), raw)
      }
    }
  }
  return relative(targetDistRoot, absolute)
}

/** Parses native LCOV into exact target-file evidence and rejects duplicate source records. */
export function parsePublishedLcov(targetDistRoot: string, lcov: string): PublishedCoverageReport {
  const files: PublishedCoverageFile[] = []
  const seen = new Set<string>()
  let linesFound = 0
  let linesHit = 0
  let functionsFound = 0
  let functionsHit = 0
  let branchesFound = 0
  let branchesHit = 0
  for (const raw of lcov.split("end_of_record")) {
    const lines = raw.trim().split("\n")
    const sources = lines.filter((line) => line.startsWith("SF:"))
    if (sources.length === 0) continue
    if (sources.length !== 1)
      throw new Error("published LCOV record contains duplicate source fields")
    const encoded = sources[0]
    if (encoded === undefined) throw new Error("published LCOV source is missing")
    const path = sourcePath(targetDistRoot, encoded.slice(3))
    if (path === ".." || path.startsWith("../"))
      throw new Error(`published LCOV escaped target dist: ${path}`)
    if (seen.has(path)) throw new Error(`published LCOV contains duplicate target file: ${path}`)
    seen.add(path)
    const fileLinesFound = lcovCounter(lines, "LF:")
    const fileLinesHit = lcovCounter(lines, "LH:")
    const fileFunctionsFound = lcovCounter(lines, "FNF:")
    const fileFunctionsHit = lcovCounter(lines, "FNH:")
    const fileBranchesFound = lcovCounter(lines, "BRF:")
    const fileBranchesHit = lcovCounter(lines, "BRH:")
    const counters = coverageCounters(
      path,
      fileLinesFound,
      fileLinesHit,
      fileFunctionsFound,
      fileFunctionsHit,
      fileBranchesFound,
      fileBranchesHit
    )
    files.push(
      Object.freeze({
        path,
        counters,
        coverage: Object.freeze({
          lines: percent(fileLinesHit, fileLinesFound),
          functions: percent(fileFunctionsHit, fileFunctionsFound),
          branches: percent(fileBranchesHit, fileBranchesFound)
        })
      })
    )
    linesFound += fileLinesFound
    linesHit += fileLinesHit
    functionsFound += fileFunctionsFound
    functionsHit += fileFunctionsHit
    branchesFound += fileBranchesFound
    branchesHit += fileBranchesHit
  }
  if (files.length === 0) throw new Error("zero published-JS coverage subjects in LCOV")
  const counters = coverageCounters(
    "aggregate",
    linesFound,
    linesHit,
    functionsFound,
    functionsHit,
    branchesFound,
    branchesHit
  )
  return Object.freeze({
    files: Object.freeze(files.sort((left, right) => left.path.localeCompare(right.path))),
    counters,
    aggregate: Object.freeze({
      lines: percent(linesHit, linesFound),
      functions: percent(functionsHit, functionsFound),
      branches: percent(branchesHit, branchesFound)
    })
  })
}

/** Requires every executable output exactly once and rejects unknown target files. */
export function requirePublishedFileInventory(
  authority: string,
  report: PublishedCoverageReport,
  requiredFiles: ReadonlySet<string>,
  allowedFiles: ReadonlySet<string>
): void {
  const seen = new Set<string>()
  for (const file of report.files) {
    if (!allowedFiles.has(file.path))
      throw new Error(`${authority} reported unknown target file ${file.path}`)
    if (seen.has(file.path))
      throw new Error(`${authority} reported duplicate target file ${file.path}`)
    seen.add(file.path)
    if (requiredFiles.has(file.path) && file.counters.lines.found === 0) {
      throw new Error(`${authority} reported zero line subjects for ${file.path}`)
    }
  }
  for (const path of Array.from(requiredFiles).sort()) {
    if (!seen.has(path)) throw new Error(`${authority} is missing executable target file ${path}`)
  }
}
