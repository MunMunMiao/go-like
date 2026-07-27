import { describe, expect, test } from "bun:test"
import { discoverWorkspaces } from "../tools/workspaces/discovery"

const RepositoryRoot = new URL("../", import.meta.url)
const DocRoot = new URL("../doc/", import.meta.url)
const PackageTokenPattern = /(?<![A-Za-z0-9._-])@likego\/[a-z0-9][a-z0-9._-]*(?![A-Za-z0-9.*_\/-])/g
const RelativePages = Object.freeze([
  "guide/architecture.md",
  "guide/broker-events.md",
  "guide/config-registry-store.md",
  "guide/getting-started.md",
  "guide/health-observability.md",
  "guide/service-call.md",
  "guide/streaming.md",
  "index.md",
  "reference/packages.md",
  "reference/verification.md"
])

interface DocumentationLocale {
  readonly path: string
  readonly tag: string
  readonly direction: "ltr" | "rtl"
}

const Locales: readonly DocumentationLocale[] = Object.freeze([
  { path: "", tag: "en-Latn", direction: "ltr" },
  { path: "ar-Arab", tag: "ar-Arab", direction: "rtl" },
  { path: "es-Latn", tag: "es-Latn", direction: "ltr" },
  { path: "fr-Latn", tag: "fr-Latn", direction: "ltr" },
  { path: "ru-Cyrl", tag: "ru-Cyrl", direction: "ltr" },
  { path: "zh-Hans", tag: "zh-Hans", direction: "ltr" },
  { path: "zh-Hant-HK", tag: "zh-Hant-HK", direction: "ltr" },
  { path: "zh-Hant-TW", tag: "zh-Hant-TW", direction: "ltr" }
])

/** Reads one UTF-8 repository file. */
async function read(relative: string): Promise<string> {
  return await Bun.file(new URL(relative, RepositoryRoot)).text()
}

/** Inventories one locale's Markdown pages without including nested locale roots. */
async function pages(locale: string): Promise<string[]> {
  const root = new URL(locale.length === 0 ? "./" : `./${locale}/`, DocRoot)
  const found: string[] = []
  for await (const file of new Bun.Glob("**/*.md").scan({ cwd: root.pathname, onlyFiles: true })) {
    const first = file.split("/", 1)[0]
    if (locale.length === 0 && Locales.some((entry) => entry.path === first)) continue
    found.push(file)
  }
  return found.sort()
}

/** Extracts unique public package tokens from prose or a manifest name. */
function packageTokens(source: string): string[] {
  return Array.from(new Set(source.match(PackageTokenPattern) ?? [])).sort()
}

