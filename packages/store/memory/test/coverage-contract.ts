import { readFile } from "node:fs/promises"

import { validateBunPackageCoverage } from "../../../../scripts/published/workspace-coverage"

const packageRoot = `${import.meta.dir}/..`
const report = await readFile(`${packageRoot}/.artifacts/coverage/lcov.info`, "utf8")
await validateBunPackageCoverage(packageRoot, report)
