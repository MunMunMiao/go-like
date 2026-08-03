import { expect, test } from "bun:test"
import { background, canceled, type Context, type ContextError, withCancel } from "@likego/context"

import { retry, type RetryOptions } from "../src/index"
import { deferred, flush } from "./helpers"

/** Creates a Context whose terminal error changes across observations. */
function racingContext(errors: readonly (ContextError | null)[]): Context {
  let reads = 0
  return Object.freeze({
    /** Reports no deadline. */
    deadline(): readonly [Date, boolean] {
      return [new Date(0), false]
    },
    /** Reports no signal. */
    done(): null {
      return null
    },
    /** Returns the next configured terminal observation. */
    err(): ContextError | null {
      const observed = errors[reads]
      reads += 1
      return observed ?? null
    },
    /** Reports no values. */
    value(_key: unknown): null {
      return null
    }
  })
}

test("returns synchronous and asynchronous operation values with inferred types", async () => {
  const sync = retry(background(), (_ctx, attempt) => attempt * 2, {
    authorization: "idempotent",
    maxAttempts: 1,
    shouldRetry: () => false
  })
  const asyncValue = retry(background(), async () => "ok", {
    authorization: "caller-approved",
    maxAttempts: 1,
    shouldRetry: async () => false
  })

  await expect(sync).resolves.toBe(2)
  await expect(asyncValue).resolves.toBe("ok")
})

test("recovers from explicitly classified transient failures", async () => {
  const transient = new Error("transient")
  const attempts: number[] = []
  const classifications: number[] = []
  const delays: number[] = []

  const value = await retry(
    background(),
    (_ctx, attempt) => {
      attempts.push(attempt)
      if (attempt < 3) throw transient
      return "recovered"
    },
    {
      authorization: "idempotent",
      maxAttempts: 3,
      shouldRetry: async (_ctx, failure, attempt) => {
        expect(failure).toBe(transient)
        classifications.push(attempt)
        return true
      },
      backoff: (attempt) => {
        delays.push(attempt)
        return attempt === 1 ? 0 : 1
      }
    }
  )

  expect(value).toBe("recovered")
  expect(attempts).toEqual([1, 2, 3])
  expect(classifications).toEqual([1, 2])
  expect(delays).toEqual([1, 2])
})

test("preserves terminal operation identity at exhaustion or policy rejection", async () => {
  const failure = new Error("terminal")
  let classifications = 0
  await expect(
    retry(background(), () => Promise.reject(failure), {
      authorization: "idempotent",
      maxAttempts: 1,
      shouldRetry: () => {
        classifications += 1
        return true
      }
    })
  ).rejects.toBe(failure)
  expect(classifications).toBe(0)

  await expect(
    retry(
      background(),
      () => {
        throw failure
      },
      {
        authorization: "caller-approved",
        maxAttempts: 2,
        shouldRetry: () => false
      }
    )
  ).rejects.toBe(failure)
})

test("preserves retry-policy and backoff failures", async () => {
  const operationFailure = new Error("operation")
  const policyFailure = new Error("policy")
  const backoffFailure = new Error("backoff")

  await expect(
    retry(
      background(),
      () => {
        throw operationFailure
      },
      {
        authorization: "idempotent",
        maxAttempts: 2,
        shouldRetry: () => {
          throw policyFailure
        }
      }
    )
  ).rejects.toBe(policyFailure)

  await expect(
    retry(
      background(),
      () => {
        throw operationFailure
      },
      {
        authorization: "idempotent",
        maxAttempts: 2,
        shouldRetry: () => true,
        backoff: () => {
          throw backoffFailure
        }
      }
    )
  ).rejects.toBe(backoffFailure)
})

test("rejects invalid predicate and backoff outcomes", async () => {
  const failure = new Error("operation")
  const invalidPredicate = {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry: () => "yes"
  }
  await expect(
    Reflect.apply(retry, undefined, [
      background(),
      () => {
        throw failure
      },
      invalidPredicate
    ])
  ).rejects.toThrow("shouldRetry must return a boolean")

  for (const delay of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    await expect(
      retry(
        background(),
        () => {
          throw failure
        },
        {
          authorization: "idempotent",
          maxAttempts: 2,
          shouldRetry: () => true,
          backoff: () => delay
        }
      )
    ).rejects.toThrow(RangeError)
  }
})

test("Context cancellation stops admission, classification, and delay", async () => {
  const [preCanceled, cancelPreCanceled] = withCancel(background())
  cancelPreCanceled()
  let attempts = 0
  await expect(
    retry(
      preCanceled,
      () => {
        attempts += 1
        return "unexpected"
      },
      {
        authorization: "idempotent",
        maxAttempts: 2,
        shouldRetry: () => true
      }
    )
  ).rejects.toBe(canceled)
  expect(attempts).toBe(0)

  const operationFailure = new Error("operation")
  const [duringOperation, cancelDuringOperation] = withCancel(background())
  await expect(
    retry(
      duringOperation,
      () => {
        cancelDuringOperation()
        throw operationFailure
      },
      {
        authorization: "idempotent",
        maxAttempts: 2,
        shouldRetry: () => true
      }
    )
  ).rejects.toBe(canceled)

  const [duringPolicy, cancelDuringPolicy] = withCancel(background())
  await expect(
    retry(
      duringPolicy,
      () => {
        throw operationFailure
      },
      {
        authorization: "idempotent",
        maxAttempts: 2,
        shouldRetry: () => {
          cancelDuringPolicy()
          return true
        }
      }
    )
  ).rejects.toBe(canceled)

  const [duringDelay, cancelDuringDelay] = withCancel(background())
  const delayed = retry(
    duringDelay,
    () => {
      throw operationFailure
    },
    {
      authorization: "idempotent",
      maxAttempts: 2,
      shouldRetry: () => true,
      backoff: () => 10_000
    }
  )
  await flush()
  cancelDuringDelay()
  await expect(delayed).rejects.toBe(canceled)
})

