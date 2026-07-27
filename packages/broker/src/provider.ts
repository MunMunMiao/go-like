import type { Subscriber } from "./index"

const terminals = new WeakMap<Subscriber, Promise<void>>()

/** Associates one stable provider terminal with an upstream-style Subscriber. */
export function registerSubscriberTerminal(
  subscriber: Subscriber,
  terminal: PromiseLike<void>
): Subscriber {
  if (typeof subscriber !== "object" || subscriber === null) {
    throw new TypeError("broker provider Subscriber must be an object")
  }
  if (typeof terminal !== "object" || terminal === null || typeof terminal.then !== "function") {
    throw new TypeError("broker provider terminal must be a PromiseLike")
  }
  const retained = Promise.resolve(terminal)
  void retained.catch(() => {})
  terminals.set(subscriber, retained)
  return subscriber
}

/** Returns a provider terminal without adding it to the public Subscriber contract. */
export function subscriberTerminal(subscriber: Subscriber): Promise<void> | null {
  return terminals.get(subscriber) ?? null
}
