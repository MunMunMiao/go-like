import type { PublishedBusinessCaseRegistry } from "../../../scripts/published/business-cases"

function exportSpecifier(packageName: string, exportName: string): string {
  return exportName === "." ? packageName : `${packageName}${exportName.slice(1)}`
}

/** Creates a syntax-valid runtime authority that proves only final package export routing. */
export function identityRuntimeModule(packageName: string, exports: readonly string[]): string {
  const imports = exports.map(
    (exportName, index) =>
      `import * as identity${index} from ${JSON.stringify(exportSpecifier(packageName, exportName))}`
  )
  const values = exports.map((_exportName, index) => `identity${index}`).join(", ")
  return `${imports.join("\n")}\nexport async function run() { void [${values}] }\n`
}

/** Creates a syntax-valid type authority that proves only final package export routing. */
export function identityTypeConsumer(packageName: string, exports: readonly string[]): string {
  const imports = exports.map(
    (exportName, index) =>
      `import * as identity${index} from ${JSON.stringify(exportSpecifier(packageName, exportName))}`
  )
  const values = exports.map((_exportName, index) => `identity${index}`).join(", ")
  return `${imports.join("\n")}\nvoid [${values}]\n`
}

/** Registers an identity-only case whose future implementation remains release-gate blocking. */
export function registerIdentityCase(
  registry: PublishedBusinessCaseRegistry,
  packageName: string,
  exports: readonly string[]
): void {
  registry.register({
    package: packageName,
    exports,
    runtimeModule: identityRuntimeModule(packageName, exports),
    typeConsumer: identityTypeConsumer(packageName, exports)
  })
}
