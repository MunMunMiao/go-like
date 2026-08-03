declare namespace Deno {
  function test(name: string, run: () => void | Promise<void>): void
}
