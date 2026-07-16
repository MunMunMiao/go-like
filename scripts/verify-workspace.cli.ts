import { VerifyWorkspace } from "./verify-workspace.ts"

const issues = await VerifyWorkspace(process.cwd())

if (issues.length > 0) {
  for (const issue of issues) {
    console.error(`${issue.Code} ${issue.Path}: ${issue.Message}`)
  }
  process.exitCode = 1
} else {
  console.log("LIKEGO_WORKSPACE_RESULT={\"valid\":true}")
}
