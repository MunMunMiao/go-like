import { background, type Context } from "@likego/context"
import { type ServiceInstance } from "@likego/registry"
import { notifyRegistrationError, snapshotServiceInstance } from "@likego/registry/provider"

import type { ChangeBus } from "./changes"
import { decodeRecord, encodeRecord, type EncodedRecord } from "./codec"
import { boundaryError, isRetryable, newAuthenticationError } from "./errors"
import { clientOptions, type OperationOptions } from "./options"
import { contextFailure, ignoreFailure, operationLease } from "./runtime"
import { ensureParents, pruneServiceParent } from "./tree"
import type { ZookeeperClient } from "./types"

interface SessionState {
  readonly key: string
  readonly options: OperationOptions
  readonly active: Map<string, EncodedRecord>
  tail: Promise<void>
  client: ZookeeperClient | null
  unsubscribe: (() => void) | null
  recoveryEpoch: number
  recoveryTimer: ReturnType<typeof setTimeout> | null
  recoveryRetryMs: number
}

/** Owns private ZooKeeper sessions behind the provider-neutral Registrar API. */
export interface RegistrationManager {
  register(ctx: Context, instance: ServiceInstance, options: OperationOptions): Promise<void>
  deregister(ctx: Context, instance: ServiceInstance, options: OperationOptions): Promise<void>
}

/** Serializes one backend session mutation. */
function enqueue<T>(session: SessionState, operation: () => Promise<T>): Promise<T> {
  const result = session.tail.then(operation, operation)
  session.tail = result.then(
    function fulfilled(): void {},
    function rejected(): void {}
  )
  return result
}

/** Closes one owned client best effort within the normal provider operation timeout. */
async function closeClient(client: ZookeeperClient, timeoutMs: number): Promise<void> {
  const lease = operationLease(background(), null, timeoutMs)
  try {
    await client.close(lease.signal)
  } catch (value) {
    ignoreFailure(value)
  } finally {
    lease.release()
  }
}

/** Reports one private recovery failure without changing an already completed registration call. */
function report(options: OperationOptions, error: Error): void {
  try {
    options.common.logger?.log("warn", "ZooKeeper registration session recovery failed", {
      code: "code" in error ? error.code : undefined,
      name: error.name
    })
  } catch {
    // Borrowed diagnostic sinks cannot control provider state.
  }
}

