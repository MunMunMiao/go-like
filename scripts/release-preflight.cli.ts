import { releasePreflight } from "./release-preflight"

const issues = await releasePreflight(process.cwd())
for (const issue of issues) console.error(`${issue.Code} ${issue.Message}`)
console.log(
  `LIKEGO_RELEASE_PREFLIGHT=${JSON.stringify({ valid: issues.length === 0, issues: issues.length })}`
)
if (issues.length > 0) process.exitCode = 1
