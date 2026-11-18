import { expect, test } from "bun:test"

import * as RabbitMqBroker from "../src/broker/index"

test("exports only the reviewed lower-camel runtime surface", () => {
  expect(Object.keys(RabbitMqBroker)).toEqual([
    "newConfirmRabbitMqBroker",
    "newRabbitMqBroker",
    "newRecoveringRabbitMqBroker",
    "startRecoveringRabbitMqBroker"
  ])
})
