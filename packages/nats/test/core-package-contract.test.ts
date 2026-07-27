import { expect, test } from "bun:test"

test("manifests pin the official SDK and declare split native lifecycle ownership", async () => {
  const packageManifest = await Bun.file(`${import.meta.dir}/../package.json`).json()
  const capability = await Bun.file(`${import.meta.dir}/../capability.json`).json()
  const owner = await Bun.file(`${import.meta.dir}/../owner.json`).json()

  expect(packageManifest.name).toBe("@likego/nats")
  expect(Object.keys(packageManifest.exports)).toEqual([
    ".",
    "./broker",
    "./jetstream",
    "./jetstream/broker"
  ])
  expect(packageManifest.module).toBe("src/index.ts")
  expect(packageManifest.typings).toBe("src/index.ts")
  expect(packageManifest.exports["."]).toBe("./src/index.ts")
  expect(packageManifest.exports["./broker"]).toBe("./src/broker.ts")
  expect(packageManifest.scripts).toMatchObject({
    "e2e:docker:core": "bun test/e2e/core-docker-e2e.ts",
    "e2e:docker:jetstream": "bun test/e2e/jetstream-docker-e2e.ts"
  })
  expect(packageManifest.dependencies).toEqual({
    "@likego/broker": "0.0.1",
    "@likego/context": expect.any(String),
    "@likego/core": expect.any(String),
    "@nats-io/jetstream": "3.4.0",
    "@nats-io/transport-node": "3.4.0",
    "@types/node": "26.1.1"
  })
  expect(packageManifest.devDependencies).toBeUndefined()
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/nats",
    packageKind: "integration",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["subscription"],
        capabilities: ["broker", "nats-core", "server"]
      }
    }
  })
  expect(capability.exports["./broker"]).toMatchObject({
    kind: "integration",
    residency: "resident",
    ownerResources: ["broker-subscription"],
    capabilities: ["broker", "nats-core", "server"]
  })
  expect(Object.keys(capability.exports)).toEqual([
    ".",
    "./broker",
    "./jetstream",
    "./jetstream/broker"
  ])
  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/nats",
    resources: [
      {
        id: "broker-subscription",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      },
      {
        id: "consumer-messages",
        owner: "application-owned",
        exposure: "native-borrowed",
        stopContract: "likego-owned"
      },
      {
        id: "jetstream-broker-subscription",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      },
      {
        id: "subscription",
        owner: "application-owned",
        exposure: "native-borrowed",
        stopContract: "likego-owned"
      }
    ]
  })
})
