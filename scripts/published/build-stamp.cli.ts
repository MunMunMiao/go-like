import { discoverPublishedPackages } from "./inventory"
import { writePublishedBuildStamp } from "./build-stamp"

async function main(): Promise<number> {
  try {
    const root = process.cwd()
    await writePublishedBuildStamp(root, await discoverPublishedPackages(root))
    process.stdout.write('LIKEGO_PUBLISHED_BUILD_STAMP_V2={"valid":true}\n')
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`LIKEGO_PUBLISHED_BUILD_STAMP_ERROR ${message}\n`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await main()
