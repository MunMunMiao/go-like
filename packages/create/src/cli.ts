#!/usr/bin/env node

import process from "node:process"

import { packageVersion, runCLI } from "./cli-run"

/** Executes the create-likego command without terminating the host process. */
export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<number> {
  return await runCLI(
    arguments_,
    await packageVersion(import.meta.url),
    process.stdout.write.bind(process.stdout),
    process.stderr.write.bind(process.stderr)
  )
}

if (import.meta.main) process.exitCode = await main()
