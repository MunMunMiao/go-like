import { verifyBunRuntime, verifyWorkspace } from "./verify-workspace"

const runtimeIssue = verifyBunRuntime(Bun.version)
const workspaceIssues = await verifyWorkspace(process.cwd())
const issues = runtimeIssue === null ? workspaceIssues : [runtimeIssue, ...workspaceIssues]

if (issues.length > 0) {
  for (const issue of issues) {
    console.error(`${issue.Code} ${issue.Path}: ${issue.Message}`)
  }
  process.exitCode = 1
} else {
  console.log('LIKEGO_WORKSPACE_RESULT={"valid":true}')
}
