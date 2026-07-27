import { createProject, packageVersion } from "./project"

export { packageVersion } from "./project"

type Writer = (value: string) => void

const Help = `Usage: create-likego <project-directory>

创建一个可直接运行的 LikeGo 内部 unary 微服务。

Options:
  --help     显示帮助
  --version  显示版本
`

/** Executes the exact create-likego argument contract without terminating its host process. */
export async function runCLI(
  arguments_: readonly string[],
  version: string,
  writeOutput: Writer,
  writeError: Writer
): Promise<number> {
  if (arguments_.length === 1 && arguments_[0] === "--help") {
    writeOutput(Help)
    return 0
  }
  if (arguments_.length === 1 && arguments_[0] === "--version") {
    writeOutput(`${version}\n`)
    return 0
  }
  const target = arguments_[0]
  if (arguments_.length !== 1 || target === undefined || target.startsWith("-")) {
    writeError(`create-likego requires exactly one target directory\n\n${Help}`)
    return 1
  }
  try {
    const created = await createProject(target)
    writeOutput(
      `Created ${created.name} in ${created.directory}\n\n` +
        `Next:\n  cd ${created.directory}\n  bun install\n  bun run start\n`
    )
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeError(
      `create-likego: ${message}\n` +
        "提示：若本次命令已认领目标目录，其中可能保留部分文件；请检查后手动处理。\n"
    )
    return 1
  }
}
