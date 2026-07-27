import { join } from "node:path"

import { bunCoverageMarker } from "./contracts"
import { discoverPublishedPackages } from "./inventory"
import { validateBunPackageCoverage } from "./workspace-coverage"

interface BunPackageCoverageResult {
  readonly package: string
  readonly status: "pass" | "fail"
  readonly detail: string | null
}

const expectedReleaseBlockingPackageCount = 46

function scriptValue(manifest: Readonly<{ readonly [key: string]: unknown }>): string | null {
  const scripts = manifest.scripts
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return null
  if (!("test:coverage" in scripts)) return null
  const value = scripts["test:coverage"]
  return typeof value === "string" ? value : null
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Validates the LCOV inventory produced by every release-blocking workspace coverage contract. */
export async function validateWorkspaceCoverage(
  root: string
): Promise<readonly BunPackageCoverageResult[]> {
  const inventory = await discoverPublishedPackages(root)
  const subjects = inventory.packages.filter((subject) => subject.releaseBlocking)
  if (subjects.length !== expectedReleaseBlockingPackageCount) {
    throw new Error(
      `workspace Bun coverage requires exactly ${expectedReleaseBlockingPackageCount} release-blocking subjects; found ${subjects.length}`
    )
  }
  const results: BunPackageCoverageResult[] = []
  for (const subject of subjects) {
    try {
      const script = scriptValue(subject.manifest)
      if (script === null) throw new Error("test:coverage script is missing")
      if (!script.includes("test/coverage-contract.ts")) {
        throw new Error("test:coverage does not execute test/coverage-contract.ts")
      }
      const lcovPath = join(subject.root, ".artifacts", "coverage", "lcov.info")
      if (!(await Bun.file(lcovPath).exists()))
        throw new Error("test:coverage produced no package LCOV")
      await validateBunPackageCoverage(subject.root, await Bun.file(lcovPath).text())
      results.push(Object.freeze({ package: subject.name, status: "pass", detail: null }))
    } catch (error) {
      results.push(
        Object.freeze({ package: subject.name, status: "fail", detail: errorDetail(error) })
      )
    }
  }
  return Object.freeze(results)
}

async function main(): Promise<number> {
  try {
    const packages = await validateWorkspaceCoverage(process.cwd())
    const passed = packages.every((subject) => subject.status === "pass")
    const result = Object.freeze({
      schemaVersion: 1,
      marker: bunCoverageMarker,
      status: passed ? "pass" : "fail",
      subjects: Object.freeze({ expected: packages.length, checked: packages.length }),
      packages
    })
    process.stdout.write(`${bunCoverageMarker}=${JSON.stringify(result)}\n`)
    return passed ? 0 : 1
  } catch (error) {
    process.stderr.write(`${bunCoverageMarker}_ERROR ${errorDetail(error)}\n`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await main()
