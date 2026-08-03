import type { CapturedRedisCacheOptions } from "../src/options"
import type { RedisConnection, RedisConnectionFactory } from "../src/connection"

/** Holds one deterministic fake Redis backend and lifecycle trace. */
export interface FakeRedisState {
  readonly values: Map<string, string>
  readonly signals: (AbortSignal | null)[]
  options: CapturedRedisCacheOptions | null
  connects: number
  closes: number
  destroys: number
  connectFailure: Error | null
  getFailure: Error | null
  putFailure: Error | null
  removeFailure: Error | null
  closeFailure: Error | null
  closeSynchronousFailure: Error | null
  destroyFailure: Error | null
  pendingGet: Promise<string | null> | null
}

/** Creates one isolated mutable fake Redis state. */
export function fakeRedisState(): FakeRedisState {
  return {
    values: new Map<string, string>(),
    signals: [],
    options: null,
    connects: 0,
    closes: 0,
    destroys: 0,
    connectFailure: null,
    getFailure: null,
    putFailure: null,
    removeFailure: null,
    closeFailure: null,
    closeSynchronousFailure: null,
    destroyFailure: null,
    pendingGet: null
  }
}

/** Creates one exact fake connection factory backed by the supplied state. */
export function fakeRedisFactory(state: FakeRedisState): RedisConnectionFactory {
  /** Creates the lifecycle-owned fake connection. */
  function factory(options: CapturedRedisCacheOptions): RedisConnection {
    state.options = options
    return Object.freeze({
      connect(): Promise<void> {
        state.connects += 1
        if (state.connectFailure !== null) return Promise.reject(state.connectFailure)
        return Promise.resolve()
      },
      async get(signal: AbortSignal | null, key: string): Promise<string | null> {
        state.signals.push(signal)
        if (state.getFailure !== null) throw state.getFailure
        if (state.pendingGet !== null) return await state.pendingGet
        return state.values.get(key) ?? null
      },
      async put(
        signal: AbortSignal | null,
        key: string,
        value: string,
        _expiresInMs: number | null
      ): Promise<void> {
        state.signals.push(signal)
        if (state.putFailure !== null) throw state.putFailure
        state.values.set(key, value)
      },
      async remove(signal: AbortSignal | null, key: string): Promise<number> {
        state.signals.push(signal)
        if (state.removeFailure !== null) throw state.removeFailure
        return state.values.delete(key) ? 1 : 0
      },
      close(): Promise<void> {
        state.closes += 1
        if (state.closeSynchronousFailure !== null) throw state.closeSynchronousFailure
        if (state.closeFailure !== null) return Promise.reject(state.closeFailure)
        return Promise.resolve()
      },
      destroy(): void {
        state.destroys += 1
        if (state.destroyFailure !== null) throw state.destroyFailure
      }
    })
  }
  return factory
}
