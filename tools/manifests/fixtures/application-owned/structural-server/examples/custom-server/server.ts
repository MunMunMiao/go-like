export interface Context {
  Deadline(): readonly [Date, boolean]
  Done(): AbortSignal | null
  Err(): Error | null
  Value(key: unknown): unknown
}

export interface StructuralServerHandle {
  Done(): Promise<void>
  Stop(ctx: Context): Promise<void>
}

export interface StructuralServer {
  Start(ctx: Context): Promise<StructuralServerHandle>
}

export const Server: StructuralServer = {
  async Start(ctx: Context): Promise<StructuralServerHandle> {
    void ctx
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    return {
      Done(): Promise<void> {
        return done
      },
      async Stop(stopCtx: Context): Promise<void> {
        void stopCtx
        resolveDone()
        await done
      }
    }
  }
}
