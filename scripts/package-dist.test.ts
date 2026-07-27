import { expect, test } from "bun:test"

import { distPackageManifest, packageEntries } from "./package-dist"

const packageManifest = {
  name: "@likego/example",
  version: "0.1.0",
  private: true,
  type: "module",
  main: "src/index.ts",
  module: "src/index.ts",
  typings: "src/index.ts",
  scripts: { build: "old" },
  files: ["dist"],
  publishConfig: { directory: "dist", access: "public" },
  dependencies: {
    "@likego/context": "workspace:*",
    hono: "4.12.31"
  },
  devDependencies: { typescript: "7.0.2" },
  exports: {
    ".": "./src/index.ts",
    "./node/testing": "./src/node-testing.ts"
  }
}

test("derives every public entry from the existing package exports", () => {
  expect(packageEntries(packageManifest)).toEqual({
    index: "src/index.ts",
    "node-testing": "src/node-testing.ts"
  })
})

test("creates an independently publishable dist manifest without a minified lane", () => {
  expect(distPackageManifest(packageManifest, new Map([["@likego/context", "0.1.0"]]))).toEqual({
    name: "@likego/example",
    version: "0.1.0",
    type: "module",
    main: "./index.js",
    module: "./index.js",
    typings: "./index.d.ts",
    types: "./index.d.ts",
    publishConfig: { access: "public" },
    repository: {
      type: "git",
      url: "git+https://github.com/MunMunMiao/likego.git"
    },
    homepage: "https://github.com/MunMunMiao/likego#readme",
    bugs: { url: "https://github.com/MunMunMiao/likego/issues" },
    keywords: ["likego", "microservices", "typescript"],
    dependencies: {
      "@likego/context": "0.1.0",
      hono: "4.12.31"
    },
    exports: {
      ".": {
        types: "./index.d.ts",
        import: "./index.js",
        default: "./index.js"
      },
      "./node/testing": {
        types: "./node-testing.d.ts",
        import: "./node-testing.js",
        default: "./node-testing.js"
      },
      "./package.json": "./package.json"
    }
  })
})

test("builds and publishes string and named JavaScript bins from dist", () => {
  const named = {
    ...packageManifest,
    bin: {
      "likego-example": "./dist/cli.js",
      "likego-example-root": "./dist/index.js"
    }
  }
  expect(packageEntries(named)).toEqual({
    index: "src/index.ts",
    "node-testing": "src/node-testing.ts",
    cli: "src/cli.ts"
  })
  expect(distPackageManifest(named, new Map([["@likego/context", "0.1.0"]])).bin).toEqual({
    "likego-example": "./cli.js",
    "likego-example-root": "./index.js"
  })
  expect(
    distPackageManifest(
      { ...packageManifest, bin: "./dist/cli.js" },
      new Map([["@likego/context", "0.1.0"]])
    ).bin
  ).toBe("./cli.js")
})

test("rejects unsafe or non-JavaScript bin targets", () => {
  for (const target of [
    "../cli.js",
    "./dist/../cli.js",
    "./dist/nested/../../cli.js",
    "./dist//cli.js",
    "./dist/.js",
    "./dist/cli.ts"
  ]) {
    expect(() =>
      distPackageManifest(
        { ...packageManifest, bin: { "likego-example": target } },
        new Map([["@likego/context", "0.1.0"]])
      )
    ).toThrow("package bin target")
  }
  expect(() =>
    packageEntries({
      ...packageManifest,
      bin: { "../likego-example": "./dist/cli.js" }
    })
  ).toThrow("package bin command must be a safe bare name")
})

test("rewrites every published workspace dependency without mutating the source manifest", () => {
  const source = Object.assign(structuredClone(packageManifest), {
    optionalDependencies: { "@likego/testing": "workspace:^" },
    peerDependencies: { "@likego/core": "workspace:~" }
  })
  const dist = distPackageManifest(
    source,
    new Map([
      ["@likego/context", "0.1.0"],
      ["@likego/core", "0.1.0"],
      ["@likego/testing", "0.1.0"]
    ])
  )
  expect(dist).toMatchObject({
    dependencies: { "@likego/context": "0.1.0" },
    optionalDependencies: { "@likego/testing": "0.1.0" },
    peerDependencies: { "@likego/core": "0.1.0" }
  })
  expect(source.dependencies["@likego/context"]).toBe("workspace:*")
  expect(source.optionalDependencies["@likego/testing"]).toBe("workspace:^")
  expect(source.peerDependencies["@likego/core"]).toBe("workspace:~")
})

test("rejects exports that do not map to a colocated TypeScript entry", () => {
  expect(() =>
    packageEntries({
      ...packageManifest,
      exports: { ".": "./elsewhere/index.ts" }
    })
  ).toThrow("package export target must be a ./src/*.ts string")
})

test("requires the package root to map to the source index", () => {
  expect(() =>
    packageEntries({
      ...packageManifest,
      exports: { ".": "./src/other.ts" }
    })
  ).toThrow("package root export must target ./src/index.ts")
})