/** Creates one registration manager with a private session per backend keyspace. */
export function newRegistrationManager(changes: ChangeBus): RegistrationManager {
  const sessions = new Map<string, SessionState>()

  /** Returns stable state for one exact ensemble and root. */
  function state(options: OperationOptions): SessionState {
    const key = JSON.stringify([options.connectionString, options.root])
    const found = sessions.get(key)
    if (found !== undefined) return found
    const created: SessionState = {
      key,
      options,
      active: new Map(),
      tail: Promise.resolve(),
      client: null,
      unsubscribe: null,
      recoveryEpoch: 0,
      recoveryTimer: null,
      recoveryRetryMs: options.retryInitialMs
    }
    sessions.set(key, created)
    return created
  }

  /** Runs one mutation on the current mapped session generation. */
  async function enqueueCurrent(
    options: OperationOptions,
    operation: (session: SessionState) => Promise<void>
  ): Promise<void> {
    while (true) {
      const session = state(options)
      const current = await enqueue(session, async function serialized(): Promise<boolean> {
        if (sessions.get(session.key) !== session) return false
        await operation(session)
        return true
      })
      if (current) return
    }
  }

  /** Detaches one resident state subscription. */
  function detach(session: SessionState): void {
    session.unsubscribe?.()
    session.unsubscribe = null
  }

  /** Cancels one scheduled recovery generation. */
  function stopRecovery(session: SessionState): void {
    session.recoveryEpoch += 1
    if (session.recoveryTimer !== null) clearTimeout(session.recoveryTimer)
    session.recoveryTimer = null
    session.recoveryRetryMs = session.options.retryInitialMs
  }

  /** Removes one empty session without erasing a later owner. */
  function forget(session: SessionState): void {
    if (sessions.get(session.key) === session) sessions.delete(session.key)
  }

  /** Invalidates every registration owned by one terminal session generation. */
  function failSession(session: SessionState, error: Error): ZookeeperClient | null {
    stopRecovery(session)
    detach(session)
    const client = session.client
    session.client = null
    const records = Array.from(session.active.values())
    session.active.clear()
    forget(session)
    for (const record of records) {
      notifyRegistrationError(session.options.common.onRegistrationError, error, record.instance)
    }
    return client
  }

  /** Schedules one bounded recovery attempt without retaining the mutation queue. */
  function scheduleRecovery(session: SessionState, epoch: number, delayMs: number): void {
    if (
      session.recoveryEpoch !== epoch ||
      session.active.size === 0 ||
      session.recoveryTimer !== null
    ) {
      return
    }
    const timer = setTimeout(function retry(): void {
      if (session.recoveryTimer !== timer || session.recoveryEpoch !== epoch) return
      session.recoveryTimer = null
      void enqueue(session, function queued(): Promise<void> {
        return recover(session, epoch)
      }).catch(ignoreFailure)
    }, delayMs)
    session.recoveryTimer = timer
  }

  /** Restores every current local instance after session expiration. */
  async function recover(session: SessionState, epoch: number): Promise<void> {
    if (session.recoveryEpoch !== epoch || session.active.size === 0 || session.client !== null) {
      return
    }
    const client = session.options.clientFactory(clientOptions(session.options))
    const lease = operationLease(background(), null, session.options.timeoutMs)
    try {
      await client.connect(lease.signal)
      for (const record of session.active.values()) {
        await ensureParents(client, session.options, record, lease.signal)
        await client.remove(record.path, lease.signal)
        await client.mutate(
          [{ kind: "create-ephemeral", path: record.path, data: record.data }],
          lease.signal
        )
      }
      session.client = client
      session.recoveryRetryMs = session.options.retryInitialMs
      attach(session, client)
      await changes.notify()
    } catch (value) {
      await closeClient(client, session.options.timeoutMs)
      const error = boundaryError(value, "ZooKeeper registration recovery failed")
      report(session.options, error)
      if (isRetryable(error)) {
        const delayMs = session.recoveryRetryMs
        session.recoveryRetryMs = Math.min(
          session.options.retryMaximumMs,
          session.recoveryRetryMs * 2
        )
        scheduleRecovery(session, epoch, delayMs)
      } else {
        failSession(session, error)
      }
    } finally {
      lease.release()
    }
  }

  /** Attaches expiration recovery to one exact current client. */
  function attach(session: SessionState, client: ZookeeperClient): void {
    detach(session)
    session.unsubscribe = client.onState(function changed(value): void {
      if (session.client !== client) return
      if (value === "expired") {
        detach(session)
        session.client = null
        const epoch = ++session.recoveryEpoch
        void closeClient(client, session.options.timeoutMs)
        scheduleRecovery(session, epoch, 0)
      } else if (value === "authentication-failed") {
        const error = newAuthenticationError()
        void enqueue(session, async function terminal(): Promise<void> {
          if (session.client !== client) return
          const failedClient = failSession(session, error)
          if (failedClient !== null) await closeClient(failedClient, session.options.timeoutMs)
        }).catch(ignoreFailure)
      }
    })
  }

  /** Opens the private registration session on first use. */
  async function activeClient(
    session: SessionState,
    signal: AbortSignal
  ): Promise<ZookeeperClient> {
    if (session.client !== null) return session.client
    stopRecovery(session)
    const client = session.options.clientFactory(clientOptions(session.options))
    try {
      await client.connect(signal)
      session.client = client
      attach(session, client)
      return client
    } catch (value) {
      await closeClient(client, session.options.timeoutMs)
      throw value
    }
  }

  /** Restores a previous local record after a failed replacement. */
  async function restore(
    client: ZookeeperClient,
    session: SessionState,
    previous: EncodedRecord
  ): Promise<void> {
    const lease = operationLease(background(), null, session.options.timeoutMs)
    try {
      await ensureParents(client, session.options, previous, lease.signal)
      await client.mutate(
        [
          { kind: "delete", path: previous.path },
          { kind: "create-ephemeral", path: previous.path, data: previous.data }
        ],
        lease.signal
      )
    } finally {
      lease.release()
    }
  }

  return Object.freeze({
    /** Registers or replaces one deterministic name/id ephemeral znode. */
    async register(ctx: Context, value: ServiceInstance, options: OperationOptions): Promise<void> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const record = encodeRecord(options.root, snapshotServiceInstance(value))
      await enqueueCurrent(options, async function serialized(session): Promise<void> {
        const lease = operationLease(ctx, null, session.options.timeoutMs)
        const previous = session.active.get(record.identity) ?? null
        let client: ZookeeperClient | null = null
        let committed = false
        try {
          client = await activeClient(session, lease.signal)
          await ensureParents(client, session.options, record, lease.signal)
          if (previous === null) {
            await client.remove(record.path, lease.signal)
            await client.mutate(
              [{ kind: "create-ephemeral", path: record.path, data: record.data }],
              lease.signal
            )
          } else {
            await client.mutate(
              [
                { kind: "delete", path: record.path },
                { kind: "create-ephemeral", path: record.path, data: record.data }
              ],
              lease.signal
            )
          }
          committed = true
          const decoded = decodeRecord(
            session.options.root,
            record.path,
            await client.data(record.path, lease.signal)
          )
          if (JSON.stringify(decoded.instance) !== JSON.stringify(record.instance)) {
            throw new Error("ZooKeeper registration readback differs from the committed instance")
          }
          const finalFailure = contextFailure(ctx)
          if (finalFailure !== null) throw finalFailure
          session.active.set(record.identity, record)
          await changes.notify()
        } catch (value) {
          const primary =
            contextFailure(ctx) ??
            boundaryError(value, "ZooKeeper registration rejected with a non-Error value")
          if (client !== null && committed) {
            try {
              await client.remove(record.path, lease.signal)
              if (previous !== null) await restore(client, session, previous)
            } catch (rollbackValue) {
              detach(session)
              if (session.client === client) session.client = null
              await closeClient(client, session.options.timeoutMs)
              const epoch = ++session.recoveryEpoch
              scheduleRecovery(session, epoch, 0)
              throw new AggregateError(
                [primary, boundaryError(rollbackValue, "ZooKeeper registration rollback failed")],
                "ZooKeeper registration failed and rollback failed"
              )
            }
          } else if (client !== null && previous !== null) {
            try {
              await restore(client, session, previous)
            } catch (restoreValue) {
              ignoreFailure(restoreValue)
            }
          }
          if (session.active.size === 0) {
            detach(session)
            if (session.client !== null) {
              const unused = session.client
              session.client = null
              await closeClient(unused, session.options.timeoutMs)
            }
            forget(session)
          }
          throw primary
        } finally {
          lease.release()
        }
      })
    },
    /** Deregisters one deterministic name/id path and retires the empty owner session. */
    async deregister(
      ctx: Context,
      value: ServiceInstance,
      options: OperationOptions
    ): Promise<void> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      const record = encodeRecord(options.root, snapshotServiceInstance(value))
      await enqueueCurrent(options, async function serialized(session): Promise<void> {
        const lease = operationLease(ctx, null, session.options.timeoutMs)
        try {
          const client = await activeClient(session, lease.signal)
          await client.remove(record.path, lease.signal)
          session.active.delete(record.identity)
          await pruneServiceParent(client, record, lease.signal)
          await changes.notify()
          const finalFailure = contextFailure(ctx)
          if (finalFailure !== null) throw finalFailure
          if (session.active.size === 0) {
            stopRecovery(session)
            detach(session)
            session.client = null
            forget(session)
            await client.close(lease.signal)
          }
        } catch (value) {
          throw (
            contextFailure(ctx) ??
            boundaryError(value, "ZooKeeper deregistration rejected with a non-Error value")
          )
        } finally {
          lease.release()
        }
      })
    }
  })
}
