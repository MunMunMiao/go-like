import { Server } from "./server.ts"

interface Context {
  Deadline(): readonly [Date, boolean]
  Done(): AbortSignal | null
  Err(): Error | null
  Value(key: unknown): unknown
}

interface ServerHandle {
  Done(): Promise<void>
  Stop(ctx: Context): Promise<void>
}

interface StructuralServer {
  Start(ctx: Context): Promise<ServerHandle>
}

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value
type StartedHandle = Awaited<ReturnType<typeof Server.Start>>

type StartArgumentsMatch = Assert<Equal<Parameters<typeof Server.Start>, [ctx: Context]>>
type DoneArgumentsMatch = Assert<Equal<Parameters<StartedHandle["Done"]>, []>>
type StopArgumentsMatch = Assert<Equal<Parameters<StartedHandle["Stop"]>, [ctx: Context]>>

export const structuralServer: StructuralServer = Server
export type StructuralContractAssertions = readonly [
  StartArgumentsMatch,
  DoneArgumentsMatch,
  StopArgumentsMatch
]
