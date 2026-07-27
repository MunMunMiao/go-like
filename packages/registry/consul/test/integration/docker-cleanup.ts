/** Minimal Docker inspect result used by cleanup verification. */
export interface DockerInspectResult {
  readonly exitCode: number
  readonly stdout: string
}

/** Docker identifies object existence by exit status; a missing object may print `[]`. */
export function dockerObjectExists(result: DockerInspectResult): boolean {
  return result.exitCode === 0
}
