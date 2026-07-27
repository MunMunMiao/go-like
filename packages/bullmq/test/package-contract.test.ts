import { expect, test } from "bun:test"

test("pins BullMQ 5.81.2 and declares native Worker lifecycle ownership", async () => {
  const root = `${import.meta.dir}/..`
  const packageManifest = await Bun.file(`${root}/package.json`).json()
  const capability = await Bun.file(`${root}/capability.json`).json()
  const owner = await Bun.file(`${root}/owner.json`).json()
  const lock = await Bun.file(`${root}/../../bun.lock`).text()

  expect(packageManifest.dependencies.bullmq).toBe("5.81.2")
  expect(packageManifest.dependencies["@types/node"]).toBe("26.1.1")
  expect(packageManifest.devDependencies).toBeUndefined()
  expect(packageManifest.module).toBe("src/index.ts")
  expect(packageManifest.typings).toBe("src/index.ts")
  expect(packageManifest.exports).toEqual({ ".": "./src/index.ts" })
  expect(lock).toContain('"bullmq": ["bullmq@5.81.2"')
  expect(lock).toContain(
    "sha512-Hi9GaVCC6HE9bQP65j/FNv1aL1fcEukTF99ezS5pl1Ud+joCFpNWiPCV45mWdkEmpuacS0XJdMMFGKPIHCwoPg=="
  )
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/bullmq",
    packageKind: "integration",
    exports: {
      ".": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["queue", "worker", "redis-connections"],
        capabilities: ["jobs", "bullmq", "server"]
      }
    }
  })
  expect(owner.resources).toEqual([
    {
      id: "queue",
      owner: "application-owned",
      exposure: "native-borrowed",
      stopContract: "application-owned"
    },
    {
      id: "worker",
      owner: "application-owned",
      exposure: "native-borrowed",
      stopContract: "likego-owned"
    },
    {
      id: "redis-connections",
      owner: "likego-owned",
      exposure: "managed-private",
      stopContract: "likego-owned"
    }
  ])
})

test("contains only the intended production source inventory", async () => {
  const files: string[] = []
  for await (const file of new Bun.Glob("*.ts").scan({
    cwd: `${import.meta.dir}/../src`,
    onlyFiles: true
  }))
    files.push(file)
  expect(files.sort()).toEqual(["errors.ts", "index.ts", "server.ts", "testing.ts", "types.ts"])
})

test("documents native ownership, the exact shutdown path, and the Redis 8 license boundary", async () => {
  const readme = await Bun.file(`${import.meta.dir}/../README.md`).text()
  expect(readme).toContain("只接受官方 `Worker`")
  expect(readme).toContain("官方三参数 ABI `(job, token, signal)`")
  expect(readme).toContain("`autorun: false`")
  expect(readme).toContain("调用一次 `close(true)`")
  expect(readme).toContain("`cancelAllJobs(reason)`")
  expect(readme).toContain("`start(ctx)` 的运行期 Promise 继续 pending")
  expect(readme).toContain("都不接受 `AbortSignal`")
  expect(readme).toContain(
    "redis:8.8.1-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb"
  )
  expect(readme).toContain("AGPLv3、RSALv2 或 SSPLv1")
})
