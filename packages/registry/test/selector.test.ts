import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"

import { background, withCancelCause, type Context } from "@likego/context"
import { type Metadata } from "@likego/metadata"
import {
  filterLabel,
  filterVersion,
  newEWMASelector,
  newP2CSelector,
  newRandomSelector,
  newRoundRobinSelector,
  newWeightedRoundRobinSelector,
  type NoAvailableEndpointError,
  type Filter,
  type SelectionDone,
  type ServiceInstance
} from "../src/index"
import { flush } from "./helpers"

const a: ServiceInstance = {
  id: "a",
  name: "catalog",
  version: "v1",
  endpoints: ["https://a.test/two", "https://a.test/one"],
  metadata: { zone: "a" }
}
const b: ServiceInstance = {
  id: "b",
  name: "catalog",
  version: "v1",
  endpoints: ["https://b.test/one"],
  metadata: { zone: "b" }
}
const billing: ServiceInstance = {
  id: "billing-a",
  name: "billing",
  version: "v1",
  endpoints: ["https://billing.test/two", "https://billing.test/one"],
  metadata: { zone: "a" }
}
const catalogAOnly: ServiceInstance = {
  id: "catalog-a-only",
  name: "catalog",
  version: "v1",
  endpoints: ["https://a-only.test/"],
  metadata: { zone: "a" }
}

describe("selector filters", () => {
  test("filterVersion keeps matching service revisions without changing instance identity", () => {
    const filter: Filter = filterVersion("v1")
    const filtered = filter([a, { ...b, version: "v2" }])
    expect(filtered).toEqual([a])
    expect(filtered[0]).toBe(a)
    expect(Object.isFrozen(filtered)).toBe(true)
  })

  test("filterLabel keeps matching flattened service-instance metadata", () => {
    const filter: Filter = filterLabel("zone", "b")
    const filtered = filter([a, b])
    expect(filtered).toEqual([b])
    expect(filtered[0]).toBe(b)
    expect(filterLabel("missing", "")([a, b])).toEqual([])
  })
})
const catalogBOnly: ServiceInstance = {
  id: "catalog-b-only",
  name: "catalog",
  version: "v1",
  endpoints: ["https://b-only.test/"],
  metadata: { zone: "b" }
}
const selectorA: ServiceInstance = {
  id: "a",
  name: "selector",
  version: "v1",
  endpoints: ["https://selector-a.test/"],
  metadata: {}
}
const selectorB: ServiceInstance = {
  id: "b",
  name: "selector",
  version: "v1",
  endpoints: ["https://selector-b.test/"],
  metadata: {}
}
const selectorC: ServiceInstance = {
  id: "c",
  name: "selector",
  version: "v1",
  endpoints: ["https://selector-c.test/"],
  metadata: {}
}

