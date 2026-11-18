import { registerHooks } from "node:module"

const root = new URL("../../../../", import.meta.url)

/** Resolves one go-like workspace package to its built JavaScript entrypoint. */
function mapped(specifier: string): URL | null {
  if (specifier === "@go-like/core/context")
    return new URL("packages/core/dist/context/index.js", root)
  if (specifier === "@go-like/core") return new URL("packages/core/dist/index.js", root)
  if (specifier === "@go-like/core/lifecycle")
    return new URL("packages/core/dist/lifecycle/index.js", root)
  if (specifier === "@go-like/core/registry")
    return new URL("packages/core/dist/registry/index.js", root)
  if (specifier === "@go-like/core/registry/provider")
    return new URL("packages/core/dist/registry/provider.js", root)
  if (specifier === "@go-like/mdns/registry")
    return new URL("packages/mdns/dist/registry/index.js", root)
  if (specifier === "@go-like/mdns/registry/node")
    return new URL("packages/mdns/dist/registry/node/index.js", root)
  return null
}

registerHooks({
  /** Maps only reviewed go-like package names and delegates every other resolution. */
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "./scenario" &&
      context.parentURL !== undefined &&
      context.parentURL.includes("/packages/mdns/test/e2e/")
    )
      return Object.freeze({
        shortCircuit: true,
        url: new URL("scenario.ts", context.parentURL).href
      })
    const target = mapped(specifier)
    return target === null
      ? nextResolve(specifier, context)
      : Object.freeze({ shortCircuit: true, url: target.href })
  }
})
