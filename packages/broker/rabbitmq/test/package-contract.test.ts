import { expect, test } from "bun:test"

test("publishes one resident RabbitMQ Broker integration package", async () => {
  const root = `${import.meta.dir}/..`
  const packageJson = await Bun.file(`${root}/package.json`).json()
  const capability = await Bun.file(`${root}/capability.json`).json()
  const owner = await Bun.file(`${root}/owner.json`).json()

  expect(packageJson).toMatchObject({
    name: "@likego/broker-rabbitmq",
    version: "0.0.1",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    exports: { ".": "./src/index.ts" },
    dependencies: {
      "@likego/broker": "0.0.1",
      "@likego/context": "0.0.1",
      "@likego/core": "0.0.1",
      "@types/node": "26.1.1",
      amqplib: "2.0.1"
    }
  })
  expect(capability.package).toBe("@likego/broker-rabbitmq")
  expect(capability.packageKind).toBe("integration")
  expect(capability.exports["."].ownerResources).toEqual(["rabbitmq-consumer"])
  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/broker-rabbitmq",
    resources: [
      {
        id: "rabbitmq-consumer",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
})