describe("VitePress documentation contract", () => {
  test("extracts complete package tokens without accepting suffixes or subpaths", () => {
    const source = [
      "`@likego/name.with.dots`",
      "`@likego/name_with_underscores`",
      "`@likego/name-with-hyphens`",
      "`@likego/core_PRIVATE`",
      "`@likego/core/private`",
      "`@likego/registry-*`"
    ].join(" ")

    expect(packageTokens(source)).toEqual([
      "@likego/name-with-hyphens",
      "@likego/name.with.dots",
      "@likego/name_with_underscores"
    ])
  })

  test("pins the stable VitePress release and the four exact document scripts", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
    expect(manifest.devDependencies.vitepress).toBe("1.6.4")
    expect({
      "doc:dev": manifest.scripts["doc:dev"],
      "doc:build": manifest.scripts["doc:build"],
      "doc:preview": manifest.scripts["doc:preview"],
      "verify:doc": manifest.scripts["verify:doc"]
    }).toEqual({
      "doc:dev": "vitepress dev doc",
      "doc:build": "vitepress build doc",
      "doc:preview": "vitepress preview doc",
      "verify:doc": "bun test test/doc-site.test.ts && bun run doc:build"
    })
  })

  test("defines eight BCP 47 locales with ISO 15924 scripts and Arabic RTL", async () => {
    const site = (await import("../doc/.vitepress/config")).default
    const configured = Object.values(site.locales).map((locale) => ({
      tag: locale.lang,
      direction: locale.dir ?? "ltr"
    }))
    expect(configured).toEqual(Locales.map(({ tag, direction }) => ({ tag, direction })))
    expect(configured.every(({ tag }) => /^[a-z]{2}-[A-Z][a-z]{3}(?:-[A-Z]{2})?$/.test(tag))).toBe(
      true
    )
    expect(site.mpa).not.toBe(true)
    expect(site.ignoreDeadLinks).not.toBe(true)
    expect(site.themeConfig.search.provider).toBe("local")
    expect(Object.keys(site.locales)).toEqual([
      "root",
      "ar-Arab",
      "es-Latn",
      "fr-Latn",
      "ru-Cyrl",
      "zh-Hans",
      "zh-Hant-HK",
      "zh-Hant-TW"
    ])
    expect(Object.values(site.locales).every((locale) => locale.themeConfig.nav.length > 0)).toBe(
      true
    )
  })

  test("keeps ten meaningful pages at identical paths in every locale", async () => {
    for (const locale of Locales) {
      const prefix = locale.path.length === 0 ? "doc" : `doc/${locale.path}`
      expect(await pages(locale.path)).toEqual(Array.from(RelativePages))
      for (const relative of RelativePages) {
        const source = await read(`${prefix}/${relative}`)
        expect(source.length).toBeGreaterThan(180)
        expect(source).toMatch(/^# /)
        if (relative === "reference/packages.md") {
          expect(source).toContain("`@likego/store-memory`")
        }
      }
    }
  })

  test("marks local workspace packages as unpublished version 0.0.1 in every locale", async () => {
    for (const locale of Locales) {
      const prefix = locale.path.length === 0 ? "doc" : `doc/${locale.path}`
      const source = await read(`${prefix}/guide/getting-started.md`)
      expect(source).toContain("`workspace:*`")
      expect(source).toContain("`0.0.1`")
      expect(source).toContain("npm")
    }
  })

  test("documents call filters, transport context, and aggregate cleanup failures", async () => {
    for (const locale of Locales) {
      const prefix = locale.path.length === 0 ? "doc" : `doc/${locale.path}`
      const source = await read(`${prefix}/guide/service-call.md`)
      expect(source).toContain("`Filter`")
      expect(source).toContain("`TransportInfo`")
      expect(source).toContain("`AggregateError`")
    }
  })

  test("documents concurrent application shutdown instead of reverse-order shutdown", async () => {
    const reverseShutdownDescriptions = [
      "الإيقاف بالترتيب العكسي",
      "parada inversa",
      "arrêt inversé",
      "остановку в обратном порядке",
      "反向停止"
    ]

    for (const locale of Locales) {
      const prefix = locale.path.length === 0 ? "doc" : `doc/${locale.path}`
      const source = await read(`${prefix}/guide/architecture.md`)
      expect(source).toContain("`Promise.allSettled`")
      for (const description of reverseShutdownDescriptions) {
        expect(source).not.toContain(description)
      }
    }
  })

  test("documents the RabbitMQ, Kubernetes Config, and Node transport entrypoints", async () => {
    for (const locale of Locales) {
      const prefix = locale.path.length === 0 ? "doc" : `doc/${locale.path}`
      const source = await read(`${prefix}/reference/packages.md`)
      expect(source).toContain("`@likego/broker-rabbitmq`")
      expect(source).toContain("`@likego/config-kubernetes`")
      expect(source).toContain("`@likego/transport-http/node`")
    }
  })

  test("lists every publishable workspace package token in every locale", async () => {
    const expected = (await discoverWorkspaces(RepositoryRoot.pathname))
      .filter(({ private: isPrivate }) => isPrivate === false)
      .map(({ name }) => name)
      .sort()
    expect(expected.length).toBeGreaterThan(0)
    for (const locale of Locales) {
      const prefix = locale.path.length === 0 ? "doc" : `doc/${locale.path}`
      const source = await read(`${prefix}/reference/packages.md`)
      expect(packageTokens(source)).toEqual(expected)
    }
  })

  test("ships independently localized Simplified Chinese, Taiwan, and Hong Kong prose", async () => {
    const simplified = await read("doc/zh-Hans/index.md")
    const taiwan = await read("doc/zh-Hant-TW/index.md")
    const hongKong = await read("doc/zh-Hant-HK/index.md")
    expect(new Set([simplified, taiwan, hongKong]).size).toBe(3)
    expect(simplified).toContain("微服务工具包")
    expect(taiwan).toContain("微服務工具套件")
    expect(hongKong).toContain("微服務工具組")
    expect(hongKong).toContain("唔會")
  })
})
