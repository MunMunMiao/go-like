import { expect, test } from "bun:test"

import * as BrokerPackage from "../../src/broker/index"
import * as BrokerProvider from "../../src/broker/provider"

test("public runtime API contains no invented settlement operations", () => {
  expect(Object.keys(BrokerPackage).sort()).toEqual(["eventBroker", "newBrokerServer"])
  expect("ack" in BrokerPackage).toBe(false)
  expect("nak" in BrokerPackage).toBe(false)
})

test("provider subpath contains only private terminal association helpers", () => {
  expect(Object.keys(BrokerProvider).sort()).toEqual([
    "brokerTopic",
    "deliver",
    "newBrokerEvent",
    "publish",
    "registerSubscriberTerminal",
    "snapshotBrokerMessage",
    "subscriberTerminal"
  ])
  expect(() => BrokerProvider.registerSubscriberTerminal(null as never, Promise.resolve())).toThrow(
    "object"
  )
  expect(() =>
    BrokerProvider.registerSubscriberTerminal(
      { topic: "topic", unsubscribe: async () => {} },
      null as never
    )
  ).toThrow(/^broker provider terminal must be a Promise$/)
})
