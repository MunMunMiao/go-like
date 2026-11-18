import { withoutCancel, type Context } from "../context"
import { isError } from "../internal/errors"

import type { SelectionDone, SelectionOutcome, Selector, ServiceInstance } from "./types"

/**
 * One validated Selector result and its one-shot feedback publication.
 * The core client and the Connect plug share this contract.
 */
export interface EndpointSelection {
  /** Selected endpoint URL, validated as a non-empty well-formed string. */
  readonly url: string
  /**
   * Publishes `outcome` to the Selector's SelectionDone with `withoutCancel(ctx)`.
   * Never throws: returns the feedback failure, or null. A thenable completion violates the
   * synchronous SelectionDone contract and is returned as a TypeError. A second call returns a
   * TypeError and does not call the Selector.
   */
  done(ctx: Context, outcome: SelectionOutcome): Error | null
}

/** Calls `selector.select` and validates the synchronous tuple contract. */
export function selectEndpoint(
  ctx: Context,
  selector: Selector,
  instances: readonly ServiceInstance[]
): EndpointSelection {
  if (selector === null || typeof selector !== "object" || typeof selector.select !== "function") {
    throw new TypeError("selector must implement Selector")
  }
  const selected = selector.select(ctx, instances)
  const [url, complete] = snapshotSelection(selected)
  let published = false
  return {
    url,
    /** Publishes one outcome. A second call does not invoke the Selector. */
    done(doneCtx: Context, outcome: SelectionOutcome): Error | null {
      if (published) return new TypeError("selection outcome was already published")
      published = true
      try {
        return selectionFeedbackResult(complete(withoutCancel(doneCtx), outcome))
      } catch (error) {
        return isError(error) ? error : new TypeError("selection feedback failed")
      }
    }
  }
}

/** Accepts only a two-element endpoint and completion tuple. */
function snapshotSelection(value: unknown): readonly [string, SelectionDone] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError("Selector.select must return an endpoint and completion callback tuple")
  }
  const selected: unknown = value[0]
  const complete: unknown = value[1]
  if (typeof selected !== "object" || selected === null || Array.isArray(selected)) {
    throw new TypeError("Selector.select endpoint must be an object")
  }
  const url: unknown = Reflect.get(selected, "url")
  if (typeof url !== "string" || url.length === 0 || !url.isWellFormed()) {
    throw new TypeError("Selector.select endpoint url must be a non-empty well-formed string")
  }
  if (typeof complete !== "function") {
    throw new TypeError("Selector.select completion callback must be a function")
  }
  return [url, complete as SelectionDone]
}

/** Creates the stable contract failure for an asynchronous Selector completion callback. */
function selectionFeedbackContractError(cause?: unknown): TypeError {
  return cause === undefined
    ? new TypeError("Selector.select completion callback must return void")
    : new TypeError("Selector.select completion callback must return void", { cause })
}

/** Consumes an out-of-contract asynchronous feedback settlement. */
function ignoreSelectionFeedbackSettlement(_value?: unknown): void {}

/** Detects and observes one forbidden completion thenable without awaiting it. */
function selectionFeedbackResult(value: unknown): Error | null {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return null
  let then: unknown
  try {
    then = Reflect.get(value, "then")
  } catch (cause) {
    return selectionFeedbackContractError(cause)
  }
  if (typeof then !== "function") return null
  try {
    const continuation: unknown = Reflect.apply(then, value, [
      ignoreSelectionFeedbackSettlement,
      ignoreSelectionFeedbackSettlement
    ])
    if (continuation !== value) {
      void Promise.resolve(continuation).catch(ignoreSelectionFeedbackSettlement)
    }
  } catch (cause) {
    return selectionFeedbackContractError(cause)
  }
  return selectionFeedbackContractError()
}
