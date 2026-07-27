import type { PublishedBusinessCase } from "./contracts"
import { parse } from "@babel/parser"
import { traverseFast } from "@babel/types"

export type { PublishedBusinessCase } from "./contracts"

export interface PublishedBusinessCaseRegistry {
  readonly register: (businessCase: PublishedBusinessCase) => void
  readonly get: (packageName: string) => PublishedBusinessCase | null
  readonly list: () => readonly PublishedBusinessCase[]
}

function exportSpecifier(packageName: string, exportName: string): string {
  return exportName === "." ? packageName : `${packageName}${exportName.slice(1)}`
}

function sourceImports(
  packageName: string,
  label: string,
  source: string,
  typescript: boolean
): readonly string[] {
  const imports: string[] = []
  let dynamicImportIsLiteral = true
  try {
    const file = parse(source, {
      sourceType: "module",
      errorRecovery: false,
      plugins: typescript ? ["typescript"] : []
    })
    traverseFast(file, (node) => {
      if (
        (node.type === "ImportDeclaration" ||
          node.type === "ExportAllDeclaration" ||
          node.type === "ExportNamedDeclaration") &&
        node.source !== null &&
        typeof node.source?.value === "string"
      ) {
        imports.push(node.source.value)
      } else if (node.type === "CallExpression" && node.callee.type === "Import") {
        const imported = node.arguments[0]
        if (imported?.type === "StringLiteral") imports.push(imported.value)
        else dynamicImportIsLiteral = false
      } else if (node.type === "ImportExpression") {
        if (node.source.type === "StringLiteral") imports.push(node.source.value)
        else dynamicImportIsLiteral = false
      }
    })
  } catch {
    throw new TypeError(`${packageName} ${label} must be syntactically scannable`)
  }
  if (!dynamicImportIsLiteral) {
    throw new TypeError(`${packageName} ${label} contains a non-literal dynamic import`)
  }
  for (const imported of imports) {
    if (imported.startsWith(".") || imported.includes("/dist/") || imported.endsWith("/dist")) {
      throw new TypeError(`${packageName} ${label} contains a relative or direct dist import`)
    }
  }
  return Object.freeze(imports)
}

function validateSource(packageName: string, label: string, source: string): readonly string[] {
  const imports = sourceImports(packageName, label, source, true)
  if (
    !imports.some((imported) => imported === packageName || imported.startsWith(`${packageName}/`))
  ) {
    throw new TypeError(`${packageName} ${label} must import its target by package name`)
  }
  return Object.freeze(imports)
}

function validateNodePreloadModule(packageName: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${packageName} node preload module must be non-empty JavaScript`)
  }
  sourceImports(packageName, "node preload module", value, false)
  return value
}

function validateExports(
  packageName: string,
  exports: readonly string[],
  typeConsumerImports: readonly string[]
): readonly string[] {
  if (
    !Array.isArray(exports) ||
    exports.length === 0 ||
    exports.some((name) => name !== "." && !/^\.\/[a-z0-9][a-z0-9/-]*$/.test(name)) ||
    new Set(exports).size !== exports.length
  ) {
    throw new TypeError(`${packageName} published business exports must be unique package subpaths`)
  }
  for (const exportName of exports) {
    const specifier = exportSpecifier(packageName, exportName)
    if (!typeConsumerImports.includes(specifier)) {
      throw new TypeError(`${packageName} type consumer must import declared export ${exportName}`)
    }
  }
  return Object.freeze(Array.from(exports).sort())
}

function validateExportSources(
  packageName: string,
  label: "runtime module" | "type consumer",
  exports: readonly string[],
  value: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  const names = Object.keys(value).sort()
  if (names.length !== exports.length || names.some((name, index) => name !== exports[index])) {
    throw new TypeError(`${packageName} ${label} export source inventory drifted`)
  }
  const sources: Record<string, string> = {}
  for (const exportName of names) {
    const source = value[exportName]
    if (typeof source !== "string") {
      throw new TypeError(`${packageName} ${label} export source must be a string: ${exportName}`)
    }
    const imports = validateSource(packageName, `${label} ${exportName}`, source)
    const specifier = exportSpecifier(packageName, exportName)
    if (!imports.includes(specifier)) {
      throw new TypeError(`${packageName} ${label} must import declared export ${exportName}`)
    }
    if (label === "runtime module" && !/export\s+async\s+function\s+run\s*\(/.test(source)) {
      throw new TypeError(
        `${packageName} runtime module ${exportName} must export async function run`
      )
    }
    sources[exportName] = source
  }
  return Object.freeze(sources)
}

function validatePolicies(
  packageName: string,
  exports: readonly string[],
  value: PublishedBusinessCase["natsExactOptionalPolicies"]
): PublishedBusinessCase["natsExactOptionalPolicies"] {
  if (value === undefined) return undefined
  const seen = new Set<string>()
  const policies = []
  for (const policy of value) {
    if (
      !exports.includes(policy.export) ||
      (policy.directDependency !== "@nats-io/transport-node" &&
        policy.directDependency !== "@nats-io/jetstream") ||
      seen.has(policy.export)
    ) {
      throw new TypeError(`${packageName} has an unknown NATS exact-optional policy`)
    }
    seen.add(policy.export)
    policies.push(
      Object.freeze({
        export: policy.export,
        directDependency: policy.directDependency
      })
    )
  }
  return Object.freeze(policies)
}

/** Creates one fail-closed registry for package-name-only published business cases. */
export function newBusinessCaseRegistry(): PublishedBusinessCaseRegistry {
  const cases = new Map<string, PublishedBusinessCase>()
  return Object.freeze({
    register(businessCase: PublishedBusinessCase): void {
      if (
        !/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(businessCase.package) ||
        cases.has(businessCase.package)
      ) {
        throw new TypeError(`duplicate published business case: ${businessCase.package}`)
      }
      validateSource(businessCase.package, "runtime module", businessCase.runtimeModule)
      const typeConsumerImports = validateSource(
        businessCase.package,
        "type consumer",
        businessCase.typeConsumer
      )
      const exports = validateExports(
        businessCase.package,
        businessCase.exports,
        typeConsumerImports
      )
      if (!/export\s+async\s+function\s+run\s*\(/.test(businessCase.runtimeModule)) {
        throw new TypeError(`${businessCase.package} runtime module must export async function run`)
      }
      const runtimeModules = validateExportSources(
        businessCase.package,
        "runtime module",
        exports,
        businessCase.runtimeModules
      )
      const typeConsumers = validateExportSources(
        businessCase.package,
        "type consumer",
        exports,
        businessCase.typeConsumers
      )
      const policies = validatePolicies(
        businessCase.package,
        exports,
        businessCase.natsExactOptionalPolicies
      )
      const nodePreloadModule = validateNodePreloadModule(
        businessCase.package,
        businessCase.nodePreloadModule
      )
      const registered = Object.freeze({
        package: businessCase.package,
        exports,
        runtimeModule: businessCase.runtimeModule,
        typeConsumer: businessCase.typeConsumer,
        nodePreloadModule,
        runtimeModules,
        typeConsumers,
        natsExactOptionalPolicies: policies
      })
      cases.set(businessCase.package, registered)
    },
    get(packageName: string): PublishedBusinessCase | null {
      return cases.get(packageName) ?? null
    },
    list(): readonly PublishedBusinessCase[] {
      return Object.freeze(
        Array.from(cases.values()).sort((left, right) => left.package.localeCompare(right.package))
      )
    }
  })
}