test("Context cancellation outranks asynchronous retry-policy settlement", async () => {
  const operationFailure = new Error("operation")
  const policyFailure = new Error("policy")

  const [resolvedContext, cancelResolved] = withCancel(background())
  const resolvedPolicy = deferred<boolean>()
  const resolved = retry(
    resolvedContext,
    () => {
      throw operationFailure
    },
    {
      authorization: "idempotent",
      maxAttempts: 2,
      shouldRetry: () => resolvedPolicy.promise
    }
  )
  await flush()
  cancelResolved()
  resolvedPolicy.resolve(true)
  await expect(resolved).rejects.toBe(canceled)

  const [rejectedContext, cancelRejected] = withCancel(background())
  const rejectedPolicy = deferred<boolean>()
  const rejected = retry(
    rejectedContext,
    () => {
      throw operationFailure
    },
    {
      authorization: "idempotent",
      maxAttempts: 2,
      shouldRetry: () => rejectedPolicy.promise
    }
  )
  await flush()
  cancelRejected()
  rejectedPolicy.reject(policyFailure)
  await expect(rejected).rejects.toBe(canceled)
})

test("Context cancellation outranks backoff callback settlement", async () => {
  const operationFailure = new Error("operation")
  const policyFailure = new Error("policy")

  const [throwingContext, cancelThrowing] = withCancel(background())
  await expect(
    retry(
      throwingContext,
      () => {
        throw operationFailure
      },
      {
        authorization: "idempotent",
        maxAttempts: 2,
        shouldRetry: () => true,
        backoff: () => {
          cancelThrowing()
          throw policyFailure
        }
      }
    )
  ).rejects.toBe(canceled)

  const [invalidContext, cancelInvalid] = withCancel(background())
  await expect(
    retry(
      invalidContext,
      () => {
        throw operationFailure
      },
      {
        authorization: "idempotent",
        maxAttempts: 2,
        shouldRetry: () => true,
        backoff: () => {
          cancelInvalid()
          return Number.NaN
        }
      }
    )
  ).rejects.toBe(canceled)
})

test("closes a Context error race after a rejected operation", async () => {
  const failure = new Error("operation")
  const ctx = racingContext([null, null, null, canceled])

  await expect(
    retry(
      ctx,
      () => {
        throw failure
      },
      {
        authorization: "idempotent",
        maxAttempts: 2,
        shouldRetry: () => true
      }
    )
  ).rejects.toBe(canceled)
})

test("validates every public retry boundary before invoking work", async () => {
  const valid: RetryOptions = {
    authorization: "idempotent",
    maxAttempts: 1,
    shouldRetry: () => false
  }
  await expect(Reflect.apply(retry, undefined, [null, () => "value", valid])).rejects.toThrow(
    TypeError
  )
  await expect(Reflect.apply(retry, undefined, [background(), null, valid])).rejects.toThrow(
    "operation must be callable"
  )
  await expect(
    Reflect.apply(retry, undefined, [background(), () => "value", null])
  ).rejects.toThrow(TypeError)
  for (const authorization of [undefined, "automatic", 1]) {
    await expect(
      Reflect.apply(retry, undefined, [
        background(),
        () => "value",
        {
          authorization,
          maxAttempts: 1,
          shouldRetry: () => false
        }
      ])
    ).rejects.toThrow(TypeError)
  }
  for (const maxAttempts of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(
      Reflect.apply(retry, undefined, [
        background(),
        () => "value",
        {
          authorization: "idempotent",
          maxAttempts,
          shouldRetry: () => false
        }
      ])
    ).rejects.toThrow(RangeError)
  }
  await expect(
    Reflect.apply(retry, undefined, [
      background(),
      () => "value",
      {
        authorization: "idempotent",
        maxAttempts: 1,
        shouldRetry: null
      }
    ])
  ).rejects.toThrow("shouldRetry must be callable")
  await expect(
    Reflect.apply(retry, undefined, [
      background(),
      () => "value",
      {
        authorization: "idempotent",
        maxAttempts: 1,
        shouldRetry: () => false,
        backoff: 1
      }
    ])
  ).rejects.toThrow("backoff must be callable")
})

test("captures the attempt bound before invoking hostile application code", async () => {
  let reads = 0
  let attempts = 0
  const failure = new Error("operation")
  const options: RetryOptions = {
    authorization: "idempotent",
    get maxAttempts(): number {
      reads += 1
      return reads === 1 ? 2 : 0
    },
    shouldRetry: () => true
  }

  await expect(
    retry(
      background(),
      () => {
        attempts += 1
        throw failure
      },
      options
    )
  ).rejects.toBe(failure)
  expect(attempts).toBe(2)
  expect(reads).toBe(1)
})
