import { expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

import { API } from "typescript/async"
import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isStringLiteral,
  SyntaxKind,
  type Node
} from "typescript/ast"

/**
 * Portable plug entries from design 3.3, lane P.
 * Node and Bun bindings are excluded.
 */
const portableEntries = [
  ["@go-like/otel", "."],
  ["@go-like/consul", "."],
  ["@go-like/consul", "./registry"],
  ["@go-like/consul", "./config"],
  ["@go-like/consul", "./store"],
  ["@go-like/etcd", "."],
  ["@go-like/etcd", "./registry"],
  ["@go-like/etcd", "./config"],
  ["@go-like/etcd", "./store"],
  ["@go-like/vault", "."],
  ["@go-like/vault", "./config"],
  ["@go-like/vault", "./store"],
  ["@go-like/kubernetes", "."],
  ["@go-like/kubernetes", "./registry"],
  ["@go-like/kubernetes", "./config"],
  ["@go-like/zookeeper", "./registry"],
  ["@go-like/mdns", "./registry"],
  ["@go-like/yaml", "./config"],
  ["@go-like/croner", "./job"],
  ["@go-like/file", "./store"],
  ["@go-like/connectrpc", "."]
] as const

const root = resolve(import.meta.dir, "..")

function display(file: string): string {
  return relative(root, file).replaceAll("\\", "/")
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return Object.fromEntries(Object.entries(value))
}

function isRuntimeSpecifier(specifier: string): boolean {
  return (
    specifier === "bun" ||
    specifier === "node" ||
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:")
  )
}

function moduleSpecifiers(node: Node): readonly string[] {
  const found: string[] = []
  const visit = (current: Node): void => {
    if (isImportDeclaration(current) && isStringLiteral(current.moduleSpecifier)) {
      found.push(current.moduleSpecifier.text)
    } else if (
      isExportDeclaration(current) &&
      current.moduleSpecifier !== undefined &&
      isStringLiteral(current.moduleSpecifier)
    ) {
      found.push(current.moduleSpecifier.text)
    } else if (
      isImportEqualsDeclaration(current) &&
      isExternalModuleReference(current.moduleReference) &&
      isStringLiteral(current.moduleReference.expression)
    ) {
      found.push(current.moduleReference.expression.text)
    } else if (isCallExpression(current) && current.expression.kind === SyntaxKind.ImportKeyword) {
      const argument = current.arguments[0]
      if (argument !== undefined && isStringLiteral(argument)) found.push(argument.text)
    } else if (
      isImportTypeNode(current) &&
      isLiteralTypeNode(current.argument) &&
      isStringLiteral(current.argument.literal)
    ) {
      found.push(current.argument.literal.text)
    }
    current.forEachChild(visit)
  }
  visit(node)
  return found
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier)
  const candidates = specifier.endsWith(".ts")
    ? [base]
    : [base, `${base}.ts`, join(base, "index.ts")]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  throw new Error(`unresolved relative import ${specifier} from ${display(fromFile)}`)
}

test("portable plug entries do not reach node: or bun specifiers", async () => {
  const paths = record(
    record(
      record(await Bun.file(resolve(root, "tsconfig.base.json")).json(), "tsconfig.base.json")
        .compilerOptions,
      "compilerOptions"
    ).paths,
    "compilerOptions.paths"
  )
  const pathTarget = new Map<string, string>()
  for (const [key, value] of Object.entries(paths)) {
    if (!Array.isArray(value) || typeof value[0] !== "string") {
      throw new TypeError(`path target for ${key} must be a string array`)
    }
    pathTarget.set(key, resolve(root, value[0]))
  }

  const starts: string[] = []
  for (const [name, key] of portableEntries) {
    const directory = name.slice("@go-like/".length)
    const manifest = record(
      await Bun.file(resolve(root, "packages", directory, "package.json")).json(),
      `${name} package.json`
    )
    const target = record(manifest.exports, `${name} exports`)[key]
    if (typeof target !== "string" || !target.startsWith("./")) {
      throw new Error(`${name} is missing portable export ${key}`)
    }
    const file = resolve(root, "packages", directory, target)
    if (!existsSync(file)) throw new Error(`${name} export ${key} is missing: ${target}`)
    starts.push(file)
  }

  const pending = [...starts]
  const seen = new Set<string>()
  const violations: string[] = []
  const api = new API()
  try {
    while (pending.length > 0) {
      const file = pending.pop()
      if (file === undefined || seen.has(file)) continue
      seen.add(file)
      const retained = await api.createSourceFile(file, await Bun.file(file).text())
      try {
        for (const specifier of moduleSpecifiers(retained.sourceFile)) {
          if (isRuntimeSpecifier(specifier)) {
            violations.push(`${display(file)} -> ${specifier}`)
            continue
          }
          if (specifier.startsWith(".")) {
            pending.push(resolveRelative(file, specifier))
            continue
          }
          if (specifier.startsWith("@go-like/")) {
            const target = pathTarget.get(specifier)
            if (target === undefined) {
              throw new Error(`unmapped @go-like import ${specifier} from ${display(file)}`)
            }
            pending.push(target)
          }
        }
      } finally {
        await retained.dispose()
      }
    }
  } finally {
    await api.close()
  }

  expect(violations).toEqual([])
}, 20_000)
