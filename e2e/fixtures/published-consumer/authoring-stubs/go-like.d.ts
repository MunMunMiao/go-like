export {}

declare global {
  namespace Deno {
    const env: {
      get(name: string): string | undefined
    }

    namespace errors {
      class NotCapable extends Error {}
    }
  }
}