describe("round-robin endpoint selector", () => {
  test("uses deterministic snapshot order and wraps fairly", () => {
    const selector = newRoundRobinSelector()
    const selected: string[] = []
    for (let index = 0; index < 7; index += 1) {
      const [endpoint, done] = selector.select(background(), [b, a])
      selected.push(endpoint.url)
      done(background(), { error: null })
      expect(Object.isFrozen(endpoint)).toBe(true)
      expect(Object.isFrozen(endpoint.instance)).toBe(true)
      expect(Object.isFrozen(done)).toBe(true)
    }
    expect(selected).toEqual([
      "https://a.test/one",
      "https://a.test/two",
      "https://b.test/one",
      "https://a.test/one",
      "https://a.test/two",
      "https://b.test/one",
      "https://a.test/one"
    ])
  })

  test("isolates fair cursors by stable service selection domain", () => {
    const selector = newRoundRobinSelector()
    expect(selector.select(background(), [a])[0].url).toBe("https://a.test/one")
    expect(selector.select(background(), [billing])[0].url).toBe("https://billing.test/one")
    expect(selector.select(background(), [a])[0].url).toBe("https://a.test/two")
    expect(selector.select(background(), [billing])[0].url).toBe("https://billing.test/two")
  })

  test("isolates fair cursors across independently versioned service snapshots", () => {
    const selector = newRoundRobinSelector()
    const versionOneA: ServiceInstance = {
      id: "version-one-a",
      name: "catalog",
      version: "v1",
      endpoints: ["https://version-one-a.test/"],
      metadata: {}
    }
    const versionOneB: ServiceInstance = {
      id: "version-one-b",
      name: "catalog",
      version: "v1",
      endpoints: ["https://version-one-b.test/"],
      metadata: {}
    }
    const versionTwoC: ServiceInstance = {
      id: "version-two-c",
      name: "catalog",
      version: "v2",
      endpoints: ["https://version-two-c.test/"],
      metadata: {}
    }
    const versionTwoD: ServiceInstance = {
      id: "version-two-d",
      name: "catalog",
      version: "v2",
      endpoints: ["https://version-two-d.test/"],
      metadata: {}
    }

    const selected = [
      selector.select(background(), [versionOneB, versionOneA])[0].url,
      selector.select(background(), [versionTwoD, versionTwoC])[0].url,
      selector.select(background(), [versionOneB, versionOneA])[0].url,
      selector.select(background(), [versionTwoD, versionTwoC])[0].url
    ]

    expect(selected).toEqual([
      "https://version-one-a.test/",
      "https://version-two-c.test/",
      "https://version-one-b.test/",
      "https://version-two-d.test/"
    ])
  })

  test("retains a surviving cursor when non-adjacent service tuples lose one member", () => {
    const selector = newRoundRobinSelector()
    const versionOneA: ServiceInstance = {
      id: "a",
      name: "catalog",
      version: "v1",
      endpoints: ["https://a.test/"],
      metadata: {}
    }
    const versionTwoB: ServiceInstance = {
      id: "b",
      name: "catalog",
      version: "v2",
      endpoints: ["https://b.test/"],
      metadata: {}
    }
    const versionOneC: ServiceInstance = {
      id: "c",
      name: "catalog",
      version: "v1",
      endpoints: ["https://c.test/"],
      metadata: {}
    }
    const versionTwoD: ServiceInstance = {
      id: "d",
      name: "catalog",
      version: "v2",
      endpoints: ["https://d.test/"],
      metadata: {}
    }

    expect(
      selector.select(background(), [versionTwoD, versionOneC, versionTwoB, versionOneA])[0].url
    ).toBe("https://a.test/")
    expect(selector.select(background(), [versionTwoD, versionTwoB, versionOneA])[0].url).toBe(
      "https://b.test/"
    )
  })

  test("sorts unique service tuples independently from their first instance id", () => {
    const selector = newRoundRobinSelector()
    const removedVersionTwo: ServiceInstance = {
      id: "a",
      name: "catalog",
      version: "v2",
      endpoints: ["https://removed-v2.test/"],
      metadata: {}
    }
    const survivingVersionOne: ServiceInstance = {
      id: "b",
      name: "catalog",
      version: "v1",
      endpoints: ["https://surviving-v1.test/"],
      metadata: {}
    }
    const survivingVersionTwo: ServiceInstance = {
      id: "c",
      name: "catalog",
      version: "v2",
      endpoints: ["https://surviving-v2.test/"],
      metadata: {}
    }

    const initial = [survivingVersionTwo, survivingVersionOne, removedVersionTwo]
    expect(selector.select(background(), initial)[0].url).toBe("https://removed-v2.test/")
    expect(selector.select(background(), initial)[0].url).toBe("https://surviving-v1.test/")
    expect(selector.select(background(), [survivingVersionTwo, survivingVersionOne])[0].url).toBe(
      "https://surviving-v2.test/"
    )
  })

  test("keeps length-colliding name and version tuples in independent domains", () => {
    const selector = newRoundRobinSelector()
    const shortName: readonly ServiceInstance[] = [
      {
        id: "a",
        name: "a",
        version: "bc",
        endpoints: ["https://short-name-a.test/"],
        metadata: {}
      },
      {
        id: "b",
        name: "a",
        version: "bc",
        endpoints: ["https://short-name-b.test/"],
        metadata: {}
      }
    ]
    const longName: readonly ServiceInstance[] = [
      {
        id: "a",
        name: "ab",
        version: "c",
        endpoints: ["https://long-name-a.test/"],
        metadata: {}
      },
      {
        id: "b",
        name: "ab",
        version: "c",
        endpoints: ["https://long-name-b.test/"],
        metadata: {}
      }
    ]

    expect(selector.select(background(), shortName)[0].url).toBe("https://short-name-a.test/")
    expect(selector.select(background(), longName)[0].url).toBe("https://long-name-a.test/")
    expect(selector.select(background(), shortName)[0].url).toBe("https://short-name-b.test/")
    expect(selector.select(background(), longName)[0].url).toBe("https://long-name-b.test/")
  })

  test("adapts its bounded cursor when a discovery snapshot changes", () => {
    const selector = newRoundRobinSelector()
    expect(selector.select(background(), [a])[0].url).toBe("https://a.test/one")
    expect(selector.select(background(), [a])[0].url).toBe("https://a.test/two")
    expect(selector.select(background(), [b])[0].url).toBe("https://b.test/one")
    expect(selector.select(background(), [a])[0].url).toBe("https://a.test/one")
  })

  test("distinguishes equal ids and URLs owned by different service names", () => {
    const selector = newRoundRobinSelector()
    const alpha: ServiceInstance = {
      id: "shared",
      name: "alpha",
      version: "v1",
      endpoints: ["https://same.test/"],
      metadata: {}
    }
    const beta: ServiceInstance = {
      id: "shared",
      name: "beta",
      version: "v1",
      endpoints: ["https://same.test/"],
      metadata: {}
    }
    const selected: string[] = []
    for (let index = 0; index < 6; index += 1) {
      selected.push(selector.select(background(), [beta, alpha])[0].instance.name)
    }
    expect(selected).toEqual(["alpha", "beta", "alpha", "beta", "alpha", "beta"])
  })

  test("distinguishes versions represented by different service instance ids", () => {
    const selector = newRoundRobinSelector()
    const v1: ServiceInstance = {
      id: "shared",
      name: "catalog",
      version: "v1",
      endpoints: ["https://same.test/"],
      metadata: {}
    }
    const v2: ServiceInstance = { ...v1, id: "shared-v2", version: "v2" }
    const selected: string[] = []
    for (let index = 0; index < 6; index += 1) {
      selected.push(selector.select(background(), [v2, v1])[0].instance.version)
    }
    expect(selected).toEqual(["v1", "v2", "v1", "v2", "v1", "v2"])
  })

  test("does not starve a stable endpoint while the same service snapshot churns", () => {
    const selector = newRoundRobinSelector()
    const selected: string[] = []
    for (let cycle = 0; cycle < 6; cycle += 1) {
      selected.push(selector.select(background(), [catalogAOnly, catalogBOnly])[0].url)
      selected.push(selector.select(background(), [catalogAOnly])[0].url)
    }

    expect(selected.filter((url) => url === "https://b-only.test/").length).toBe(5)
  })

  test("bounds high-cardinality service-domain state with deterministic oldest eviction", () => {
    const selector = newRoundRobinSelector()
    expect(selector.select(background(), [catalogAOnly, catalogBOnly])[0].url).toBe(
      "https://a-only.test/"
    )
    for (let index = 0; index < 1_024; index += 1) {
      selector.select(background(), [
        {
          id: `domain-${index}`,
          name: `domain-${index}`,
          version: "v1",
          endpoints: [`https://domain-${index}.test/`],
          metadata: {}
        }
      ])
    }

    expect(selector.select(background(), [catalogAOnly, catalogBOnly])[0].url).toBe(
      "https://a-only.test/"
    )
  })

  test("throws the stable immutable empty-snapshot error without advancing state", () => {
    const selector = newRoundRobinSelector()
    const failure = (() => {
      try {
        selector.select(background(), [])
        return null
      } catch (error) {
        return error
      }
    })()
    expect(failure).toMatchObject({
      name: "NoAvailableEndpointError",
      code: "LIKEGO_NO_AVAILABLE_ENDPOINT"
    } satisfies Partial<NoAvailableEndpointError>)
    expect(failure).toBeInstanceOf(Error)
    expect(Object.isFrozen(failure)).toBe(true)
    expect(selector.select(background(), [a])[0].url).toBe("https://a.test/one")
  })

  test("honors Context cancellation before reading or advancing a snapshot", () => {
    const selector = newRoundRobinSelector()
    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("caller no longer needs an endpoint")
    cancel(failure)
    expect(() => selector.select(ctx, [a])).toThrow(failure)
    expect(selector.select(background(), [a])[0].url).toBe("https://a.test/one")
  })

  test("preserves a cross-realm Context error by identity", () => {
    const selector = newRoundRobinSelector()
    const failure: Error = runInNewContext('new Error("foreign Context failure")')
    const ctx: Context = {
      deadline() {
        return background().deadline()
      },
      done() {
        return null
      },
      err() {
        return failure
      },
      value() {
        return null
      }
    }
    let caught: unknown = null

    try {
      selector.select(ctx, [a])
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(failure)
  })

  test("preserves the first terminal error from a stateful structural Context", () => {
    const selector = newRoundRobinSelector()
    const failure = new Error("structural Context changed after err")
    let reads = 0
    const ctx: Context = {
      deadline() {
        return background().deadline()
      },
      done() {
        return null
      },
      err() {
        reads += 1
        return reads === 1 ? failure : null
      },
      value() {
        return null
      }
    }
    expect(() => selector.select(ctx, [a])).toThrow(failure)
    expect(reads).toBe(2)
  })

  test("fails closed on malformed snapshots and preserves the next fair selection", () => {
    const selector = newRoundRobinSelector()
    const malformed = { ...a, endpoints: ["not-an-absolute-url"] }
    expect(() => selector.select(background(), [malformed])).toThrow(TypeError)
    expect(selector.select(background(), [a])[0].url).toBe("https://a.test/one")
  })
})

describe("random endpoint selector", () => {
  test("uses exactly one sample per selection and the stable endpoint order", () => {
    const samples = [0, 0.34, 0.999_999]
    let calls = 0
    const selector = newRandomSelector(() => {
      const sample = samples[calls]
      calls += 1
      if (sample === undefined) throw new Error("random sample is missing")
      return sample
    })

    const selected = [
      selector.select(background(), [b, a]),
      selector.select(background(), [b, a]),
      selector.select(background(), [b, a])
    ]

    expect(selected.map(([endpoint]) => endpoint.url)).toEqual([
      "https://a.test/one",
      "https://a.test/two",
      "https://b.test/one"
    ])
    expect(calls).toBe(3)
    expect(selected.every((selection) => Object.isFrozen(selection))).toBe(true)
    expect(selected.every(([, done]) => Object.isFrozen(done))).toBe(true)
  })

  test("rejects invalid sources and results without retaining selection state", () => {
    expect(() => newRandomSelector(null as never)).toThrow(TypeError)

    for (const invalid of [
      Number.NEGATIVE_INFINITY,
      -1,
      Number.NaN,
      1,
      2,
      Number.POSITIVE_INFINITY
    ]) {
      let valid = false
      const selector = newRandomSelector(() => (valid ? 0 : invalid))
      expect(() => selector.select(background(), [selectorB, selectorA])).toThrow(TypeError)
      valid = true
      expect(selector.select(background(), [selectorB, selectorA])[0].instance.id).toBe("a")
    }

    const failure = new Error("random failed")
    let calls = 0
    const selector = newRandomSelector(() => {
      calls += 1
      if (calls === 1) throw failure
      return 0
    })
    expect(() => selector.select(background(), [selectorB, selectorA])).toThrow(failure)
    expect(selector.select(background(), [selectorB, selectorA])[0].instance.id).toBe("a")
  })

  test("rejects cancellation and empty snapshots before reading randomness", () => {
    let calls = 0
    const selector = newRandomSelector(() => {
      calls += 1
      return 0
    })
    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("selection canceled")
    cancel(failure)

    expect(() => selector.select(ctx, [selectorA])).toThrow(failure)
    expect(() => selector.select(background(), [])).toThrow("no service endpoint is available")
    expect(calls).toBe(0)
  })
})

describe("weighted round-robin endpoint selector", () => {
  test("emits exact consecutive 5:1 slots in stable endpoint order", () => {
    let calls = 0
    const selector = newWeightedRoundRobinSelector((endpoint) => {
      calls += 1
      return endpoint.instance.id === "a" ? 5 : 1
    })
    const selected: string[] = []

    for (let index = 0; index < 6; index += 1) {
      selected.push(selector.select(background(), [selectorB, selectorA])[0].instance.id)
    }

    expect(selected).toEqual(["a", "a", "a", "a", "a", "b"])
    expect(calls).toBe(12)
  })

  test("retains a surviving endpoint slot across membership changes", () => {
    const selector = newWeightedRoundRobinSelector((endpoint) =>
      endpoint.instance.id === "a" ? 5 : 1
    )
    const selected: string[] = []

    for (let index = 0; index < 3; index += 1) {
      selected.push(selector.select(background(), [selectorB, selectorA])[0].instance.id)
    }
    for (let index = 0; index < 3; index += 1) {
      selected.push(selector.select(background(), [selectorC, selectorA])[0].instance.id)
    }
    selected.push(selector.select(background(), [selectorB, selectorA])[0].instance.id)

    expect(selected).toEqual(["a", "a", "a", "a", "a", "c", "a"])
  })

  test("validates every weight before atomically advancing its slot", () => {
    let throwing = false
    const failure = new Error("weight failed")
    const selector = newWeightedRoundRobinSelector((endpoint) => {
      if (throwing && endpoint.instance.id === "b") throw failure
      return endpoint.instance.id === "a" ? 2 : 1
    })

    expect(selector.select(background(), [selectorB, selectorA])[0].instance.id).toBe("a")
    throwing = true
    expect(() => selector.select(background(), [selectorB, selectorA])).toThrow(failure)
    throwing = false
    expect(selector.select(background(), [selectorB, selectorA])[0].instance.id).toBe("a")
    expect(selector.select(background(), [selectorB, selectorA])[0].instance.id).toBe("b")

    for (const invalid of [
      Number.NEGATIVE_INFINITY,
      -1,
      0,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
      Number.POSITIVE_INFINITY
    ]) {
      let valid = false
      const invalidSelector = newWeightedRoundRobinSelector((endpoint) =>
        endpoint.instance.id === "a" || valid ? 1 : invalid
      )
      expect(() => invalidSelector.select(background(), [selectorB, selectorA])).toThrow(TypeError)
      valid = true
      expect(invalidSelector.select(background(), [selectorB, selectorA])[0].instance.id).toBe("a")
    }

    const maximum = newWeightedRoundRobinSelector(() => Number.MAX_SAFE_INTEGER)
    expect(maximum.select(background(), [selectorA])[0].instance.id).toBe("a")
  })

  test("rejects invalid construction and terminal inputs before reading weights", () => {
    expect(() => newWeightedRoundRobinSelector(null as never)).toThrow(TypeError)
    let calls = 0
    const selector = newWeightedRoundRobinSelector(() => {
      calls += 1
      return 1
    })
    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("selection canceled")
    cancel(failure)

    expect(() => selector.select(ctx, [selectorA])).toThrow(failure)
    expect(() => selector.select(background(), [])).toThrow("no service endpoint is available")
    expect(calls).toBe(0)
  })

  test("bounds cursor domains with deterministic oldest eviction", () => {
    const selector = newWeightedRoundRobinSelector(() => 1)
    expect(selector.select(background(), [selectorA, selectorB])[0].instance.id).toBe("a")
    for (let index = 0; index < 1_024; index += 1) {
      selector.select(background(), [
        {
          id: `weighted-${index}`,
          name: `weighted-${index}`,
          version: "v1",
          endpoints: [`https://weighted-${index}.test/`],
          metadata: {}
        }
      ])
    }

    expect(selector.select(background(), [selectorA, selectorB])[0].instance.id).toBe("a")
  })
})

describe("EWMA endpoint selector", () => {
  test("uses the standard clock with one endpoint and publishes frozen feedback", () => {
    const [endpoint, done] = newEWMASelector().select(background(), [selectorA])

    expect(endpoint.instance.id).toBe("a")
    expect(Object.isFrozen(done)).toBe(true)
    done(background(), { error: null })
  })

  test("preserves a cross-realm feedback error by identity", () => {
    const failure: Error = runInNewContext('new Error("foreign feedback failure")')
    let classified: unknown
    const selector = newEWMASelector({
      now: () => 0,
      isFailure(error) {
        classified = error
        return true
      }
    })
    const [, done] = selector.select(background(), [selectorA])

    done(background(), { error: failure })

    expect(classified).toBe(failure)
  })

  test("validates and snapshots options without executing callbacks at construction", () => {
    for (const options of [null, [], { random: null }, { now: null }, { isFailure: null }]) {
      expect(() => newEWMASelector(options as never)).toThrow(TypeError)
    }

    let randomReads = 0
    let nowReads = 0
    let classifierReads = 0
    let randomCalls = 0
    let nowCalls = 0
    let classifierCalls = 0
    const selector = newEWMASelector({
      get random() {
        randomReads += 1
        return () => {
          randomCalls += 1
          return 0
        }
      },
      get now() {
        nowReads += 1
        return () => {
          nowCalls += 1
          return 0
        }
      },
      get isFailure() {
        classifierReads += 1
        return () => {
          classifierCalls += 1
          return false
        }
      }
    })

    expect([randomReads, nowReads, classifierReads]).toEqual([1, 1, 1])
    expect([randomCalls, nowCalls, classifierCalls]).toEqual([0, 0, 0])
    const [, done] = selector.select(background(), [selectorA])
    done(background(), { error: new Error("application response") })
    expect([randomCalls, nowCalls, classifierCalls]).toEqual([0, 2, 1])
  })

  test("captures the default random source at construction", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Math, "random")
    if (descriptor === undefined) throw new Error("Math.random descriptor is missing")
    Object.defineProperty(Math, "random", { ...descriptor, value: () => 0 })
    const selector = newEWMASelector({ now: () => 0 })
    Object.defineProperty(Math, "random", { ...descriptor, value: () => 0.999_999 })
    try {
      expect(selector.select(background(), [selectorB, selectorA])[0].instance.id).toBe("b")
    } finally {
      Object.defineProperty(Math, "random", descriptor)
    }
  })

  test("learns latency and force-picks a stale sampled endpoint only after three seconds", () => {
    let time = 0
    const selector = newEWMASelector({ random: () => 0, now: () => time })

    const [slow, slowDone] = selector.select(background(), [selectorB, selectorA])
    expect(slow.instance.id).toBe("b")
    time = 100
    slowDone(background(), { error: null })

    const [fast, fastDone] = selector.select(background(), [selectorB, selectorA])
    expect(fast.instance.id).toBe("a")
    time = 101
    fastDone(background(), { error: null })

    time = 3_000
    const [boundary, boundaryDone] = selector.select(background(), [selectorB, selectorA])
    expect(boundary.instance.id).toBe("a")
    boundaryDone(background(), { error: null })

    time = 3_001
    const [forced, forcedDone] = selector.select(background(), [selectorB, selectorA])
    expect(forced.instance.id).toBe("b")
    forcedDone(background(), { error: null })
  })

  test("keeps last-pick time monotonic across a regressive clock reentry", () => {
    let phase: "outer" | "nested" | "later" = "outer"
    let nestedEndpoint = ""
    const nestedCompletions: SelectionDone[] = []
    let selector: ReturnType<typeof newEWMASelector>
    selector = newEWMASelector({
      random: () => 0,
      now() {
        if (phase === "outer") {
          phase = "nested"
          const [endpoint, done] = selector.select(background(), [selectorA])
          nestedEndpoint = endpoint.instance.id
          nestedCompletions.push(done)
          phase = "later"
          return 0
        }
        if (phase === "nested") return 100
        return 3_001
      }
    })

    const [outerEndpoint, outerDone] = selector.select(background(), [selectorA])
    const [nextEndpoint, nextDone] = selector.select(background(), [selectorA, selectorB])

    expect([nestedEndpoint, outerEndpoint.instance.id, nextEndpoint.instance.id]).toEqual([
      "a",
      "a",
      "b"
    ])
    const nestedDone = nestedCompletions[0]
    if (nestedDone === undefined) throw new Error("clock reentry did not complete")
    nestedDone(background(), { error: null })
    outerDone(background(), { error: null })
    nextDone(background(), { error: null })
  })

  test("keeps completion stamps monotonic when a custom clock regresses", () => {
    let time = 0
    const selector = newEWMASelector({ random: () => 0, now: () => time })

    const [, firstDone] = selector.select(background(), [selectorA])
    time = 200
    firstDone(background(), { error: null })

    const [, regressiveDone] = selector.select(background(), [selectorA])
    time = 100
    regressiveDone(background(), { error: null })

    time = 200
    const [, laterDone] = selector.select(background(), [selectorA])
    time = 300
    laterDone(background(), { error: null })

    time = 120
    const [comparison, comparisonDone] = selector.select(background(), [selectorA, selectorB])
    expect(comparison.instance.id).toBe("b")
    time = 300
    comparisonDone(background(), { error: null })

    time = 301
    const [selected, done] = selector.select(background(), [selectorA, selectorB])
    expect(selected.instance.id).toBe("b")
    done(background(), { error: null })
  })

  test("predicts majority slow in-flight work before choosing the healthier sample", () => {
    let time = 0
    const selector = newEWMASelector({ random: () => 0, now: () => time })

    const [, bDone] = selector.select(background(), [selectorB, selectorA])
    time = 10
    bDone(background(), { error: null })
    const [a, aDone] = selector.select(background(), [selectorB, selectorA])
    expect(a.instance.id).toBe("a")
    time = 20
    aDone(background(), { error: null })

    const [activeA, activeADone] = selector.select(background(), [selectorB, selectorA])
    expect(activeA.instance.id).toBe("a")
    time = 1_000
    const [healthy, healthyDone] = selector.select(background(), [selectorB, selectorA])
    expect(healthy.instance.id).toBe("b")
    activeADone(background(), { error: null })
    healthyDone(background(), { error: null })
  })

  test("classifies standard Web failures and lets an extension add application failures", () => {
    let time = 0
    let standardExtensionCalls = 0
    const standard = newEWMASelector({
      random: () => 0,
      now: () => time,
      isFailure() {
        standardExtensionCalls += 1
        throw new Error("standard failures must not reach the extension")
      }
    })
    const unavailable = Object.assign(new Error("unavailable"), { status: 503 })
    const ordinaryStatus = Object.assign(new Error("ordinary status"), { status: 400 })
    const aborted = new Error("aborted")
    aborted.name = "AbortError"
    const bunNetworkFailures = [
      Object.assign(new Error("connection closed"), { code: "ConnectionClosed" }),
      Object.assign(new Error("connection refused"), { code: "ConnectionRefused" }),
      Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
    ]

    const [, initialDone] = standard.select(background(), [selectorB, selectorA])
    time = 1
    initialDone(background(), { error: null })
    const [failed, failedDone] = standard.select(background(), [selectorB, selectorA])
    expect(failed.instance.id).toBe("a")
    time = 2
    failedDone(background(), { error: unavailable })
    const [healthy, healthyDone] = standard.select(background(), [selectorB, selectorA])
    expect(healthy.instance.id).toBe("b")
    healthyDone(background(), { error: null })
    for (const error of bunNetworkFailures) {
      const [, done] = standard.select(background(), [selectorA])
      time += 1
      done(background(), { error })
    }
    expect(standardExtensionCalls).toBe(0)

    const portableFailures = newEWMASelector({ now: () => time })
    for (const error of [
      aborted,
      new TypeError("fetch failed"),
      ordinaryStatus,
      new Error("application")
    ]) {
      const [, done] = portableFailures.select(background(), [selectorA])
      time += 1
      done(background(), { error })
    }

    const classified: Error[] = []
    let extendedTime = 0
    const extended = newEWMASelector({
      random: () => 0,
      now: () => extendedTime,
      isFailure(error) {
        classified.push(error)
        return true
      }
    })
    const application = new Error("application failure")
    const [, extendedInitialDone] = extended.select(background(), [selectorB, selectorA])
    extendedTime = 1
    extendedInitialDone(background(), { error: null })
    const [, applicationDone] = extended.select(background(), [selectorB, selectorA])
    extendedTime = 2
    const replyMetadata: Metadata = Object.freeze({
      node: Object.freeze(["orders-a"])
    })
    applicationDone(background(), {
      error: application,
      replyMetadata,
      bytesSent: true,
      bytesReceived: true
    })
    const [extendedHealthy, extendedHealthyDone] = extended.select(background(), [
      selectorB,
      selectorA
    ])
    expect(extendedHealthy.instance.id).toBe("b")
    extendedHealthyDone(background(), { error: null })
    expect(classified).toEqual([application])

    const extensionFailure = new Error("application classifier failed")
    const hostile = newEWMASelector({
      now: () => extendedTime,
      isFailure() {
        throw extensionFailure
      }
    })
    const [, hostileDone] = hostile.select(background(), [selectorA])
    expect(() => hostileDone(background(), { error: application })).toThrow(extensionFailure)
  })

  test("keeps invalid completion callbacks atomic, retryable, and idempotent", () => {
    const clock = [0, Number.NaN, 10, 10, 10, 10]
    let clockCalls = 0
    let validClassifier = false
    const selector = newEWMASelector({
      now: () => {
        const value = clock[clockCalls]
        clockCalls += 1
        if (value === undefined) throw new Error("clock sample is missing")
        return value
      },
      isFailure() {
        return validClassifier ? true : ("invalid" as never)
      }
    })
    const [, done] = selector.select(background(), [selectorA])

    expect(() => done(background(), null as never)).toThrow(TypeError)
    expect(() => done(background(), { error: "invalid" } as never)).toThrow(TypeError)
    expect(() => done(background(), { error: new Error("failure") })).toThrow(TypeError)
    expect(() => done(background(), { error: new Error("failure") })).toThrow(TypeError)
    validClassifier = true
    done(background(), { error: new Error("failure") })

    const hostile: Context = {
      deadline() {
        throw new Error("completed callback read Context.deadline")
      },
      done() {
        throw new Error("completed callback read Context.done")
      },
      err() {
        throw new Error("completed callback read Context.err")
      },
      value() {
        throw new Error("completed callback read Context.value")
      }
    }
    expect(() => done(hostile, { error: null })).not.toThrow()
  })

  test("blocks synchronous completion reentry before reading external callbacks twice", () => {
    let time = 0
    let clockCalls = 0
    let classifierCalls = 0
    let reentered = false
    let done: SelectionDone | null = null
    const selector = newEWMASelector({
      now() {
        clockCalls += 1
        return time
      },
      isFailure() {
        classifierCalls += 1
        if (!reentered) {
          reentered = true
          done?.(background(), { error: null })
        }
        return true
      }
    })
    const selected = selector.select(background(), [selectorA])
    done = selected[1]
    time = 1
    done(background(), { error: new Error("application failure") })

    expect(clockCalls).toBe(2)
    expect(classifierCalls).toBe(1)
  })

  test("serializes different same-endpoint completions across classifier reentry", () => {
    function selectedAfterCompletions(reentrant: boolean): string {
      let time = 0
      let inner: SelectionDone | null = null
      const selector = newEWMASelector({
        random: () => 0,
        now: () => time,
        isFailure() {
          if (reentrant && inner !== null) {
            const current = inner
            inner = null
            time = 6_700
            current(background(), { error: null })
          }
          return true
        }
      })

      let selection = selector.select(background(), [selectorB, selectorA])
      expect(selection[0].instance.id).toBe("b")
      time = 1_000
      selection[1](background(), { error: null })

      selection = selector.select(background(), [selectorB, selectorA])
      expect(selection[0].instance.id).toBe("a")
      time = 1_001
      selection[1](background(), { error: null })

      time = 6_000
      selection = selector.select(background(), [selectorB, selectorA])
      expect(selection[0].instance.id).toBe("b")
      time = 6_500
      selection[1](background(), { error: null })

      const outer = selector.select(background(), [selectorB, selectorA])
      const nested = selector.select(background(), [selectorB, selectorA])
      expect([outer[0].instance.id, nested[0].instance.id]).toEqual(["a", "a"])
      inner = nested[1]
      time = 6_600
      outer[1](background(), { error: new Error("endpoint failure") })
      if (!reentrant) {
        time = 6_700
        inner(background(), { error: null })
        inner = null
      }

      time = 6_701
      return selector.select(background(), [selectorB, selectorA])[0].instance.id
    }

    expect(selectedAfterCompletions(false)).toBe("b")
    expect(selectedAfterCompletions(true)).toBe("b")
  })

  test("drains a legal nested completion while leaving a failed outer completion retryable", () => {
    const classifierFailure = new Error("classifier failed after nested completion")
    let time = 0
    let clockCalls = 0
    let classifierCalls = 0
    let nested = false
    let rejectClassifier = true
    let inner: SelectionDone | null = null
    const selector = newEWMASelector({
      now() {
        clockCalls += 1
        return time
      },
      isFailure() {
        classifierCalls += 1
        if (!nested && inner !== null) {
          nested = true
          time = 2
          inner(background(), { error: null })
        }
        if (rejectClassifier) {
          rejectClassifier = false
          throw classifierFailure
        }
        return true
      }
    })
    const outer = selector.select(background(), [selectorA])[1]
    inner = selector.select(background(), [selectorA])[1]

    time = 1
    expect(() => outer(background(), { error: new Error("endpoint failure") })).toThrow(
      classifierFailure
    )
    expect([clockCalls, classifierCalls]).toEqual([4, 1])

    inner(background(), { error: null })
    expect(clockCalls).toBe(4)
    time = 3
    outer(background(), { error: new Error("endpoint failure") })
    expect([clockCalls, classifierCalls]).toEqual([5, 2])
    outer(background(), { error: null })
    inner(background(), { error: null })
    expect([clockCalls, classifierCalls]).toEqual([5, 2])
  })

  test("reports every queued completion failure and leaves both observations retryable", () => {
    const outerFailure = new Error("outer classifier failed")
    const innerFailure = new Error("inner classifier failed")
    let classifierCalls = 0
    let inner: SelectionDone | null = null
    const selector = newEWMASelector({
      now: () => 0,
      isFailure() {
        classifierCalls += 1
        if (classifierCalls === 1 && inner !== null) {
          inner(background(), { error: new Error("nested endpoint failure") })
          throw outerFailure
        }
        if (classifierCalls === 2) throw innerFailure
        return true
      }
    })
    const outer = selector.select(background(), [selectorA])[1]
    inner = selector.select(background(), [selectorA])[1]

    let failure: unknown = null
    try {
      outer(background(), { error: new Error("endpoint failure") })
    } catch (value) {
      failure = value
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([outerFailure, innerFailure])

    outer(background(), { error: new Error("endpoint failure") })
    inner(background(), { error: new Error("nested endpoint failure") })
    expect(classifierCalls).toBe(4)
  })

  test("observes a rejected asynchronous classifier result before failing closed", async () => {
    const classifierFailure = new Error("async classifier rejected")
    const selector = newEWMASelector({
      now: () => 0,
      isFailure: () => Promise.reject(classifierFailure) as never
    })
    const [, done] = selector.select(background(), [selectorA])

    expect(() => done(background(), { error: new Error("application failure") })).toThrow(TypeError)
    await Promise.resolve()
    await Promise.resolve()
  })

  test("observes rejected callback and option thenables across selector policies", async () => {
    const accessorFailure = new Error("then accessor failed")
    const invocationFailure = new Error("then invocation failed")
    const hostileResult = Object.defineProperty({}, "then", {
      get(): never {
        throw accessorFailure
      }
    })
    const hostileThenable = {
      then(): never {
        throw invocationFailure
      }
    }
    const hostileOptions = Object.defineProperty({}, "then", {
      get(): never {
        throw accessorFailure
      }
    })

    expect(() =>
      newEWMASelector({ now: () => hostileResult as never }).select(background(), [selectorA])
    ).toThrow(TypeError)
    expect(() =>
      newEWMASelector({ now: () => hostileThenable as never }).select(background(), [selectorA])
    ).toThrow(TypeError)
    expect(() => newEWMASelector(hostileOptions as never)).toThrow(TypeError)

    expect(() =>
      newEWMASelector({
        now: () => Promise.reject(new Error("clock rejected")) as never
      }).select(background(), [selectorA])
    ).toThrow(TypeError)

    expect(() =>
      newEWMASelector({
        random: () => Promise.reject(new Error("random rejected")) as never,
        now: () => 0
      }).select(background(), [selectorB, selectorA])
    ).toThrow(TypeError)

    expect(() =>
      newWeightedRoundRobinSelector(
        () => Promise.reject(new Error("weight rejected")) as never
      ).select(background(), [selectorA])
    ).toThrow(TypeError)

    expect(() =>
      newEWMASelector({
        isFailure: Promise.reject(new Error("option rejected")) as never
      })
    ).toThrow(TypeError)

    expect(() =>
      newP2CSelector({
        failureThreshold: Promise.reject(new Error("integer option rejected")) as never
      })
    ).toThrow(TypeError)

    expect(() =>
      newEWMASelector(Promise.reject(new Error("EWMA options rejected")) as never)
    ).toThrow(TypeError)
    expect(() =>
      newP2CSelector(Promise.reject(new Error("P2C options rejected")) as never)
    ).toThrow(TypeError)

    await Promise.resolve()
    await Promise.resolve()
  })

  test("observes every returned or thrown thenable at synchronous selector boundaries", async () => {
    function rejected(message: string): Promise<never> {
      return Promise.reject(new Error(message))
    }

    function thenableError(message: string): Error {
      const failure = new Error(message)
      const rejection = rejected(`${message} settlement`)
      return Object.defineProperty(failure, "then", { value: rejection.then.bind(rejection) })
    }

    function thenableCallback(message: string): () => number {
      const callback = () => 0
      return Object.defineProperty(callback, "then", { value: rejected(message) })
    }

    function thenableArray(message: string): unknown[] {
      return Object.defineProperty([], "then", { value: rejected(message) })
    }

    function freshDone(): SelectionDone {
      return newEWMASelector({ now: () => 0 }).select(background(), [selectorA])[1]
    }

    function structuralContext(read: () => unknown): Context {
      return {
        deadline() {
          return background().deadline()
        },
        done() {
          return null
        },
        err: read as Context["err"],
        value() {
          return null
        }
      }
    }

    expect(() =>
      freshDone()(
        background(),
        Object.defineProperty(Promise.reject(new Error("outcome carrier rejected")), "error", {
          value: null
        }) as never
      )
    ).toThrow(TypeError)

    expect(() =>
      freshDone()(background(), thenableCallback("callable outcome carrier rejected") as never)
    ).toThrow(TypeError)
    expect(() =>
      freshDone()(background(), thenableArray("array outcome carrier rejected") as never)
    ).toThrow(TypeError)

    expect(() =>
      newEWMASelector(thenableCallback("callable EWMA options rejected") as never)
    ).toThrow(TypeError)
    expect(() => newEWMASelector(thenableArray("array EWMA options rejected") as never)).toThrow(
      TypeError
    )
    expect(() =>
      newP2CSelector(thenableCallback("callable P2C options rejected") as never)
    ).toThrow(TypeError)
    expect(() => newP2CSelector(thenableArray("array P2C options rejected") as never)).toThrow(
      TypeError
    )

    expect(() =>
      newRandomSelector(thenableCallback("direct random callback rejected") as never)
    ).toThrow(TypeError)
    expect(() =>
      newWeightedRoundRobinSelector(thenableCallback("direct weight callback rejected") as never)
    ).toThrow(TypeError)
    for (const name of ["random", "now", "isFailure"]) {
      const options = Object.defineProperty({}, name, {
        value: thenableCallback(`EWMA ${name} callback rejected`)
      })
      let failure: unknown = null
      try {
        newEWMASelector(options)
      } catch (value) {
        failure = value
      }
      expect(failure).toBeInstanceOf(TypeError)
    }
    for (const name of ["random", "now"]) {
      const options = Object.defineProperty({}, name, {
        value: thenableCallback(`P2C ${name} callback rejected`)
      })
      let failure: unknown = null
      try {
        newP2CSelector(options)
      } catch (value) {
        failure = value
      }
      expect(failure).toBeInstanceOf(TypeError)
    }

    const returnedError = Object.defineProperty({}, "error", {
      get() {
        return rejected("outcome error returned a Promise")
      }
    })
    expect(() => freshDone()(background(), returnedError as never)).toThrow(TypeError)
    expect(() =>
      freshDone()(background(), { error: thenableError("outcome Error was thenable") })
    ).toThrow(TypeError)

    const thrownError = Object.defineProperty({}, "error", {
      get(): never {
        throw rejected("outcome error threw a Promise")
      }
    })
    expect(() => freshDone()(background(), thrownError as never)).toThrow(TypeError)

    const hostileThenGetter = Object.defineProperty({ error: null }, "then", {
      get(): never {
        throw rejected("outcome then getter threw a Promise")
      }
    })
    expect(() => freshDone()(background(), hostileThenGetter)).toThrow(TypeError)

    const hostileThenCall = {
      error: null,
      then(): never {
        throw rejected("outcome then call threw a Promise")
      }
    }
    expect(() => freshDone()(background(), hostileThenCall)).toThrow(TypeError)

    const hostileThenContinuation = {
      error: null,
      then() {
        return rejected("outcome then continuation rejected")
      }
    }
    expect(() => freshDone()(background(), hostileThenContinuation)).toThrow(TypeError)

    const nestedGetterFailure = Object.defineProperty({}, "then", {
      get(): never {
        throw new Error("nested then getter failed")
      }
    })
    const nestedCallFailure = {
      then(): never {
        throw new Error("nested then call failed")
      }
    }
    for (const failure of [nestedGetterFailure, nestedCallFailure]) {
      const nestedHostileCarrier = Object.defineProperty({ error: null }, "then", {
        get(): never {
          throw failure
        }
      })
      expect(() => freshDone()(background(), nestedHostileCarrier)).toThrow(TypeError)
    }

    const rejectedNestedGetter = Object.defineProperty({}, "then", {
      get(): never {
        throw rejected("nested then getter threw a rejected Promise")
      }
    })
    const rejectedGetterCarrier = Object.defineProperty({ error: null }, "then", {
      get(): never {
        throw rejectedNestedGetter
      }
    })
    expect(() => freshDone()(background(), rejectedGetterCarrier)).toThrow(TypeError)

    const rejectedNestedCall = {
      then(): never {
        throw rejected("nested then call threw a rejected Promise")
      }
    }
    const rejectedCallCarrier = {
      error: null,
      then(): never {
        throw rejectedNestedCall
      }
    }
    expect(() => freshDone()(background(), rejectedCallCarrier)).toThrow(TypeError)

    const proxyFailure = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw rejected("thenable prototype inspection threw a rejected Promise")
        }
      }
    )
    const rejectedProxyCarrier = Object.defineProperty({ error: null }, "then", {
      get(): never {
        throw proxyFailure
      }
    })
    expect(() => freshDone()(background(), rejectedProxyCarrier)).toThrow(TypeError)

    const hostilePromiseConstructor = Promise.resolve()
    Object.defineProperty(hostilePromiseConstructor, "constructor", {
      get(): never {
        throw rejected("Promise continuation construction threw a rejected Promise")
      }
    })
    const hostilePromiseCarrier = Object.defineProperty({ error: null }, "then", {
      get(): never {
        throw hostilePromiseConstructor
      }
    })
    expect(() => freshDone()(background(), hostilePromiseCarrier)).toThrow(TypeError)

    const selfReferential = {
      error: null,
      then(): unknown {
        return selfReferential
      }
    }
    expect(() => freshDone()(background(), selfReferential)).toThrow(TypeError)

    const firstCycle: { error: null; then(): unknown } = {
      error: null,
      then(): unknown {
        return secondCycle
      }
    }
    const secondCycle = {
      then(): unknown {
        return firstCycle
      }
    }
    expect(() => freshDone()(background(), firstCycle)).toThrow(TypeError)

    let generatedThenables = 0
    function generatedThenable(): { then(): unknown } {
      generatedThenables += 1
      return { then: generatedThenable }
    }
    const boundedCarrier = { error: null, then: generatedThenable }
    expect(() => freshDone()(background(), boundedCarrier)).toThrow(TypeError)
    expect(generatedThenables).toBe(64)

    const nativePromises: Promise<never>[] = []
    const nativeRejectors: ((reason: unknown) => void)[] = []
    for (let index = 0; index < 64; index += 1) {
      nativePromises.push(
        new Promise<never>((_resolve, reject) => {
          nativeRejectors.push(reject)
        })
      )
    }
    const nativeCarrier = nativePromises[0]
    if (nativeCarrier === undefined) throw new Error("native rejection chain is empty")
    const boundedNativeCarrier = Object.defineProperty(nativeCarrier, "error", { value: null })
    let boundedNativeFailure: unknown = null
    try {
      freshDone()(background(), boundedNativeCarrier as never)
    } catch (failure) {
      boundedNativeFailure = failure
    }
    expect(boundedNativeFailure).toBeInstanceOf(TypeError)
    for (let index = 0; index < nativeRejectors.length - 1; index += 1) {
      const reject = nativeRejectors[index]
      const nested = nativePromises[index + 1]
      if (reject === undefined || nested === undefined) {
        throw new Error("native rejection chain is incomplete")
      }
      reject(nested)
      await flush()
    }
    const terminalReject = nativeRejectors.at(-1)
    if (terminalReject === undefined) throw new Error("native rejection chain terminal is missing")
    terminalReject(new Error("native rejection chain terminal"))

    const asynchronouslyShapedCarrier = { error: null, then: Promise.resolve() }
    expect(() => freshDone()(background(), asynchronouslyShapedCarrier as never)).toThrow(TypeError)

    expect(() =>
      freshDone()(
        structuralContext(() => rejected("Context.err returned a Promise")),
        {
          error: null
        }
      )
    ).toThrow(TypeError)
    expect(() =>
      freshDone()(
        structuralContext(() => "invalid Context error"),
        { error: null }
      )
    ).toThrow(TypeError)
    expect(() =>
      freshDone()(
        structuralContext(() => thenableError("Context.err returned a thenable Error")),
        { error: null }
      )
    ).toThrow(TypeError)
    expect(() =>
      freshDone()(
        structuralContext(() => {
          throw rejected("Context.err threw a Promise")
        }),
        { error: null }
      )
    ).toThrow(TypeError)

    let causeReturnReads = 0
    const terminal = new Error("terminal Context")
    expect(() =>
      freshDone()(
        structuralContext(() => {
          causeReturnReads += 1
          return causeReturnReads === 1 ? terminal : rejected("Context cause returned a Promise")
        }),
        { error: null }
      )
    ).toThrow(TypeError)

    let thenableCauseReads = 0
    expect(() =>
      freshDone()(
        structuralContext(() => {
          thenableCauseReads += 1
          return thenableCauseReads === 1
            ? terminal
            : thenableError("Context cause returned a thenable Error")
        }),
        { error: null }
      )
    ).toThrow(TypeError)

    let invalidCauseReads = 0
    expect(() =>
      freshDone()(
        structuralContext(() => {
          invalidCauseReads += 1
          return invalidCauseReads === 1 ? terminal : "invalid Context cause"
        }),
        { error: null }
      )
    ).toThrow(TypeError)

    let causeThrowReads = 0
    expect(() =>
      freshDone()(
        structuralContext(() => {
          causeThrowReads += 1
          if (causeThrowReads === 1) return terminal
          throw rejected("Context cause threw a Promise")
        }),
        { error: null }
      )
    ).toThrow(TypeError)

    expect(() =>
      newEWMASelector({
        now: () => rejected("EWMA clock returned a Promise") as never
      }).select(background(), [selectorA])
    ).toThrow(TypeError)
    expect(() =>
      newP2CSelector({
        now(): never {
          throw rejected("P2C clock threw a Promise")
        }
      }).select(background(), [selectorA])
    ).toThrow(TypeError)
    expect(() =>
      newEWMASelector({
        random(): never {
          throw rejected("random threw a Promise")
        },
        now: () => 0
      }).select(background(), [selectorA, selectorB])
    ).toThrow(TypeError)
    expect(() =>
      newEWMASelector({
        now(): never {
          throw { then: Promise.resolve() }
        }
      }).select(background(), [selectorA])
    ).toThrow(TypeError)

    const classifierDone = newEWMASelector({
      now: () => 0,
      isFailure(): never {
        throw rejected("classifier threw a Promise")
      }
    }).select(background(), [selectorA])[1]
    expect(() => classifierDone(background(), { error: new Error("application") })).toThrow(
      TypeError
    )
    const shapedClassifierDone = newEWMASelector({
      now: () => 0,
      isFailure: () => ({ then: Promise.resolve() }) as never
    }).select(background(), [selectorA])[1]
    expect(() => shapedClassifierDone(background(), { error: new Error("application") })).toThrow(
      TypeError
    )

    const ewmaOptions = Object.defineProperty({}, "now", {
      get(): never {
        throw rejected("EWMA option getter threw a Promise")
      }
    })
    const p2cOptions = Object.defineProperty({}, "failureThreshold", {
      get(): never {
        throw rejected("P2C option getter threw a Promise")
      }
    })
    expect(() => newEWMASelector(ewmaOptions)).toThrow(TypeError)
    expect(() => newP2CSelector(p2cOptions)).toThrow(TypeError)

    const hostileName = Object.defineProperty(new Error("hostile name"), "name", {
      get() {
        return rejected("Error.name returned a Promise")
      }
    })
    const hostileStatus = Object.defineProperty(new Error("hostile status"), "status", {
      get() {
        return rejected("Error.status returned a Promise")
      }
    })
    const hostileCode = Object.defineProperty(new Error("hostile code"), "code", {
      get(): never {
        throw rejected("Error.code threw a Promise")
      }
    })
    const hostileReturnedCode = Object.defineProperty(new Error("hostile returned code"), "code", {
      get() {
        return rejected("Error.code returned a Promise")
      }
    })
    for (const error of [hostileName, hostileStatus, hostileCode, hostileReturnedCode]) {
      expect(() => freshDone()(background(), { error })).toThrow(TypeError)
    }
    for (const key of ["name", "status", "code"]) {
      const error = Object.defineProperty(new Error(`hostile thrown ${key}`), key, {
        get(): never {
          throw rejected(`Error.${key} threw a Promise`)
        }
      })
      expect(() => freshDone()(background(), { error })).toThrow(TypeError)
    }

    await flush(70)
  })

  test("validates each selector option before reading the next getter", async () => {
    let ewmaLaterReads = 0
    const ewmaOptions = {
      get random() {
        return Promise.reject(new Error("EWMA random option rejected"))
      },
      get now(): never {
        ewmaLaterReads += 1
        throw new Error("EWMA later getter must not be read")
      }
    }
    expect(() => newEWMASelector(ewmaOptions as never)).toThrow(TypeError)
    expect(ewmaLaterReads).toBe(0)

    let p2cLaterReads = 0
    const p2cOptions = {
      get failureThreshold() {
        return Promise.reject(new Error("P2C failureThreshold option rejected"))
      },
      get cooldownMs(): never {
        p2cLaterReads += 1
        throw new Error("P2C later getter must not be read")
      }
    }
    expect(() => newP2CSelector(p2cOptions as never)).toThrow(TypeError)
    expect(p2cLaterReads).toBe(0)

    for (const name of ["random", "now", "isFailure"]) {
      const options = Object.defineProperty({}, name, {
        get(): never {
          throw Promise.reject(new Error(`EWMA ${name} getter rejected`))
        }
      })
      expect(() => newEWMASelector(options)).toThrow(TypeError)
    }
    for (const name of ["random", "now", "failureThreshold", "cooldownMs"]) {
      const options = Object.defineProperty({}, name, {
        get(): never {
          throw Promise.reject(new Error(`P2C ${name} getter rejected`))
        }
      })
      expect(() => newP2CSelector(options)).toThrow(TypeError)
    }

    await flush()
  })

  test("keeps thrown-thenable EWMA and P2C queue failures atomic and retryable", async () => {
    function nestedGetterRejection(message: string): object {
      const nested = Object.defineProperty({}, "then", {
        get(): never {
          throw Promise.reject(new Error(`${message} settlement`))
        }
      })
      return {
        then(): never {
          throw nested
        }
      }
    }

    function nestedCallRejection(message: string): object {
      const nested = {
        then(): never {
          throw Promise.reject(new Error(`${message} settlement`))
        }
      }
      return {
        then(): never {
          throw nested
        }
      }
    }

    const endpointFailure = new Error("endpoint failure")
    const classifierFailures = [
      nestedGetterRejection("outer classifier rejected"),
      nestedCallRejection("inner classifier rejected")
    ]
    let classifierCalls = 0
    let innerEWMA: SelectionDone | null = null
    const ewma = newEWMASelector({
      now: () => 0,
      isFailure() {
        classifierCalls += 1
        if (classifierCalls === 1) innerEWMA?.(background(), { error: endpointFailure })
        const failure = classifierFailures[classifierCalls - 1]
        if (failure !== undefined) throw failure
        return true
      }
    })
    const outerEWMA = ewma.select(background(), [selectorA])[1]
    innerEWMA = ewma.select(background(), [selectorA])[1]

    let ewmaFailure: unknown = null
    try {
      outerEWMA(background(), { error: endpointFailure })
    } catch (failure) {
      ewmaFailure = failure
    }
    expect(ewmaFailure).toBeInstanceOf(AggregateError)
    expect((ewmaFailure as AggregateError).errors).toHaveLength(2)
    expect(
      (ewmaFailure as AggregateError).errors.every((error) => error instanceof TypeError)
    ).toBe(true)
    outerEWMA(background(), { error: endpointFailure })
    innerEWMA(background(), { error: endpointFailure })
    outerEWMA(background(), { error: endpointFailure })
    innerEWMA(background(), { error: endpointFailure })
    expect(classifierCalls).toBe(4)

    const clockFailures = [
      nestedGetterRejection("outer clock rejected"),
      nestedCallRejection("inner clock rejected")
    ]
    let completing = false
    let clockCalls = 0
    let innerP2C: SelectionDone | null = null
    const p2c = newP2CSelector({
      now() {
        if (!completing) return 0
        clockCalls += 1
        if (clockCalls === 1) innerP2C?.(background(), { error: endpointFailure })
        const failure = clockFailures[clockCalls - 1]
        if (failure !== undefined) throw failure
        return 0
      },
      failureThreshold: 1,
      cooldownMs: 10
    })
    const outerP2C = p2c.select(background(), [selectorA])[1]
    innerP2C = p2c.select(background(), [selectorA])[1]
    completing = true

    let p2cFailure: unknown = null
    try {
      outerP2C(background(), { error: endpointFailure })
    } catch (failure) {
      p2cFailure = failure
    }
    expect(p2cFailure).toBeInstanceOf(AggregateError)
    expect((p2cFailure as AggregateError).errors).toHaveLength(2)
    expect((p2cFailure as AggregateError).errors.every((error) => error instanceof TypeError)).toBe(
      true
    )
    outerP2C(background(), { error: endpointFailure })
    innerP2C(background(), { error: endpointFailure })
    outerP2C(background(), { error: endpointFailure })
    innerP2C(background(), { error: endpointFailure })
    expect(clockCalls).toBe(4)

    await flush()
  })

  test("rejects terminal and callback failures before retaining selector state", () => {
    let validRandom = false
    let validClock = false
    const randomFailure = new Error("random callback failed")
    const classifierFailure = new Error("classifier failed")
    const selector = newEWMASelector({
      random: () => {
        if (!validRandom) throw randomFailure
        return 0
      },
      now: () => (validClock ? 0 : Number.POSITIVE_INFINITY),
      isFailure() {
        throw classifierFailure
      }
    })
    const [ctx, cancel] = withCancelCause(background())
    const canceled = new Error("selection canceled")
    cancel(canceled)

    expect(() => selector.select(ctx, [selectorA])).toThrow(canceled)
    expect(() => selector.select(background(), [])).toThrow("no service endpoint is available")
    expect(() => selector.select(background(), [selectorB, selectorA])).toThrow(TypeError)
    validClock = true
    expect(() => selector.select(background(), [selectorB, selectorA])).toThrow(randomFailure)
    validRandom = true
    const [selected, done] = selector.select(background(), [selectorB, selectorA])
    expect(selected.instance.id).toBe("b")
    expect(() => done(background(), { error: new Error("failure") })).toThrow(classifierFailure)

    const [doneCtx, cancelDone] = withCancelCause(background())
    const doneFailure = new Error("feedback canceled")
    cancelDone(doneFailure)
    expect(() => done(doneCtx, { error: null })).toThrow(doneFailure)
  })

  test("bounds observation slots and service-domain state without timers", () => {
    const selector = newEWMASelector({ random: () => 0, now: () => 0 })
    const pending = []
    for (let index = 0; index < 201; index += 1) {
      pending.push(selector.select(background(), [selectorA])[1])
    }
    for (const done of pending) done(background(), { error: null })

    const [first, firstDone] = selector.select(background(), [selectorA, selectorB])
    expect(first.instance.id).toBe("b")
    firstDone(background(), { error: null })
    for (let index = 0; index < 1_024; index += 1) {
      const [, done] = selector.select(background(), [
        {
          id: `ewma-${index}`,
          name: `ewma-${index}`,
          version: "v1",
          endpoints: [`https://ewma-${index}.test/`],
          metadata: {}
        }
      ])
      done(background(), { error: null })
    }

    const [evicted, evictedDone] = selector.select(background(), [selectorA, selectorB])
    expect(evicted.instance.id).toBe("b")
    evictedDone(background(), { error: null })
  })
})

