import { background } from "@likego/context"
import { describe, expect, test } from "bun:test"

import { newMemoryTemperatureLedger, newTemperatureConfig } from "../src/config"
import { newColdChainHandler } from "../src/http"
import { assessTemperature, newMonitorTemperature } from "../src/service"

describe("cold-chain monitoring", () => {
  test("treats both configured boundaries as within range", () => {
    const limits = { minimumC: 2, maximumC: 8 }
    expect(
      assessTemperature(
        { shipmentId: "shipment-a", sensorId: "sensor-a", sequence: 1, temperatureC: 2 },
        limits
      ).status
    ).toBe("withinRange")
    expect(
      assessTemperature(
        { shipmentId: "shipment-b", sensorId: "sensor-a", sequence: 1, temperatureC: 8 },
        limits
      ).status
    ).toBe("withinRange")
    expect(
      assessTemperature(
        { shipmentId: "shipment-c", sensorId: "sensor-a", sequence: 1, temperatureC: 8.1 },
        limits
      ).status
    ).toBe("breach")
  })

  test("uses the immutable Config value after caller mutation", async () => {
    const limits = { minimumC: 2, maximumC: 8 }
    const config = newTemperatureConfig(limits)
    const handler = newColdChainHandler(newMonitorTemperature(config, newMemoryTemperatureLedger()))
    await config.load(background())
    limits.maximumC = 99
    try {
      const response = await handler(
        new Request("https://example.test/v1/cold-chain/readings", {
          method: "POST",
          body: JSON.stringify({
            shipmentId: "shipment-config",
            sensorId: "sensor-a",
            sequence: 1,
            temperatureC: 9
          })
        })
      )
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({ maximumC: 8, status: "breach" })
    } finally {
      await config.close(background())
    }
  })

  test("accepts exact replay but rejects stale and conflicting sequences", async () => {
    const config = newTemperatureConfig({ minimumC: 2, maximumC: 8 })
    const monitor = newMonitorTemperature(config, newMemoryTemperatureLedger())
    await config.load(background())
    const reading = {
      shipmentId: "shipment-sequence",
      sensorId: "sensor-a",
      sequence: 2,
      temperatureC: 5
    }
    try {
      const first = monitor(background(), reading)
      expect(monitor(background(), reading)).toEqual(first)
      expect(() =>
        monitor(background(), {
          shipmentId: "shipment-sequence",
          sensorId: "sensor-a",
          sequence: 1,
          temperatureC: 5
        })
      ).toThrow("reading sequence is stale or conflicting")
      expect(() =>
        monitor(background(), {
          shipmentId: "shipment-sequence",
          sensorId: "sensor-a",
          sequence: 2,
          temperatureC: 6
        })
      ).toThrow("reading sequence is stale or conflicting")
    } finally {
      await config.close(background())
    }
  })

  test("refuses monitoring before Config loads a value", () => {
    const config = newTemperatureConfig({ minimumC: 2, maximumC: 8 })
    const monitor = newMonitorTemperature(config, newMemoryTemperatureLedger())
    expect(() =>
      monitor(background(), {
        shipmentId: "shipment-not-ready",
        sensorId: "sensor-a",
        sequence: 1,
        temperatureC: 5
      })
    ).toThrow("temperature configuration is not ready")
  })
})
