import { background, withCancel } from "@go-like/context"
import { describe, expect, test } from "bun:test"

import { newMemoryTemperatureLedger, newTemperatureConfig } from "../src/config"
import { newColdChainHandler } from "../src/http"
import {
  assessTemperature,
  newMonitorTemperature,
  validateTemperatureLimits,
  validateTemperatureReading
} from "../src/service"

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
      expect(
        monitor(background(), {
          shipmentId: "shipment-sequence",
          sensorId: "sensor-a",
          sequence: 3,
          temperatureC: 6
        })
      ).toMatchObject({ sequence: 3, temperatureC: 6 })
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

  test("validates limits and readings, including canceled contexts", () => {
    expect(validateTemperatureLimits({ minimumC: -10, maximumC: 10 })).toBeUndefined()
    expect(() => validateTemperatureLimits({ minimumC: 2, maximumC: 2 })).toThrow(
      "minimumC must be lower than maximumC"
    )
    expect(() => validateTemperatureLimits({ minimumC: Number.NaN, maximumC: 8 })).toThrow(
      "minimumC must be lower than maximumC"
    )
    const valid = { shipmentId: "shipment-1", sensorId: "sensor-1", sequence: 1, temperatureC: 5 }
    expect(validateTemperatureReading(valid)).toBeUndefined()
    expect(() => validateTemperatureReading({ ...valid, shipmentId: "bad id" })).toThrow(
      "invalid shipment or sensor identity"
    )
    expect(() => validateTemperatureReading({ ...valid, sequence: 0 })).toThrow(
      "sequence must be a positive safe integer"
    )
    expect(() => validateTemperatureReading({ ...valid, temperatureC: 101 })).toThrow(
      "temperatureC must be between -100 and 100"
    )

    const ledger = newMemoryTemperatureLedger()
    const [ctx, cancel] = withCancel(background())
    cancel()
    expect(() =>
      ledger.record(ctx, { ...valid, minimumC: 2, maximumC: 8, status: "withinRange" })
    ).toThrow()
  })

  test("maps malformed, stale, and unexpected handler failures", async () => {
    const config = newTemperatureConfig({ minimumC: 2, maximumC: 8 })
    await config.load(background())
    try {
      const monitor = newMonitorTemperature(config, newMemoryTemperatureLedger())
      const handler = newColdChainHandler(monitor)
      const invalidShapeConfig = {
        value: () => ({ load: () => [] })
      } as unknown as Parameters<typeof newMonitorTemperature>[0]
      const invalidShapeMonitor = newMonitorTemperature(
        invalidShapeConfig,
        newMemoryTemperatureLedger()
      )
      expect(() =>
        invalidShapeMonitor(background(), {
          shipmentId: "invalid-config-shape",
          sensorId: "sensor",
          sequence: 1,
          temperatureC: 5
        })
      ).toThrow("temperature configuration is invalid")
      const incompleteConfig = {
        value: () => ({ load: () => ({ minimumC: 2 }) })
      } as unknown as Parameters<typeof newMonitorTemperature>[0]
      const incompleteMonitor = newMonitorTemperature(
        incompleteConfig,
        newMemoryTemperatureLedger()
      )
      expect(() =>
        incompleteMonitor(background(), {
          shipmentId: "invalid-config-fields",
          sensorId: "sensor",
          sequence: 1,
          temperatureC: 5
        })
      ).toThrow("temperature configuration is invalid")
      const requests: Array<[Request, number, string?]> = [
        [new Request("https://example.test/other", { method: "GET" }), 404],
        [
          new Request("https://example.test/v1/cold-chain/readings", {
            method: "POST",
            body: JSON.stringify([])
          }),
          400
        ],
        [
          new Request("https://example.test/v1/cold-chain/readings", {
            method: "POST",
            body: JSON.stringify({ shipmentId: "x", sensorId: "y", sequence: "1", temperatureC: 5 })
          }),
          400
        ],
        [
          new Request("https://example.test/v1/cold-chain/readings", {
            method: "POST",
            body: JSON.stringify({
              shipmentId: "stale",
              sensorId: "s",
              sequence: 2,
              temperatureC: 5
            })
          }),
          201
        ],
        [
          new Request("https://example.test/v1/cold-chain/readings", {
            method: "POST",
            body: JSON.stringify({
              shipmentId: "stale",
              sensorId: "s",
              sequence: 1,
              temperatureC: 5
            })
          }),
          409,
          "reading sequence is stale or conflicting"
        ]
      ]
      for (const [request, status, message] of requests) {
        const response = await handler(request)
        expect(response.status).toBe(status)
        if (message !== undefined) expect(await response.json()).toMatchObject({ message })
      }

      const failing = newColdChainHandler(() => {
        throw new Error("ledger unavailable")
      })
      const response = await failing(
        new Request("https://example.test/v1/cold-chain/readings", {
          method: "POST",
          body: JSON.stringify({
            shipmentId: "failure",
            sensorId: "s",
            sequence: 1,
            temperatureC: 5
          })
        })
      )
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({
        code: "temperature_reading_rejected",
        message: "ledger unavailable"
      })
    } finally {
      await config.close(background())
    }
  })
})
