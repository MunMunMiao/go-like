import * as zookeeper from "node-zookeeper-client"

import { newAuthenticationError, newOperationError } from "./errors"
import type {
  ZookeeperAcl,
  ZookeeperClient,
  ZookeeperClientFactoryOptions,
  ZookeeperClientState,
  ZookeeperMutation,
  ZookeeperOperation
} from "./types"

interface NativeExceptionLike {
  /** Returns one ZooKeeper protocol error code. */
  getCode(): number
}

/** Reports whether one unknown rejection carries a native ZooKeeper code. */
function exceptionLike(value: unknown): value is NativeExceptionLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "getCode" in value &&
    typeof value.getCode === "function"
  )
}

/** Converts one native callback failure without retaining native error text or credentials. */
function operationFailure(operation: ZookeeperOperation, value: unknown): Error {
  const code = exceptionLike(value) ? value.getCode() : null
  const retryable = code === -4 || code === -7 || code === -112
  return newOperationError(operation, code, retryable)
}

/** Returns the exact abort Error without leaking a non-Error reason. */
function abortFailure(signal: AbortSignal, operation: ZookeeperOperation): Error {
  return signal.reason instanceof Error ? signal.reason : newOperationError(operation, null, false)
}

/** Adapts one callback operation to an abort-aware Promise. */
function callbackOperation<T>(
  operation: ZookeeperOperation,
  signal: AbortSignal,
  invoke: (callback: (error: unknown, value: T) => void) => void
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortFailure(signal, operation))
  return new Promise<T>(function execute(resolve, reject): void {
    let settled = false
    /** Rejects the caller wait without assuming the native request is cancelable. */
    function aborted(): void {
      if (settled) return
      settled = true
      reject(abortFailure(signal, operation))
    }
    /** Settles one native callback exactly once. */
    function completed(error: unknown, value: T): void {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", aborted)
      if (error === null || error === undefined) resolve(value)
      else reject(operationFailure(operation, error))
    }
    signal.addEventListener("abort", aborted, { once: true })
    try {
      invoke(completed)
    } catch (value) {
      completed(value, undefined as T)
    }
  })
}

/** Adapts one submitted ZooKeeper multi whose native commit cannot be canceled. */
function commitOperation(
  signal: AbortSignal,
  invoke: (callback: (error: unknown) => void) => void
): Promise<void> {
  if (signal.aborted) return Promise.reject(abortFailure(signal, "mutate"))
  return new Promise<void>(function execute(resolve, reject): void {
    /** Reports the real commit outcome even when the caller stopped waiting. */
    function completed(error: unknown): void {
      if (error === null || error === undefined) resolve()
      else reject(operationFailure("mutate", error))
    }
    try {
      invoke(completed)
    } catch (value) {
      completed(value)
    }
  })
}

/** Reads one runtime ACL constant omitted by the third-party declaration package. */
function nativeAcl(value: ZookeeperAcl): readonly zookeeper.ACL[] {
  const key = value === "creator" ? "CREATOR_ALL_ACL" : "OPEN_ACL_UNSAFE"
  const descriptor = Object.getOwnPropertyDescriptor(zookeeper.ACL, key)
  if (descriptor === undefined || !Array.isArray(descriptor.value)) {
    throw new TypeError(`node-zookeeper-client omitted ${key}`)
  }
  return descriptor.value
}

