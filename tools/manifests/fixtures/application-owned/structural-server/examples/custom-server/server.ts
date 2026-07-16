export interface StructuralServer {
  Start(): Promise<void>
  Stop(): Promise<void>
}

export const Server: StructuralServer = {
  async Start(): Promise<void> {},
  async Stop(): Promise<void> {}
}
