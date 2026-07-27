import { server } from "./server"

interface Context {
  deadline(): readonly [Date, boolean]
  done(): AbortSignal | null
  err(): Error | null
  value(key: unknown): unknown
}

interface ServerHandle {
  done(): Promise<void>
  stop(ctx: Context): Promise<void>
}

interface StructuralServer {
  start(ctx: Context): Promise<ServerHandle>
}

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value
type StartedHandle = Awaited<ReturnType<typeof server.start>>

type StartArgumentsMatch = Assert<Equal<Parameters<typeof server.start>, [ctx: Context]>>
type DoneArgumentsMatch = Assert<Equal<Parameters<StartedHandle["done"]>, []>>
type StopArgumentsMatch = Assert<Equal<Parameters<StartedHandle["stop"]>, [ctx: Context]>>

// @ts-expect-error PascalCase start aliases are not part of the structural contract.
type RemovedStartAlias = typeof server["Start"]
// @ts-expect-error PascalCase done aliases are not part of the structural contract.
type RemovedDoneAlias = StartedHandle["Done"]
// @ts-expect-error PascalCase stop aliases are not part of the structural contract.
type RemovedStopAlias = StartedHandle["Stop"]

export const structuralServer: StructuralServer = server
export type StructuralContractAssertions = readonly [
  StartArgumentsMatch,
  DoneArgumentsMatch,
  StopArgumentsMatch,
  RemovedStartAlias,
  RemovedDoneAlias,
  RemovedStopAlias
]
