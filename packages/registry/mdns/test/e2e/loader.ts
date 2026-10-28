import { registerHooks } from "node:module"

const root = new URL("../../../../../", import.meta.url)

/** Resolves one go-like workspace package to its built JavaScript entrypoint. */
function mapped(specifier: string): URL | null {
  if (specifier === "@go-like/context") return new URL("packages/context/dist/index.js", root)
  if (specifier === "@go-like/core") return new URL("packages/core/dist/index.js", root)
  if (specifier === "@go-like/core/lifecycle")
    return new URL("packages/core/dist/lifecycle.js", root)
  if (specifier === "@go-like/registry") return new URL("packages/registry/dist/index.js", root)
  if (specifier === "@go-like/registry/provider")
    return new URL("packages/registry/dist/provider.js", root)
  if (specifier === "@go-like/registry-mdns")
    return new URL("packages/registry/mdns/dist/index.js", root)
  if (specifier === "@go-like/registry-mdns/node")
    return new URL("packages/registry/mdns/dist/node.js", root)
  return null
}

registerHooks({
  /** Maps only reviewed go-like package names and delegates every other resolution. */
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "./scenario" &&
      context.parentURL !== undefined &&
      context.parentURL.includes("/packages/registry/mdns/test/e2e/")
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
