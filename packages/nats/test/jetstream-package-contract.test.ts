import { expect, test } from "bun:test"

test("manifests pin the official SDK and declare split native lifecycle ownership", async () => {
  const packageManifest = await Bun.file(`${import.meta.dir}/../package.json`).json()
  const capability = await Bun.file(`${import.meta.dir}/../capability.json`).json()
  const owner = await Bun.file(`${import.meta.dir}/../owner.json`).json()

  expect(packageManifest.name).toBe("@likego/nats")
  expect(packageManifest.module).toBe("src/index.ts")
  expect(packageManifest.typings).toBe("src/index.ts")
  expect(packageManifest.exports["./jetstream"]).toBe("./src/jetstream.ts")
  expect(packageManifest.exports["./jetstream/broker"]).toBe("./src/jetstream-broker.ts")
  expect(packageManifest.scripts["e2e:docker:jetstream"]).toBe(
    "bun test/e2e/jetstream-docker-e2e.ts"
  )
  expect(packageManifest.dependencies["@nats-io/jetstream"]).toBe("3.4.0")
  expect(packageManifest.dependencies["@nats-io/transport-node"]).toBe("3.4.0")
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/nats",
    packageKind: "integration",
    exports: {
      "./jetstream": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["consumer-messages"],
        capabilities: ["broker", "nats-jetstream", "server"]
      },
      "./jetstream/broker": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["jetstream-broker-subscription"],
        capabilities: ["broker", "nats-jetstream", "server"]
      }
    }
  })
  expect(owner.package).toBe("@likego/nats")
  expect(owner.resources).toEqual([
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
  ])
})