describe("power-of-two-choices endpoint selector", () => {
  test("uses the standard clock when all options are omitted", () => {
    const [endpoint, done] = newP2CSelector().select(background(), [selectorA])

    expect(endpoint.instance.id).toBe("a")
    done(background(), { error: null })
  })

  test("validates and snapshots options without executing callbacks at construction", () => {
    for (const options of [
      null,
      [],
      { random: null },
      { now: null },
      { failureThreshold: 0 },
      { failureThreshold: 1.5 },
      { failureThreshold: 1_001 },
      { cooldownMs: 0 },
      { cooldownMs: 1.5 },
      { cooldownMs: 2_147_483_648 }
    ]) {
      expect(() => newP2CSelector(options as never)).toThrow(TypeError)
    }

    let randomReads = 0
    let nowReads = 0
    let randomCalls = 0
    let nowCalls = 0
    const selector = newP2CSelector({
      get random() {
        randomReads += 1
        return () => {
          randomCalls += 1
          return 0
        }
      },
      get now() {
        nowReads += 1
        return () => {
          nowCalls += 1
          return 0
        }
      },
      failureThreshold: 1,
      cooldownMs: 1
    })

    expect(randomReads).toBe(1)
    expect(nowReads).toBe(1)
    expect(randomCalls).toBe(0)
    expect(nowCalls).toBe(0)
    const [, done] = selector.select(background(), [selectorA])
    done(background(), { error: null })
    expect(randomCalls).toBe(0)
    expect(nowCalls).toBe(1)
  })

  test("captures the default Math.random source at construction", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Math, "random")
    if (descriptor === undefined) throw new Error("Math.random descriptor is missing")
    Object.defineProperty(Math, "random", { ...descriptor, value: () => 0 })
    const selector = newP2CSelector({ now: () => 0 })
    Object.defineProperty(Math, "random", { ...descriptor, value: () => 0.999_999 })
    try {
      expect(selector.select(background(), [selectorB, selectorA])[0].instance.id).toBe("a")
    } finally {
      Object.defineProperty(Math, "random", descriptor)
    }
  })

  test("shares a fresh domain across clock and random callback reentry", () => {
    let clockReentered = false
    let clockInnerEndpoint = ""
    const clockInnerCompletions: SelectionDone[] = []
    let clockSelector: ReturnType<typeof newP2CSelector>
    clockSelector = newP2CSelector({
      random: () => 0,
      now() {
        if (!clockReentered) {
          clockReentered = true
          const [endpoint, done] = clockSelector.select(background(), [selectorA, selectorB])
          clockInnerEndpoint = endpoint.instance.id
          clockInnerCompletions.push(done)
        }
        return 0
      }
    })

    const [clockOuterEndpoint, clockOuterDone] = clockSelector.select(background(), [
      selectorA,
      selectorB
    ])
    expect(clockInnerEndpoint).toBe("a")
    expect(clockOuterEndpoint.instance.id).toBe("b")
    const completeClockInner = clockInnerCompletions[0]
    if (completeClockInner === undefined) throw new Error("clock reentry did not complete")
    completeClockInner(background(), { error: null })
    clockOuterDone(background(), { error: null })

    let randomReentered = false
    let randomInnerEndpoint = ""
    const randomInnerCompletions: SelectionDone[] = []
    let randomSelector: ReturnType<typeof newP2CSelector>
    randomSelector = newP2CSelector({
      random() {
        if (!randomReentered) {
          randomReentered = true
          const [endpoint, done] = randomSelector.select(background(), [selectorA, selectorB])
          randomInnerEndpoint = endpoint.instance.id
          randomInnerCompletions.push(done)
        }
        return 0
      },
      now: () => 0
    })

    const [randomOuterEndpoint, randomOuterDone] = randomSelector.select(background(), [
      selectorA,
      selectorB
    ])
    expect(randomInnerEndpoint).toBe("a")
    expect(randomOuterEndpoint.instance.id).toBe("b")
    const completeRandomInner = randomInnerCompletions[0]
    if (completeRandomInner === undefined) throw new Error("random reentry did not complete")
    completeRandomInner(background(), { error: null })
    randomOuterDone(background(), { error: null })
  })

  test("revalidates cooldown eligibility after each random callback reentry", () => {
    let phase: "setup" | "outer" = "setup"
    let randomCalls = 0
    let initialDone: SelectionDone | null = null
    const selector = newP2CSelector({
      random() {
        randomCalls += 1
        if (phase === "outer" && initialDone !== null) {
          const done = initialDone
          initialDone = null
          done(background(), { error: new Error("endpoint failed during sampling") })
        }
        return 0
      },
      now: () => 0,
      failureThreshold: 1,
      cooldownMs: 100
    })

    const [initial, done] = selector.select(background(), [selectorA, selectorB])
    expect(initial.instance.id).toBe("a")
    initialDone = done

    phase = "outer"
    const [outer, outerDone] = selector.select(background(), [selectorA, selectorB])
    expect(outer.instance.id).toBe("b")
    expect(randomCalls).toBe(3)
    outerDone(background(), { error: null })
  })

  test("retains a committed reentrant selection when the outer clock throws", () => {
    const outerFailure = new Error("outer P2C clock failed")
    let firstClock = true
    const innerCompletions: SelectionDone[] = []
    let selector: ReturnType<typeof newP2CSelector>
    selector = newP2CSelector({
      random: () => 0,
      now() {
        if (firstClock) {
          firstClock = false
          const [, done] = selector.select(background(), [selectorA, selectorB])
          innerCompletions.push(done)
          throw outerFailure
        }
        return 0
      }
    })

    expect(() => selector.select(background(), [selectorA, selectorB])).toThrow(outerFailure)
    const [afterFailure, afterDone] = selector.select(background(), [selectorA, selectorB])
    expect(afterFailure.instance.id).toBe("b")
    const completeInner = innerCompletions[0]
    if (completeInner === undefined) throw new Error("clock reentry did not complete")
    completeInner(background(), { error: null })
    afterDone(background(), { error: null })
  })

  test("samples two distinct candidates and prefers lower in-flight load", () => {
    const samples = [0.5, 0.75, 0.5, 0.75, 0.8, 0.75]
    let randomCalls = 0
    let nowCalls = 0
    let clockAllowed = true
    const selector = newP2CSelector({
      random: () => {
        const sample = samples[randomCalls]
        randomCalls += 1
        if (sample === undefined) throw new Error("random sample is missing")
        return sample
      },
      now: () => {
        if (!clockAllowed) throw new Error("clock must not be read")
        nowCalls += 1
        return 0
      }
    })

    const [first, firstDone] = selector.select(background(), [selectorC, selectorA, selectorB])
    const [second, secondDone] = selector.select(background(), [selectorC, selectorA, selectorB])
    expect(first.instance.id).toBe("b")
    expect(second.instance.id).toBe("c")
    expect(Object.isFrozen(firstDone)).toBe(true)

    firstDone(background(), { error: null })
    const completedNowCalls = nowCalls
    clockAllowed = false
    const hostile: Context = {
      deadline() {
        throw new Error("completed callback read Context.deadline")
      },
      done() {
        throw new Error("completed callback read Context.done")
      },
      err() {
        throw new Error("completed callback read Context.err")
      },
      value() {
        throw new Error("completed callback read Context.value")
      }
    }
    expect(() => firstDone(hostile, { error: new Error("duplicate") })).not.toThrow()
    expect(nowCalls).toBe(completedNowCalls)

    clockAllowed = true
    secondDone(background(), { error: null })
    const [third, thirdDone] = selector.select(background(), [selectorC, selectorA, selectorB])
    expect(third.instance.id).toBe("c")
    expect(randomCalls).toBe(6)
    thirdDone(background(), { error: null })
  })

  test("uses default threshold and cooldown and resets eligibility at the exact boundary", () => {
    let time = 100
    let randomCalls = 0
    const selector = newP2CSelector({
      random: () => {
        randomCalls += 1
        return 0
      },
      now: () => time
    })

    for (let failure = 0; failure < 3; failure += 1) {
      const [endpoint, done] = selector.select(background(), [selectorB, selectorA])
      expect(endpoint.instance.id).toBe("a")
      const error = new Error(`failure-${failure}`)
      done(
        background(),
        failure === 0 ? { error, bytesSent: true, bytesReceived: false } : { error }
      )
    }

    time = 10_099
    const [duringCooldown, duringDone] = selector.select(background(), [selectorB, selectorA])
    expect(duringCooldown.instance.id).toBe("b")
    expect(randomCalls).toBe(6)
    duringDone(background(), { error: null })

    time = 10_100
    const [afterCooldown, afterDone] = selector.select(background(), [selectorB, selectorA])
    expect(afterCooldown.instance.id).toBe("a")
    expect(randomCalls).toBe(8)
    afterDone(background(), { error: null })
  })

  test("chooses the earliest recovery when all endpoints cool down without timers", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")
    if (descriptor === undefined || descriptor.configurable !== true) {
      throw new Error("setTimeout descriptor must be configurable")
    }
    let timerCalls = 0
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      enumerable: descriptor.enumerable === true,
      value: () => {
        timerCalls += 1
        throw new Error("selector must not start a timer")
      }
    })
    let time = 10
    let randomCalls = 0
    const selector = newP2CSelector({
      random: () => {
        randomCalls += 1
        return 0
      },
      now: () => time,
      failureThreshold: 1,
      cooldownMs: 100
    })

    try {
      const [first, firstDone] = selector.select(background(), [selectorB, selectorA])
      expect(first.instance.id).toBe("a")
      firstDone(background(), { error: new Error("a failed") })

      time = 20
      const [second, secondDone] = selector.select(background(), [selectorB, selectorA])
      expect(second.instance.id).toBe("b")
      secondDone(background(), { error: new Error("b failed") })

      time = 30
      const [earliest, earliestDone] = selector.select(background(), [selectorB, selectorA])
      expect(earliest.instance.id).toBe("a")
      expect(randomCalls).toBe(2)
      earliestDone(background(), { error: null })

      time = 40
      const [reset, resetDone] = selector.select(background(), [selectorB, selectorA])
      expect(reset.instance.id).toBe("a")
      expect(randomCalls).toBe(2)
      resetDone(background(), { error: null })
      expect(timerCalls).toBe(0)
    } finally {
      Object.defineProperty(globalThis, "setTimeout", descriptor)
    }
  })

  test("fails invalid random and selection clock callbacks atomically", () => {
    const randomSamples = [0, 1, 0, 0]
    let randomCalls = 0
    const invalidRandom = newP2CSelector({
      random: () => {
        const sample = randomSamples[randomCalls]
        randomCalls += 1
        if (sample === undefined) throw new Error("random sample is missing")
        return sample
      },
      now: () => 0
    })
    expect(() => invalidRandom.select(background(), [selectorB, selectorA])).toThrow(TypeError)
    expect(invalidRandom.select(background(), [selectorB, selectorA])[0].instance.id).toBe("a")

    let clockCalls = 0
    let selectionRandomCalls = 0
    const invalidClock = newP2CSelector({
      random: () => {
        selectionRandomCalls += 1
        return 0
      },
      now: () => {
        clockCalls += 1
        if (clockCalls === 1) return Number.NaN
        return 0
      }
    })
    expect(() => invalidClock.select(background(), [selectorB, selectorA])).toThrow(TypeError)
    expect(selectionRandomCalls).toBe(0)
    expect(invalidClock.select(background(), [selectorB, selectorA])[0].instance.id).toBe("a")

    const randomFailure = new Error("random callback failed")
    const clockFailure = new Error("clock callback failed")
    expect(() =>
      newP2CSelector({
        random: () => {
          throw randomFailure
        },
        now: () => 0
      }).select(background(), [selectorB, selectorA])
    ).toThrow(randomFailure)
    expect(() =>
      newP2CSelector({
        random: () => 0,
        now: () => {
          throw clockFailure
        }
      }).select(background(), [selectorB, selectorA])
    ).toThrow(clockFailure)
  })

  test("keeps a failed completion clock update atomic and retryable", () => {
    const clockValues = [0, Number.NaN, 0, 0]
    let clockCalls = 0
    const selector = newP2CSelector({
      random: () => 0,
      now: () => {
        const value = clockValues[clockCalls]
        clockCalls += 1
        if (value === undefined) throw new Error("clock sample is missing")
        return value
      },
      failureThreshold: 1,
      cooldownMs: 100
    })

    const [first, firstDone] = selector.select(background(), [selectorB, selectorA])
    expect(first.instance.id).toBe("a")
    expect(() => firstDone(background(), { error: new Error("failure") })).toThrow(TypeError)

    const [second, secondDone] = selector.select(background(), [selectorB, selectorA])
    expect(second.instance.id).toBe("b")
    firstDone(background(), { error: null })
    secondDone(background(), { error: null })

    const [third, thirdDone] = selector.select(background(), [selectorB, selectorA])
    expect(third.instance.id).toBe("a")
    thirdDone(background(), { error: null })
  })

  test("keeps a rejected P2C completion admission open for one later settlement", () => {
    let nowCalls = 0
    const selector = newP2CSelector({
      now() {
        nowCalls += 1
        return 0
      }
    })
    const [, done] = selector.select(background(), [selectorA])

    expect(() => done(background(), null as never)).toThrow(TypeError)
    expect(nowCalls).toBe(1)
    done(background(), { error: null })
    expect(nowCalls).toBe(1)
    done(background(), { error: null })
    expect(nowCalls).toBe(1)
  })

  test("blocks P2C completion clock reentry before decrementing in-flight twice", () => {
    let clockCalls = 0
    let reentered = false
    let done: SelectionDone | null = null
    const selector = newP2CSelector({
      random: () => 0,
      now() {
        clockCalls += 1
        if (done !== null && !reentered) {
          reentered = true
          done(background(), { error: null })
        }
        return 0
      },
      failureThreshold: 1,
      cooldownMs: 100
    })
    const selected = selector.select(background(), [selectorB, selectorA])
    done = selected[1]
    done(background(), { error: new Error("endpoint failed") })

    expect(clockCalls).toBe(2)
  })

  test("serializes different same-endpoint completions across clock reentry", () => {
    function selectedAfterCompletions(reentrant: boolean): string {
      let time = 0
      let completing = false
      let inner: SelectionDone | null = null
      const selector = newP2CSelector({
        random: () => 0,
        now() {
          if (reentrant && completing && inner !== null) {
            const current = inner
            inner = null
            current(background(), { error: null })
          }
          return time
        },
        failureThreshold: 1,
        cooldownMs: 10
      })
      const outer = selector.select(background(), [selectorA])[1]
      inner = selector.select(background(), [selectorA])[1]

      time = 10
      completing = true
      outer(background(), { error: new Error("endpoint failure") })
      completing = false
      if (!reentrant) {
        inner(background(), { error: null })
        inner = null
      }
      return selector.select(background(), [selectorA, selectorB])[0].instance.id
    }

    expect(selectedAfterCompletions(false)).toBe("a")
    expect(selectedAfterCompletions(true)).toBe("a")
  })

  test("drains a nested completion after a clock failure and retries the outer observation once", () => {
    const clockFailure = new Error("clock failed after nested completion")
    let time = 0
    let clockCalls = 0
    let completing = false
    let rejectClock = true
    let inner: SelectionDone | null = null
    const selector = newP2CSelector({
      random: () => 0,
      now() {
        clockCalls += 1
        if (completing && inner !== null) {
          const current = inner
          inner = null
          current(background(), { error: null })
        }
        if (completing && rejectClock) {
          rejectClock = false
          throw clockFailure
        }
        return time
      },
      failureThreshold: 1,
      cooldownMs: 10
    })
    const outer = selector.select(background(), [selectorA])[1]
    const nested = selector.select(background(), [selectorA])[1]
    inner = nested

    time = 10
    completing = true
    expect(() => outer(background(), { error: new Error("endpoint failure") })).toThrow(
      clockFailure
    )
    completing = false
    expect(clockCalls).toBe(3)

    nested(background(), { error: null })
    expect(clockCalls).toBe(3)
    time = 11
    outer(background(), { error: new Error("endpoint failure") })
    expect(clockCalls).toBe(4)
    outer(background(), { error: null })
    expect(clockCalls).toBe(4)

    time = 21
    expect(selector.select(background(), [selectorA, selectorB])[0].instance.id).toBe("a")
    expect(clockCalls).toBe(5)
  })

  test("does not read random with one eligible endpoint and honors terminal failures", () => {
    let randomCalls = 0
    let nowCalls = 0
    const selector = newP2CSelector({
      random: () => {
        randomCalls += 1
        return 0
      },
      now: () => {
        nowCalls += 1
        return 0
      }
    })
    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("selection canceled")
    cancel(failure)

    expect(() => selector.select(ctx, [selectorA])).toThrow(failure)
    expect(() => selector.select(background(), [])).toThrow("no service endpoint is available")
    expect(randomCalls).toBe(0)
    expect(nowCalls).toBe(0)

    const [, done] = selector.select(background(), [selectorA])
    done(background(), { error: null })
    expect(randomCalls).toBe(0)
    expect(nowCalls).toBe(1)
  })

  test("bounds service-domain state with deterministic oldest eviction", () => {
    const selector = newP2CSelector({ random: () => 0, now: () => 0 })
    const [first, firstDone] = selector.select(background(), [selectorA, selectorB])
    expect(first.instance.id).toBe("a")

    for (let index = 0; index < 1_024; index += 1) {
      const [, done] = selector.select(background(), [
        {
          id: `p2c-${index}`,
          name: `p2c-${index}`,
          version: "v1",
          endpoints: [`https://p2c-${index}.test/`],
          metadata: {}
        }
      ])
      done(background(), { error: null })
    }

    const [selected, done] = selector.select(background(), [selectorA, selectorB])
    expect(selected.instance.id).toBe("a")
    firstDone(background(), { error: null })
    done(background(), { error: null })
  })
})