/** Creates one promise-oriented adapter over node-zookeeper-client 1.1.3. */
export function newNativeZookeeperClient(options: ZookeeperClientFactoryOptions): ZookeeperClient {
  const client = zookeeper.createClient(options.connectionString, {
    sessionTimeout: options.sessionTimeoutMs,
    spinDelay: options.spinDelayMs,
    retries: options.retries
  })
  const acls = nativeAcl(options.acl)
  if (options.auth !== null) {
    client.addAuthInfo(options.auth.scheme, Buffer.from(options.auth.credential))
  }

  return Object.freeze({
    /** Opens the native ZooKeeper session. */
    connect(signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.reject(abortFailure(signal, "connect"))
      return new Promise<void>(function opening(resolve, reject): void {
        let settled = false
        /** Releases admission listeners. */
        function release(): void {
          signal.removeEventListener("abort", aborted)
          client.removeListener("connected", connected)
          client.removeListener("authenticationFailed", authenticationFailed)
        }
        /** Accepts the writable connected state. */
        function connected(): void {
          if (settled) return
          settled = true
          release()
          resolve()
        }
        /** Rejects without reflecting authentication bytes. */
        function authenticationFailed(): void {
          if (settled) return
          settled = true
          release()
          reject(newAuthenticationError())
        }
        /** Abandons and closes this still-unaccepted client. */
        function aborted(): void {
          if (settled) return
          settled = true
          release()
          client.close()
          reject(abortFailure(signal, "connect"))
        }
        signal.addEventListener("abort", aborted, { once: true })
        client.once("connected", connected)
        client.once("authenticationFailed", authenticationFailed)
        try {
          client.connect()
        } catch (value) {
          settled = true
          release()
          reject(operationFailure("connect", value))
        }
      })
    },
    /** Closes the native session after observing its socket transition. */
    close(signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.reject(abortFailure(signal, "close"))
      return new Promise<void>(function closing(resolve, reject): void {
        let settled = false
        /** Releases close listeners. */
        function release(): void {
          signal.removeEventListener("abort", aborted)
          client.removeListener("disconnected", disconnected)
        }
        /** Resolves once the native connection is no longer resident. */
        function disconnected(): void {
          if (settled) return
          settled = true
          release()
          resolve()
        }
        /** Rejects only the caller wait; close itself remains requested. */
        function aborted(): void {
          if (settled) return
          settled = true
          release()
          reject(abortFailure(signal, "close"))
        }
        signal.addEventListener("abort", aborted, { once: true })
        client.once("disconnected", disconnected)
        try {
          client.close()
        } catch (value) {
          settled = true
          release()
          reject(operationFailure("close", value))
        }
      })
    },
    /** Maps native session events to the provider boundary. */
    onState(listener: (state: ZookeeperClientState) => void): () => void {
      /** Reports a connected state. */
      function connected(): void {
        listener("connected")
      }
      /** Reports an availability interruption. */
      function disconnected(): void {
        listener("disconnected")
      }
      /** Reports terminal expiry of the current native client. */
      function expired(): void {
        listener("expired")
      }
      /** Reports terminal authentication failure. */
      function authenticationFailed(): void {
        listener("authentication-failed")
      }
      client.on("connected", connected)
      client.on("disconnected", disconnected)
      client.on("expired", expired)
      client.on("authenticationFailed", authenticationFailed)
      /** Detaches exactly this state listener group. */
      function unsubscribe(): void {
        client.removeListener("connected", connected)
        client.removeListener("disconnected", disconnected)
        client.removeListener("expired", expired)
        client.removeListener("authenticationFailed", authenticationFailed)
      }
      return unsubscribe
    },
    /** Creates every missing persistent path component. */
    mkdirp(path: string, signal: AbortSignal): Promise<void> {
      return callbackOperation<void>("mkdirp", signal, function invoke(callback): void {
        client.mkdirp(
          path,
          Buffer.alloc(0),
          Array.from(acls),
          zookeeper.CreateMode.PERSISTENT,
          function done(error): void {
            callback(error, undefined)
          }
        )
      })
    },
    /** Reads one exact child list. */
    children(path: string, signal: AbortSignal) {
      return callbackOperation<readonly string[]>(
        "children",
        signal,
        function invoke(callback): void {
          client.getChildren(path, function done(error, names): void {
            callback(error, names)
          })
        }
      ).then(function snapshot(names) {
        return Object.freeze({ names: Object.freeze(Array.from(names).sort()) })
      })
    },
    /** Reads children and installs one one-shot native watch. */
    watchChildren(path: string, listener: () => void, signal: AbortSignal) {
      return callbackOperation<readonly string[]>(
        "watch-children",
        signal,
        function invoke(callback): void {
          client.getChildren(
            path,
            function watched(): void {
              listener()
            },
            function done(error, names): void {
              callback(error, names)
            }
          )
        }
      ).then(function snapshot(names) {
        return Object.freeze({ names: Object.freeze(Array.from(names).sort()) })
      })
    },
    /** Reads one payload as an independent byte snapshot. */
    data(path: string, signal: AbortSignal): Promise<Uint8Array> {
      return callbackOperation<Uint8Array>("data", signal, function invoke(callback): void {
        client.getData(path, function done(error, data): void {
          callback(error, data)
        })
      }).then(function snapshot(data): Uint8Array {
        return Uint8Array.from(data)
      })
    },
    /** Commits one exact ZooKeeper multi mutation. */
    mutate(mutations: readonly ZookeeperMutation[], signal: AbortSignal): Promise<void> {
      if (mutations.length === 0) return Promise.resolve()
      return commitOperation(signal, function invoke(callback): void {
        let transaction = client.transaction()
        for (const mutation of mutations) {
          if (mutation.kind === "create-ephemeral") {
            transaction = transaction.create(
              mutation.path,
              Buffer.from(mutation.data),
              Array.from(acls),
              zookeeper.CreateMode.EPHEMERAL
            )
          } else transaction = transaction.remove(mutation.path, -1)
        }
        transaction.commit(function done(error): void {
          callback(error)
        })
      })
    },
    /** Removes one exact znode and treats absence as an idempotent result. */
    async remove(path: string, signal: AbortSignal): Promise<boolean> {
      try {
        await callbackOperation<void>("remove", signal, function invoke(callback): void {
          client.remove(path, -1, function done(error): void {
            callback(error, undefined)
          })
        })
        return true
      } catch (value) {
        if (
          value instanceof Error &&
          "nativeCode" in value &&
          value.nativeCode === zookeeper.Exception.NO_NODE
        ) {
          return false
        }
        throw value
      }
    }
  })
}
