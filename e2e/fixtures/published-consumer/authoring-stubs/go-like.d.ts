export declare function background(): unknown
export declare function newMemoryTransport(): unknown
export declare function transport(value: unknown): unknown
export declare function address(value: string): unknown
export declare function endpoint(
  service: string,
  method: string,
  request: unknown,
  response: unknown,
  stream?: boolean
): unknown
export declare function newServer(...options: readonly unknown[]): {
  registerHandler(endpoint: unknown, handler: (ctx: unknown, request: unknown) => unknown): void
  start(ctx: unknown): Promise<void>
  endpoint(ctx: unknown): Promise<string>
  stop(ctx: unknown): Promise<void>
}
export declare function newClient(...options: readonly unknown[]): {
  call(ctx: unknown, endpoint: unknown, request: unknown): Promise<unknown>
  close(ctx: unknown): Promise<void>
}
export declare function withTransport(value: unknown): unknown
export declare function withEndpoint(value: string): unknown
export declare function newApp(...options: readonly unknown[]): {
  run(): Promise<void>
  stop(): Promise<void>
}
export declare function afterStart(hook: () => void): unknown
export declare function telemetry(value: unknown): unknown
export declare function newTelemetry(options?: object): unknown
export declare function withTelemetry(ctx: unknown, telemetry: unknown): unknown
export declare function newTelemetryRecorder(options?: object): {
  readonly telemetry: unknown
  spans(): readonly {
    readonly kind: string
    readonly name: string
    readonly ended: boolean
  }[]
}
export declare namespace struct {
  function object(shape: Record<string, unknown>): unknown
  function number(): unknown
}
