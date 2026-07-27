export interface Context {
  deadline(): readonly [Date, boolean]
  done(): AbortSignal | null
  err(): Error | null
  value(key: unknown): unknown
}

export interface StructuralServerHandle {
  done(): Promise<void>
  stop(ctx: Context): Promise<void>
}

export interface StructuralServer {
  start(ctx: Context): Promise<StructuralServerHandle>
}

export const server: StructuralServer = {
  async start(ctx: Context): Promise<StructuralServerHandle> {
    void ctx
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    return {
      done(): Promise<void> {
        return done
      },
      async stop(stopCtx: Context): Promise<void> {
        void stopCtx
        resolveDone()
        await done
      }
    }
  }
}
