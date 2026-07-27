import type { Context } from "@likego/context"
import { newProbeRegistry } from "@likego/health"
import type { Handler } from "@likego/web"

import { newArrivalHandler } from "./http"

/** Captures one vehicle observation and its predicted arrival. */
export interface ArrivalPrediction {
  readonly stopId: string
  readonly vehicleId: string
  readonly arrivalAt: number
  readonly observedAt: number
}

export interface ArrivalQuery {
  readonly stopId: string
  readonly now: number
  readonly maxAgeMs: number
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
}

/** Validates one observed arrival prediction. */
export function validateArrivalPrediction(prediction: ArrivalPrediction): void {
  if (!validId(prediction.stopId)) throw new TypeError("invalid stopId")
  if (!validId(prediction.vehicleId)) throw new TypeError("invalid vehicleId")
  if (
    !Number.isSafeInteger(prediction.observedAt) ||
    prediction.observedAt < 0 ||
    !Number.isSafeInteger(prediction.arrivalAt) ||
    prediction.arrivalAt < prediction.observedAt
  ) {
    throw new RangeError("invalid prediction timestamps")
  }
}

/** Validates one bounded freshness query. */
export function validateArrivalQuery(query: ArrivalQuery): void {
  if (!validId(query.stopId)) throw new TypeError("invalid stopId")
  if (!Number.isSafeInteger(query.now) || query.now < 0) {
    throw new RangeError("invalid query time")
  }
  if (!Number.isSafeInteger(query.maxAgeMs) || query.maxAgeMs <= 0 || query.maxAgeMs > 86_400_000) {
    throw new RangeError("maxAgeMs is outside the supported range")
  }
}

/** Produces the stable content identity of one vehicle observation. */
export function arrivalFingerprint(prediction: ArrivalPrediction): string {
  return `${prediction.observedAt}\u0000${prediction.arrivalAt}`
}

export interface ArrivalRepository {
  save(ctx: Context, prediction: ArrivalPrediction): ArrivalPrediction
  listFresh(ctx: Context, query: ArrivalQuery): readonly ArrivalPrediction[]
  checkFeedFreshness(ctx: Context, now: number, maxAgeMs: number): void
}

function predictionKey(prediction: ArrivalPrediction): string {
  return `${prediction.stopId}\u0000${prediction.vehicleId}`
}

/** Creates an in-memory repository that keeps the latest vehicle observation. */
export function newMemoryArrivalRepository(): ArrivalRepository {
  const predictions = new Map<string, ArrivalPrediction>()

  return Object.freeze({
    save(ctx: Context, prediction: ArrivalPrediction): ArrivalPrediction {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const key = predictionKey(prediction)
      const current = predictions.get(key)
      if (current !== undefined) {
        if (prediction.observedAt < current.observedAt) {
          throw new Error("stale observation")
        }
        if (prediction.observedAt === current.observedAt) {
          if (arrivalFingerprint(prediction) !== arrivalFingerprint(current)) {
            throw new Error("observation identity conflict")
          }
          return current
        }
      }
      const saved: ArrivalPrediction = Object.freeze({
        stopId: prediction.stopId,
        vehicleId: prediction.vehicleId,
        arrivalAt: prediction.arrivalAt,
        observedAt: prediction.observedAt
      })
      predictions.set(key, saved)
      return saved
    },
    listFresh(ctx: Context, query: ArrivalQuery): readonly ArrivalPrediction[] {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const fresh: ArrivalPrediction[] = []
      for (const prediction of predictions.values()) {
        if (
          prediction.stopId === query.stopId &&
          prediction.observedAt <= query.now &&
          query.now - prediction.observedAt <= query.maxAgeMs
        ) {
          fresh.push(prediction)
        }
      }
      fresh.sort(function compareArrivals(left, right): number {
        const arrivalOrder = left.arrivalAt - right.arrivalAt
        return arrivalOrder !== 0 ? arrivalOrder : left.vehicleId.localeCompare(right.vehicleId)
      })
      return Object.freeze(fresh)
    },
    checkFeedFreshness(ctx: Context, now: number, maxAgeMs: number): void {
      const failure = ctx.err()
      if (failure !== null) throw failure
      if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("invalid probe time")
      if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
        throw new RangeError("invalid probe freshness window")
      }
      for (const prediction of predictions.values()) {
        if (prediction.observedAt <= now && now - prediction.observedAt <= maxAgeMs) {
          return
        }
      }
      throw new Error("arrival prediction feed is stale")
    }
  })
}

export type PublishArrival = (ctx: Context, prediction: ArrivalPrediction) => ArrivalPrediction

export type ListFreshArrivals = (ctx: Context, query: ArrivalQuery) => readonly ArrivalPrediction[]

/** Creates the latest-observation publication operation. */
export function newPublishArrival(repository: ArrivalRepository): PublishArrival {
  return function publishArrival(ctx: Context, prediction: ArrivalPrediction): ArrivalPrediction {
    validateArrivalPrediction(prediction)
    return repository.save(ctx, prediction)
  }
}

/** Creates the freshness-bounded arrival query. */
export function newListFreshArrivals(repository: ArrivalRepository): ListFreshArrivals {
  return function listFreshArrivals(
    ctx: Context,
    query: ArrivalQuery
  ): readonly ArrivalPrediction[] {
    validateArrivalQuery(query)
    return repository.listFresh(ctx, query)
  }
}

/** Composes arrival publication and queries as a standard Fetch handler. */
export function newHandler(): Handler {
  return newRuntime().handler
}

/** Composes arrival handling and prediction-feed freshness readiness. */
export function newRuntime(now: () => number = Date.now, readinessMaxAgeMs = 60_000) {
  const repository = newMemoryArrivalRepository()
  const probes = newProbeRegistry()
  probes.register("ready", "arrival_feed", function checkArrivalFeed(ctx): void {
    repository.checkFeedFreshness(ctx, now(), readinessMaxAgeMs)
  })
  return Object.freeze({
    handler: newArrivalHandler(newPublishArrival(repository), newListFreshArrivals(repository)),
    probes
  })
}
